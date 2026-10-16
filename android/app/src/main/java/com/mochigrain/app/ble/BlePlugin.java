package com.mochigrain.app.ble;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.mochigrain.app.notify.NotificationHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;

/**
 * Capacitor plugin "MochiBle" — the native-first BLE + monitoring bridge.
 *
 * IMPORTANT — OS pairing vs. APP authorization (do not confuse them):
 * The AlertDialog device chooser below is the AUTHORIZATION moment, the
 * exact equivalent of the Web Bluetooth requestDevice() chooser: the USER
 * explicitly picks which BLE device this app may talk to, and that choice
 * is persisted in NativeStore. This has NOTHING to do with Android system
 * PAIRING (bonding) — BLE GATT here uses unencrypted, no-bonding links;
 * runtime permissions (BLUETOOTH_CONNECT/SCAN or legacy location) only
 * gate the OS-level scan/connect API, never the user's device choice.
 *
 * Permission model (runtime, via Capacitor's alias system):
 *   API 31+:  alias "ble" → BLUETOOTH_CONNECT + BLUETOOTH_SCAN
 *             (manifest declares SCAN with neverForLocation — no location
 *              permission is needed or requested on 31+).
 *   API <31:  alias "location" → ACCESS_FINE_LOCATION (legacy scan gate;
 *             BLUETOOTH/BLUETOOTH_ADMIN are install-time, maxSdkVersion 30).
 *   API 33+:  alias "notifications" → POST_NOTIFICATIONS, requested from
 *             associate() AND startMonitoring(); granted state is tracked
 *             in NativeStore.
 *
 * All readings and states surfaced here come from REAL firmware packets —
 * this plugin never synthesizes telemetry.
 */
@CapacitorPlugin(name = "MochiBle", permissions = {
        @Permission(strings = {Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN}, alias = "ble"),
        @Permission(strings = {Manifest.permission.ACCESS_FINE_LOCATION}, alias = "location"),
        @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications")
})
public class BlePlugin extends Plugin {

    private static final String ALIAS_BLE = "ble";
    private static final String ALIAS_LOCATION = "location";
    private static final String ALIAS_NOTIFICATIONS = "notifications";

    private static final String CB_ASSOCIATE_PERMS = "onAssociatePerms";
    private static final String CB_ASSOCIATE_NOTIFS = "onAssociateNotifs";
    private static final String CB_MONITOR_NOTIFS = "onMonitorNotifs";

    private static final String REJECT_NO_DEVICE = "no-device";
    private static final String REJECT_DENIED = "denied";

