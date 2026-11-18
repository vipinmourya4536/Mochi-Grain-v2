'use client';

import { useGrainStore, type TabId } from '@/lib/grain-store';
import {
  House,
  Compass,
  ClockCounterClockwise,
  Gear,
} from '@phosphor-icons/react/dist/ssr';
import { t, type AppLanguage } from '@/lib/i18n';
import { haptic, HAPTIC_TAP } from '@/lib/haptics';

const TABS: { id: TabId; icon: typeof House; labelKey: string }[] = [
  { id: 'home', icon: House, labelKey: 'nav.home' },
  { id: 'history', icon: ClockCounterClockwise, labelKey: 'nav.history' },
  { id: 'discover', icon: Compass, labelKey: 'nav.discover' },
  { id: 'settings', icon: Gear, labelKey: 'nav.settings' },
];

/**
 * Floating frosted-glass navigation.
 * Physical glass: translucent gradient surface, blurred, upper reflection line,
 * subtle ambient shadow, soft accent light bleeding through behind the active tab.
 */
export function BottomNav() {
  /* Selector-based subscription — the nav repaints on tab/language/haptic
     changes only; BLE packet churn never re-renders the navigation. */
  const activeTab = useGrainStore((s) => s.activeTab);
  const setActiveTab = useGrainStore((s) => s.setActiveTab);
  const hapticsEnabled = useGrainStore((s) => s.settings.hapticsEnabled);
  const lang = useGrainStore((s) => s.settings.language) as AppLanguage;

  return (
    <nav className="grain-floating-nav" aria-label="Primary">
      <div className="grain-floating-nav-inner">
        {TABS.map(({ id, icon: Icon, labelKey }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => {
                if (id === activeTab) return;
                haptic(hapticsEnabled, HAPTIC_TAP);
                setActiveTab(id);
              }}
              className={`grain-nav-btn ${isActive ? 'active' : ''}`}
              aria-label={t(labelKey, lang)}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="grain-nav-icon">
                <Icon size={22} weight={isActive ? 'fill' : 'bold'} />
              </span>
              <span className="grain-nav-label">{t(labelKey, lang)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
