# Mochi Grain — Android (Capacitor) Architecture

## Application identity

| Field | Value |
|---|---|
| App name | Mochi Grain |
| Application ID | `com.mochigrain.app` |
| Bundle (webDir) | `out/` — static export of the SAME Next.js frontend |
| Capacitor | 7.x (`@capacitor/core` `android` `cli` `app` `status-bar` `splash-screen`) |
| minSdk | 26 (required by notification channels; see `android/variables.gradle`) |
| compile/targetSdk | Capacitor 7 defaults (35/36) |

## Deployment architecture (deliberate choice)

Mochi Grain ships **two artifacts from one codebase**:

1. **Hosted PWA (unchanged)** — Next.js `output: "standalone"` (a real Node
   server). Build with `bun run build`, serve `.next/standalone`. The service
   worker (`public/sw.js`) provides offline capability for the browser app.
2. **Android APK (Capacitor)** — bundles a **static export** of the same
   frontend (`MOCHI_TARGET=capacitor bunx next build` → `out/` → synced into
   `android/app/src/main/assets/public` by `bun run android:sync`).

Why static export is valid **only for the APK target**: the frontend is fully
client-side — there are no `/api` routes, no server-only modules, no
`next/image` loaders, and no session/auth server state. Every reading,
setting, decision, and bookmark lives in IndexedDB inside the WebView. The
hosted deployment keeps `standalone` (server stays authoritative for the web
app); we did **not** switch the project to static export globally.

Consequences:

- **Cold start offline**: the APK boots from local assets — zero network
  requests to start. The web PWA instead uses the service worker (verified
  in Task 15-a).
- **Updates**: APK ships updates via reinstall/Play, **not** web deploys.
  The bundled `sw.js` is harmless inside the WebView and simply mirrors the
  already-local assets.
- **Server-dependent routes**: none exist. If a server feature is ever added
  to the web app, the APK must either reach the hosted deployment when
  online or feature-detect and degrade honestly (the app's Discover tab is
  the reference pattern: explicit offline state, no fake content).

## Build

Prereqs (a real build machine): JDK 17+, Android SDK (platform 35), Android
Studio recommended.

```bash
bun install
bun run android:web      # MOCHI_TARGET=capacitor next build → out/
bun run android:sync     # cap sync android (copies out/ into the APK assets)
bun run android:open     # cap open android (Android Studio)
bun run android:debug    # web + sync + ./gradlew assembleDebug
bun run android:release  # web + sync + ./gradlew assembleRelease
```

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`.

### Sandbox build blocker (honest status)

A debug APK was **not** produced in the cloud sandbox. `./gradlew assembleDebug`
fails at task creation with:

```
Toolchain installation '/usr/lib/jvm/java-21-openjdk-amd64'
does not provide the required capabilities: [JAVA_COMPILER]
```

The sandbox has a JRE 21 only (no `javac`), no Android SDK, and no sudo.
The Gradle wrapper (8.11.1) and dependency resolution DO work — with a JDK
and `ANDROID_HOME` set, `bun run android:debug` is the complete path.

## Native integration

- **Back button** (`@capacitor/app`): one listener (module-flag guarded) in
  `src/lib/capacitor-bridge.ts` runs the shared policy `handleBackNative()`
  (topmost overlay → history detail → secondary tab → Home). On Home the app
  is **minimized, not exited** (`App.minimizeApp()`), deliberately keeping
  BLE monitoring alive while backgrounded. No edge-swipe interception —
  gesture navigation stays stock.
- **System bars** (`@capacitor/status-bar`): synced to the theme pair
  `#09090b` (dark) / `#f5f5f7` (light) from page.tsx's theme effect. The
  accent color never recolors the chrome (same rule as the web).
- **Splash** (`@capacitor/splash-screen`): launch splash on `#09090b`,
  auto-hide 800 ms + JS `hide()` safety net.
- **Edge-to-edge / safe areas**: `adjustMarginsForEdgeToEdge: 'auto'`;
  the web layer already uses `viewport-fit=cover` + safe-area insets.
- **Web-only APIs**: service worker, Web Bluetooth, beforeinstallprompt are
  all guarded — native execution never depends on them (Web Bluetooth is
  replaced by the native BLE plugin, see BLE docs).

## Next: native BLE + notifications

The Android BLE foreground service (`connectedDevice`), device association,
reconnection policy, and system notifications are documented in
`docs/BLE-ANDROID.md` (see Task 15-c/15-d in the worklog).
