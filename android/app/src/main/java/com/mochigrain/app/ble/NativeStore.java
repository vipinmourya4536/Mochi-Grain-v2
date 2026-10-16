package com.mochigrain.app.ble;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * SharedPreferences-backed JSON state store for native BLE monitoring.
 *
 * This is the ONLY durable state the native side keeps (everything else is
 * in-memory inside {@link GrainBleManager} / {@link BleMonitoringService}).
 * The WebView layer (IndexedDB) remains the source of truth for history;
 * this store only carries what the foreground service needs while the app
 * is killed, backgrounded or rebooted:
 *
 *  - associatedDevice     : {address, name} — the user-authorized probe
 *                           (chosen in the AlertDialog, the equivalent of
 *                           the Web Bluetooth requestDevice() chooser).
 *  - monitoringConfig     : snapshot written by JS at startMonitoring
 *                           {grainType, moistureSafeMax, moistureWarnMax,
 *                            tempSafeMax, tempWarnMax, pushAlerts, language,
 *                            monitoringEnabled}.
 *  - lastValidReading     : full reading JSON + receivedAt (real packets only).
 *  - lastPacketAt         : epoch ms of the newest valid packet.
 *  - pendingReadings      : FIFO queue (max 2000, oldest dropped; entries
 *                           replaced in place by id → put() semantics).
 *  - alertState           : {signature, lastSeverity, lastAlertAt,
 *                            lastRecoveryAt, lastBatteryAlertAt, disconnectedAt}
 *                           — notification dedup/cooldown memory.
 *  - connectionState      : 'connected'|'connecting'|'reconnecting'|'disconnected'
 *                           + lastError (short code, null when healthy).
 *  - pendingTap           : notification tap target tab for the WebView.
 *
 * Thread-safety: all methods are synchronized (GATT callbacks arrive on
 * binder threads, the service/plugin run on the main thread) and writes use
 * SharedPreferences.apply() (async persist, never blocks the caller).
 *
 * NO FABRICATED DATA: nothing in this class ever synthesizes a reading,
 * timestamp or battery value — it only stores what valid packets deliver.
 */
public final class NativeStore {

    private static final String PREFS = "mochi_native_state";
    private static final int MAX_PENDING_READINGS = 2000;

    private static final String K_ASSOCIATED = "associatedDevice";
    private static final String K_CONFIG = "monitoringConfig";
    private static final String K_LAST_READING = "lastValidReading";
    private static final String K_LAST_PACKET_AT = "lastPacketAt";
    private static final String K_PENDING = "pendingReadings";
    private static final String K_ALERT_STATE = "alertState";
    private static final String K_CONN_STATE = "connectionState";
    private static final String K_LAST_ERROR = "lastError";
    private static final String K_PENDING_TAP = "pendingTap";
    private static final String K_MONITORING = "monitoringEnabled";
    private static final String K_NOTIFS_GRANTED = "notificationsGranted";

    private final SharedPreferences prefs;

