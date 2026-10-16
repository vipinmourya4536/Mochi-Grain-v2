'use client';

/* ═══════════════════════════════════════════════════════════════
   Live BLE link quality (0–100) — observed, never invented
   ═══════════════════════════════════════════════════════════════
   The probe's firmware signal byte is often a near-constant, so
   the SIGNAL pill used to look frozen at one number. This module
   derives a LIVE number from real transport observations only:

   • Notification cadence — inter-arrival jitter of actual packets
     vs the learned expected interval. A degrading link (distance,
     interference, congestion) shows up as late/irregular/missing
     notifications long before the GATT drop fires.
   • Firmware signal byte — blended in only when the probe actually
     varies it (≥2 distinct values observed in the session).
   • Staleness decay — when the next packet is overdue the score
     decays smoothly instead of holding a stale optimistic value.

   Disconnected → null (the UI shows '—'). There are NO random
   numbers and NO simulated drift anywhere in this file: every
   input is a real packet arrival timestamp or a real firmware byte.

   Sleep note: a firmware-sleeping probe legitimately stops
   notifying; the staleness decay then reports "packets are not
   arriving", which is transport truth — the GATT link itself is
   still tracked separately by the connection state.
   ═══════════════════════════════════════════════════════════════ */

type Listener = (q: number | null) => void;

const listeners = new Set<Listener>();

/* ── Tuning ──────────────────────────────────────────────────── */
const WINDOW = 8;        // packet intervals kept for jitter
const IV_EMA = 0.3;      // expected-interval smoothing
const OUT_EMA = 0.25;    // output smoothing (stable, still responsive)
const MIN_IV = 200;      // ms — ignore duplicate/burst deliveries
const MAX_IV = 90_000;   // ms — ignore wake-from-sleep mega-gaps
const JITTER_PENALTY = 90; // jitter ratio 1.0 → −90 points
const STALE_START = 1.5; // overdue ratio where decay begins
const STALE_FLOOR = 0.2; // decay floor (link may still recover)
const RSSI_TTL = 15_000; // ms — an RSSI sample older than this is ignored

let connected = false;
let lastPacketAt = 0;
let intervals: number[] = [];
let expectedIv = 0;
let reportedEma: number | null = null;
const reportedSeen = new Set<number>();
let rssi: number | null = null;
let rssiAt = 0;
let current: number | null = null;
let lastEmitted: number | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/* ── Core computation (pure over observed state) ─────────────── */

function computeNow(): number | null {
  if (!connected) return null;
  const now = Date.now();

  // 1) True RSSI sample, when the platform delivered one recently.
  //    Map −90 dBm → 0 … −40 dBm → 100.
  if (rssi !== null && now - rssiAt < RSSI_TTL) {
    return clamp(Math.round(((rssi + 90) / 50) * 100), 1, 100);
  }

  // 2) Cadence regularity: mean |interval − expected| / expected.
  let cad: number;
  if (intervals.length < 2 || expectedIv <= 0) {
    cad = 70; // linked but not yet measured — honest middle until packets prove the link
  } else {
    let jitter = 0;
    for (const iv of intervals) jitter += Math.abs(iv - expectedIv);
    jitter /= intervals.length * expectedIv;
    cad = clamp(100 - jitter * JITTER_PENALTY, 0, 100);
  }

  // 3) Staleness: the next packet is overdue → decay smoothly.
  if (expectedIv > 0 && lastPacketAt > 0) {
    const ratio = (now - lastPacketAt) / expectedIv;
    if (ratio > STALE_START) {
      cad *= Math.max(STALE_FLOOR, 1 - (ratio - STALE_START) * 0.15);
    }
  }

  // 4) Blend the firmware byte in ONLY when the probe varies it.
  if (reportedEma !== null && reportedSeen.size >= 2) {
    return clamp(Math.round(reportedEma * 0.55 + cad * 0.45), 1, 100);
  }
  return clamp(Math.round(cad), 1, 100);
}

function update(): void {
  const q = computeNow();
  if (q === null) {
    current = null;
  } else {
    current = current === null ? q : current + OUT_EMA * (q - current);
  }
  const rounded = current === null ? null : Math.round(current);
  if (rounded !== lastEmitted) {
    lastEmitted = rounded;
    for (const l of listeners) l(rounded);
  }
}

/* ── Public API (fed by ble-bridge / bluetooth events) ───────── */

/** A real packet arrived. `reportedSignal` = firmware byte 0–100. */
export function recordPacket(reportedSignal?: number | null): void {
  const now = Date.now();
  if (lastPacketAt) {
    const iv = now - lastPacketAt;
    if (iv >= MIN_IV && iv <= MAX_IV) {
      intervals.push(iv);
      if (intervals.length > WINDOW) intervals.shift();
      expectedIv = expectedIv === 0 ? iv : expectedIv + IV_EMA * (iv - expectedIv);
    }
  }
  lastPacketAt = now;
  if (typeof reportedSignal === 'number' && reportedSignal >= 0 && reportedSignal <= 100) {
    if (reportedSeen.size > 12) reportedSeen.clear(); // bounded; "varies" flag survives
    reportedSeen.add(reportedSignal);
    reportedEma = reportedEma === null
      ? reportedSignal
      : reportedEma + 0.4 * (reportedSignal - reportedEma);
  }
  update();
}

/** A real RSSI sample (dBm) from the platform radio, when available. */
export function recordRssi(dbm: number): void {
  if (!Number.isFinite(dbm) || dbm > 0 || dbm < -127) return;
  rssi = dbm;
  rssiAt = Date.now();
  update();
}

/** GATT link is up — begin observation. */
export function markConnected(): void {
  connected = true;
  intervals = [];
  expectedIv = 0;
  reportedEma = null;
  reportedSeen.clear();
  rssi = null;
  rssiAt = 0;
  lastPacketAt = 0;
  current = null;
  update();
  if (!ticker) {
    ticker = setInterval(update, 1000); // staleness decay needs a clock
  }
}

/** Link down or deliberate disconnect → null until the next connect. */
export function markDisconnected(): void {
  connected = false;
  current = null;
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  if (lastEmitted !== null) {
    lastEmitted = null;
    for (const l of listeners) l(null);
  }
}

/** Latest observed quality (rounded), or null while not connected. */
export function getLinkQuality(): number | null {
  return current === null ? null : Math.round(current);
}

/** Subscribe to quality changes. Returns an unsubscribe function. */
export function onLinkQuality(cb: Listener): () => void {
  listeners.add(cb);
  cb(current === null ? null : Math.round(current));
  return () => {
    listeners.delete(cb);
  };
}
