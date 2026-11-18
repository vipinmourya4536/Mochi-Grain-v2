/* ═════════════════════════════════════════════════════════════════
   Admin Panel API Client — Railway-hosted admin panel
   ═════════════════════════════════════════════════════════════════

   The Discover feed is served by the user's deployed Railway admin
   panel (set NEXT_PUBLIC_ADMIN_API_URL). This client is the ONLY
   source of Discover videos — there is no hardcoded fallback list.

   Strict approval contract:
   - Every item must carry `isApproved === true` to be rendered.
   - Items missing required fields (id, title, url) are discarded.
   - A response that isn't JSON or isn't an array / { videos: [] }
     shape is an error, never a silent empty list.
   - The admin panel must send CORS headers for the app origin.   */

import type { DiscoverVideo, GrainType, RiskTheme } from './grain-types';

/** Base URL of the deployed admin panel (no trailing slash, no /api). */
const ADMIN_API_URL: string = (process.env.NEXT_PUBLIC_ADMIN_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

/** True when NEXT_PUBLIC_ADMIN_API_URL is set to a real domain. */
export function isAdminApiConfigured(): boolean {
  return ADMIN_API_URL.length > 0 && /^https?:\/\//i.test(ADMIN_API_URL);
}

/** Fetch error kinds — surfaced so the UI can pick the right message. */
export type AdminApiErrorKind = 'unconfigured' | 'network' | 'server' | 'invalid';

export class AdminApiError extends Error {
  readonly kind: AdminApiErrorKind;
  constructor(kind: AdminApiErrorKind, detail?: string) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'AdminApiError';
    this.kind = kind;
  }
}

/** Query derived from the user's live grain profile + latest telemetry. */
export interface DiscoverQuery {
  grainType: GrainType;
  conditionStatus: RiskTheme;
  /** Latest moisture % — omitted from the request when unknown. */
  moisture?: number;
}

export interface DiscoverFetchResult {
  /** Only admin-approved items, validated and deduped. */
  videos: DiscoverVideo[];
  fetchedAt: number;
}

/** Request timeout — the user may be on a weak rural connection. */
const FETCH_TIMEOUT_MS = 12_000;

/** Build the /api/discover request URL for a query. */
export function buildDiscoverUrl(query: DiscoverQuery): string {
  const url = new URL(`${ADMIN_API_URL}/api/discover`);
  url.searchParams.set('grainType', query.grainType);
  url.searchParams.set('conditionStatus', query.conditionStatus);
  if (typeof query.moisture === 'number' && Number.isFinite(query.moisture)) {
    // One decimal is all the probe reports; keep the payload small.
    url.searchParams.set('moisture', query.moisture.toFixed(1));
  }
  return url.toString();
}

/** Fetch approved recommendations from the admin panel. Throws AdminApiError. */
export async function fetchDiscoverVideos(query: DiscoverQuery): Promise<DiscoverFetchResult> {
  if (!isAdminApiConfigured()) {
    throw new AdminApiError('unconfigured');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(buildDiscoverUrl(query), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new AdminApiError('server', `HTTP ${res.status}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AdminApiError('invalid', 'response is not JSON');
    }
    const videos = parseDiscoverResponse(json);
    return { videos, fetchedAt: Date.now() };
  } catch (err) {
    if (err instanceof AdminApiError) throw err;
    // AbortError (timeout) and network failures behave the same for the UI
    throw new AdminApiError('network', err instanceof Error ? err.message : undefined);
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ── Response parsing (strict) ── */

function parseDiscoverResponse(json: unknown): DiscoverVideo[] {
  let list: unknown[] | null = null;
  if (Array.isArray(json)) {
    list = json;
  } else if (json != null && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.videos)) list = obj.videos;
    else if (Array.isArray(obj.items)) list = obj.items;
    else if (obj.data != null && typeof obj.data === 'object') {
      // Nested envelope: { data: { videos: [...] } }
      const inner = obj.data as Record<string, unknown>;
      if (Array.isArray(inner.videos)) list = inner.videos;
    }
  }
  if (!list) {
    // Unrecognized shape → hard error. An empty approved list is fine;
    // a malformed payload is never silently treated as "no results".
    throw new AdminApiError('invalid', 'unrecognized response shape');
  }

  const out: DiscoverVideo[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const video = toDiscoverVideo(raw);
    if (!video) continue; // unapproved or invalid — discarded, not rendered
    if (seen.has(video.id)) continue; // dedupe by id, first occurrence wins
    seen.add(video.id);
    out.push(video);
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Extract a YouTube video id from common URL forms, if present. */
function youtubeIdFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || undefined;
    if (/^(www\.)?youtube(-nocookie)?\.com$/i.test(u.hostname)) {
      if (u.searchParams.get('v')) return u.searchParams.get('v') ?? undefined;
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/);
      if (m) return m[1];
    }
  } catch {
    /* not a parseable absolute URL */
  }
  return undefined;
}

/** Map one admin-panel item to a DiscoverVideo — or null when it must not render. */
function toDiscoverVideo(raw: unknown): DiscoverVideo | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  /* STRICT approval gate: only items the admin explicitly approved render. */
  if (o.isApproved !== true) return null;

  const id = asString(o.id ?? o._id ?? o.videoId ?? o.youtubeId);
  const title = asString(o.title ?? o.name);
  const url = asString(o.url ?? o.link ?? o.youtubeUrl ?? o.videoUrl);
  if (!id || !title || !url) return null; // required fields missing → discard

  const source = asString(o.source ?? o.channel ?? o.channelName ?? o.publisher) ?? '';
  const why = asString(o.why ?? o.reason ?? o.description ?? o.summary) ?? '';
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((tg): tg is string => typeof tg === 'string').slice(0, 8)
    : [];

  /* Thumbnail: use the panel's own URL; when absent, derive the public
     YouTube thumbnail for YouTube links only. Otherwise the card's
     branded fallback tile renders (never a broken <img>). */
  const givenThumb = asString(o.thumbnail ?? o.thumbnailUrl ?? o.thumb);
  const ytId = youtubeIdFromUrl(url);
  const thumbnail =
    givenThumb ?? (ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : '');

  return { id, title, source, thumbnail, url, why, tags };
}

/** True when the video link points at YouTube (drives the source-row icon). */
export function isYouTubeUrl(url: string): boolean {
  return youtubeIdFromUrl(url) !== undefined;
}
