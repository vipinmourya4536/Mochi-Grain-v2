/* ═══════════════════════════════════════════════════════════════
   Native alert-rule mirror — banding + dedup/cooldown decision table
   ═══════════════════════════════════════════════════════════════
   These are the SAME rules the Android notification engine runs in
   NotificationHelper.java (Java mirror, hand-synced — there is no
   JVM/JDK in the sandbox to run it; any constant change must be
   re-applied in BOTH files).

   Validated here (bun test): band() boundaries, temperature
   independence, cross-grain thresholds, max-of-two escalation,
   signature changes, escalation bypass and the cooldown windows.

   Constants (MUST equal NotificationHelper.java):
     COOLDOWN_WARNING_MS   = 30 min
     COOLDOWN_CRITICAL_MS  = 15 min
     RECOVERY_MIN_GAP_MS   = 60 min
     BATTERY_LOW_PCT       = 15
     BATTERY_ALERT_INTERVAL_MS = 12 h
   ═══════════════════════════════════════════════════════════════ */

import { describe, expect, it } from 'bun:test';

const COOLDOWN_WARNING_MS = 30 * 60_000;
const COOLDOWN_CRITICAL_MS = 15 * 60_000;
const RECOVERY_MIN_GAP_MS = 60 * 60_000;

/** v <= safe → 0 (safe); v <= warn → 1 (warning); else 2 (critical). */
function band(v: number, safe: number, warn: number): 0 | 1 | 2 {
  if (v <= safe) return 0;
  if (v <= warn) return 1;
  return 2;
}

/** Severity = max(moisture band, temperature band). */
function resolveSeverity(m: 0 | 1 | 2, t: 0 | 1 | 2): 0 | 1 | 2 {
  return Math.max(m, t) as 0 | 1 | 2;
}

/** Which metric drove the alert — ties resolve to moisture (deterministic). */
function driver(m: 0 | 1 | 2, t: 0 | 1 | 2): 'moisture' | 'temperature' {
  return m >= t ? 'moisture' : 'temperature';
}

/** Dedup/cooldown decision for one alert evaluation (mirrors Java). */
function shouldFire(input: {
  prevSev: 0 | 1 | 2;
  prevSignature: string | null;
  lastAlertAt: number;
  now: number;
  severity: 0 | 1 | 2;
  signature: string;
}): boolean {
  const { prevSev, prevSignature, lastAlertAt, now, severity, signature } = input;
  if (prevSev <= 0) return true; // first alert
  if (severity > prevSev) return true; // genuine escalation bypasses cooldown
  if (signature !== prevSignature) return true; // signature change
  const cooldown = severity === 1 ? COOLDOWN_WARNING_MS : COOLDOWN_CRITICAL_MS;
  return now - lastAlertAt >= cooldown;
}

/** Recovery: fired only for 1|2 → 0 transitions, ≥60 min apart. */
function shouldFireRecovery(input: {
  prevSev: 0 | 1 | 2;
  lastRecoveryAt: number;
  now: number;
}): boolean {
  const hadAlert = input.prevSev === 1 || input.prevSev === 2;
  if (!hadAlert) return false;
  return input.lastRecoveryAt === 0
    || input.now - input.lastRecoveryAt >= RECOVERY_MIN_GAP_MS;
}

describe('native rules — band()', () => {
  // Cross-grain thresholds from GRAIN_PROFILES (grain-types.ts).
  const WHEAT = { safe: 13.0, warn: 15.0 };
  const SOYBEAN = { safe: 12.0, warn: 14.0 };
  const CORN = { safe: 14.0, warn: 15.5 };

  it('v == safe → 0 (boundary equal-to-threshold)', () => {
    expect(band(13.0, WHEAT.safe, WHEAT.warn)).toBe(0);
  });

  it('v = safe + 0.1 → 1 (just above)', () => {
    expect(band(13.1, WHEAT.safe, WHEAT.warn)).toBe(1);
  });

  it('v == warn → 1 (boundary equal-to-threshold)', () => {
    expect(band(15.0, WHEAT.safe, WHEAT.warn)).toBe(1);
  });

  it('v = warn + 0.1 → 2 (just above)', () => {
    expect(band(15.1, WHEAT.safe, WHEAT.warn)).toBe(2);
  });

  it('deep critical → 2', () => {
    expect(band(19.9, WHEAT.safe, WHEAT.warn)).toBe(2);
  });

  it('temperature banding mirrors the same band() with temp thresholds', () => {
    // Wheat tempSafe 30 / tempWarn 33
    expect(band(30.0, 30, 33)).toBe(0);
    expect(band(30.1, 30, 33)).toBe(1);
    expect(band(33.0, 30, 33)).toBe(1);
    expect(band(33.1, 30, 33)).toBe(2);
  });

  it('moisture and temperature bands are independent (cross-grain)', () => {
    // Soybean moisture safe at 12.0 — 12.5 is already warning there,
    // while wheat would still call 12.5 safe.
    expect(band(12.5, SOYBEAN.safe, SOYBEAN.warn)).toBe(1);
    expect(band(12.5, WHEAT.safe, WHEAT.warn)).toBe(0);
    // Corn safe 14.0 / warn 15.5: 13.5 is warning for wheat, safe for corn;
    // 15.4 is critical for wheat, still only warning for corn.
    expect(band(13.5, WHEAT.safe, WHEAT.warn)).toBe(1);
    expect(band(13.5, CORN.safe, CORN.warn)).toBe(0);
    expect(band(15.4, WHEAT.safe, WHEAT.warn)).toBe(2);
    expect(band(15.4, CORN.safe, CORN.warn)).toBe(1);
  });
});

