'use client';

import { useEffect, useRef } from 'react';
import { useGrainStore } from '@/lib/grain-store';
import { useNetworkStatus } from '@/lib/pwa';
import { CloudSlash, WarningCircle } from '@phosphor-icons/react/dist/ssr';
import { t, type AppLanguage } from '@/lib/i18n';

/**
 * Internet-connectivity ribbon — deliberately DISTINCT from device (BLE) states:
 *
 *   BLE states live in the Home hero (LIVE / LAST READING / Connecting /
 *   Disconnected heroes). This ribbon describes INTERNET only:
 *
 *   - Offline : amber ribbon, CloudSlash icon — internet down; local data
 *               safe; BLE monitoring unaffected (honest note, no fake live).
 *   - Weak    : dashed amber ribbon, WarningCircle — OS-reported 2G/slow-2g/
 *               high-rtt/saveData. Only shown when the browser exposes the
 *               Network Information API; never guessed.
 *   - Healthy : nothing rendered (no noise).
 *
 * A brief "Back online" toast fires on recovery.
 */
export function ConnectivityRibbon() {
  const { online, quality } = useNetworkStatus();
  const { settings, showToast } = useGrainStore();
  const lang = settings.language as AppLanguage;

  const wasOffline = useRef(false);

  // Fire the recovery toast exactly on the offline→online transition
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      showToast(t('toast.back_online', lang));
    }
  }, [online, lang, showToast]);

  const isOffline = !online;
  const isWeak = online && quality === 'weak';
  if (!isOffline && !isWeak) return null;

  const label = isOffline ? t('connectivity.offline', lang) : t('connectivity.weak', lang);
  const desc = isOffline ? t('connectivity.offline_desc', lang) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`grain-conn-ribbon ${isOffline ? 'offline' : 'weak'} grain-fade-in`}
      data-state={isOffline ? 'offline' : 'weak'}
    >
      <span className="grain-conn-icon" aria-hidden="true">
        {isOffline ? <CloudSlash size={15} weight="bold" /> : <WarningCircle size={15} weight="bold" />}
      </span>
      <span className="grain-conn-text">
        <span className="grain-conn-label">{label}</span>
        {desc && <span className="grain-conn-desc">{desc}</span>}
      </span>
    </div>
  );
}
