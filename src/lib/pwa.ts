'use client';

/* ═══════════════════════════════════════════════════════════════
   PWA helpers – install prompt capture + connectivity status
   ═══════════════════════════════════════════════════════════════ */

import { useEffect, useState, useCallback } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Captured across hook instances so the prompt survives tab switches */
let deferredPrompt: BeforeInstallPromptEvent | null = null;

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/**
 * Install-flow state machine:
 * - `canInstall` true after the browser fires `beforeinstallprompt`
 * - `isStandalone` true when already running as an installed app
 * - `promptInstall()` triggers the native install sheet
 */
export function usePwaInstall() {
  const [canInstall, setCanInstall] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const standalone =
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches) ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setIsStandalone(standalone);

    const onBip = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onInstalled = () => {
      deferredPrompt = null;
      setCanInstall(false);
      setIsStandalone(true);
    };

    window.addEventListener('beforeinstallprompt', onBip);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<InstallOutcome> => {
    if (!deferredPrompt) return 'unavailable';
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      return outcome;
    } catch {
      return 'unavailable';
    } finally {
      deferredPrompt = null;
      setCanInstall(false);
    }
  }, []);

  return { canInstall, isStandalone, promptInstall };
}

/** Live navigator.onLine status (reactive to online/offline events) */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    // Defer the initial sync out of the effect body (avoids cascading render)
    const initId = setTimeout(() => setOnline(navigator.onLine), 0);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      clearTimeout(initId);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}

/* ── Network quality ──
 * Honest weak-link detection: only the OS-reported Network Information API
 * (Chromium/Android) is used. When the browser doesn't expose it, the hook
 * reports `unknown` — we never guess or fake a "weak" state. This describes
 * INTERNET quality only; BLE probe quality is a separate radio path and is
 * reported by the device/signal UI, never from here. */
export type NetworkQuality = 'unknown' | 'strong' | 'moderate' | 'weak';

interface NetworkInformationLike extends EventTarget {
  effectiveType?: string; // 'slow-2g' | '2g' | '3g' | '4g'
  rtt?: number; // ms
  saveData?: boolean;
}

function classifyConnection(conn: NetworkInformationLike | undefined): NetworkQuality {
  if (!conn || typeof conn.effectiveType !== 'string') return 'unknown';
  // saveData = user asked the browser to be frugal → treat as constrained
  if (conn.saveData) return 'weak';
  if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return 'weak';
  // rtt is a moving OS estimate; a very high rtt even on "4g" is a weak link
  if (typeof conn.rtt === 'number' && conn.rtt > 1400) return 'weak';
  if (conn.effectiveType === '3g') return 'moderate';
  return 'strong';
}

export interface NetworkStatus {
  online: boolean;
  quality: NetworkQuality;
}

/** Internet connectivity + quality in one hook (offline / weak / strong) */
export function useNetworkStatus(): NetworkStatus {
  const online = useOnlineStatus();
  const [quality, setQuality] = useState<NetworkQuality>(() => {
    // Lazy initializer avoids a synchronous setState inside the effect.
    // SSR and pre-effect clients default to 'unknown'; the effect syncs.
    if (typeof navigator === 'undefined') return 'unknown';
    const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    return classifyConnection(conn);
  });

  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    if (!conn) return;
    // Defer out of the effect body (consistent with useOnlineStatus)
    const initId = setTimeout(() => setQuality(classifyConnection(conn)), 0);
    const onChange = () => setQuality(classifyConnection(conn));
    conn.addEventListener('change', onChange);
    return () => {
      clearTimeout(initId);
      conn.removeEventListener('change', onChange);
    };
  }, []);

  return { online, quality };
}
