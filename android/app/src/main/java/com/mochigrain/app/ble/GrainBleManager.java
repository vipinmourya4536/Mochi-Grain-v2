package com.mochigrain.app.ble;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * The SINGLE GATT client owner for the GRAIN-01 probe (singleton).
 *
 * Firmware contract (MUST stay identical to src/lib/bluetooth.ts — that file
 * is authoritative and must never be modified by native work):
 *   Service UUID        0000ffe0-0000-1000-8000-00805f9b34fb
 *   DATA char (notify)  0000ffe1-0000-1000-8000-00805f9b34fb
 *   CMD char  (write)   0000ffe2-0000-1000-8000-00805f9b34fb
 *
 * Packet (min length 12, little-endian):
 *   byte0      grain code index into
 *              ['wheat','rice','corn','barley','soybean','sorghum','oats','millet']
 *              (diagnostic metadata only — never authoritative)
 *   u16 @1     moisture × 10
 *   i16 @3     temperature × 10
 *   u8  @5     battery %
 *   u8  @6     signal %
 *   u8  @7     status (0 connected, 1 syncing, 2 sleeping, 3 low-battery, 4 awake)
 *   bytes 8-11 reserved — ignored
 *
 * Commands (single byte write to CMD char): wake=1, calibrate=2, sync=3, sleep=4.
 *
 * Connection policy
 * ─────────────────
 *  - First attempt: autoConnect=false (direct connect, bounded).
 *  - Unexpected drop → bounded retries: attempts 1..6, delay 5s × attempt
 *    capped at 30s, then give up PERMANENTLY (state=disconnected +
 *    lastError=RECONNECT_GAVE_UP, listener notified). A retryGeneration
 *    counter invalidates pending retries when the user disconnects
 *    deliberately or monitoring stops — the user's stop ALWAYS wins.
 *  - Bluetooth adapter on/off is observed via ACTION_STATE_CHANGED:
 *    BT off → retries cancelled, state=disconnected/ADAPTER_OFF;
 *    BT on  → one fresh bounded retry cycle if monitoringEnabled.
 *  - Deliberate disconnects never retry and never fire alerts (the service
 *    only notifies on terminal unexpected reasons).
 *
 * NO FABRICATED DATA: parsePacket() ignores packets shorter than 12 bytes,
 * rejects moisture outside 0..100 and temperature outside -20..85
 * (lastError=MALFORMED_PACKET) and never synthesizes values. Short/odd
 * fragments are silently dropped (they are BLE reassembly noise, not data).
 */
public final class GrainBleManager {

    /* ── Firmware contract constants (mirror of src/lib/bluetooth.ts) ── */
    public static final String SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
    public static final String DATA_CHAR_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
    public static final String CMD_CHAR_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb";
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final byte[] ENABLE_NOTIFICATION_VALUE = {0x01, 0x00};

    public static final String[] FIRMWARE_GRAIN_CODES = {
            "wheat", "rice", "corn", "barley", "soybean", "sorghum", "oats", "millet"
    };

    /** Single-byte commands understood by the probe firmware. */
    public static final byte CMD_WAKE = 0x01;
    public static final byte CMD_CALIBRATE = 0x02;
    public static final byte CMD_SYNC = 0x03;
    public static final byte CMD_SLEEP = 0x04;

    /* ── Policy constants ───────────────────────────────────────────── */
    private static final long SCAN_DURATION_MS = 12_000L;
    private static final int MAX_RETRIES = 6;
    private static final long RETRY_BASE_DELAY_MS = 5_000L;
    private static final long RETRY_MAX_DELAY_MS = 30_000L;
    /** Bounded wait for the FIRST connect attempt result (plugin call). */
    private static final long CONNECT_RESULT_TIMEOUT_MS = 10_000L;

    public static final String STATE_CONNECTED = "connected";
    public static final String STATE_CONNECTING = "connecting";
    public static final String STATE_RECONNECTING = "reconnecting";
    public static final String STATE_DISCONNECTED = "disconnected";

