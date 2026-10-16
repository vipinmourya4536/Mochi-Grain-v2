package com.mochigrain.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.mochigrain.app.ble.BlePlugin;

/**
 * Mochi Grain — Capacitor 7 bridge activity.
 *
 * Plugin registration NOTE: BridgeActivity.registerPlugin(Class) consumes
 * the plugin list inside super.onCreate() (BridgeActivity.load()), so the
 * registration MUST happen BEFORE super.onCreate(). Capacitor 7's public
 * API takes the plugin CLASS (it instantiates the plugin itself via its
 * no-arg constructor and provides Context/Activity through the Plugin
 * base class) — there is deliberately no instance-based overload here.
 *
 * Notification taps: the tap PendingIntent carries extra "mochi.tapTab"
 * (set by NotificationHelper). Both cold-start (getIntent) and warm taps
 * (singleTask → onNewIntent) are routed into NativeStore pendingTap, which
 * the WebView consumes via MochiBle.consumePendingTap() at session restore.
 */
public class MainActivity extends BridgeActivity {

    /** Extra key for notification tap PendingIntents (public: notify package). */
    public static final String EXTRA_TAP_TAB = "mochi.tapTab";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // BEFORE super.onCreate() — see class comment.
        registerPlugin(BlePlugin.class);
        super.onCreate(savedInstanceState);
        BlePlugin.setPendingTap(this, readTapTab(getIntent()));
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        BlePlugin.setPendingTap(this, readTapTab(intent));
    }

    private static String readTapTab(Intent intent) {
        return intent == null ? null : intent.getStringExtra(EXTRA_TAP_TAB);
    }
}
