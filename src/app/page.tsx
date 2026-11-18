'use client';

import { useEffect, useRef, useMemo, useCallback } from 'react';
import { useGrainStore } from '@/lib/grain-store';
import { Header } from '@/components/grain/header';
import { BottomNav } from '@/components/grain/bottom-nav';
import { Toast } from '@/components/grain/toast';
import { DisconnectedView } from '@/components/grain/home/disconnected-view';
import { ConnectingView } from '@/components/grain/home/connecting-view';
import { ConnectedView } from '@/components/grain/home/connected-view';
import { BtOffHero } from '@/components/grain/home/bt-off-hero';
import { SleepingView, LowBatteryView, SyncingView } from '@/components/grain/home/special-states';
import { DiscoverTab } from '@/components/grain/discover/discover-tab';
import { HistoryTab } from '@/components/grain/history/history-tab';
import { SettingsTab } from '@/components/grain/settings/settings-tab';
import type { AppLanguage } from '@/lib/i18n';
import { primeAlertSound } from '@/lib/alert-sound';
import { initBackNav, syncBackNav } from '@/lib/back-nav';
import { computeGlassVars } from '@/lib/glass';
import { registerServiceWorker, useSwUpdate } from '@/lib/sw-registration';
import { initNativeShell, syncStatusBar } from '@/lib/capacitor-bridge';
import { ConnectivityRibbon } from '@/components/grain/connectivity-ribbon';
import { t } from '@/lib/i18n';

const LANG_MAP: Record<string, string> = {
  en: 'en', hi: 'hi', mr: 'mr', hinglish: 'en',
};

/**
 * System chrome color — driven by the DARK/LIGHT THEME only, never by the
 * accent color. The accent palette is confined to interactive controls,
 * the active nav item, slider thumbs and deliberate highlights; it must
 * never recolor the Android status bar or the top shell.
 *
 * Native shell note: when the app is wrapped in Capacitor, this same
 * neutral pair must be fed to the Android system-bar plugin
 * (@capacitor/status-bar setBackgroundColor + setStyle(Style.Dark/Light))
 * on theme change — changing the HTML meta alone does not repaint the
 * native bar inside the wrapper.
 */
const THEME_CHROME = {
  dark: '#09090b',  // near-black neutral — same family as the app background
  light: '#f5f5f7', // subtle off-white neutral
} as const;

function computeThemeColor(isDark: boolean): string {
  return isDark ? THEME_CHROME.dark : THEME_CHROME.light;
}