    /* ── Callbacks ──────────────────────────────────────────────────── */

    /** Scan discovery callbacks (bounded 12s scan, never infinite). */
    public interface ScanCallback {
        void onDevice(String address, String name, int rssi);

        void onDone();
    }

    /** One-shot result of the FIRST connect attempt (never fired for retries). */
    public interface ConnectResultCallback {
        void onResult(boolean connected, String errorCode);
    }

    /** Connection state transitions (drives plugin events + notifications). */
    public interface ConnectionListener {
        void onConnectionStateChanged(String state, String reason);
    }

    /** Valid parsed packets only — malformed data never reaches this. */
    public interface PacketListener {
        void onPacket(JSONObject reading);
    }

    /* ── Singleton ──────────────────────────────────────────────────── */

    private static volatile GrainBleManager instance;

    public static GrainBleManager get(Context context) {
        if (instance == null) {
            synchronized (GrainBleManager.class) {
                if (instance == null) instance = new GrainBleManager(context);
            }
        }
        return instance;
    }

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic cmdChar;
    /** In-flight connect guard — a new connect() closes the previous GATT first. */
    private boolean connecting;
    /** True while a DELIBERATE disconnect is in progress (no retry, no alert). */
    private volatile boolean deliberate;
    /** Incremented to invalidate pending retry runnables (user stop wins). */
    private int retryGeneration = 0;
    private int retryAttempt = 0;

    private String state = STATE_DISCONNECTED;
    private String lastError;

    private ConnectionListener connectionListener;
    private PacketListener packetListener;
    private ConnectResultCallback firstAttemptCb;
    private final Runnable firstAttemptTimeout = this::fireFirstAttemptTimeout;

    private ScanCallback activeScanCb;
    private android.bluetooth.le.ScanCallback scanCallbackRef;
    private final Runnable scanTimeout = this::finishScan;

    private boolean btReceiverRegistered;

    private GrainBleManager(Context context) {
        this.appContext = context.getApplicationContext();
    }

    /* ── Listener wiring (service only) ─────────────────────────────── */

    public void setConnectionListener(ConnectionListener l) {
        this.connectionListener = l;
    }

    public void setPacketListener(PacketListener l) {
        this.packetListener = l;
    }

    public synchronized String getState() {
        return state;
    }

    public synchronized String getLastError() {
        return lastError;
    }

    /* ── Bluetooth adapter access ───────────────────────────────────── */

    private BluetoothAdapter adapter() {
        BluetoothManager bm = appContext.getSystemService(BluetoothManager.class);
        return bm == null ? null : bm.getAdapter();
    }

    /* ── Scanning (association chooser only — 12s bounded) ──────────── */

