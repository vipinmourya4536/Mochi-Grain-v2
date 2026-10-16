'use client';

/* ═══════════════════════════════════════════════════════════════
   Capacitor native-shell bridge — Mochi Grain Android wrapper
   ═══════════════════════════════════════════════════════════════
   Every native capability is wired here so the web PWA behaves
   EXACTLY as before: all plugin modules are imported dynamically
   (await import inside the call path) and every entry point early-
   exits on the web. The ONLY static import is a type-only one
   (erased at build time) and the app's own back-nav policy.

   Detection strategy
   ──────────────────
   `@capacitor/core` is NEVER imported at runtime. Inside the
   Capacitor Android WebView the native bridge injects the global
   `window.Capacitor` (with isNativePlatform()) before any app JS
   executes; in a plain browser that global does not exist because
   nothing in the bundle statically imports the core module. So a
   synchronous, dependency-free `isNativeApp()` reads the global.

   Android Back policy
   ───────────────────
   ONE hardware Back listener is registered (module-flag guarded
   against double registration). Each press runs the SHARED
   back-navigation policy (src/lib/back-nav.ts → handleBackNative):
   topmost overlay → history detail → secondary tab → Home. When
   the policy reports false (Home, no overlays), the app is
   MINIMIZED, not exited: `App.minimizeApp()` backgrounds the
   process so BLE monitoring, IndexedDB writes and the WebView
   state all stay alive — deliberately background-not-exit,
   matching how a native monitor app behaves. (exitApp would kill
   the BLE session mid-measurement.)

   Status bar / splash
   ───────────────────
   syncStatusBar(isDark) mirrors the web theme-color sync: the
   Android system bar follows the app's neutral chrome pair
   (#09090b dark / #f5f5f7 light) — the accent color must never
   recolor it. SplashScreen.hide() is a safety net on top of the
   config's launchAutoHide (800 ms). */

import type { PluginListenerHandle } from '@capacitor/core';
import { handleBackNative } from '@/lib/back-nav';

/** Neutral system-chrome pair — MUST stay identical to THEME_CHROME
 *  in src/app/page.tsx (theme-color meta) and the splash config. */
const CHROME_DARK = '#09090b';
const CHROME_LIGHT = '#f5f5f7';

/* ── Module state ── */

let backHandle: PluginListenerHandle | null = null;
/** Double-registration guard for the ONE hardware Back listener. */
let nativeShellActive = false;
let splashHidden = false;

/* ── Detection ── */

/**
 * True only inside a native Capacitor container. Reads the
 * bridge-injected `window.Capacitor` global (see header) — zero
 * imports, synchronous, safe during SSR (returns false).
 */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
}

/* ── Back button ── */

/**
 * Initialize the native shell. No-op on the web (returns a no-op
 * cleanup). On native:
 *   1. registers the single hardware Back listener,
 *   2. schedules the splash-screen hide for first mount.
 *
 * `cleanupReg` (optional) receives the cleanup so it can be
 * collected alongside other effect cleanups; the cleanup is ALSO
 * returned, so the caller can `return initNativeShell(...)` from a
 * React effect exactly like `initBackNav`. If the effect unmounts
 * before the async listener attach finishes, the pending listener
 * is removed as soon as it resolves (race-safe).
 *
 * Returns: cleanup that removes the Back listener and resets the
 * module guard.
 */
export function initNativeShell(
  cleanupReg?: (cleanup: () => void) => void
): () => void {
  if (!isNativeApp()) return () => {};
  if (nativeShellActive) return () => {}; // already registered
  nativeShellActive = true;

  let disposed = false;
  const cleanup = (): void => {
    disposed = true;
    nativeShellActive = false;
    if (backHandle) {
      void backHandle.remove().catch(() => {});
      backHandle = null;
    }
  };
  cleanupReg?.(cleanup);

  /* 1 — ONE hardware Back listener for the whole app. */
  void (async () => {
    try {
      const { App } = await import('@capacitor/app');
      if (disposed) return; // unmounted while importing
      const handle = await App.addListener('backButton', () => {
        // Shared policy: overlay → history detail → secondary tab → Home.
        // false ⇒ Home with nothing interceptable ⇒ minimize (background,
        // never exit — keeps BLE monitoring + WebView state alive).
        const handled = handleBackNative();
        if (!handled) void App.minimizeApp();
      });
      if (disposed) {
        void handle.remove().catch(() => {});
        return;
      }
      backHandle = handle;
    } catch {
      nativeShellActive = false; // allow a later retry
    }
  })();

  /* 2 — Hide the launch splash at first mount (after window load,
     or immediately if already loaded). launchAutoHide:true in
     capacitor.config.ts handles the normal case; this is the belt-
     and-braces path if the auto-hide is disabled or late. */
  if (!splashHidden) {
    if (document.readyState === 'complete') {
      hideSplashOnce();
    } else {
      window.addEventListener('load', () => hideSplashOnce(), { once: true });
    }
  }

  return cleanup;
}

async function hideSplashOnce(): Promise<void> {
  if (splashHidden) return;
  splashHidden = true;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 250 });
  } catch {
    // Plugin unavailable — config launchAutoHide already covers it.
  }
}

/* ── Status bar ── */

/**
 * Mirror the app's dark/light theme onto the Android system bar.
 * Called from the theme effect in page.tsx; no-op on the web.
 * Style.Dark = light text for dark backgrounds (Capacitor naming).
 */
export function syncStatusBar(isDark: boolean): void {
  if (!isNativeApp()) return;
  void (async () => {
    try {
      const [{ StatusBar, Style }] = await Promise.all([import('@capacitor/status-bar')]);
      await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
      await StatusBar.setBackgroundColor({ color: isDark ? CHROME_DARK : CHROME_LIGHT });
    } catch {
      // Never let a system-bar sync break the app.
    }
  })();
}
