import type { CapacitorConfig } from '@capacitor/cli';

/* ═══════════════════════════════════════════════════════════════
   Capacitor 7 Android shell configuration — Mochi Grain
   ──────────────
   appId: com.mochigrain.app
     Reverse-DNS application id used for the Android package,
     Play Store listing and native storage namespaces. Chosen once
     and must never change after first release (Android treats a
     different appId as a different app).
   webDir: 'out'
     The static export produced by `bun run android:web`
     (MOCHI_TARGET=capacitor next build → output: 'export').
   server.androidScheme: 'https'
     The WebView serves the bundle from https://localhost so the
     app is a secure context: Web Bluetooth, service worker,
     IndexedDB and crypto APIs all work inside the APK.
   android.allowMixedContent: false
     Never load insecure http:// subresources inside the secure
     WebView (hardening; the bundle has no remote dependencies).
   android.adjustMarginsForEdgeToEdge: 'auto'
     Capacitor 7 edge-to-edge handling: on Android 15+ the WebView
     is drawn edge-to-edge and the bridge automatically applies
     safe-area margins unless the window opts out. 'auto' is the
     recommended value for Capacitor 7 apps (key verified in
     node_modules/@capacitor/cli/dist/declarations.d.ts,
     @since 7.1.0, default 'disable').
   plugins.SplashScreen / plugins.StatusBar
     Key names verified against the plugin definition files in
     node_modules/@capacitor/{splash-screen,status-bar}/dist/esm/
     definitions.d.ts (launchShowDuration, launchAutoHide,
     backgroundColor, showSpinner; style 'DARK'/'LIGHT',
     backgroundColor, overlaysWebView).
   ═══════════════════════════════════════════════════════════════ */

const config: CapacitorConfig = {
  appId: 'com.mochigrain.app',
  appName: 'Mochi Grain',
  webDir: 'out',

  server: {
    androidScheme: 'https',
  },

  android: {
    allowMixedContent: false,
    adjustMarginsForEdgeToEdge: 'auto',
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      launchAutoHide: true,
      backgroundColor: '#09090b',
      showSpinner: false,
    },
    StatusBar: {
      // 'DARK' = light text on dark bar (Capacitor Style.Dark).
      // The JS side also syncs this on theme change via
      // src/lib/capacitor-bridge.ts syncStatusBar().
      style: 'DARK',
      backgroundColor: '#09090b',
      overlaysWebView: false,
    },
  },
};

export default config;
