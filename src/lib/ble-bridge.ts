'use client';

/* ═══════════════════════════════════════════════════════════════
   Native-first BLE bridge — Mochi Grain probe connectivity
   ═══════════════════════════════════════════════════════════════
   Swaps in front of ./bluetooth with the SAME exported API that
   grain-store consumes (requestDevice, connect, reconnect,
   onReading, onDisconnected, disconnect, sendCommand) plus native
   extras (setNativeMonitoringConfig, initNativeSession).

   Routing
   ───────
   WEB  → every call delegates to ./bluetooth: zero behavior change
          (Web Bluetooth requestDevice/chooser, GATT notifications,
          single notifyHandler semantics).
   NATIVE → the Capacitor plugin "MochiBle" (BlePlugin.java):
          requestDevice() → MochiBle.associate() — runtime Bluetooth
            permissions, then a bounded 12s scan and a USER SELECTION
            AlertDialog (the authorization moment, equivalent of the
            requestDevice chooser). If the user cancels/none chosen,
            an EXISTING association is used as fallback instead of
            failing — reconnects never re-open a chooser.
          connect() → MochiBle.connect() (foreground service takes
            ownership) then MochiBle.startMonitoring() with the
            settings snapshot pushed by grain-store via
            setNativeMonitoringConfig() BEFORE connect.
          reconnect() → MochiBle.connect() again (fresh bounded retry
            cycle inside GrainBleManager; config already persisted).
          onReading/onDisconnected → addListener('grainReading' |
            'grainConnection') with payloads mapped into Reading.

   Detection is identical to capacitor-bridge.ts: a synchronous read
   of the bridge-injected window.Capacitor global. @capacitor/core
   is NEVER statically imported — dynamic import only, so the web
   bundle stays clean. (The single type-only import is erased.)

   NO FABRICATED DATA: native payloads missing moisture/temperature/
   timestamp/deviceId are dropped, not patched. Battery/signal are
   null on DeviceInfo until a real packet arrives (same as web).
   */

import type { PluginListenerHandle } from '@capacitor/core';
import type { Reading, DeviceInfo, GrainType } from './grain-types';
import { GRAIN_OPTIONS } from './grain-types';
import * as webBle from './bluetooth';
import { isNativeApp } from './capacitor-bridge';
import {
  recordPacket as lqRecordPacket,
  markConnected as lqMarkConnected,
  markDisconnected as lqMarkDisconnected,
} from './link-quality';

/* ── Native config snapshot (pushed by grain-store before connect) ── */

/** Mirrors the monitoringConfig snapshot persisted by BlePlugin
 *  (threshold fields optional — the native rule engine skips
 *  moisture/temperature alerts when a field is missing; it never
 *  invents thresholds). */
export interface NativeMonitoringConfig {
  grainType?: string;
  moistureSafeMax?: number;
  moistureWarnMax?: number;
  tempSafeMax?: number;
  tempWarnMax?: number;
  pushAlerts?: boolean;
  language?: string;
  monitoringEnabled?: boolean;
}

let nativeConfig: NativeMonitoringConfig | null = null;

/** Called by grain-store.connectProbe on native, right before connect. */
export function setNativeMonitoringConfig(cfg: NativeMonitoringConfig): void {
  nativeConfig = { ...cfg };
}

/* ── Plugin typing (dynamic import — no static @capacitor/core) ──── */

interface NativeReadingPayload {
  id?: string;
  deviceId?: string;
  ts?: number;
  receivedAt?: number;
  moisture?: number;
  temperature?: number;
  battery?: number;
  signal?: number;
  status?: number;
  deviceGrain?: string | null;
}

interface NativeAssociation {
  address?: string;
  name?: string;
}

interface NativeStatus {
  association?: NativeAssociation | null;
  connectionState?: string;
  lastError?: string | null;
  lastPacketAt?: number;
  lastValidReading?: NativeReadingPayload | null;
  pendingTap?: string | null;
  monitoringEnabled?: boolean;
}

