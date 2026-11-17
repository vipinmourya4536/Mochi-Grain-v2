'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useGrainStore } from '@/lib/grain-store';
import { stateToRiskTheme, type DiscoverVideo } from '@/lib/grain-types';
import {
  fetchDiscoverVideos,
  isAdminApiConfigured,
  isYouTubeUrl,
} from '@/lib/admin-api';
import {
  getBookmarkedEntries,
  toggleVideoBookmark,
  getCachedDiscoverVideos,
  cacheDiscoverVideos,
  discoverCacheKey,
} from '@/lib/offline-storage';
import { haptic } from '@/lib/haptics';
import { useNetworkStatus } from '@/lib/pwa';
import {
  YoutubeLogo,
  ArrowSquareOut,
  PlayCircle,
  BookmarkSimple,
  CloudSlash,
  WarningCircle,
  Plugs,
  Video,
  ArrowClockwise,
} from '@phosphor-icons/react/dist/ssr';
import { t, tp, tGrain, type AppLanguage } from '@/lib/i18n';

/** Why the feed currently renders (drives banners + empty states). */
type DiscoverStatus =
  | 'loading' // fetching the admin panel (no cache to paint yet)
  | 'unconfigured' // NEXT_PUBLIC_ADMIN_API_URL not set
  | 'ready' // videos rendered (live fetch or offline cache)
  | 'empty' // online, panel answered: zero approved matches
  | 'offline-empty' // offline and nothing cached for this condition
  | 'error'; // online fetch failed and no cache to fall back on

/**
 * Single video card.
 * The thumbnail loads from the network; when a card has no thumbnail (the
 * admin panel omitted one and the link isn't YouTube) or the image fails,
 * we swap to a branded gradient tile so the card never shows a broken img.
 */
function DiscoverCard({
  video,
  saved,
  onToggleSave,
  lang,
}: {
  video: DiscoverVideo;
  saved: boolean;
  onToggleSave: (video: DiscoverVideo) => void;
  lang: AppLanguage;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const noThumb = !video.thumbnail;
  const showFallback = thumbFailed || noThumb;

  return (
    <div className="grain-discover-card-wrap relative">
      <a
        href={video.url}
        target="_blank"
        rel="noopener noreferrer"
        className="grain-discover-card block"
      >
        {/* Thumbnail row */}
        <div className="relative w-full h-36 overflow-hidden">
          {showFallback ? (
            <div
              className="w-full h-full flex items-center justify-center"
              style={{
                background:
                  'radial-gradient(120% 140% at 20% 0%, var(--gm-accent-soft, rgba(249,115,22,0.4)) 0%, transparent 55%),' +
                  'linear-gradient(135deg, rgba(0,0,0,0.55), rgba(0,0,0,0.35))',
              }}
              aria-hidden="true"
            >
              <PlayCircle size={44} weight="fill" style={{ color: 'rgba(255,255,255,0.85)' }} />
            </div>
          ) : (
            <img
              src={video.thumbnail}
              alt={video.title}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={() => setThumbFailed(true)}
            />
          )}
          {/* Bottom scrim for depth under the play affordance */}
          <div
            className="absolute inset-x-0 bottom-0 h-14 pointer-events-none"
            style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.45), transparent)' }}
          />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span
              className="w-11 h-11 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(0,0,0,0.42)',
                backdropFilter: 'blur(4px)',
                border: '1px solid rgba(255,255,255,0.22)',
              }}
            >
              <PlayCircle size={26} weight="fill" style={{ color: 'rgba(255,255,255,0.94)' }} />
            </span>
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <h3 className="text-sm font-bold tracking-tight leading-snug" style={{ color: 'var(--gm-text-primary)' }}>
              {video.title}
            </h3>
            <ArrowSquareOut size={16} weight="bold" style={{ color: 'var(--gm-text-tertiary)', flexShrink: 0, marginTop: 2 }} />
          </div>
          {video.source && (
            <div className="flex items-center gap-2 mb-2">
              {isYouTubeUrl(video.url) ? (
                <YoutubeLogo size={14} weight="fill" style={{ color: '#EF4444' }} />
              ) : (
                <Video size={14} weight="fill" style={{ color: 'var(--gm-text-tertiary)' }} />
              )}
              <span className="text-[11px]" style={{ color: 'var(--gm-text-tertiary)' }}>
                {video.source}
              </span>
            </div>
          )}
          {video.why && (
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--gm-text-secondary)' }}>
              {video.why}
            </p>
          )}
        </div>
      </a>
      {/* Save button — floats over the card corner, outside the link so taps don't navigate */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleSave(video);
        }}
        className={`grain-bookmark-btn ${saved ? 'saved' : ''}`}
        aria-pressed={saved}
        aria-label={t(saved ? 'discover.bookmark_remove' : 'discover.bookmark_add', lang)}
      >
        <BookmarkSimple size={15} weight={saved ? 'fill' : 'bold'} />
      </button>
    </div>
  );
}

