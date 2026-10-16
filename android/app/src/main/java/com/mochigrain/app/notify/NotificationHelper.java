package com.mochigrain.app.notify;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.mochigrain.app.MainActivity;
import com.mochigrain.app.R;
import com.mochigrain.app.ble.NativeStore;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Notification channels + the alert rule engine for native monitoring.
 *
 * Channels (created once, idempotent):
 *   grain_critical — IMPORTANCE_HIGH, sound + vibration (moisture/temperature critical)
 *   grain_warnings — IMPORTANCE_DEFAULT (early storage-risk warnings)
 *   grain_status   — IMPORTANCE_LOW, silent (connection status, recovery, battery)
 *
 * Rule engine (evaluateReading) mirrors the TypeScript banding 1:1:
 *   band(v, safe, warn)      = v <= safe ? 0 : v <= warn ? 1 : 2
 *   resolveSeverity(m, t)    = max(m, t)
 *   cooldown: warning 30 min, critical 15 min; genuine escalation (1→2)
 *   always fires immediately (bypasses cooldown); signature change always
 *   fires; recovery (1|2→0) fires ONE "back to safe" note with ≥60 min gap.
 *
 * ⚠ HONEST LIMIT: the test vectors in tests/native-rules.test.ts validate the
 * TypeScript mirror automatically (bun test). This Java file is a HAND-SYNCED
 * mirror — there is no JVM/JDK in the sandbox to run it, so any change here
 * must be re-applied to tests/native-rules.test.ts (constants: WARNING=30min,
 * CRITICAL=15min, RECOVERY_GAP=60min, BATTERY=15% every 12h).
 *
 * NO FABRICATED DATA: alerts fire ONLY from freshly parsed valid packets
 * (the service calls evaluateReading synchronously after parsePacket()).
 * Missing/malformed/stale data can never trigger an alert.
 *
 * Grain profile labels are English proper nouns (Wheat, Rice, …) in every
 * locale — the surrounding guidance text is localized (en/hi/mr).
 *
 * Icons: framework drawables for now (ic_dialog_alert/ic_dialog_info);
 * swapping in a branded small icon is a one-line change per builder.
 */
public final class NotificationHelper {

    /* ── Shared constants — MUST mirror tests/native-rules.test.ts ──── */
    public static final long COOLDOWN_WARNING_MS = 30L * 60_000L;
    public static final long COOLDOWN_CRITICAL_MS = 15L * 60_000L;
    public static final long RECOVERY_MIN_GAP_MS = 60L * 60_000L;
    public static final double BATTERY_LOW_PCT = 15.0;
    public static final long BATTERY_ALERT_INTERVAL_MS = 12L * 3_600_000L;

    public static final String CH_CRITICAL = "grain_critical";
    public static final String CH_WARNINGS = "grain_warnings";
    public static final String CH_STATUS = "grain_status";

    private static final String TAG_ALERT = "grain-alert";
    private static final AtomicInteger ALERT_ID = new AtomicInteger(100);

    private NotificationHelper() {
    }

    /* ── Banding (pure rules — mirrored in TS) ──────────────────────── */

    /** v <= safe → 0 (safe); v <= warn → 1 (warning); else 2 (critical). */
    public static int band(double v, double safe, double warn) {
        if (v <= safe) return 0;
        if (v <= warn) return 1;
        return 2;
    }

    /** Severity = max(moisture band, temperature band). */
    public static int resolveSeverity(int moistureBand, int tempBand) {
        return Math.max(moistureBand, tempBand);
    }

    /* ── Channels ───────────────────────────────────────────────────── */

