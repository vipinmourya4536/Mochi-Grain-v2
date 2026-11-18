'use client';

import { useGrainStore } from '@/lib/grain-store';
import { t, type AppLanguage } from '@/lib/i18n';
import { LanguageSelector } from '@/components/grain/language-selector';
import { useOnlineStatus } from '@/lib/pwa';
import { BatteryHigh, BatteryLow, WifiSlash } from '@phosphor-icons/react/dist/ssr';

/**
 * Premium instrument header.
 * LEFT:  status indicator + GRAIN MONITOR title
 * RIGHT: battery telemetry capsule → offline chip → language utility action
 * Each control has a deliberately different visual weight:
 *   - battery  = device telemetry (elongated glass capsule)
 *   - language = utility action (compact rounded rectangle)
 */
export function Header() {
  /* Selector-based subscription — the header displays connection state,
     battery %, language and the settings-tab flag. Selecting the battery
     NUMBER (not the deviceInfo object) keeps packet-driven deviceInfo
     object churn (signal/grainType) from re-rendering the header; battery
     itself only repaints when the displayed percent changes. */
  const deviceState = useGrainStore((s) => s.deviceState);
  const battery = useGrainStore((s) => (s.deviceInfo && s.deviceInfo.battery != null ? s.deviceInfo.battery : null));
  const settings = useGrainStore((s) => s.settings);
  const activeTab = useGrainStore((s) => s.activeTab);
  const lang = settings.language as AppLanguage;
  const online = useOnlineStatus();

  const isConnected = deviceState !== 'disconnected' && deviceState !== 'connecting';

  const dotStyle = !isConnected
    ? { background: 'var(--gm-dot-offline, #71717a)', boxShadow: '0 0 8px var(--gm-dot-offline, #71717a)' }
    : {};

  const batteryLow = battery != null && battery < 20;
  const isSettings = activeTab === 'settings';

  return (
    <header className="grain-glass-header">
      <div className="grain-header-inner">
        {/* Left: status dot + title */}
        <div className="grain-header-brand">
          <span className={`grain-status-dot w-2 h-2 rounded-full ${isConnected ? 'grain-status-dot-live' : ''}`} style={dotStyle} />
          <h1 className="grain-header-title">
            {t('app.title', lang)}
          </h1>
        </div>

        {/* Right: compact telemetry + state cluster */}
        <div className="grain-header-actions">
          {battery != null && (
            <div
              className={`grain-battery-capsule ${batteryLow ? 'low' : ''}`}
              role="status"
              aria-label={`${t('metric.battery', lang)} ${battery}%`}
            >
              {batteryLow
                ? <BatteryLow size={12} weight="fill" />
                : <BatteryHigh size={12} weight="fill" />}
              <span>{battery}%</span>
            </div>
          )}
          {!online && (
            <div className="grain-offline-chip" role="status" aria-label={t('header.offline', lang)}>
              <WifiSlash size={11} weight="bold" />
              <span>{t('header.offline', lang)}</span>
            </div>
          )}
          {isSettings && <LanguageSelector />}
        </div>
      </div>
    </header>
  );
}