describe('native rules — resolveSeverity (max of two)', () => {
  it('max-of-two: moisture safe + temperature critical → 2', () => {
    expect(resolveSeverity(0, 2)).toBe(2);
  });

  it('max-of-two: moisture warning + temperature safe → 1', () => {
    expect(resolveSeverity(1, 0)).toBe(1);
  });

  it('both safe → 0', () => {
    expect(resolveSeverity(0, 0)).toBe(0);
  });

  it('both critical → 2', () => {
    expect(resolveSeverity(2, 2)).toBe(2);
  });

  it('temperature independence: hot but dry grain still escalates', () => {
    // moisture 12 (safe), temp 34.2 (critical for wheat 30/33)
    const m = band(12.0, 13, 15);
    const t = band(34.2, 30, 33);
    expect(resolveSeverity(m, t)).toBe(2);
    expect(driver(m, t)).toBe('temperature');
  });
});

describe('native rules — dedup / cooldown decision table', () => {
  const NOW = 1_800_000_000_000;

  it('first alert (prev 0) always fires', () => {
    expect(shouldFire({
      prevSev: 0, prevSignature: null, lastAlertAt: 0, now: NOW,
      severity: 1, signature: '1:moisture',
    })).toBe(true);
  });

  it('same warning signature within 30 min cooldown is suppressed', () => {
    expect(shouldFire({
      prevSev: 1, prevSignature: '1:moisture', lastAlertAt: NOW - 29 * 60_000, now: NOW,
      severity: 1, signature: '1:moisture',
    })).toBe(false);
  });

  it('same warning signature after 30 min cooldown fires again', () => {
    expect(shouldFire({
      prevSev: 1, prevSignature: '1:moisture', lastAlertAt: NOW - 31 * 60_000, now: NOW,
      severity: 1, signature: '1:moisture',
    })).toBe(true);
  });

  it('same critical signature within 15 min cooldown is suppressed', () => {
    expect(shouldFire({
      prevSev: 2, prevSignature: '2:temperature', lastAlertAt: NOW - 14 * 60_000, now: NOW,
      severity: 2, signature: '2:temperature',
    })).toBe(false);
  });

  it('1→2 escalation fires IMMEDIATELY, bypassing the cooldown', () => {
    expect(shouldFire({
      prevSev: 1, prevSignature: '1:moisture', lastAlertAt: NOW - 5_000, now: NOW,
      severity: 2, signature: '2:moisture',
    })).toBe(true);
  });

  it('signature change (moisture → temperature driver) fires', () => {
    expect(shouldFire({
      prevSev: 1, prevSignature: '1:moisture', lastAlertAt: NOW - 5_000, now: NOW,
      severity: 1, signature: '1:temperature',
    })).toBe(true);
  });

  it('de-escalation 2→1 with changed signature fires (warning)', () => {
    expect(shouldFire({
      prevSev: 2, prevSignature: '2:moisture', lastAlertAt: NOW - 5_000, now: NOW,
      severity: 1, signature: '1:moisture',
    })).toBe(true);
  });
});

describe('native rules — recovery notes', () => {
  const NOW = 1_800_000_000_000;

  it('1 → 0 fires ONE recovery note', () => {
    expect(shouldFireRecovery({ prevSev: 1, lastRecoveryAt: 0, now: NOW })).toBe(true);
  });

  it('2 → 0 fires a recovery note', () => {
    expect(shouldFireRecovery({ prevSev: 2, lastRecoveryAt: 0, now: NOW })).toBe(true);
  });

  it('second recovery within 60 min is suppressed (no safe-announcement storm)', () => {
    expect(shouldFireRecovery({
      prevSev: 1, lastRecoveryAt: NOW - 59 * 60_000, now: NOW,
    })).toBe(false);
  });

  it('recovery after ≥60 min gap fires again', () => {
    expect(shouldFireRecovery({
      prevSev: 2, lastRecoveryAt: NOW - 61 * 60_000, now: NOW,
    })).toBe(true);
  });

  it('0 → 0 never announces anything', () => {
    expect(shouldFireRecovery({ prevSev: 0, lastRecoveryAt: 0, now: NOW })).toBe(false);
  });
});
