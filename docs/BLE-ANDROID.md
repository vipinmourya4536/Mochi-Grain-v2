# Mochi Grain — Android BLE Monitoring & Notifications

## Chosen mechanism (and why it fits the ESP32 probe)

| Concern | Choice | Reason |
|---|---|---|
| Background monitoring | `BleMonitoringService` — foreground service, `connectedDevice` type | The official Android pattern for maintaining a BLE connection with the screen off / WebView suspended. A `WakeLock`-free, user-visible service; the OS will not kill it while the notification is up. |
| Device authorization | In-app scan (FFE0 service-UUID filter) + user selection dialog, persisted in `NativeStore` | Equivalent of the Web Bluetooth chooser. Deliberately **not** treated as satisfied by an OS "paired device" entry — pairing ≠ runtime permission; `BLUETOOTH_CONNECT` runtime grant + in-app association are what authorize access. |
| Auto-reconnect | Bounded retries (6 attempts, 5s→30s backoff) with generation counter; adapter-state receiver restarts one bounded cycle after BT re-enable | Prevents battery-draining infinite scans; deliberate disconnect cancels retries immediately (user intent wins); probe wake-up after sleep is handled because reconnect uses direct `connect()` on the stored address (no advertising needed for a direct connect). |
| Companion Device API | Not required | CDM adds value for post-boot discovery without location permission; the probe is selected in-app and reconnects by address, so CDM would duplicate authorization paths. Documented as a future option. |
| Data path | Native `SharedPreferences` JSON store (`NativeStore`) + JS replay | The native service **cannot** touch the WebView's IndexedDB. Valid packets are queued natively (cap 2000, FIFO) and replayed through the TS engine (`handleReading`) when the UI resumes — dedupe is guaranteed by deterministic reading ids (`{mac}-{packetTimestampMs}`), and classification stays in ONE place (the TS Mochi engine). |

## Firmware contract (kept exactly; no change without inspection)

- Service `0000ffe0-…`; DATA char `ffe1` (notify), CMD char `ffe2` (write).
- Packet ≥ 12 bytes, little-endian: `u16 moisture×10`, `i16 temp×10`, `u8 battery`, `u8 signal`, `u8 status` (0 connected / 1 syncing / 2 sleeping / 3 low-battery / 4 awake). Grain code byte 0 is diagnostic metadata only.
- Commands: wake=1, calibrate=2, sync=3, sleep=4.
- **Advertising/sleep limit (documented, not promised):** if the probe stops advertising while asleep, background auto-*discovery* is impossible — reconnection relies on the persisted association + direct `connect()`, and the manual wake command. Firmware modification (persistent advertise during sleep) would be required for true auto-rediscovery.

## Notification design

- Channels: `grain_critical` (HIGH, sound+vibration), `grain_warnings` (DEFAULT, sound), `grain_status` (LOW, silent).
- Fired only from **freshly parsed valid packets** — never on stale, missing, malformed, or assumed data.
- Rule (banding, mirrors the TypeScript engine's static bands):
  `value <= safe → 0 (safe); <= warn → 1 (warning); else → 2 (critical)` — worse of moisture/temperature wins.
- Dedup: signature = severity + driving metric; warning cooldown 30 min, critical 15 min; **genuine escalation (warning→critical) bypasses cooldown**; one recovery note per hour max.
- Battery < 15 %: max one per 12 h. Unexpected disconnect while monitoring: one status note; reconnect is silent.
- `pushAlerts` off suppresses warning/critical/battery notifications (connection status notes remain).
- Shared test vectors: `tests/native-rules.test.ts` (24 tests) validates the TS mirror `src/lib/native-rules.ts`; the Java `band()` in `NotificationHelper.java` is a hand-synced mirror (no JVM in sandbox — **must be re-validated on a build machine**; both files cross-reference the vector table).
- Localization: en (default), hi, mr; Hinglish intentionally uses the default romanized strings. Tap → opens the relevant tab (`history` for risk alerts, `home` for status).

## Honest verification status

| Item | Status |
|---|---|
| TS rule vectors | ✅ 24/24 automated tests pass |
| Java rule mirror | ⚠️ Hand-synced, requires JVM/device validation |
| Service lifecycle / reconnect transitions | ⚠️ Code-reviewed only — needs real phone + ESP32 |
| Foreground notification with screen off | ⚠️ Needs real device (hardware-locked validation) |
| Boot receiver restart | ⚠️ Code follows `connectedDevice` boot rules; verify on Android 14/15 |
| Web PWA BLE path after bridge swap | ✅ Browser-verified (honest "No device selected" flow, no regressions) |
| Background readings sync/dedup | ⚠️ Logic implemented + id-deterministic; needs real-device soak test |
