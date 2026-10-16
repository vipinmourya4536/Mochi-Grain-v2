package com.mochigrain.app.ble;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.ServiceCompat;

import com.mochigrain.app.notify.NotificationHelper;

import org.json.JSONObject;

/**
 * Foreground Service (type connectedDevice) that owns BLE monitoring while
 * the app is backgrounded or the process is restarted by the system.
 *
 * Responsibilities
 * ────────────────
 *  - startForeground with a LOW-priority "monitor status" notification
 *    (id 1, channel grain_status): "Monitoring {deviceName} · last reading
 *    {age}". The age is computed ONLY from the real lastPacketAt — a packet
 *    that never arrived is shown as "waiting for first reading", never an
 *    invented age or value. The notification updates only when a new valid
 *    packet arrives (setOnlyAlertOnce → no repeated buzzing).
 *  - Owns the GrainBleManager. On every VALID packet:
 *      1. update NativeStore (lastValidReading, lastPacketAt, pendingReadings),
 *      2. evaluate alert rules via NotificationHelper (REAL values only),
 *      3. notifyListeners('grainReading') via BlePlugin — pushing to a
 *         suspended WebView is harmless, so this is safe to always call.
 *  - Probe sleep (status byte 2): the status notification notes it. NOTE:
 *    if the firmware stops advertising while asleep, auto-rediscovery is
 *    IMPOSSIBLE — reconnect relies on the stored association + a direct
 *    connect() to the MAC; the wake command (0x01) exists for manual wake.
 *  - START_STICKY: if the system restarted the process and monitoringEnabled,
 *    the service re-foregrounds itself and reconnects to the associated probe.
 *
 * Destroy semantics: the manager is always shut down, but notifications are
 * cancelled ONLY for a deliberate stop (ACTION_STOP) — a system kill leaves
 * the status notification to the system (it disappears with the process).
 */
public class BleMonitoringService extends Service {

    public static final String ACTION_START = "com.mochigrain.app.ble.action.START";
    public static final String ACTION_CONNECT = "com.mochigrain.app.ble.action.CONNECT";
    public static final String ACTION_STOP = "com.mochigrain.app.ble.action.STOP";
    public static final String EXTRA_ADDRESS = "com.mochigrain.app.ble.extra.ADDRESS";

    private static final int NOTIF_ID_STATUS = 1;

    private NativeStore store;
    private GrainBleManager manager;
    private volatile boolean deliberateStop;

    @Override
    public void onCreate() {
        super.onCreate();
        store = new NativeStore(this);
        manager = GrainBleManager.get(this);
        NotificationHelper.ensureChannels(this);

        manager.setConnectionListener((state, reason) -> {
            store.setConnectionState(state, reason);
            BlePlugin.emitConnection(state, reason);
            if (GrainBleManager.STATE_CONNECTED.equals(state)) {
                // Reconnect recovery is a SILENT status update — no fresh
                // announcement storm; just refresh the status notification.
                NotificationHelper.clearDisconnected(store);
                updateStatusNotification();
            } else if (GrainBleManager.STATE_DISCONNECTED.equals(state)
                    && store.isMonitoringEnabled()
                    && reason != null
                    && !"deliberate".equals(reason)) {
                // Terminal unexpected drop (RECONNECT_GAVE_UP / ADAPTER_OFF):
                // exactly one 'probe disconnected' notification per drop.
                NotificationHelper.notifyDisconnected(this, store);
                NotificationHelper.markDisconnected(store);
            }
        });

        // Valid packets only — parsePacket() guarantees sanity upstream.
        manager.setPacketListener(parsed -> {
            long now = System.currentTimeMillis();
            try {
                parsed.put("receivedAt", now);
            } catch (Exception ignored) {
                // put of a long cannot realistically throw
            }
            String address = associationAddress();
            long ts = now; // packet timestamp = receive time (never faked)
            try {
                // Deterministic id: {mac}-{packetTimestampMs} → IndexedDB
                // put() dedupes replays on the WebView side.
                parsed.put("id", address + "-" + ts);
                parsed.put("deviceId", address);
                parsed.put("ts", ts);
            } catch (Exception ignored) {
                // id/deviceId annotation failure → still forward raw packet
            }

            store.setLastValidReading(parsed);
            store.setLastPacketAt(ts);
            store.enqueuePendingReading(new JSONObject(parsed.toString()));

            JSONObject cfg = store.getMonitoringConfig();
            NotificationHelper.evaluateReading(this, parsed, cfg, store);

            // Bridge push: reach a suspended WebView harmlessly (safe always).
            BlePlugin.emitReading(parsed);

            updateStatusNotification();
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationHelper.ensureChannels(this);
        startStatusForeground();

        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            // Deliberate stop from the plugin: tear down + remove notification.
            deliberateStop = true;
            manager.disconnect(); // cancels retries first (deliberate)
            store.setConnectionState(GrainBleManager.STATE_DISCONNECTED, "deliberate");
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        String address = intent != null ? intent.getStringExtra(EXTRA_ADDRESS) : null;
        if (address == null || address.length() == 0) {
            JSONObject assoc = store.getAssociatedDevice();
            address = assoc == null ? null : assoc.optString("address", null);
        }

        if (address != null) {
            manager.connect(this, address, null);
        } else if (!store.isMonitoringEnabled()) {
            // Nothing associated and nothing to monitor → honest stop.
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    /** Promote to foreground FIRST (before any reconnect work). */
    private void startStatusForeground() {
        Notification n = NotificationHelper.buildStatusNotification(this, store);
        int type = Build.VERSION.SDK_INT >= 29
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                : 0;
        ServiceCompat.startForeground(this, NOTIF_ID_STATUS, n, type);
    }

    private void updateStatusNotification() {
        Notification n = NotificationHelper.buildStatusNotification(this, store);
        try {
            NotificationHelper.notifyStatus(this, NOTIF_ID_STATUS, n);
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS revoked mid-run → status bar stays empty,
            // monitoring continues regardless.
        }
    }

    private String associationAddress() {
        JSONObject assoc = store.getAssociatedDevice();
        return assoc == null ? "" : assoc.optString("address", "");
    }

    @Override
    public void onDestroy() {
        if (manager != null) manager.shutdown();
        if (deliberateStop) {
            NotificationHelper.cancelAll(this);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // started service, never bound
    }
}
