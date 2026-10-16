'use client';

/* ═══════════════════════════════════════════════════════════════
   Haptic feedback – subtle tactile taps for a precision instrument
   ═══════════════════════════════════════════════════════════════
   Two engines, one API:

   • Native (Capacitor Android) — @capacitor/haptics, imported
     dynamically and only when window.Capacitor reports a native
     platform. Vibration patterns are mapped onto the plugin's
     LIGHT / MEDIUM / HEAVY impact styles (the plugin has no
     millisecond API, so total-pattern duration picks the style).
   • Web — navigator.vibrate() with the exact pattern.

   Both paths fail silently. `haptic()` NEVER pretends to vibrate:
   if the platform has no engine (desktop browsers without a
   vibration API) it simply does nothing, and no code may show a
   "vibration happened" state based on calling this function.

   The user gate (`enabled`) is settings.hapticsEnabled — checked
   by every caller BEFORE invoking haptic(). */

import { isNativeApp } from '@/lib/capacitor-bridge';

export function haptic(enabled: boolean, pattern: number | number[] = 8): void {
  if (!enabled) return;
  if (isNativeApp()) {
    void nativeImpact(pattern);
    return;
  }
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* vibration unsupported or blocked – silently ignore */
  }
}

/* ── Native engine (Capacitor Haptics) ── */

type CapHaptics = {
  impact: (opts: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }) => Promise<void>;
  selectionChanged?: () => Promise<void>;
};

let hapticsPluginPromise: Promise<CapHaptics | null> | null = null;

function loadHapticsPlugin(): Promise<CapHaptics | null> {
  if (!hapticsPluginPromise) {
    hapticsPluginPromise = (async () => {
      try {
        const mod = await import('@capacitor/haptics');
        /* Haptics is exported as a registered plugin instance (v7). */
        return mod.Haptics as unknown as CapHaptics;
      } catch {
        return null; // plugin unavailable — vibrate path already covered native too
      }
    })();
  }
  return hapticsPluginPromise;
}

/** Map a millisecond pattern onto the plugin's three impact styles. */
function impactStyleFor(pattern: number | number[]): 'LIGHT' | 'MEDIUM' | 'HEAVY' {
  const total = Array.isArray(pattern)
    ? pattern.reduce((a, b) => a + b, 0)
    : pattern;
  if (total <= 8) return 'LIGHT';
  if (total <= 16) return 'MEDIUM';
  return 'HEAVY';
}

async function nativeImpact(pattern: number | number[]): Promise<void> {
  const plugin = await loadHapticsPlugin();
  if (!plugin) {
    // Plugin missing but the Android WebView still exposes vibrate() in
    // some shells — try it once as a fallback, then give up quietly.
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
    return;
  }
  try {
    await plugin.impact({ style: impactStyleFor(pattern) });
  } catch {
    /* haptics unavailable on this device — silently ignore */
  }
}

/* ── Standard interaction taps ── */
export const HAPTIC_TAP = 8;              // nav switch, small selections
export const HAPTIC_SELECT = 6;           // grain / option selection
export const HAPTIC_TOGGLE = 10;          // toggles, destructive confirms
export const HAPTIC_TICK = 4;             // slider discrete-step tick (felt, not noticed)
export const HAPTIC_ALERT: number[] = [12, 70, 12]; // warning escalation
export const HAPTIC_CRITICAL: number[] = [16, 60, 16, 60, 24]; // critical escalation

/* ── Throttled slider ticker ────────────────────────────────────
   Precision sliders fire a tiny tick when the value crosses a
   discrete step — NOT on every pointer move and never per frame.
   The factory owns its own clock so two sliders never share a
   throttle window. The slider component additionally only calls
   the ticker when the committed value actually changed, so this
   interval is a belt-and-braces floor, not the main gate. */
export function createHapticTicker(
  enabled: boolean,
  intervalMs = 40,
): () => void {
  let last = -Infinity;
  return () => {
    if (!enabled) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - last < intervalMs) return;
    last = now;
    haptic(enabled, HAPTIC_TICK);
  };
}
