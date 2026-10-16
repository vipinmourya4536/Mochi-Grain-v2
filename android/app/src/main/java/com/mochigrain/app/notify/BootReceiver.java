package com.mochigrain.app.notify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.mochigrain.app.ble.BleMonitoringService;
import com.mochigrain.app.ble.NativeStore;

/**
 * Restarts native monitoring after a device reboot IF the user had it on.
 *
 * HONEST LIMITS:
 *  - Acts ONLY on ACTION_BOOT_COMPLETED (post-unlock). The manifest also
 *    declares LOCKED_BOOT_COMPLETED (directBootAware receiver), but the code
 *    deliberately ignores it: default SharedPreferences (NativeStore) live
 *    in credential-encrypted storage and are NOT readable before the user
 *    unlocks — reading them there would throw. Once unlocked, BOOT_COMPLETED
 *    delivers the same restart guarantee.
 *  - Android 15 restricts some foreground-service types at boot
 *    (e.g. dataSync, mediaProcessing); the connectedDevice type used here
 *    is on the permitted list, but this MUST be verified on a real device
 *    (no emulator/device exists in this sandbox).
 *  - startForegroundService from a receiver can still throw under OEM
 *    background-start restrictions → guarded, logged, never crashes boot.
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "MochiBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return; // guard null action
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

        try {
            NativeStore store = new NativeStore(context);
            if (!store.isMonitoringEnabled()) return;      // user opted out → stay off
            if (store.getAssociatedDevice() == null) return; // nothing to reconnect to

            Intent svc = new Intent(context, BleMonitoringService.class);
            svc.setAction(BleMonitoringService.ACTION_START);
            ContextCompat.startForegroundService(context, svc);
        } catch (Exception e) {
            Log.w(TAG, "monitoring restart after boot failed", e);
        }
    }
}