export default function GrainMonitorPage() {
  /* Selector-based subscription (zustand v5) — the page shell re-renders
     ONLY when fields it actually renders change (tab, connection state,
     risk theme, settings, BT availability). A live BLE packet no longer
     re-renders the whole page tree (Header/Nav/Toast + tab children);
     ConnectedView subscribes to the reading itself. `hasReading` is a
     BOOLEAN selector so per-packet Reading object churn cannot re-render. */
  const activeTab = useGrainStore((s) => s.activeTab);
  const deviceState = useGrainStore((s) => s.deviceState);
  const riskTheme = useGrainStore((s) => s.riskTheme);
  const hasReading = useGrainStore((s) => s.currentReading !== null);
  const settings = useGrainStore((s) => s.settings);
  const btAvailable = useGrainStore((s) => s.btAvailable);
  const loadSettings = useGrainStore((s) => s.loadSettings);
  const loadHistory = useGrainStore((s) => s.loadHistory);
  const setBtAvailable = useGrainStore((s) => s.setBtAvailable);
  const restoreNativeSession = useGrainStore((s) => s.restoreNativeSession);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isDark = settings.theme === 'dark';

  const glassStyle = useMemo(
    () => computeGlassVars(isDark, settings.glassOpacity),
    [isDark, settings.glassOpacity]
  );

  // Sync body background with theme to prevent black/white bar.
  // On native (Capacitor) also repaint the Android system bar with the
  // same neutral chrome pair — no-op on the web.
  useEffect(() => {
    document.body.style.background = isDark ? '#09090b' : '#f5f5f7';
    syncStatusBar(isDark);
  }, [isDark]);

  /* ── Offline layer + native shell ──
   * Registers /sw.js once. After the first visit the app shell, bundles
   * and icons are cached: Home / History / Settings and the Mochi engine
   * cold-start with no internet (all data lives in IndexedDB). A new
   * deployed version is surfaced as a user-approved banner — never an
   * auto-reload — and SW version bumps never touch IndexedDB.
   *
   * Capacitor shell: inside the Android APK the same effect wires the
   * hardware Back listener + splash hide (initNativeShell). On the web
   * it is a no-op — every plugin call is dynamically imported and
   * guarded by Capacitor.isNativePlatform(), so browser behavior is
   * 100% unchanged. The bundled sw.js is harmless inside the WebView
   * (same-origin https://localhost, bundle versions always match). */
  useEffect(() => {
    registerServiceWorker();
    restoreNativeSession(); // native only — re-attach to a live service session (web no-op)
    return initNativeShell();
  }, []);

  const { updateReady, applyUpdate } = useSwUpdate();

  // Prime the alert-sound AudioContext on the first user gesture so browser
  // autoplay policies never block the warning/critical chimes later.
  useEffect(() => {
    const prime = () => primeAlertSound();
    window.addEventListener('pointerdown', prime, { once: true, passive: true });
    window.addEventListener('keydown', prime, { once: true });
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, []);

  // Sync <meta name="theme-color"> with the DARK/LIGHT THEME only.
  // Replaces any SSR media-scoped metas with one plain meta so the
  // PWA/Android system bar always matches the app's neutral shell.
  useEffect(() => {
    const color = computeThemeColor(isDark);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    document.head.appendChild(meta);
  }, [isDark]);

  // Sync html lang attribute with language
  useEffect(() => {
    const htmlLang = LANG_MAP[settings.language] || 'en';
    document.documentElement.lang = htmlLang;
  }, [settings.language]);

  // Check Bluetooth availability on mount (no gate, just sets store state for BtOffHero)
  const checkBT = useCallback(async () => {
    if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
      setBtAvailable(true); // no Web Bluetooth API → allow app
      return;
    }
    const bt = navigator.bluetooth as Bluetooth & { getAvailability?: () => Promise<boolean> };
    if (typeof bt.getAvailability === 'function') {
      try { setBtAvailable(await bt.getAvailability()); } catch { setBtAvailable(true); }
    } else {
      setBtAvailable(true);
    }
  }, [setBtAvailable]);

  useEffect(() => {
    loadSettings();
    loadHistory();
    checkBT();

    // Listen for BT adapter state changes
    if (typeof navigator !== 'undefined' && 'bluetooth' in navigator) {
      const btNav = navigator.bluetooth as Bluetooth & {
        addEventListener?: (e: string, h: () => void) => void;
        removeEventListener?: (e: string, h: () => void) => void;
      };
      const handler = () => { checkBT(); };
      if (btNav.addEventListener) btNav.addEventListener('availabilitychanged', handler);
      return () => { if (btNav.removeEventListener) btNav.removeEventListener('availabilitychanged', handler); };
    }
  }, [checkBT]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeTab]);

  /* ── Android Back / PWA popstate policy ──
   * One synthetic history entry is armed while a secondary tab is open.
   * System Back pops it → the policy closes the topmost overlay (registered
   * by the overlay components) or falls back: history detail view → Home.
   * On Home nothing is armed, so Back exits the app normally. The same
   * policy object is reusable by a future Capacitor native Back listener
   * (handleBackNative). */
  useEffect(() => {
    return initBackNav({
      consumeFallback: () => {
        const s = useGrainStore.getState();
        if (s.selectedHistoryEntry) {
          s.setSelectedHistoryId(null); // close the detail view first
          return true;
        }
        if (s.activeTab !== 'home') {
          s.setActiveTab('home');
          return true;
        }
        return false; // Home + no overlays → let the OS exit
      },
      isInterceptable: () => useGrainStore.getState().activeTab !== 'home',
    });
  }, []);

  // Re-arm/disarm whenever the active tab changes (never accumulates entries)
  useEffect(() => {
    syncBackNav();
  }, [activeTab]);

  const renderHomeState = () => {
    // When BT is off, show BT prompt in the hero card area
    if (btAvailable === false) return <BtOffHero />;
    if (hasReading) return <ConnectedView />;
    switch (deviceState) {
      case 'disconnected': return <DisconnectedView />;
      case 'connecting': return <ConnectingView />;
      case 'syncing': return <SyncingView />;
      case 'sleeping': return <SleepingView />;
      case 'low-battery': return <LowBatteryView />;
      default: return <DisconnectedView />;
    }
  };

  return (
    <div
      className="grain-app"
      data-grain-theme={riskTheme}
      data-accent={settings.accentColor}
      data-theme={settings.theme}
      style={glassStyle}
    >
      <Header />
      <Toast />
      <main className="grain-scroll" ref={scrollRef}>
        {/* Internet state ribbon — BLE/device states are separate (Home hero).
            Lives inside the scroll content because the header is a floating
            frost layer that content flows underneath. */}
        <ConnectivityRibbon />
        {updateReady && (
          <div className="grain-update-banner" role="status">
            <span className="grain-update-dot" aria-hidden="true" />
            <span className="grain-update-label">{t('update.available', settings.language as AppLanguage)}</span>
            <button
              type="button"
              className="grain-update-btn"
              onClick={applyUpdate}
            >
              {t('update.reload', settings.language as AppLanguage)}
            </button>
          </div>
        )}
        {/* key={activeTab} retriggers the subtle 220ms enter transition on tab switch */}
        <div key={activeTab} className="grain-tab-enter">
          {activeTab === 'home' && renderHomeState()}
          {activeTab === 'discover' && <DiscoverTab />}
          {activeTab === 'history' && <HistoryTab />}
          {activeTab === 'settings' && <SettingsTab />}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