interface MochiBlePlugin {
  associate(): Promise<{ id: string; name: string }>;
  forget(): Promise<void>;
  connect(): Promise<{ connected: boolean; error?: string }>;
  disconnect(): Promise<void>;
  sendCommand(opts: { cmd: string }): Promise<{ sent: boolean }>;
  startMonitoring(opts: { settings: NativeMonitoringConfig }): Promise<void>;
  stopMonitoring(): Promise<void>;
  getStatus(): Promise<NativeStatus>;
  drainPendingReadings(): Promise<{ readings?: NativeReadingPayload[] }>;
  consumePendingTap(): Promise<{ tab?: string | null }>;
  addListener(
    eventName: 'grainReading',
    cb: (data: NativeReadingPayload) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'grainConnection',
    cb: (data: { state: string; reason?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

/* ── Detection + plugin access ───────────────────────────────────── */

let pluginPromise: Promise<MochiBlePlugin | null> | null = null;

async function getNative(): Promise<MochiBlePlugin | null> {
  if (!isNativeApp()) return null;
  if (!pluginPromise) {
    pluginPromise = (async () => {
      try {
        const core = await import('@capacitor/core');
        // registerPlugin caches instances — repeated calls are safe.
        return core.registerPlugin<MochiBlePlugin>('MochiBle');
      } catch {
        return null;
      }
    })();
  }
  return pluginPromise;
}

/* ── Payload → Reading mapping (strict — drops malformed) ────────── */

const STATUS_MAP: Record<number, Reading['deviceStatus']> = {
  0: 'connected', 1: 'syncing', 2: 'sleeping', 3: 'low-battery', 4: 'awake',
};

function isGrainType(v: string): v is GrainType {
  return (GRAIN_OPTIONS as string[]).includes(v);
}

function mapReading(p: NativeReadingPayload): Reading | null {
  const ts = typeof p.ts === 'number' && p.ts > 0
    ? p.ts
    : (typeof p.receivedAt === 'number' && p.receivedAt > 0 ? p.receivedAt : 0);
  const deviceId = typeof p.deviceId === 'string' ? p.deviceId : '';
  const moisture = typeof p.moisture === 'number' ? p.moisture : NaN;
  const temperature = typeof p.temperature === 'number' ? p.temperature : NaN;
  // Sanity mirrors the native parse (never emit what was never received).
  if (!ts || !deviceId
    || !Number.isFinite(moisture) || moisture < 0 || moisture > 100
    || !Number.isFinite(temperature) || temperature < -20 || temperature > 85) {
    return null;
  }
  const deviceGrain = p.deviceGrain && isGrainType(p.deviceGrain)
    ? p.deviceGrain
    : undefined;
  return {
    // Deterministic id (mac-timestampMs) → IndexedDB put() dedupes replays.
    id: typeof p.id === 'string' && p.id ? p.id : `${deviceId}-${ts}`,
    deviceId,
    grainType: 'wheat', // placeholder — the store normalizes to settings.grainType
    deviceGrain, // diagnostic metadata from firmware (optional)
    moisture,
    temperature,
    battery: typeof p.battery === 'number' ? p.battery : 0,
    timestamp: ts,
    signal: typeof p.signal === 'number' ? p.signal : 0,
    deviceStatus: STATUS_MAP[p.status ?? 0] ?? 'connected',
  };
}

function assocToDevice(assoc: { id: string; name?: string }): DeviceInfo {
  return {
    id: assoc.id,
    name: assoc.name || 'GRAIN-01',
    // No firmware version is reported by the native link — honest 'unknown'
    // (the web path reports the firmware constant from bluetooth.ts).
    firmware: 'unknown',
    platform: 'ESP32',
    grainType: 'wheat',
    // Real telemetry only: filled by the store when a packet arrives.
    battery: null,
    signal: null,
  };
}

/* ── Native event listeners (attached once) ──────────────────────── */

let listenersAttached = false;
let readingCb: ((reading: Reading) => void) | null = null;
let disconnectCb: (() => void) | null = null;
// Readings that arrived before any onRegistration — flushed on first add.
const earlyReadings: Reading[] = [];
let earlyDisconnect = false;

async function ensureNativeListeners(plugin: MochiBlePlugin): Promise<void> {
  if (listenersAttached) return;
  listenersAttached = true;
  try {
    await plugin.addListener('grainReading', (payload) => {
      const reading = mapReading(payload);
      if (!reading) return;
      // Real packet arrival → live link-quality observation (both paths).
      lqRecordPacket(reading.signal);
      if (!readingCb) {
        earlyReadings.push(reading);
        if (earlyReadings.length > 50) earlyReadings.shift();
        return;
      }
      readingCb(reading);
    });
    await plugin.addListener('grainConnection', (data) => {
      if (data?.state !== 'disconnected' || data.reason === 'deliberate') return;
      lqMarkDisconnected(); // unexpected native drop — stop the live signal
      if (!disconnectCb) {
        earlyDisconnect = true;
        return;
      }
      disconnectCb();
    });
  } catch {
    listenersAttached = false; // allow a later retry
  }
}

/* ═══ Public API — same shape as ./bluetooth ═══ */

/** Native → MochiBle.associate() (chooser dialog). Web → unchanged. */
export async function requestDevice(): Promise<DeviceInfo | null> {
  const native = await getNative();
  if (!native) return webBle.requestDevice();

  try {
    const picked = await native.associate();
    return assocToDevice(picked);
  } catch {
    // Cancel / none chosen / denied → fall back to an EXISTING
    // association (reconnects must not force a chooser re-open).
    try {
      const status = await native.getStatus();
      if (status.association?.address) {
        return assocToDevice({
          id: status.association.address,
          name: status.association.name,
        });
      }
    } catch {
      // getStatus failure → honest null
    }
    return null;
  }
}

/** Native → MochiBle.connect() + startMonitoring(config snapshot). */
export async function connect(): Promise<boolean> {
  const native = await getNative();
  if (!native) {
    const ok = await webBle.connect();
    if (ok) lqMarkConnected(); // web GATT link up — begin link-quality observation
    return ok;
  }

  await ensureNativeListeners(native);
  try {
    const res = await native.connect();
    if (!res.connected) return false;
    lqMarkConnected(); // native link up — begin link-quality observation
    try {
      await native.startMonitoring({
        settings: { ...(nativeConfig ?? {}), monitoringEnabled: true },
      });
    } catch {
      // Monitoring config push failed; the GATT link itself is up —
      // the service will still stream packets + persist them.
    }
    return true;
  } catch {
    return false;
  }
}

/** Native → MochiBle.connect() again (fresh bounded retry cycle). */
export async function reconnect(): Promise<boolean> {
  const native = await getNative();
  if (!native) {
    const ok = await webBle.reconnect();
    if (ok) lqMarkConnected();
    return ok;
  }
  await ensureNativeListeners(native);
  try {
    const res = await native.connect();
    if (res.connected) lqMarkConnected();
    return res.connected;
  } catch {
    return false;
  }
}

/** Register the reading handler (single slot, web-identical semantics). */
export function onReading(callback: (reading: Reading) => void): void {
  if (!isNativeApp()) {
    // Wrap so EVERY real web packet feeds the live link-quality observer
    // (native packets are observed inside the grainReading listener).
    webBle.onReading((reading) => {
      lqRecordPacket(reading.signal);
      callback(reading);
    });
    return;
  }
  readingCb = callback;
  if (earlyReadings.length) {
    const buffered = earlyReadings.splice(0);
    for (const r of buffered) callback(r);
  }
}

/** Register the unexpected-disconnect handler (deliberate stops excluded). */
export function onDisconnected(callback: () => void): void {
  if (!isNativeApp()) {
    webBle.onDisconnected(() => {
      lqMarkDisconnected(); // GATT dropped — stop the live signal honestly
      callback();
    });
    return;
  }
  disconnectCb = callback;
  if (earlyDisconnect) {
    earlyDisconnect = false;
    callback();
  }
}

/** Deliberate disconnect: native stops the service; web unchanged. */
export function disconnect(): void {
  lqMarkDisconnected(); // both paths — the live signal pill goes honest '—'
  if (!isNativeApp()) {
    webBle.disconnect();
    return;
  }
  readingCb = null;
  disconnectCb = null;
  earlyReadings.length = 0;
  earlyDisconnect = false;
  void (async () => {
    try {
      const native = await getNative();
      await native?.disconnect();
    } catch {
      // already down / bridge gone — nothing to clean up
    }
  })();
}

/** wake=1 calibrate=2 sync=3 sleep=4 (native maps the same codes). */
export async function sendCommand(
  command: 'wake' | 'calibrate' | 'sync' | 'sleep',
): Promise<boolean> {
  const native = await getNative();
  if (!native) return webBle.sendCommand(command);
  try {
    const res = await native.sendCommand({ cmd: command });
    return !!res.sent;
  } catch {
    return false;
  }
}

/* ═══ Native extras ═══ */

export interface NativeSessionRestore {
  deviceInfo: DeviceInfo | null;
  pendingTap: string | null;
}

/**
 * Restore a monitoring session after WebView reload/app restart.
 * NATIVE ONLY (web returns null immediately).
 *
 *  1. getStatus() → restore ONLY when an association exists AND the
 *     native side reports 'connected' — never fake liveness while the
 *     service is still reconnecting.
 *  2. attach the shared listeners and register the caller's callbacks.
 *  3. drain pendingReadings and replay them through onReading (the
 *     caller routes them into the store once its state is 'connected';
 *     IndexedDB put() dedupes the deterministic ids).
 *  4. consume the pending notification tap so the store can switch tabs.
 */
export async function initNativeSession(
  onReadingCb: (reading: Reading) => void,
  onDisconnectedCb: () => void,
): Promise<NativeSessionRestore | null> {
  const native = await getNative();
  if (!native) return null;

  let status: NativeStatus;
  try {
    status = await native.getStatus();
  } catch {
    return null;
  }

  const assoc = status.association;
  if (!assoc?.address) return { deviceInfo: null, pendingTap: null };

  const deviceInfo = assocToDevice({ id: assoc.address, name: assoc.name });
  if (status.connectionState !== 'connected') {
    return { deviceInfo: null, pendingTap: null };
  }

  await ensureNativeListeners(native);
  readingCb = onReadingCb;
  disconnectCb = onDisconnectedCb;
  lqMarkConnected(); // status already verified 'connected' above

  try {
    const drained = await native.drainPendingReadings();
    const list = drained?.readings ?? [];
    for (const payload of list) {
      const reading = mapReading(payload);
      if (reading) {
        lqRecordPacket(reading.signal);
        readingCb(reading);
      }
    }
  } catch {
    // Queue drain is best-effort — a failed drain retries at next restore.
  }

  let pendingTap: string | null = null;
  try {
    const tap = await native.consumePendingTap();
    pendingTap = tap?.tab ?? null;
  } catch {
    // No tap or consume failed → null is the honest answer.
  }

  return { deviceInfo, pendingTap };
}