    /**
     * Bounded 12s scan for the probe. Filters: the firmware service UUID
     * (FFE0) with a fallback on the advertised name GRAIN-01 (some firmwares
     * advertise the name without the 128-bit listed cleanly). Results are
     * forwarded per device; {@code onDone} fires exactly once after 12s or
     * on scan failure. NEVER scans indefinitely and NEVER scans while the
     * probe is asleep/associated — scanning is only used for association.
     */
    public void scanForProbe(Context ctx, ScanCallback cb) {
        mainHandler.removeCallbacks(scanTimeout);
        stopLeScanInternal(); // never leak a previous scan
        activeScanCb = cb;

        BluetoothAdapter adapter = adapter();
        BluetoothLeScanner scanner = adapter == null ? null : adapter.getBluetoothLeScanner();
        if (scanner == null) {
            // No adapter / BT off → report "no candidates" honestly.
            mainHandler.post(() -> {
                if (cb != null) cb.onDone();
            });
            return;
        }

        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder()
                .setServiceUuid(ParcelUuid.fromString(SERVICE_UUID))
                .build());
        filters.add(new ScanFilter.Builder()
                .setDeviceName("GRAIN-01")
                .build());
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        android.bluetooth.le.ScanCallback leCb = new android.bluetooth.le.ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                if (result == null || result.getDevice() == null) return;
                String address = result.getDevice().getAddress();
                String name = result.getScanRecord() != null
                        ? result.getScanRecord().getDeviceName() : null;
                ScanCallback cb1 = activeScanCb;
                if (cb1 != null) cb1.onDevice(address, name, result.getRssi());
            }

            @Override
            public void onScanFailed(int errorCode) {
                finishScan();
            }
        };
        scanCallbackRef = leCb;
        try {
            scanner.startScan(filters, settings, leCb);
        } catch (SecurityException e) {
            // Runtime BLE permissions not granted → honest "no candidates".
            finishScan();
            return;
        }
        mainHandler.postDelayed(scanTimeout, SCAN_DURATION_MS);
    }

    /** Stops an active association scan early (e.g. chooser dismissed). */
    public synchronized void cancelScan() {
        mainHandler.removeCallbacks(scanTimeout);
        stopLeScanInternal();
        activeScanCb = null;
    }

    private synchronized void finishScan() {
        mainHandler.removeCallbacks(scanTimeout);
        stopLeScanInternal();
        ScanCallback cb = activeScanCb;
        activeScanCb = null;
        if (cb != null) cb.onDone();
    }

    private void stopLeScanInternal() {
        BluetoothLeScanner scanner = null;
        BluetoothAdapter adapter = adapter();
        if (adapter != null) scanner = adapter.getBluetoothLeScanner();
        android.bluetooth.le.ScanCallback leCb = scanCallbackRef;
        scanCallbackRef = null;
        if (scanner != null && leCb != null) {
            try {
                scanner.stopScan(leCb);
            } catch (SecurityException | IllegalStateException ignored) {
                // scanner already stopped or permissions revoked mid-scan
            }
        }
    }

    /* ── Connect / reconnect ────────────────────────────────────────── */

    /**
     * Connect to the associated probe. {@code firstAttemptCb} (optional) is
     * invoked EXACTLY ONCE with the outcome of the first attempt (success =
     * service discovered + notifications subscribed) or with a bounded
     * timeout error; background retries continue regardless.
     */
    public void connect(Context ctx, String address, ConnectResultCallback firstAttemptCb) {
        synchronized (this) {
            // Guard: never duplicate connections — close any previous GATT.
            closeGattQuietly();
            deliberate = false;
            retryAttempt = 0;
            state = STATE_CONNECTING;
            lastError = null;
            this.firstAttemptCb = firstAttemptCb;
            connecting = true;
        }
        registerBtReceiver();

        if (firstAttemptCb != null) {
            mainHandler.removeCallbacks(firstAttemptTimeout);
            mainHandler.postDelayed(firstAttemptTimeout, CONNECT_RESULT_TIMEOUT_MS);
        }

        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) {
            setTerminalState(STATE_DISCONNECTED, "ADAPTER_OFF");
            return;
        }
        if (Build.VERSION.SDK_INT >= 31
                && ContextCompat.checkSelfPermission(appContext, android.Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED) {
            setTerminalState(STATE_DISCONNECTED, "PERMISSION_DENIED");
            return;
        }

        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(address);
        } catch (IllegalArgumentException e) {
            setTerminalState(STATE_DISCONNECTED, "BAD_ADDRESS");
            return;
        }

        // autoConnect=false → direct, bounded first attempt.
        gatt = device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        if (gatt == null) {
            setTerminalState(STATE_DISCONNECTED, "GATT_NULL");
        }
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {

        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                g.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                closeGattQuietly();
                if (deliberate) {
                    // Deliberate path: no retry, no alert, plain state.
                    setTerminalState(STATE_DISCONNECTED, null);
                } else {
                    fireFirstAttemptResult(false, "GATT_DISCONNECTED");
                    scheduleRetry();
                }
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                if (!deliberate) scheduleRetry();
                else setTerminalState(STATE_DISCONNECTED, null);
                return;
            }
            BluetoothGattService svc = g.getService(UUID.fromString(SERVICE_UUID));
            BluetoothGattCharacteristic data = svc == null
                    ? null : svc.getCharacteristic(UUID.fromString(DATA_CHAR_UUID));
            cmdChar = svc == null
                    ? null : svc.getCharacteristic(UUID.fromString(CMD_CHAR_UUID));
            if (svc == null || data == null) {
                // Firmware without the expected shape → honest error, retry bounded.
                lastError = "SERVICE_MISSING";
                if (!deliberate) scheduleRetry();
                else setTerminalState(STATE_DISCONNECTED, "SERVICE_MISSING");
                return;
            }
            // ONE notification listener only: subscribe DATA char with CCCD 0x2902.
            g.setCharacteristicNotification(data, true);
            BluetoothGattDescriptor cccd = data.getDescriptor(CCCD_UUID);
            if (cccd == null) {
                lastError = "CCCD_MISSING";
                if (!deliberate) scheduleRetry();
                else setTerminalState(STATE_DISCONNECTED, "CCCD_MISSING");
                return;
            }
            try {
                if (Build.VERSION.SDK_INT >= 33) {
                    g.writeDescriptor(cccd, ENABLE_NOTIFICATION_VALUE);
                } else {
                    cccd.setValue(ENABLE_NOTIFICATION_VALUE);
                    g.writeDescriptor(cccd);
                }
            } catch (SecurityException e) {
                setTerminalState(STATE_DISCONNECTED, "PERMISSION_DENIED");
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            if (CCCD_UUID.equals(d.getUuid()) && status == BluetoothGatt.GATT_SUCCESS) {
                synchronized (GrainBleManager.this) {
                    connecting = false;
                    state = STATE_CONNECTED;
                    lastError = null;
                }
                mainHandler.removeCallbacks(firstAttemptTimeout);
                fireFirstAttemptResult(true, null);
                notifyState(STATE_CONNECTED, null);
            }
            // A failed CCCD write leaves state=connecting; the bounded
            // first-attempt timeout or a later drop triggers the retry path.
        }

        /* API 33+ callback — invoked by the framework on T+ devices. */
        @Override
        public void onCharacteristicChanged(BluetoothGatt g,
                                            BluetoothGattCharacteristic c,
                                            byte[] value) {
            handleNotify(c, value);
        }

        /* Legacy callback — invoked on API < 33 devices only. */
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            if (Build.VERSION.SDK_INT < 33) {
                handleNotify(c, c.getValue());
            }
        }
    };

    private void handleNotify(BluetoothGattCharacteristic c, byte[] value) {
        if (c == null || value == null) return;
        if (!UUID.fromString(DATA_CHAR_UUID).equals(c.getUuid())) return;

        JSONObject parsed = parsePacket(value);
        if (parsed == null) return; // malformed → dropped, never emitted

        PacketListener l = packetListener;
        if (l != null) l.onPacket(parsed);
    }

    /* ── Retry policy ───────────────────────────────────────────────── */

    private void scheduleRetry() {
        synchronized (this) {
            if (deliberate) return;
            if (retryAttempt >= MAX_RETRIES) {
                giveUp();
                return;
            }
            retryAttempt += 1;
            state = STATE_RECONNECTING;
        }
        notifyState(STATE_RECONNECTING, lastError);

        final int gen = retryGeneration;
        long delay = Math.min(RETRY_BASE_DELAY_MS * retryAttempt, RETRY_MAX_DELAY_MS);
        mainHandler.postDelayed(() -> {
            if (gen != retryGeneration || deliberate) return; // user stop wins
            connectInternal();
        }, delay);
    }

    private void giveUp() {
        closeGattQuietly();
        setTerminalState(STATE_DISCONNECTED, "RECONNECT_GAVE_UP");
    }

    /** Direct connect used by retries and the BT-on recovery cycle. */
    private void connectInternal() {
        synchronized (this) {
            closeGattQuietly();
            connecting = true;
            state = STATE_CONNECTING;
        }
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) {
            setTerminalState(STATE_DISCONNECTED, "ADAPTER_OFF");
            return;
        }
        JSONObject assoc = new NativeStore(appContext).getAssociatedDevice();
        if (assoc == null) {
            setTerminalState(STATE_DISCONNECTED, "NO_ASSOCIATION");
            return;
        }
        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(assoc.optString("address", ""));
        } catch (IllegalArgumentException e) {
            setTerminalState(STATE_DISCONNECTED, "BAD_ADDRESS");
            return;
        }
        try {
            gatt = device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException e) {
            setTerminalState(STATE_DISCONNECTED, "PERMISSION_DENIED");
            return;
        }
        if (gatt == null) setTerminalState(STATE_DISCONNECTED, "GATT_NULL");
    }

    /** Cancels pending retries (deliberate stop / monitoring stopped / BT off). */
    private void cancelRetries() {
        retryGeneration += 1;
        mainHandler.removeCallbacks(firstAttemptTimeout);
    }

    /* ── Terminal state transitions ─────────────────────────────────── */

    private void setTerminalState(String newState, String error) {
        synchronized (this) {
            connecting = false;
            state = newState;
            lastError = error;
        }
        fireFirstAttemptResult(false, error);
        notifyState(newState, error);
    }

    /** Fires the one-shot first-attempt callback exactly once; true if fired. */
    private synchronized boolean fireFirstAttemptResult(boolean ok, String errorCode) {
        ConnectResultCallback cb = firstAttemptCb;
        firstAttemptCb = null;
        if (cb != null) {
            mainHandler.post(() -> cb.onResult(ok, errorCode));
            return true;
        }
        return false;
    }

    private void fireFirstAttemptTimeout() {
        fireFirstAttemptResult(false, "TIMEOUT");
        // NOTE: retries are NOT cancelled by the timeout — the first attempt
        // result is only the plugin call's answer; background recovery goes on.
    }

    private void notifyState(String s, String reason) {
        ConnectionListener l = connectionListener;
        if (l != null) l.onConnectionStateChanged(s, reason);
    }

    /* ── Packet parsing (firmware contract — never fabricates) ──────── */

    /**
     * Parses a DATA-char notification per the firmware contract. Returns the
     * base reading object (moisture/temperature/battery/signal/status/
     * deviceGrain) or null when the packet is short or out of sanity range
     * (lastError=MALFORMED_PACKET). Malformed packets are NEVER emitted.
     */
    public JSONObject parsePacket(byte[] data) {
        if (data == null || data.length < 12) return null; // ignore short packets

        int grainIdx = data[0] & 0xFF;
        int moistureRaw = (data[1] & 0xFF) | ((data[2] & 0xFF) << 8);
        int tempRaw = (short) ((data[3] & 0xFF) | ((data[4] & 0xFF) << 8));
        int battery = data[5] & 0xFF;
        int signal = data[6] & 0xFF;
        int status = data[7] & 0xFF;

        double moisture = moistureRaw / 10.0;
        double temperature = tempRaw / 10.0;

        if (moisture < 0.0 || moisture > 100.0 || temperature < -20.0 || temperature > 85.0) {
            synchronized (this) {
                lastError = "MALFORMED_PACKET";
            }
            return null; // DO NOT emit
        }

        JSONObject packet = new JSONObject();
        try {
            packet.put("moisture", moisture);
            packet.put("temperature", temperature);
            packet.put("battery", battery);
            packet.put("signal", signal);
            packet.put("status", status);
            packet.put("deviceGrain",
                    grainIdx >= 0 && grainIdx < FIRMWARE_GRAIN_CODES.length
                            ? FIRMWARE_GRAIN_CODES[grainIdx]
                            : JSONObject.NULL);
        } catch (Exception ignored) {
            return null;
        }
        return packet;
    }

    /* ── Commands ───────────────────────────────────────────────────── */

    /**
     * Writes a single-byte command to the CMD char (FFE2). Returns false
     * (never throws) when no live connection/char exists.
     */
    public boolean writeCommand(byte cmd) {
        BluetoothGatt g;
        BluetoothGattCharacteristic c;
        synchronized (this) {
            if (deliberate || gatt == null || cmdChar == null) return false;
            g = gatt;
            c = cmdChar;
        }
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                return g.writeCharacteristic(c, new byte[]{cmd},
                        BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
                        == BluetoothGatt.GATT_SUCCESS;
            }
            c.setValue(new byte[]{cmd});
            return g.writeCharacteristic(c);
        } catch (SecurityException e) {
            return false;
        }
    }

    /* ── Deliberate disconnect ──────────────────────────────────────── */

    /**
     * Deliberate stop: cancels pending retries FIRST (user stop wins), then
     * closes the GATT. No retry, no alert, listener notified with
     * reason="deliberate".
     */
    public void disconnect() {
        deliberate = true;
        cancelRetries();
        synchronized (this) {
            closeGattQuietly();
            connecting = false;
            state = STATE_DISCONNECTED;
            lastError = null;
        }
        notifyState(STATE_DISCONNECTED, "deliberate");
    }

    /** Full teardown (service destroyed): disconnect + receiver unregister. */
    public void shutdown() {
        deliberate = true;
        cancelRetries();
        synchronized (this) {
            closeGattQuietly();
            connecting = false;
            state = STATE_DISCONNECTED;
        }
        unregisterBtReceiver();
        connectionListener = null;
        packetListener = null;
    }

    private synchronized void closeGattQuietly() {
        if (gatt != null) {
            try {
                gatt.disconnect();
                gatt.close();
            } catch (SecurityException | IllegalStateException ignored) {
                // permission revoked or callback raced — nothing to recover
            }
            gatt = null;
        }
        cmdChar = null;
    }

    /* ── Adapter state receiver ─────────────────────────────────────── */

    private final BroadcastReceiver btReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null
                    || !BluetoothAdapter.ACTION_STATE_CHANGED.equals(intent.getAction())) {
                return;
            }
            int adapterState = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE,
                    BluetoothAdapter.ERROR);
            if (adapterState == BluetoothAdapter.STATE_OFF
                    || adapterState == BluetoothAdapter.STATE_TURNING_OFF) {
                deliberate = false; // adapter off is NOT the user's choice
                cancelRetries();
                synchronized (GrainBleManager.this) {
                    closeGattQuietly();
                    connecting = false;
                    state = STATE_DISCONNECTED;
                }
                setTerminalState(STATE_DISCONNECTED, "ADAPTER_OFF");
            } else if (adapterState == BluetoothAdapter.STATE_ON) {
                // ONE fresh bounded retry cycle if monitoring is enabled.
                NativeStore store = new NativeStore(appContext);
                if (store.isMonitoringEnabled() && store.getAssociatedDevice() != null) {
                    String current = getState();
                    if (STATE_DISCONNECTED.equals(current)) {
                        retryAttempt = 0;
                        retryGeneration += 1;
                        deliberate = false;
                        connectInternal();
                    }
                }
            }
        }
    };

    private void registerBtReceiver() {
        if (btReceiverRegistered) return;
        btReceiverRegistered = true;
        ContextCompat.registerReceiver(appContext, btReceiver,
                new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    private void unregisterBtReceiver() {
        if (!btReceiverRegistered) return;
        btReceiverRegistered = false;
        try {
            appContext.unregisterReceiver(btReceiver);
        } catch (IllegalArgumentException ignored) {
            // receiver was never registered (process race)
        }
    }
}