export function DiscoverTab() {
  const { decision, settings, deviceState, currentReading, historyEntries, showToast } = useGrainStore();
  const { online } = useNetworkStatus();
  const lang = settings.language as AppLanguage;

  /* ── Condition query (existing app state + IndexedDB telemetry) ──
   * grainType: the user's active grain profile (persisted settings).
   * conditionStatus: the live Mochi decision when connected, otherwise
   * the most recent stored decision from IndexedDB history.
   * moisture: the latest reading % — same live-then-stored priority. */
  const grainType = settings.grainType;
  const latestDecision = decision ?? historyEntries[0]?.decision ?? null;
  const conditionStatus = latestDecision ? stateToRiskTheme(latestDecision.state) : 'safe';
  const moisture =
    typeof currentReading?.moisture === 'number'
      ? currentReading.moisture
      : typeof historyEntries[0]?.reading?.moisture === 'number'
        ? historyEntries[0].reading.moisture
        : undefined;
  /** One-time flip once stored telemetry hydrates → refetch with real params. */
  const hydrated = moisture !== undefined;

  /* ── Feed state ── */
  const [videos, setVideos] = useState<DiscoverVideo[]>([]);
  const [status, setStatus] = useState<DiscoverStatus>('loading');
  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  /* ── Saved videos (full records from IndexedDB) ── */
  const [savedVideos, setSavedVideos] = useState<DiscoverVideo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<'all' | 'saved'>('all');

  const savedIds = useMemo(() => new Set(savedVideos.map((v) => v.id)), [savedVideos]);

  useEffect(() => {
    let cancelled = false;
    getBookmarkedEntries().then((rows) => {
      if (!cancelled) {
        setSavedVideos(rows.map((r) => r.video));
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSave = (video: DiscoverVideo) => {
    const willSave = !savedIds.has(video.id);
    // Optimistic flip; IndexedDB is source of truth on next load
    setSavedVideos((prev) =>
      willSave ? [video, ...prev] : prev.filter((v) => v.id !== video.id),
    );
    haptic(settings.hapticsEnabled, willSave ? 12 : 8);
    showToast(t(willSave ? 'toast.saved' : 'toast.unsaved', lang));
    toggleVideoBookmark(video).catch(() => {
      // Roll back on storage failure
      setSavedVideos((prev) =>
        willSave ? prev.filter((v) => v.id !== video.id) : [video, ...prev],
      );
    });
  };

  /* ── Offline-first load flow ──
   * 1. Paint the IndexedDB cache for this condition instantly.
   * 2. Online → fetch the admin panel, overwrite the cache with the
   *    latest approved list (empty included — it is the current truth),
   *    replace the rendered list.
   * 3. Offline or failed fetch → the cache stands; without a cache the
   *    honest empty/error state shows. Re-runs when connectivity
   *    returns so the cache self-refreshes. */
  const moistureRef = useRef<number | undefined>(moisture);
  moistureRef.current = moisture;

  useEffect(() => {
    let cancelled = false;

    const paintCache = (list: DiscoverVideo[], fetchedAt: number) => {
      setVideos(list);
      setFromCache(true);
      setCachedAt(fetchedAt);
      setStatus('ready');
    };
    const paintEmpty = (next: DiscoverStatus) => {
      setVideos([]);
      setFromCache(false);
      setCachedAt(null);
      setStatus(next);
    };

    const run = async () => {
      if (cancelled) return;

      /* No admin panel URL configured → nothing can be fetched or cached. */
      if (!isAdminApiConfigured()) {
        setRefreshing(false);
        paintEmpty('unconfigured');
        return;
      }

      const cache = await getCachedDiscoverVideos(grainType, conditionStatus);
      if (cancelled) return;

      if (!online) {
        if (cache && cache.videos.length > 0) {
          paintCache(cache.videos, cache.fetchedAt);
        } else {
          paintEmpty('offline-empty');
        }
        setRefreshing(false);
        return;
      }

      /* Paint cache first (stale-while-revalidate); fetch replaces it. */
      if (cache && cache.videos.length > 0) {
        paintCache(cache.videos, cache.fetchedAt);
        setRefreshing(true);
      } else {
        paintEmpty('loading');
      }

      try {
        const result = await fetchDiscoverVideos({
          grainType,
          conditionStatus,
          moisture: moistureRef.current,
        });
        if (cancelled) return;

        /* Persist the latest approved list for offline use (empty included). */
        await cacheDiscoverVideos({
          cacheKey: discoverCacheKey(grainType, conditionStatus),
          grainType,
          conditionStatus,
          moisture: moistureRef.current ?? null,
          videos: result.videos,
          fetchedAt: result.fetchedAt,
        });
        if (cancelled) return;

        setVideos(result.videos);
        setFromCache(false);
        setCachedAt(result.fetchedAt);
        setStatus(result.videos.length > 0 ? 'ready' : 'empty');
      } catch {
        if (cancelled) return;
        /* Network/server failure → the painted cache stands; without one,
         * the honest error state with a retry shows. Never random videos. */
        if (cache && cache.videos.length > 0) {
          paintCache(cache.videos, cache.fetchedAt);
        } else {
          paintEmpty('error');
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    };

    /* Small debounce so boot hydration (settings → history → reading)
     * collapses into one request instead of firing per param flip. */
    const timer = setTimeout(run, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [grainType, conditionStatus, online, hydrated, reloadToken]);

  /* ── Derived render state ── */
  const visibleVideos = filter === 'all' ? videos : savedVideos;
  const isConnected = deviceState !== 'disconnected' && deviceState !== 'connecting';

  const conditionLabel =
    conditionStatus === 'safe'
      ? t('discover.condition_normal', lang)
      : conditionStatus === 'warn'
        ? t('discover.condition_elevated', lang)
        : t('discover.condition_critical', lang);

  const savedCount = savedVideos.length;
  const cachedAtLabel = useMemo(() => {
    if (!cachedAt) return null;
    const mins = Math.max(1, Math.round((Date.now() - cachedAt) / 60000));
    if (mins < 60) return tp('discover.cache_mins', lang, { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return tp('discover.cache_hours', lang, { n: hours });
    return tp('discover.cache_days', lang, { n: Math.round(hours / 24) });
  }, [cachedAt, lang]);

  return (
    <div className="pt-2 pb-6 grain-fade-in">
      <h2 className="text-2xl font-bold tracking-tight mb-1" style={{ color: 'var(--gm-text-primary)' }}>
        {t('discover.title', lang)}
      </h2>
      <p className="text-sm mb-5" style={{ color: 'var(--gm-text-secondary)' }}>
        {isConnected
          ? `${tGrain(grainType, lang)} · ${conditionLabel}`
          : t('discover.disconnected_desc', lang)}
      </p>

      {isConnected && (
        <div className="grain-insight-card mb-5">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--gm-text-secondary)' }}>
            {conditionStatus === 'critical'
              ? t('discover.connected_desc_critical', lang)
              : conditionStatus === 'warn'
                ? t('discover.connected_desc_warn', lang)
                : conditionStatus === 'monitor'
                  ? t('discover.connected_desc_safe', lang)
                  : t('discover.connected_desc_safe', lang)}
          </p>
        </div>
      )}

      {/* Offline banner — remote content needs the network; say so honestly */}
      {!online && (
        <div className="grain-discover-offline" role="status">
          <CloudSlash size={15} weight="bold" aria-hidden="true" />
          <span>{t('discover.offline_banner', lang)}</span>
        </div>
      )}

      {/* Stale banner — panel unreachable but a cached list is serving */}
      {online && fromCache && status === 'ready' && (
        <div className="grain-discover-offline" role="status">
          <WarningCircle size={15} weight="bold" aria-hidden="true" />
          <span>
            {cachedAtLabel
              ? `${t('discover.stale_banner', lang)} · ${cachedAtLabel}`
              : t('discover.stale_banner', lang)}
          </span>
        </div>
      )}

      {/* Background refresh indicator */}
      {refreshing && status === 'ready' && (
        <div className="grain-discover-refresh" role="status">
          <span className="grain-discover-spin" aria-hidden="true" />
          <span>{t('discover.refreshing', lang)}</span>
        </div>
      )}

      {/* Filter chips: All | Saved */}
      <div className="flex items-center gap-2 mb-4">
        <div className="grain-seg" role="tablist" aria-label={t('discover.filter_all', lang)}>
          <button
            role="tab"
            aria-selected={filter === 'all'}
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >
            {t('discover.filter_all', lang)}
          </button>
          <button
            role="tab"
            aria-selected={filter === 'saved'}
            className={filter === 'saved' ? 'active' : ''}
            onClick={() => setFilter('saved')}
          >
            {t('discover.filter_saved', lang)}
            {loaded && savedCount > 0 && (
              <span className="grain-bookmark-count" aria-hidden="true">{savedCount}</span>
            )}
          </button>
        </div>
      </div>

      {/* ── Feed body by status ── */}
      {status === 'loading' && filter === 'all' && (
        <div className="flex flex-col items-center justify-center py-16" role="status">
          <div className="grain-spinner" aria-hidden="true" />
          <p className="text-xs mt-4" style={{ color: 'var(--gm-text-tertiary)' }}>
            {t('discover.loading', lang)}
          </p>
        </div>
      )}

      {status === 'unconfigured' && filter === 'all' && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4 grain-card">
            <Plugs size={24} weight="bold" style={{ color: 'var(--gm-text-tertiary)' }} />
          </div>
          <p className="text-sm max-w-[280px]" style={{ color: 'var(--gm-text-secondary)' }}>
            {t('discover.admin_unconfigured', lang)}
          </p>
        </div>
      )}

      {status === 'error' && filter === 'all' && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4 grain-card">
            <WarningCircle size={24} weight="bold" style={{ color: 'var(--gm-text-tertiary)' }} />
          </div>
          <p className="text-sm max-w-[280px] mb-5" style={{ color: 'var(--gm-text-secondary)' }}>
            {t('discover.fetch_error', lang)}
          </p>
          <button
            type="button"
            onClick={() => setReloadToken((x) => x + 1)}
            className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold"
            style={{
              color: 'var(--gm-text-primary)',
              border: '1px solid var(--gm-glass-border)',
              background: 'var(--gm-surface)',
            }}
          >
            <ArrowClockwise size={14} weight="bold" aria-hidden="true" />
            {t('discover.retry', lang)}
          </button>
        </div>
      )}

      {(status === 'empty' || status === 'offline-empty') && filter === 'all' && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4 grain-card">
            {status === 'offline-empty' ? (
              <CloudSlash size={24} weight="bold" style={{ color: 'var(--gm-text-tertiary)' }} />
            ) : (
              <PlayCircle size={24} weight="bold" style={{ color: 'var(--gm-text-tertiary)' }} />
            )}
          </div>
          <p className="text-sm max-w-[260px]" style={{ color: 'var(--gm-text-secondary)' }}>
            {status === 'offline-empty'
              ? t('discover.offline_no_cache', lang)
              : t('discover.no_results', lang)}
          </p>
        </div>
      )}

      {/* ── Cards ── */}
      <div className="flex flex-col gap-3">
        {filter === 'saved' && savedCount > 0 && (
          <p className="text-[10px] font-semibold tracking-wide uppercase px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
            {tp('discover.saved_meta', lang, { n: savedCount })}
          </p>
        )}
        {filter === 'all'
          ? status === 'ready' && visibleVideos.map((video) => (
              <DiscoverCard
                key={video.id}
                video={video}
                saved={savedIds.has(video.id)}
                onToggleSave={toggleSave}
                lang={lang}
              />
            ))
          : visibleVideos.map((video) => (
              <DiscoverCard
                key={video.id}
                video={video}
                saved={savedIds.has(video.id)}
                onToggleSave={toggleSave}
                lang={lang}
              />
            ))}
      </div>

      {filter === 'saved' && savedCount === 0 && loaded && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4 grain-card">
            <BookmarkSimple size={24} weight="bold" style={{ color: 'var(--gm-text-tertiary)' }} />
          </div>
          <p className="text-sm max-w-[240px]" style={{ color: 'var(--gm-text-secondary)' }}>
            {t('discover.saved_empty', lang)}
          </p>
        </div>
      )}
    </div>
  );
}