    public static void ensureChannels(Context ctx) {
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CH_CRITICAL) != null) return;

        NotificationChannel critical = new NotificationChannel(CH_CRITICAL,
                ctx.getString(R.string.notify_channel_critical_name),
                NotificationManager.IMPORTANCE_HIGH);
        critical.setDescription(ctx.getString(R.string.notify_channel_critical_desc));
        critical.enableVibration(true);
        critical.setVibrationPattern(new long[]{0, 250, 250, 250});
        critical.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI,
                Notification.AUDIO_ATTRIBUTES_DEFAULT);
        nm.createNotificationChannel(critical);

        NotificationChannel warnings = new NotificationChannel(CH_WARNINGS,
                ctx.getString(R.string.notify_channel_warnings_name),
                NotificationManager.IMPORTANCE_DEFAULT);
        warnings.setDescription(ctx.getString(R.string.notify_channel_warnings_desc));
        nm.createNotificationChannel(warnings);

        NotificationChannel status = new NotificationChannel(CH_STATUS,
                ctx.getString(R.string.notify_channel_status_name),
                NotificationManager.IMPORTANCE_LOW);
        status.setDescription(ctx.getString(R.string.notify_channel_status_desc));
        status.setSound(null, null);
        status.enableVibration(false);
        nm.createNotificationChannel(status);
    }

    /* ── Rule engine (called per VALID packet) ──────────────────────── */

    /**
     * Dedup + cooldown decision table (mirrored in tests/native-rules.test.ts):
     *   prev 0 → any alert            : FIRE (new alert)
     *   sev ↑ (1→2)                   : FIRE immediately (escalation bypass)
     *   signature changed             : FIRE
     *   same signature                : FIRE only when now-lastAlertAt ≥
     *                                    (warning 30 min | critical 15 min)
     *   prev 1|2 → 0                  : ONE recovery note, ≥60 min apart
     *   battery < 15%                 : one note per 12 h (grain_status)
     *   pushAlerts=false              : warning/critical/battery suppressed;
     *                                   grain_status connection notes remain
     */
    public static void evaluateReading(Context ctx, JSONObject reading,
                                       JSONObject cfg, NativeStore store) {
        // org.json put() declares JSONException — a rule-engine failure must
        // never crash the monitoring service, so the whole evaluation is
        // guarded (worst case: the alert-state write is skipped this packet).
        try {
            evaluateReadingInner(ctx, reading, cfg, store);
        } catch (Exception ignored) {
            // keep monitoring alive; never fabricate a fallback alert
        }
    }

    private static void evaluateReadingInner(Context ctx, JSONObject reading,
                                             JSONObject cfg, NativeStore store)
            throws Exception {
        long now = System.currentTimeMillis();
        JSONObject a = store.getAlertState(); // local working copy, saved below

        double m = reading.optDouble("moisture", Double.NaN);
        double t = reading.optDouble("temperature", Double.NaN);
        if (Double.isNaN(m) || Double.isNaN(t)) return; // never alert on missing data

        boolean pushAlerts = cfg == null || cfg.optBoolean("pushAlerts", true);
        String grainType = cfg == null ? "wheat" : cfg.optString("grainType", "wheat");
        String grainLabel = grainLabel(grainType);

        boolean hasThresholds = cfg != null
                && cfg.has("moistureSafeMax") && cfg.has("moistureWarnMax")
                && cfg.has("tempSafeMax") && cfg.has("tempWarnMax");

        int prevSev = a.optInt("lastSeverity", 0);
        String prevSignature = a.has("signature") ? a.optString("signature") : null;
        long lastAlertAt = a.optLong("lastAlertAt", 0L);
        long lastRecoveryAt = a.optLong("lastRecoveryAt", 0L);

        if (hasThresholds) {
            int mBand = band(m, cfg.optDouble("moistureSafeMax", 0),
                    cfg.optDouble("moistureWarnMax", 0));
            int tBand = band(t, cfg.optDouble("tempSafeMax", 0),
                    cfg.optDouble("tempWarnMax", 0));
            int severity = resolveSeverity(mBand, tBand);

            if (severity == 0) {
                boolean hadAlert = prevSev == 1 || prevSev == 2;
                if (hadAlert && (lastRecoveryAt == 0L
                        || now - lastRecoveryAt >= RECOVERY_MIN_GAP_MS)) {
                    postRecovery(ctx, grainLabel);
                    a.put("lastRecoveryAt", now);
                }
                a.put("lastSeverity", 0);
                a.remove("signature");
            } else {
                String driver = mBand >= tBand ? "moisture" : "temperature";
                String signature = severity + ":" + driver;

                boolean fire;
                if (prevSev <= 0) {
                    fire = true; // first alert
                } else if (severity > prevSev) {
                    fire = true; // genuine escalation — bypasses cooldown
                } else if (!signature.equals(prevSignature)) {
                    fire = true; // signature change (metric driver or severity step)
                } else {
                    long cooldown = severity == 1 ? COOLDOWN_WARNING_MS : COOLDOWN_CRITICAL_MS;
                    fire = now - lastAlertAt >= cooldown;
                }

                if (fire) {
                    double value = "moisture".equals(driver) ? m : t;
                    // Threshold actually crossed: severity 1 crossed the SAFE
                    // max; severity 2 crossed the WARN max.
                    double threshold = "moisture".equals(driver)
                            ? (severity == 2 ? cfg.optDouble("moistureWarnMax", 0)
                            : cfg.optDouble("moistureSafeMax", 0))
                            : (severity == 2 ? cfg.optDouble("tempWarnMax", 0)
                            : cfg.optDouble("tempSafeMax", 0));
                    if (pushAlerts) {
                        postAlert(ctx, severity, driver, value, threshold, grainLabel);
                    }
                    a.put("lastAlertAt", now);
                }
                a.put("lastSeverity", severity);
                a.put("signature", signature);
            }
        }
        // Without the JS config snapshot there are NO thresholds to band
        // against — moisture/temp alerts stay silent (never invented).

        double battery = reading.optDouble("battery", Double.NaN);
        if (!Double.isNaN(battery) && battery < BATTERY_LOW_PCT) {
            long lastBat = a.optLong("lastBatteryAlertAt", 0L);
            if (lastBat == 0L || now - lastBat >= BATTERY_ALERT_INTERVAL_MS) {
                if (pushAlerts) postBattery(ctx, (int) Math.round(battery));
                a.put("lastBatteryAlertAt", now);
            }
        }

        store.setAlertState(a);
    }

    /* ── Connection loss (terminal unexpected drops only) ───────────── */

    /** One 'probe disconnected' note per permanent unexpected drop. */
    public static void notifyDisconnected(Context ctx, NativeStore store) {
        JSONObject assoc = store.getAssociatedDevice();
        String name = assoc == null ? "GRAIN-01" : assoc.optString("name", "GRAIN-01");
        long lastPacketAt = store.getLastPacketAt();
        String age = lastPacketAt == 0L
                ? ctx.getString(R.string.notify_age_never)
                : ageText(ctx, lastPacketAt);
        String text = ctx.getString(R.string.notify_text_disconnected, name, age)
                + "\n" + ctx.getString(R.string.notify_guidance_disconnect);
        Notification n = new NotificationCompat.Builder(ctx, CH_STATUS)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(ctx.getString(R.string.notify_title_disconnected))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(tapIntent(ctx, "home"))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build();
        notifyTagged(ctx, TAG_ALERT, ALERT_ID.incrementAndGet(), n);
    }

    /** Clear the disconnect marker on reconnect (silent status update only). */
    public static void clearDisconnected(NativeStore store) {
        try {
            JSONObject a = store.getAlertState();
            a.remove("disconnectedAt");
            store.setAlertState(a);
        } catch (Exception ignored) {
            // alert-state bookkeeping must never crash the service
        }
    }

    public static void markDisconnected(NativeStore store) {
        try {
            JSONObject a = store.getAlertState();
            a.put("disconnectedAt", System.currentTimeMillis());
            store.setAlertState(a);
        } catch (Exception ignored) {
            // alert-state bookkeeping must never crash the service
        }
    }

    /* ── Status notification (FGS #1) ───────────────────────────────── */

    /**
     * "Monitoring {deviceName} · last reading {age}" — the age is computed
     * ONLY from the real lastPacketAt (0 → "waiting for first reading").
     * Probe sleeping (status byte 2) is noted explicitly. Nothing invented.
     */
    public static Notification buildStatusNotification(Context ctx, NativeStore store) {
        JSONObject assoc = store.getAssociatedDevice();
        String name = assoc == null ? "GRAIN-01" : assoc.optString("name", "GRAIN-01");
        long lastPacketAt = store.getLastPacketAt();

        String text;
        if (lastPacketAt == 0L) {
            text = ctx.getString(R.string.notify_status_waiting, name);
        } else {
            String age = ageText(ctx, lastPacketAt);
            JSONObject last = store.getLastValidReading();
            boolean sleeping = last != null && last.optInt("status", 0) == 2;
            text = sleeping
                    ? ctx.getString(R.string.notify_status_sleeping, name, age)
                    : ctx.getString(R.string.notify_status_monitoring, name, age);
        }

        return new NotificationCompat.Builder(ctx, CH_STATUS)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(tapIntent(ctx, "home"))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    public static void notifyStatus(Context ctx, int id, Notification n) {
        notifyTagged(ctx, null, id, n);
    }

    public static void cancelStatus(Context ctx) {
        NotificationManagerCompat.from(ctx).cancel(1);
    }

    public static void cancelAll(Context ctx) {
        NotificationManagerCompat.from(ctx).cancel(1);
        NotificationManagerCompat.from(ctx).cancel(TAG_ALERT, ALERT_ID.get());
    }

    /* ── Individual notification builders ───────────────────────────── */

    private static void postAlert(Context ctx, int severity, String driver,
                                  double value, double threshold, String grainLabel) {
        boolean moisture = "moisture".equals(driver);
        String unit = moisture ? "%" : "°C";
        int titleRes = severity == 2
                ? (moisture ? R.string.notify_title_critical_moisture
                : R.string.notify_title_critical_temperature)
                : (moisture ? R.string.notify_title_warning_moisture
                : R.string.notify_title_warning_temperature);
        int guidanceRes = moisture ? R.string.notify_guidance_moisture
                : R.string.notify_guidance_temperature;

        String text = ctx.getString(R.string.notify_text_alert, grainLabel,
                formatValue(value), unit, formatValue(threshold), unit)
                + "\n" + ctx.getString(guidanceRes);

        Notification n = new NotificationCompat.Builder(ctx,
                severity == 2 ? CH_CRITICAL : CH_WARNINGS)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(ctx.getString(titleRes))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(tapIntent(ctx, "history"))
                .setAutoCancel(true)
                .setCategory(severity == 2
                        ? NotificationCompat.CATEGORY_ALARM
                        : NotificationCompat.CATEGORY_STATUS)
                .build();
        notifyTagged(ctx, TAG_ALERT, ALERT_ID.incrementAndGet(), n);
    }

    private static void postBattery(Context ctx, int pct) {
        String text = ctx.getString(R.string.notify_text_battery, pct)
                + "\n" + ctx.getString(R.string.notify_guidance_battery);
        Notification n = new NotificationCompat.Builder(ctx, CH_STATUS)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(ctx.getString(R.string.notify_title_battery))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(tapIntent(ctx, "home"))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build();
        notifyTagged(ctx, TAG_ALERT, ALERT_ID.incrementAndGet(), n);
    }

    private static void postRecovery(Context ctx, String grainLabel) {
        String text = ctx.getString(R.string.notify_recovered_text, grainLabel);
        Notification n = new NotificationCompat.Builder(ctx, CH_STATUS)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(ctx.getString(R.string.notify_recovered))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(tapIntent(ctx, "home"))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build();
        notifyTagged(ctx, TAG_ALERT, ALERT_ID.incrementAndGet(), n);
    }

    /* ── helpers ────────────────────────────────────────────────────── */

    private static void notifyTagged(Context ctx, String tag, int id, Notification n) {
        try {
            NotificationManagerCompat.from(ctx).notify(tag, id, n);
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS revoked — monitoring keeps running silently.
        }
    }

    /** One decimal for both metrics (matches the web UI's precision). */
    private static String formatValue(double v) {
        return String.format(java.util.Locale.US, "%.1f", v);
    }

    /** Age from the REAL lastPacketAt — never a fabricated interval. */
    static String ageText(Context ctx, long lastPacketAt) {
        long diff = System.currentTimeMillis() - lastPacketAt;
        if (diff < 0) diff = 0;
        if (diff < 60_000L) return ctx.getString(R.string.notify_age_now);
        if (diff < 3_600_000L) {
            return ctx.getString(R.string.notify_age_min, (int) (diff / 60_000L));
        }
        if (diff < 86_400_000L) {
            return ctx.getString(R.string.notify_age_hr, (int) (diff / 3_600_000L));
        }
        return ctx.getString(R.string.notify_age_day, (int) (diff / 86_400_000L));
    }

    /** Tap target: warning/critical → History; status/recovery → Home. */
    private static PendingIntent tapIntent(Context ctx, String tab) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        i.putExtra(MainActivity.EXTRA_TAP_TAB, tab);
        int requestCode = "history".equals(tab) ? 1 : 0;
        return PendingIntent.getActivity(ctx, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** English proper-noun labels (see class comment about locales). */
    static String grainLabel(String grainType) {
        if (grainType == null) return "Wheat";
        switch (grainType) {
            case "rice": return "Rice";
            case "corn": return "Corn";
            case "barley": return "Barley";
            case "soybean": return "Soybean";
            case "sorghum": return "Sorghum";
            case "oats": return "Oats";
            case "millet": return "Millet";
            default: return "Wheat";
        }
    }
}
