/* ═══════════════════════════════════════════════════════════════
   Offline Storage Layer – IndexedDB via 'idb' library
   ═══════════════════════════════════════════════════════════════ */

import { openDB, type IDBPDatabase } from 'idb';
import type { Reading, AppSettings, HistoryEntry, MochiDecision, DiscoverVideo, GrainType, RiskTheme } from './grain-types';
import { DEFAULT_SETTINGS } from './grain-types';

const DB_NAME = 'grain-monitor-db';
const DB_VERSION = 4;

/** Legacy synthetic-probe id used by the removed demo mode.
 *  Kept ONLY so the v3 upgrade can purge any rows a pre-3 database may
 *  still contain. Never written by current code. */
const LEGACY_DEMO_DEVICE_ID = 'DEMO-GRAIN-01';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade: async (db, oldVersion, _newVersion, transaction) => {
        // Readings store
        if (!db.objectStoreNames.contains('readings')) {
          const readings = db.createObjectStore('readings', { keyPath: 'id' });
          readings.createIndex('deviceId', 'deviceId', { unique: false });
          readings.createIndex('timestamp', 'timestamp', { unique: false });
        }
        // Settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        // History entries (reading + decision)
        if (!db.objectStoreNames.contains('history')) {
          const history = db.createObjectStore('history', { keyPath: 'id' });
          history.createIndex('deviceId', 'reading.deviceId', { unique: false });
          history.createIndex('timestamp', 'reading.timestamp', { unique: false });
        }
        // v2: Saved Discover videos (keyPath = video id string)
        if (oldVersion < 2 && !db.objectStoreNames.contains('bookmarks')) {
          db.createObjectStore('bookmarks', { keyPath: 'id' });
        }
        // v4: Discover API cache — one entry per (grainType + conditionStatus)
        // holding the latest admin-approved videos so Discover works offline.
        if (!db.objectStoreNames.contains('discover-cache')) {
          db.createObjectStore('discover-cache', { keyPath: 'cacheKey' });
        }
        // v4: purge legacy id-only bookmarks. Pre-API bookmarks stored just
        // { id, savedAt } against the removed hardcoded library; without an
        // embedded video record they can never be rendered again. Real
        // bookmarks written by the admin-API era store the full video and
        // are preserved.
        if (oldVersion > 0 && oldVersion < 4) {
          const bookmarks = transaction.objectStore('bookmarks');
          let bCursor = await bookmarks.openCursor();
          while (bCursor) {
            const rec = bCursor.value as { video?: unknown } | null;
            if (rec == null || rec.video == null) bCursor.delete();
            bCursor = await bCursor.continue();
          }
        }
        // v3: one-time purge of legacy synthetic demo rows. Only rows whose
        // deviceId matches the retired demo probe id are deleted — every
        // real reading, history entry, bookmark, and setting is preserved.
        if (oldVersion > 0 && oldVersion < 3) {
          const scope = IDBKeyRange.only(LEGACY_DEMO_DEVICE_ID);
          const purge = async (storeName: 'readings' | 'history') => {
            const index = transaction.objectStore(storeName).index('deviceId');
            let cursor = await index.openCursor(scope);
            while (cursor) {
              cursor.delete();
              cursor = await cursor.continue();
            }
          };
          // Both purges share the version-change transaction and commit with it
          await Promise.all([purge('readings'), purge('history')]);
        }
      },
    });
  }
  return dbPromise;
}

/* ── Readings ── */
export async function saveReading(reading: Reading): Promise<void> {
  const db = await getDB();
  await db.put('readings', reading);
}

