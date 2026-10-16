'use client';

import { useEffect, useMemo, useState } from 'react';
import { useGrainStore } from '@/lib/grain-store';
import { t, type AppLanguage } from '@/lib/i18n';
import { computeStorageScore, scoreBandColor } from '@/lib/storage-score';
import { onLinkQuality, getLinkQuality } from '@/lib/link-quality';

/**
 * Supporting telemetry squares – TEMP | SIGNAL | STORAGE.
 * The selected grain is displayed in the hero card only;
 * Home never allows grain selection (Settings is the single selector).
 *
 * SIGNAL is LIVE: it streams the observed BLE link quality
 * (packet-cadence regularity + staleness + firmware byte blend —
 * see link-quality.ts), so it visibly moves when the radio link
 * gets better or worse instead of freezing on one byte.
 * Band colors: ≥70 good · 40–69 fair · <40 risky.
 *
 * STORAGE is the same 0–100 storage score shown on the History
 * tab, computed from the real stored readings — never a canned
 * number. '—' until at least one reading exists.
 */
export function MetricPills() {
  const { currentReading, deviceInfo, settings, historyEntries } = useGrainStore();
  const lang = settings.language as AppLanguage;

  // Live link quality — real BLE transport observations only.
  const [link, setLink] = useState<number | null>(() => getLinkQuality());
  useEffect(() => onLinkQuality(setLink), []);

  const score = useMemo(
    () => computeStorageScore(historyEntries, settings.thresholds),
    [historyEntries, settings.thresholds],
  );

  if (!currentReading || !deviceInfo) return null;

  // Live observation wins; fall back to the last packet's firmware byte.
  const signalQ = link ?? (typeof deviceInfo.signal === 'number' ? deviceInfo.signal : null);
  const signalColor =
    signalQ === null ? 'var(--gm-text-primary)'
      : signalQ >= 70 ? 'var(--gm-band-good)'
        : signalQ >= 40 ? 'var(--gm-band-fair)'
          : 'var(--gm-band-risky)';

  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="grain-card p-3.5">
        <div className="text-[9px] font-bold tracking-[0.15em] uppercase mb-2" style={{ color: 'var(--gm-text-secondary)' }}>
          {t('metric.temp', lang)}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-bold" style={{ color: 'var(--gm-text-primary)' }}>
            {Math.round(currentReading.temperature)}
          </span>
          <span className="text-xs font-medium" style={{ color: 'var(--gm-text-secondary)' }}>°C</span>
        </div>
      </div>
      <div
        className="grain-card p-3.5"
        role="status"
        aria-label={signalQ === null
          ? t('metric.signal', lang)
          : `${t('metric.link_quality', lang)} ${signalQ}%`}
      >
        <div className="text-[9px] font-bold tracking-[0.15em] uppercase mb-2" style={{ color: 'var(--gm-text-secondary)' }}>
          {t('metric.signal', lang)}
        </div>
        <div className="flex items-baseline gap-1">
          <span
            className="text-2xl font-bold grain-tabular transition-colors duration-500"
            style={{ color: signalColor }}
          >
            {signalQ ?? '—'}
          </span>
          <span className="text-xs font-medium" style={{ color: 'var(--gm-text-secondary)' }}>%</span>
        </div>
      </div>
      <div
        className="grain-card p-3.5"
        role="status"
        aria-label={score ? `${t('history.score_title', lang)} ${score.score}/100` : t('history.score_title', lang)}
      >
        <div className="text-[9px] font-bold tracking-[0.15em] uppercase mb-2" style={{ color: 'var(--gm-text-secondary)' }}>
          {t('metric.storage', lang)}
        </div>
        <div className="flex items-baseline gap-1">
          <span
            className="text-2xl font-bold grain-tabular"
            style={{ color: score ? scoreBandColor(score.band) : 'var(--gm-text-tertiary)' }}
          >
            {score ? score.score : '—'}
          </span>
          <span className="text-xs font-medium" style={{ color: 'var(--gm-text-secondary)' }}>/100</span>
        </div>
      </div>
    </div>
  );
}