    /** Live instance for cross-component pushes (service → WebView events). */
    private static volatile BlePlugin liveInstance;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        liveInstance = this;
    }

    /* ── Static emit helpers used by BleMonitoringService ───────────── */

    public static void emitReading(JSONObject payload) {
        BlePlugin plugin = liveInstance;
        if (plugin == null || payload == null) return;
        JSObject data = plugin.toJs(payload);
        plugin.mainHandler.post(() -> plugin.notifyListeners("grainReading", data));
    }

    public static void emitConnection(String state, String reason) {
        BlePlugin plugin = liveInstance;
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("state", state);
        if (reason != null) data.put("reason", reason);
        plugin.mainHandler.post(() -> plugin.notifyListeners("grainConnection", data));
    }

    /** Called by MainActivity for notification taps (extra mochi.tapTab). */
    public static void setPendingTap(Context ctx, String tab) {
        if (tab == null || tab.length() == 0) return;
        new NativeStore(ctx).setPendingTap(tab);
    }

    /* ── Association (the authorization moment) ─────────────────────── */

    @PluginMethod
    public void associate(PluginCall call) {
        String alias = Build.VERSION.SDK_INT >= 31 ? ALIAS_BLE : ALIAS_LOCATION;
        if (aliasGranted(alias)) {
            maybeRequestNotifications(call, CB_ASSOCIATE_NOTIFS);
        } else {
            requestPermissionForAlias(alias, call, CB_ASSOCIATE_PERMS);
        }
    }

    @PermissionCallback
    private void onAssociatePerms(PluginCall call) {
        String alias = Build.VERSION.SDK_INT >= 31 ? ALIAS_BLE : ALIAS_LOCATION;
        if (!aliasGranted(alias)) {
            call.reject(REJECT_DENIED);
            return;
        }
        maybeRequestNotifications(call, CB_ASSOCIATE_NOTIFS);
    }

    @PermissionCallback
    private void onAssociateNotifs(PluginCall call) {
        recordNotificationState();
        startAssociationScan(call);
    }

    /** POST_NOTIFICATIONS on 33+ (associate + startMonitoring), then continue. */
    private void maybeRequestNotifications(PluginCall call, String callbackName) {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias(ALIAS_NOTIFICATIONS, call, callbackName);
        } else {
            recordNotificationState();
            if (CB_ASSOCIATE_NOTIFS.equals(callbackName)) {
                startAssociationScan(call);
            } else {
                doStartMonitoring(call);
            }
        }
    }

    private void recordNotificationState() {
        boolean granted = Build.VERSION.SDK_INT < 33
                || ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        new NativeStore(getContext()).setNotificationsGranted(granted);
    }

    private void startAssociationScan(PluginCall call) {
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("bluetooth-unavailable");
            return;
        }

        LinkedHashMap<String, String> candidates = new LinkedHashMap<>();
        GrainBleManager manager = GrainBleManager.get(getContext());
        manager.scanForProbe(getContext(), new GrainBleManager.ScanCallback() {
            @Override
            public void onDevice(String address, String name, int rssi) {
                synchronized (candidates) {
                    if (!candidates.containsKey(address)) {
                        String label = name == null || name.length() == 0 ? "GRAIN-01" : name;
                        candidates.put(address, label);
                    }
                }
            }

            @Override
            public void onDone() {
                mainHandler.post(() -> showDeviceChooser(call, candidates));
            }
        });
    }

    /**
     * USER SELECTION dialog — the authorization moment (see class comment).
     * Even a single candidate goes through the dialog: the user must
     * explicitly approve this device, exactly like the requestDevice()
     * chooser on the web. Cancel → reject("denied"); the JS bridge then
     * falls back to any existing association.
     */
    private void showDeviceChooser(PluginCall call, LinkedHashMap<String, String> candidates) {
        int size;
        synchronized (candidates) {
            size = candidates.size();
        }
        if (size == 0) {
            call.reject(REJECT_NO_DEVICE);
            return;
        }
        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            call.reject(REJECT_NO_DEVICE);
            return;
        }

        final String[] addresses;
        final CharSequence[] labels;
        synchronized (candidates) {
            addresses = candidates.keySet().toArray(new String[0]);
            labels = new CharSequence[addresses.length];
            for (int i = 0; i < addresses.length; i++) {
                labels[i] = candidates.get(addresses[i]) + "  (" + addresses[i] + ")";
            }
        }

        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("Select grain probe")
                .setItems(labels, (DialogInterface d, int which) -> {
                    String address = addresses[which];
                    String name = candidates.get(address);
                    new NativeStore(getContext()).setAssociatedDevice(address, name);
                    JSObject res = new JSObject();
                    res.put("id", address);
                    res.put("name", name);
                    call.resolve(res);
                })
                .setNegativeButton("Cancel", (DialogInterface d, int which) ->
                        call.reject(REJECT_DENIED))
                .setOnCancelListener((DialogInterface d) -> call.reject(REJECT_DENIED))
                .create();
        dialog.show();
    }

    /* ── Forget ─────────────────────────────────────────────────────── */

    @PluginMethod
    public void forget(PluginCall call) {
        NativeStore store = new NativeStore(getContext());
        store.setMonitoringEnabled(false);
        store.clearAssociatedDevice();
        GrainBleManager.get(getContext()).disconnect(); // deliberate
        getContext().stopService(new Intent(getContext(), BleMonitoringService.class));
        NotificationHelper.cancelStatus(getContext());
        call.resolve();
    }

    /* ── Connect / disconnect ───────────────────────────────────────── */

    @PluginMethod
    public void connect(PluginCall call) {
        NativeStore store = new NativeStore(getContext());
        JSONObject assoc = store.getAssociatedDevice();
        if (assoc == null) {
            call.reject("no-association");
            return;
        }
        String address = assoc.optString("address", "");
        store.setMonitoringEnabled(true); // a connect implies monitoring

        Intent svc = new Intent(getContext(), BleMonitoringService.class);
        svc.setAction(BleMonitoringService.ACTION_CONNECT);
        svc.putExtra(BleMonitoringService.EXTRA_ADDRESS, address);
        ContextCompat.startForegroundService(getContext(), svc);

        GrainBleManager.get(getContext()).connect(getContext(), address,
                (connected, errorCode) -> {
                    JSObject res = new JSObject();
                    res.put("connected", connected);
                    if (!connected && errorCode != null) res.put("error", errorCode);
                    call.resolve(res);
                });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        // Deliberate stop: cancel retries first, then stop service + notif.
        GrainBleManager.get(getContext()).disconnect();
        NativeStore store = new NativeStore(getContext());
        store.setMonitoringEnabled(false);
        store.setConnectionState(GrainBleManager.STATE_DISCONNECTED, "deliberate");
        Intent svc = new Intent(getContext(), BleMonitoringService.class);
        svc.setAction(BleMonitoringService.ACTION_STOP);
        try {
            ContextCompat.startForegroundService(getContext(), svc);
        } catch (IllegalStateException e) {
            // app in background on some OEMs → fall back to plain stop
            getContext().stopService(new Intent(getContext(), BleMonitoringService.class));
            NotificationHelper.cancelStatus(getContext());
        }
        call.resolve();
    }

    /* ── Commands ───────────────────────────────────────────────────── */

    @PluginMethod
    public void sendCommand(PluginCall call) {
        String cmd = call.getString("cmd");
        Byte b = commandByte(cmd);
        if (b == null) {
            call.reject("unknown-command");
            return;
        }
        boolean sent = GrainBleManager.get(getContext()).writeCommand(b);
        JSObject res = new JSObject();
        res.put("sent", sent);
        call.resolve(res);
    }

    private Byte commandByte(String cmd) {
        if (cmd == null) return null;
        switch (cmd) {
            case "wake": return GrainBleManager.CMD_WAKE;
            case "calibrate": return GrainBleManager.CMD_CALIBRATE;
            case "sync": return GrainBleManager.CMD_SYNC;
            case "sleep": return GrainBleManager.CMD_SLEEP;
            default: return null;
        }
    }

    /* ── Monitoring config ──────────────────────────────────────────── */

    @PluginMethod
    public void startMonitoring(PluginCall call) {
        JSONObject settings = call.getData().optJSONObject("settings");
        if (settings == null) {
            call.reject("no-settings");
            return;
        }
        try {
            settings.put("monitoringEnabled", true);
        } catch (Exception ignored) {
            // cannot throw for a boolean
        }
        NativeStore store = new NativeStore(getContext());
        store.setMonitoringConfig(settings);
        store.setMonitoringEnabled(true);

        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias(ALIAS_NOTIFICATIONS, call, CB_MONITOR_NOTIFS);
        } else {
            recordNotificationState();
            doStartMonitoring(call);
        }
    }

    @PermissionCallback
    private void onMonitorNotifs(PluginCall call) {
        recordNotificationState();
        doStartMonitoring(call);
    }

    private void doStartMonitoring(PluginCall call) {
        NativeStore store = new NativeStore(getContext());
        Intent svc = new Intent(getContext(), BleMonitoringService.class);
        svc.setAction(BleMonitoringService.ACTION_START);
        ContextCompat.startForegroundService(getContext(), svc);
        call.resolve();
    }

    @PluginMethod
    public void stopMonitoring(PluginCall call) {
        // Config update only — the connection may stay if JS keeps it.
        // In the Mochi Grain flow disconnect() replaces this method.
        NativeStore store = new NativeStore(getContext());
        store.setMonitoringEnabled(false);
        JSONObject cfg = store.getMonitoringConfig();
        if (cfg != null) {
            try {
                cfg.put("monitoringEnabled", false);
                store.setMonitoringConfig(cfg);
            } catch (Exception ignored) {
                // cannot throw for a boolean
            }
        }
        call.resolve();
    }

    /* ── Status / queue / tap ───────────────────────────────────────── */

    @PluginMethod
    public void getStatus(PluginCall call) {
        NativeStore store = new NativeStore(getContext());
        JSObject res = new JSObject();
        JSONObject assoc = store.getAssociatedDevice();
        if (assoc != null) {
            try {
                res.put("association", JSObject.fromJSONObject(assoc));
            } catch (Exception e) {
                res.put("association", new JSObject());
            }
        }
        res.put("connectionState", store.getConnectionState());
        String lastError = store.getLastError();
        if (lastError != null) res.put("lastError", lastError);
        res.put("lastPacketAt", store.getLastPacketAt());
        JSONObject last = store.getLastValidReading();
        if (last != null) {
            try {
                res.put("lastValidReading", JSObject.fromJSONObject(last));
            } catch (Exception ignored) {
                // omit rather than fabricate
            }
        }
        String tap = store.getPendingTap();
        if (tap != null) res.put("pendingTap", tap);
        res.put("monitoringEnabled", store.isMonitoringEnabled());
        call.resolve(res);
    }

    @PluginMethod
    public void drainPendingReadings(PluginCall call) {
        NativeStore store = new NativeStore(getContext());
        JSONArray readings = store.drainPendingReadings();
        JSObject res = new JSObject();
        res.put("readings", readings);
        call.resolve(res);
    }

    @PluginMethod
    public void consumePendingTap(PluginCall call) {
        NativeStore store = new NativeStore(getContext());
        String tap = store.getPendingTap();
        store.setPendingTap(null);
        JSObject res = new JSObject();
        if (tap != null) res.put("tab", tap); // absent key → JS undefined → bridged as null
        call.resolve(res);
    }

    /* ── helpers ────────────────────────────────────────────────────── */

    private BluetoothAdapter getAdapter() {
        android.bluetooth.BluetoothManager bm =
                getContext().getSystemService(android.bluetooth.BluetoothManager.class);
        return bm == null ? null : bm.getAdapter();
    }

    private boolean aliasGranted(String alias) {
        try {
            return com.getcapacitor.PermissionState.GRANTED.equals(getPermissionState(alias));
        } catch (Exception e) {
            return false;
        }
    }

    private JSObject toJs(JSONObject obj) {
        try {
            return JSObject.fromJSONObject(obj);
        } catch (Exception e) {
            return new JSObject(); // never fabricate; empty payload beats a crash
        }
    }
}