export async function saveReadings(readings: Reading[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('readings', 'readwrite');
  await Promise.all(readings.map((r) => tx.store.put(r)));
  await tx.done;
}

export async function getReadings(deviceId?: string, limit = 50): Promise<Reading[]> {
  const db = await getDB();
  let readings: Reading[];
  if (deviceId) {
    readings = await db.getAllFromIndex('readings', 'deviceId', deviceId);
  } else {
    readings = await db.getAll('readings');
  }
  readings.sort((a, b) => b.timestamp - a.timestamp);
  return readings.slice(0, limit);
}

export async function getRecentReadings(deviceId: string, count = 20): Promise<Reading[]> {
  const all = await getReadings(deviceId, 200);
  return all.slice(0, count);
}

/* ── History Entries (reading + decision) ── */
export async function saveHistoryEntry(entry: HistoryEntry): Promise<void> {
  const db = await getDB();
  // Ensure top-level id for keyPath
  const record = { ...entry, id: entry.reading.id };
  await db.put('history', record);
}

export async function getHistoryEntries(deviceId?: string, limit = 100): Promise<HistoryEntry[]> {
  const db = await getDB();
  let entries: HistoryEntry[];
  if (deviceId) {
    entries = await db.getAllFromIndex('history', 'deviceId', deviceId);
  } else {
    entries = await db.getAll('history');
  }
  entries.sort((a, b) => b.reading.timestamp - a.reading.timestamp);
  return entries.slice(0, limit);
}

export async function getHistoryEntry(id: string): Promise<HistoryEntry | undefined> {
  const db = await getDB();
  return db.get('history', id);
}

export async function clearAllHistory(): Promise<void> {
  const db = await getDB();
  await db.clear('readings');
  await db.clear('history');
}

/* ── Discover video bookmarks (full video records) ──
   The full DiscoverVideo is embedded in the record so the Saved view
   renders saved videos even when they are absent from the current
   condition's API response — and keeps working fully offline. */
export interface BookmarkRecord {
  id: string;
  savedAt: number;
  video: DiscoverVideo;
}

export async function getBookmarkedIds(): Promise<string[]> {
  try {
    const db = await getDB();
    const rows: BookmarkRecord[] = await db.getAll('bookmarks');
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/** Full bookmark records (id + savedAt + video), sorted newest-first */
export async function getBookmarkedEntries(): Promise<BookmarkRecord[]> {
  try {
    const db = await getDB();
    const rows: BookmarkRecord[] = await db.getAll('bookmarks');
    return rows.filter((r) => r && typeof r.id === 'string' && r.video != null)
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** Toggle a video bookmark (stores the full video record); returns the new saved state */
export async function toggleVideoBookmark(video: DiscoverVideo): Promise<boolean> {
  const db = await getDB();
  const existing = await db.get('bookmarks', video.id);
  if (existing) {
    await db.delete('bookmarks', video.id);
    return false;
  }
  await db.put('bookmarks', { id: video.id, savedAt: Date.now(), video });
  return true;
}

/* ── Discover API cache (offline-first) ──
   One cache entry per grain condition bucket: `${grainType}:${conditionStatus}`.
   Written on every successful admin-panel fetch (empty result included — it
   is the latest truth), read whenever the network is unavailable or fails. */
export interface DiscoverCacheEntry {
  cacheKey: string;
  grainType: GrainType;
  conditionStatus: RiskTheme;
  /** Moisture the entry was fetched with (null when telemetry was unknown). */
  moisture: number | null;
  videos: DiscoverVideo[];
  fetchedAt: number; // epoch ms
}

export function discoverCacheKey(grainType: GrainType, conditionStatus: RiskTheme): string {
  return `${grainType}:${conditionStatus}`;
}

export async function cacheDiscoverVideos(entry: DiscoverCacheEntry): Promise<void> {
  try {
    const db = await getDB();
    await db.put('discover-cache', entry);
  } catch {
    /* cache write failure is non-fatal — the UI still renders the fetch */
  }
}

export async function getCachedDiscoverVideos(
  grainType: GrainType,
  conditionStatus: RiskTheme,
): Promise<DiscoverCacheEntry | undefined> {
  try {
    const db = await getDB();
    const entry = await db.get('discover-cache', discoverCacheKey(grainType, conditionStatus));
    return entry && Array.isArray(entry.videos) ? entry : undefined;
  } catch {
    return undefined;
  }
}

export async function clearDiscoverCache(): Promise<void> {
  const db = await getDB();
  await db.clear('discover-cache');
}

/* ── Settings ── */
export async function getSettings(): Promise<AppSettings> {
  try {
    const db = await getDB();
    const row = await db.get('settings', 'app-settings');
    return row?.value ?? DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await getDB();
  await db.put('settings', { key: 'app-settings', value: settings });
}

/* ── Full backup (JSON): settings + readings + history ── */

export interface BackupFile {
  app: 'grain-monitor';
  version: 1;
  exportedAt: string;
  settings: AppSettings | null;
  readings: Reading[];
  history: HistoryEntry[];
}

/** Serialize the complete local database (settings + all stores) as a JSON string. */
export async function exportBackupJSON(): Promise<string> {
  const db = await getDB();
  const [settings, readings, history] = await Promise.all([
    getSettings(),
    db.getAll('readings'),
    db.getAll('history'),
  ]);
  const backup: BackupFile = {
    app: 'grain-monitor',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    readings,
    history,
  };
  return JSON.stringify(backup, null, 2);
}

function isValidReading(r: any): r is Reading {
  return (
    r != null &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    typeof r.deviceId === 'string' &&
    typeof r.moisture === 'number' && Number.isFinite(r.moisture) &&
    typeof r.timestamp === 'number' && Number.isFinite(r.timestamp)
  );
}

function isValidEntry(e: any): e is HistoryEntry {
  return (
    e != null &&
    typeof e === 'object' &&
    isValidReading(e.reading) &&
    e.decision != null &&
    typeof e.decision === 'object' &&
    typeof e.decision.state === 'string'
  );
}


/**
 * Restore a backup produced by exportBackupJSON.
 * mode 'merge' (default): keep local data, add/overwrite backup records.
 * mode 'replace': wipe readings + history first, then restore.
 * Settings are always merged over current settings.
 * Throws Error('invalid') when the file is not a Grain Monitor backup.
 */
export async function importBackupJSON(
  json: string,
  mode: 'merge' | 'replace' = 'merge',
): Promise<{ readings: number; history: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('invalid');
  }

  const b = parsed as Partial<BackupFile> | null;
  if (
    !b ||
    typeof b !== 'object' ||
    b.app !== 'grain-monitor' ||
    !Array.isArray(b.readings) ||
    !Array.isArray(b.history)
  ) {
    throw new Error('invalid');
  }

  const readings = (b.readings as unknown[]).filter(isValidReading);
  const history = (b.history as unknown[])
    .filter(isValidEntry)
    // Guarantee the top-level keyPath id the history store requires
    .map((e) => ({ ...e, id: e.reading.id }));

  const db = await getDB();

  if (mode === 'replace') {
    await db.clear('readings');
    await db.clear('history');
  }

  // Bulk-insert readings + history in single transactions
  const rx = db.transaction('readings', 'readwrite');
  await Promise.all(readings.map((r) => rx.store.put(r)));
  await rx.done;

  const hx = db.transaction('history', 'readwrite');
  await Promise.all(history.map((e) => hx.store.put(e)));
  await hx.done;

  // Merge settings (backup values win over current, defaults fill gaps)
  if (b.settings && typeof b.settings === 'object') {
    const current = await getSettings();
    const merged = { ...DEFAULT_SETTINGS, ...current, ...(b.settings as Partial<AppSettings>) } as AppSettings;
    await saveSettings(merged);
  }

  return { readings: readings.length, history: history.length };
}