    public NativeStore(Context context) {
        prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /* ── Device association ─────────────────────────────────────────── */

    public synchronized void setAssociatedDevice(String address, String name) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("address", address);
            obj.put("name", name != null ? name : "GRAIN-01");
        } catch (Exception ignored) {
            // JSON of two strings cannot throw in practice
        }
        prefs.edit().putString(K_ASSOCIATED, obj.toString()).apply();
    }

    /** {@code null} when no probe is associated yet. */
    public synchronized JSONObject getAssociatedDevice() {
        return optObject(K_ASSOCIATED);
    }

    public synchronized void clearAssociatedDevice() {
        prefs.edit().remove(K_ASSOCIATED).apply();
    }

    /* ── Monitoring config snapshot (written by JS) ─────────────────── */

    public synchronized void setMonitoringConfig(JSONObject cfg) {
        prefs.edit().putString(K_CONFIG, cfg == null ? null : cfg.toString()).apply();
    }

    /** {@code null} until the WebView pushed a startMonitoring snapshot. */
    public synchronized JSONObject getMonitoringConfig() {
        return optObject(K_CONFIG);
    }

    public synchronized boolean isMonitoringEnabled() {
        return prefs.getBoolean(K_MONITORING, false);
    }

    public synchronized void setMonitoringEnabled(boolean enabled) {
        prefs.edit().putBoolean(K_MONITORING, enabled).apply();
    }

    /* ── Last valid reading / last packet time ──────────────────────── */

    public synchronized void setLastValidReading(JSONObject reading) {
        prefs.edit().putString(K_LAST_READING, reading.toString()).apply();
    }

    /** {@code null} until the first valid packet arrives. */
    public synchronized JSONObject getLastValidReading() {
        return optObject(K_LAST_READING);
    }

    public synchronized void setLastPacketAt(long tsMs) {
        prefs.edit().putLong(K_LAST_PACKET_AT, tsMs).apply();
    }

    /** {@code 0} when no packet has ever arrived (never faked). */
    public synchronized long getLastPacketAt() {
        return prefs.getLong(K_LAST_PACKET_AT, 0L);
    }

    /* ── Pending readings queue (FIFO, cap 2000, put-by-id) ─────────── */

    /**
     * Enqueue a reading payload. Semantics are put-by-id: an existing entry
     * with the same id is replaced in place; otherwise the entry is appended.
     * Beyond {@code MAX_PENDING_READINGS} the OLDEST entries are dropped.
     * The deterministic id (mac-timestampMs) makes replays dedupe again
     * in IndexedDB on the WebView side via put().
     */
    public synchronized void enqueuePendingReading(JSONObject reading) {
        try {
            JSONArray queue = optArray(K_PENDING);
            JSONArray next = new JSONArray();
            String id = reading.optString("id", null);
            for (int i = 0; i < queue.length(); i++) {
                JSONObject existing = queue.optJSONObject(i);
                if (existing == null) continue;
                String existingId = existing.optString("id", null);
                // keep everything EXCEPT an entry with the same id (replace-in-place)
                if (id == null || existingId == null || !id.equals(existingId)) {
                    next.put(existing);
                }
            }
            next.put(reading);
            // drop OLDEST beyond the cap
            int overflow = next.length() - MAX_PENDING_READINGS;
            if (overflow > 0) {
                JSONArray trimmed = new JSONArray();
                for (int i = overflow; i < next.length(); i++) {
                    trimmed.put(next.opt(i));
                }
                next = trimmed;
            }
            prefs.edit().putString(K_PENDING, next.toString()).apply();
        } catch (Exception ignored) {
            // A corrupt queue must never crash the monitoring service.
        }
    }

    /** Returns the whole queue and clears it (drain). */
    public synchronized JSONArray drainPendingReadings() {
        JSONArray queue = optArray(K_PENDING);
        prefs.edit().remove(K_PENDING).apply();
        return queue;
    }

    /* ── Alert state (dedup + cooldown memory) ──────────────────────── */

    public synchronized JSONObject getAlertState() {
        JSONObject obj = optObject(K_ALERT_STATE);
        return obj != null ? obj : new JSONObject();
    }

    public synchronized void setAlertState(JSONObject state) {
        prefs.edit().putString(K_ALERT_STATE, state == null ? null : state.toString()).apply();
    }

    /* ── Connection state ───────────────────────────────────────────── */

    public synchronized void setConnectionState(String state, String lastError) {
        SharedPreferences.Editor e = prefs.edit();
        e.putString(K_CONN_STATE, state);
        if (lastError == null) {
            e.remove(K_LAST_ERROR);
        } else {
            e.putString(K_LAST_ERROR, lastError);
        }
        e.apply();
    }

    public synchronized String getConnectionState() {
        return prefs.getString(K_CONN_STATE, "disconnected");
    }

    /** Short error code (e.g. {@code MALFORMED_PACKET}) or null. */
    public synchronized String getLastError() {
        return prefs.getString(K_LAST_ERROR, null);
    }

    /* ── Pending notification tap ───────────────────────────────────── */

    public synchronized void setPendingTap(String tab) {
        SharedPreferences.Editor e = prefs.edit();
        if (tab == null || tab.length() == 0) {
            e.remove(K_PENDING_TAP);
        } else {
            e.putString(K_PENDING_TAP, tab);
        }
        e.apply();
    }

    public synchronized String getPendingTap() {
        return prefs.getString(K_PENDING_TAP, null);
    }

    /* ── Runtime notification permission memory ─────────────────────── */

    public synchronized void setNotificationsGranted(boolean granted) {
        prefs.edit().putBoolean(K_NOTIFS_GRANTED, granted).apply();
    }

    public synchronized boolean isNotificationsGranted() {
        return prefs.getBoolean(K_NOTIFS_GRANTED, false);
    }

    /* ── helpers ────────────────────────────────────────────────────── */

    private JSONObject optObject(String key) {
        String raw = prefs.getString(key, null);
        if (raw == null) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return null; // corrupt entry → treated as absent, never fabricated
        }
    }

    private JSONArray optArray(String key) {
        String raw = prefs.getString(key, null);
        if (raw == null) return new JSONArray();
        try {
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray(); // corrupt entry → empty queue
        }
    }
}
