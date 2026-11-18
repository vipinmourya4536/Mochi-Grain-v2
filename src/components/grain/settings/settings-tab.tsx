'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useGrainStore } from '@/lib/grain-store';
import {
  Cpu, DownloadSimple, ArrowClockwise, Trash, Power, Wrench,
  Sun, Moon, CaretDown, SlidersHorizontal, Palette, Check, Timer,
  DeviceMobile, Archive, UploadSimple, ArrowsClockwise, Warning, FileCsv,
} from '@phosphor-icons/react/dist/ssr';
import { type GrainType, type AccentColor, GRAIN_OPTIONS, SAMPLING_INTERVAL_OPTIONS_MS } from '@/lib/grain-types';
import { t, tp, tGrain, type AppLanguage } from '@/lib/i18n';
import { haptic, HAPTIC_SELECT, HAPTIC_TOGGLE } from '@/lib/haptics';
import { PrecisionSlider } from '@/components/grain/precision-slider';
import { DeleteButton, ConfirmDialog } from '@/components/grain/delete-button';
import { buildReadingsCsv, deliverCsv } from '@/lib/csv-export';
import { playSafeAlert } from '@/lib/alert-sound';
import { usePwaInstall } from '@/lib/pwa';
import { registerBackConsumer } from '@/lib/back-nav';
import { exportBackupJSON, importBackupJSON } from '@/lib/offline-storage';
import {
  sliderBounds, clampThresholdEdit,
  MOISTURE_KEYS, TEMPERATURE_KEYS,
  type ThresholdKey,
} from '@/lib/thresholds';
import { GLASS_MIN, GLASS_MAX, clampGlass } from '@/lib/glass';
import { ENGINE_VERSION } from '@/lib/mochi-engine';
import { format } from 'date-fns';

/** Overall app version — distinct from the engine version (ENGINE_VERSION). */
const APP_VERSION = '2.0.0';

const ACCENT_COLORS: { value: AccentColor; color: string; labelKey: string }[] = [
  { value: 'orange', color: '#F97316', labelKey: 'accent.orange' },
  { value: 'green', color: '#22C55E', labelKey: 'accent.green' },
  { value: 'purple', color: '#A855F7', labelKey: 'accent.purple' },
  { value: 'blue', color: '#3B82F6', labelKey: 'accent.blue' },
  { value: 'teal', color: '#14B8A6', labelKey: 'accent.teal' },
];

/** Human label for a sampling-interval preset (radiogroup + toast).
 *  0 → localized "Realtime"; seconds below a minute, minutes otherwise. */
function samplingLabel(ms: number, lang: AppLanguage): string {
  if (ms <= 0) return t('settings.sampling_realtime', lang);
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function SettingsTab() {
  /* Selector-based subscription (zustand v5): each field re-renders only
     when ITS value changes. `settings` identity is stable while BLE
     packets stream, so this tab no longer re-renders per reading; the
     Device card subscribes to name/meta STRINGS so battery/signal packet
     updates (new deviceInfo objects) don't re-render the whole tab either. */
  const deviceName = useGrainStore((s) => s.deviceInfo?.name ?? null);
  const deviceFirmware = useGrainStore((s) => s.deviceInfo?.firmware ?? null);
  const deviceMeta = useGrainStore(
    (s) => (s.deviceInfo ? `${s.deviceInfo.firmware} · ${s.deviceInfo.platform}` : null),
  );
  const settings = useGrainStore((s) => s.settings);
  const updateSettings = useGrainStore((s) => s.updateSettings);
  const selectGrainType = useGrainStore((s) => s.selectGrainType);
  const disconnectProbe = useGrainStore((s) => s.disconnectProbe);
  const sendProbeCommand = useGrainStore((s) => s.sendProbeCommand);
  const hasDevice = useGrainStore((s) => s.hasDevice);
  const showToast = useGrainStore((s) => s.showToast);
  const { canInstall, isStandalone, promptInstall } = usePwaInstall();

  const lang = settings.language as AppLanguage;
  const isDark = settings.theme === 'dark';
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const hasConnection = hasDevice;

  return (
    <div className="pt-2 pb-6 grain-fade-in grain-stagger">
      <h2 className="text-2xl font-bold tracking-tight mb-1" style={{ color: 'var(--gm-text-primary)' }}>
        {t('settings.title', lang)}
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--gm-text-secondary)' }}>
        {t('settings.desc', lang)}
      </p>

      {/* ═══ BASIC SETTINGS ═══ */}

      {/* ─── Theme Toggle ─── */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('theme.title', lang)}
      </p>
      <div className="grain-card p-4 mb-6">
        <div className="flex justify-between items-center gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'var(--gm-accent-dim)' }}
            >
              {isDark
                ? <Moon size={18} weight="bold" style={{ color: 'var(--gm-accent)' }} />
                : <Sun size={18} weight="bold" style={{ color: 'var(--gm-accent)' }} />}
            </div>
            <div className="min-w-0">
              <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>
                {isDark ? t('theme.dark', lang) : t('theme.light', lang)}
              </span>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--gm-text-tertiary)' }}>
                {t('theme.tap_switch', lang)}
              </p>
            </div>
          </div>
          <ThemePillSwitch
            isDark={isDark}
            label={`${t('theme.title', lang)} — ${isDark ? t('theme.dark', lang) : t('theme.light', lang)}`}
            onToggle={() => {
              haptic(settings.hapticsEnabled, HAPTIC_TOGGLE);
              updateSettings({ theme: isDark ? 'light' : 'dark' });
            }}
          />
        </div>
      </div>

      {/* ─── Accent Color (themes) — lives NEXT to light/dark mode, per UX request:
            persona belongs with the everyday controls, not buried in Advanced ─── */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('accent.title', lang)}
      </p>
      <div className="grain-card p-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: 'var(--gm-accent-dim)' }}
            >
              <Palette size={18} weight="bold" style={{ color: 'var(--gm-accent)' }} />
            </div>
            <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>
              {t('accent.title', lang)}
            </span>
          </div>
        </div>
        <div className="flex justify-between mt-4 px-1">
          {ACCENT_COLORS.map((a) => (
            <div key={a.value} className="flex flex-col items-center gap-1.5">
              <button
                onClick={() => {
                  if (settings.accentColor === a.value) return;
                  haptic(settings.hapticsEnabled, HAPTIC_SELECT);
                  updateSettings({ accentColor: a.value });
                }}
                className={`grain-accent-dot ${settings.accentColor === a.value ? 'selected' : ''}`}
                style={{ background: a.color }}
                aria-label={t(a.labelKey, lang)}
                aria-pressed={settings.accentColor === a.value}
              />
              <span className="text-[9px] font-medium" style={{ color: settings.accentColor === a.value ? 'var(--gm-accent)' : 'var(--gm-text-tertiary)' }}>
                {t(a.labelKey, lang)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ─── Device ─── */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.device', lang)}
      </p>
      <div className="grain-card p-5 mb-6">
        <div className="flex items-center gap-4 mb-5">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'var(--gm-toggle-bg)', border: '1px solid var(--gm-toggle-border)' }}>
            <Cpu size={22} weight="bold" style={{ color: 'var(--gm-text-secondary)' }} />
          </div>
          <div>
            <h3 className="font-bold text-sm tracking-tight" style={{ color: 'var(--gm-text-primary)' }}>
              {deviceName || '—'}
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--gm-text-secondary)' }}>
              {deviceMeta || t('settings.no_device', lang)}
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={async () => {
              if (!hasConnection) {
                showToast(t('settings.connect_first', lang));
                return;
              }
              await sendProbeCommand('calibrate');
            }}
            disabled={!hasConnection}
            className="flex-1 font-bold text-xs py-3.5 rounded-xl active:scale-95 transition-all tracking-wide"
            style={{
              background: hasConnection ? 'var(--gm-btn-primary-bg)' : 'var(--gm-toggle-bg)',
              color: hasConnection ? 'var(--gm-btn-primary-text)' : 'var(--gm-text-tertiary)',
              border: hasConnection ? 'none' : '1px solid var(--gm-toggle-border)',
              cursor: hasConnection ? 'pointer' : 'not-allowed',
            }}
          >
            {t('settings.calibrate', lang)}
          </button>
          {hasConnection ? (
            <button
              onClick={disconnectProbe}
              className="px-4 py-3.5 rounded-xl active:scale-95 transition-all font-bold text-xs"
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                color: '#EF4444',
                border: '1px solid rgba(239, 68, 68, 0.2)',
              }}
            >
              <Power size={18} weight="bold" />
            </button>
          ) : null}
        </div>
      </div>

      {/* ─── Sampling Interval — the "time section": how often live readings
             are CAPTURED. The probe pushes packets at the firmware's pace; this
             gate keeps one per window (realtime = every packet, the previous
             fixed behavior). Enforced in grain-store.handleReading BEFORE any
             storage/evaluation work, so skipped packets cost nothing. ─── */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.sampling', lang)}
      </p>
      <div className="grain-card p-4 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--gm-accent-dim)' }}>
            <Timer size={18} weight="bold" style={{ color: 'var(--gm-accent)' }} />
          </div>
          <div className="min-w-0">
            <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>
              {t('settings.sampling', lang)}
            </span>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--gm-text-tertiary)' }}>
              {t('settings.sampling_desc', lang)}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label={t('settings.sampling', lang)}>
          {SAMPLING_INTERVAL_OPTIONS_MS.map((ms) => {
            const isActive = settings.samplingIntervalMs === ms;
            return (
              <button
                key={ms}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => {
                  if (isActive) return;
                  haptic(settings.hapticsEnabled, HAPTIC_SELECT);
                  updateSettings({ samplingIntervalMs: ms });
                  showToast(tp('toast.sampling_updated', lang, { v: samplingLabel(ms, lang) }));
                }}
                className={`grain-grain-card ${isActive ? 'active' : ''}`}
              >
                <span className="truncate">{samplingLabel(ms, lang)}</span>
                {isActive && <Check size={12} weight="bold" style={{ flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] leading-relaxed mt-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
          {settings.samplingIntervalMs === 0
            ? t('settings.sampling_realtime_hint', lang)
            : t('settings.sampling_hint', lang)}
        </p>
      </div>

      {/* ─── Grain Type – the ONLY grain selector in the app ─── */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.grain_type', lang)}
      </p>
      <div className="grain-card p-2.5 mb-6">
        <div className="grid grid-cols-3 gap-2">
          {GRAIN_OPTIONS.map((g) => {
            const isActive = settings.grainType === g;
            return (
              <button
                key={g}
                onClick={() => {
                  if (g === settings.grainType) return;
                  haptic(settings.hapticsEnabled, HAPTIC_SELECT);
                  selectGrainType(g);
                }}
                className={`grain-grain-card ${isActive ? 'active' : ''}`}
                aria-pressed={isActive}
              >
                <span className="truncate">{tGrain(g, lang)}</span>
                {isActive && <Check size={12} weight="bold" style={{ flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      </div>

      {/* ═══ Threshold sliders live at the VERY BOTTOM of Advanced Settings
             (the last thing in the whole Settings page) — rare, deliberate
             controls belong at the deepest point of the hierarchy. ═══ */}

      {/* ═══ PREFERENCES ═══ */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.preferences', lang)}
      </p>
      <div className="grain-card overflow-hidden mb-6">
        <label className="flex justify-between items-center px-5 py-4 cursor-pointer">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.push_alerts', lang)}</span>
          <input type="checkbox" checked={settings.pushAlerts} onChange={(e) => { updateSettings({ pushAlerts: e.target.checked }); showToast(e.target.checked ? t('toast.alerts_on', lang) : t('toast.alerts_off', lang)); }} className="grain-toggle" />
        </label>
        <div className="grain-separator" />
        <label className="flex justify-between items-center px-5 py-4 cursor-pointer">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.auto_sync', lang)}</span>
          <input type="checkbox" checked={settings.autoSync} onChange={(e) => { updateSettings({ autoSync: e.target.checked }); showToast(e.target.checked ? t('toast.autosync_on', lang) : t('toast.autosync_off', lang)); }} className="grain-toggle" />
        </label>
        <div className="grain-separator" />
        <label className="flex justify-between items-center px-5 py-4 cursor-pointer">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.auto_reconnect', lang)}</span>
          <input type="checkbox" checked={settings.autoReconnect} onChange={(e) => { updateSettings({ autoReconnect: e.target.checked }); }} className="grain-toggle" />
        </label>
        <div className="grain-separator" />
        <label className="flex justify-between items-center px-5 py-4 cursor-pointer">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.haptics', lang)}</span>
          <input type="checkbox" checked={settings.hapticsEnabled} onChange={(e) => { updateSettings({ hapticsEnabled: e.target.checked }); haptic(e.target.checked, 14); }} className="grain-toggle" />
        </label>
        <div className="grain-separator" />
        <label className="flex justify-between items-center px-5 py-4 cursor-pointer">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.sound', lang)}</span>
          <input type="checkbox" checked={settings.soundAlerts} onChange={(e) => { updateSettings({ soundAlerts: e.target.checked }); if (e.target.checked) playSafeAlert(true); }} className="grain-toggle" />
        </label>
        <div className="grain-separator" />
        <label className="flex justify-between items-center px-5 py-4 cursor-pointer">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.wake_on_connect', lang)}</span>
          <input type="checkbox" checked={settings.wakeOnConnect} onChange={(e) => { updateSettings({ wakeOnConnect: e.target.checked }); }} className="grain-toggle" />
        </label>
      </div>

      {/* ─── Install App (PWA) ─── */}
      {canInstall && !isStandalone && (
        <div className="grain-card overflow-hidden mb-6">
          <button
            onClick={async () => {
              const outcome = await promptInstall();
              if (outcome === 'accepted') showToast(t('toast.install_ok', lang));
              else if (outcome === 'dismissed') showToast(t('toast.install_dismissed', lang));
            }}
            className="w-full flex justify-between items-center px-5 py-4 grain-row text-left"
            style={{ color: 'var(--gm-text-primary)' }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--gm-accent-dim)' }}>
                <DeviceMobile size={18} weight="bold" style={{ color: 'var(--gm-accent)' }} />
              </div>
              <span className="text-sm font-medium">{t('settings.install_app', lang)}</span>
            </div>
            <span className="text-[11px]" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.install_desc', lang)}</span>
          </button>
        </div>
      )}

      {/* ═══ ABOUT ═══ */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.about', lang)}
      </p>
      <div className="grain-card overflow-hidden mb-6">
        <div className="flex justify-between items-center px-5 py-4">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.app_version', lang)}</span>
          <span className="text-[11px]" style={{ color: 'var(--gm-text-secondary)' }}>Mochi Grain {APP_VERSION}</span>
        </div>
        <div className="grain-separator" />
        <div className="flex justify-between items-center px-5 py-4">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.engine', lang)}</span>
          <span className="text-[11px]" style={{ color: 'var(--gm-text-secondary)' }}>Mochi Engine v{ENGINE_VERSION}</span>
        </div>
        <div className="grain-separator" />
        <div className="flex justify-between items-center px-5 py-4">
          <span className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.probe_firmware', lang)}</span>
          <span className="text-[11px]" style={{ color: 'var(--gm-text-secondary)' }}>{deviceFirmware || '—'}</span>
        </div>
      </div>

      <div className="text-center pb-4">
        <p className="text-[10px]" style={{ color: 'var(--gm-text-tertiary)' }}>
          {t('settings.built_for', lang)}
        </p>
      </div>

      {/* ═══ ADVANCED SETTINGS (collapsed) ═══ */}
      <button
        className="grain-advanced-toggle mb-4"
        onClick={() => setAdvancedOpen(prev => !prev)}
      >
        <div className="flex items-center gap-3">
          <SlidersHorizontal size={18} weight="bold" style={{ color: 'var(--gm-accent)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--gm-text-primary)' }}>
            {t('settings.advanced', lang)}
          </span>
        </div>
        <CaretDown
          size={18}
          weight="bold"
          className={`grain-chevron ${advancedOpen ? 'rotated' : ''}`}
          style={{ color: 'var(--gm-text-tertiary)' }}
        />
      </button>

      <div className={`grain-advanced-content ${advancedOpen ? 'expanded' : 'collapsed'}`}>
        {advancedOpen && <AdvancedSettingsContent />}
      </div>
    </div>
  );
}

function AdvancedSettingsContent() {
  /* Selector-based subscription — see SettingsTab note. historyCount (a
     number) replaces the historyEntries ARRAY so live packets streaming in
     don't re-render this whole panel, only the count changes it displays. */
  const settings = useGrainStore((s) => s.settings);
  const updateSettings = useGrainStore((s) => s.updateSettings);
  const sendProbeCommand = useGrainStore((s) => s.sendProbeCommand);
  const syncProbeHistory = useGrainStore((s) => s.syncProbeHistory);
  const clearHistory = useGrainStore((s) => s.clearHistory);
  const hasDevice = useGrainStore((s) => s.hasDevice);
  const showToast = useGrainStore((s) => s.showToast);
  const historyCount = useGrainStore((s) => s.historyEntries.length);
  const loadHistory = useGrainStore((s) => s.loadHistory);
  const loadSettings = useGrainStore((s) => s.loadSettings);

  const lang = settings.language as AppLanguage;
  const hasConnection = hasDevice;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importModeRef = useRef<'merge' | 'replace'>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  /* Focus trap + focus restore for the destructive confirmation modal.
     Tab/Shift+Tab cycle inside the dialog; Escape closes (capture-phase,
     works even when focus sits on body); on close, focus returns to the
     element that opened the dialog (captured in the click handler — by the
     time the open-effect runs, React has already applied autoFocus to the
     Cancel button, so the effect would otherwise capture the dialog itself). */
  const openReplaceModal = () => {
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    setConfirmReplace(true);
  };

  useEffect(() => {
    if (!confirmReplace) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setConfirmReplace(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const focusables = Array.from(
        overlay.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !overlay.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !overlay.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      lastFocusRef.current?.focus?.();
    };
  }, [confirmReplace]);

  /* Android Back closes this confirmation first — it must NOT also trigger
   * the parent Settings tab's back handler (handled=true stops the policy). */
  useEffect(() => {
    if (!confirmReplace) return;
    return registerBackConsumer({
      id: 'settings-replace-modal',
      priority: 30,
      onClose: () => {
        setConfirmReplace(false);
        return true;
      },
    });
  }, [confirmReplace]);

  const openImportPicker = (mode: 'merge' | 'replace') => {
    importModeRef.current = mode;
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    const mode = importModeRef.current;
    try {
      const text = await file.text();
      const result = await importBackupJSON(text, mode);
      // Refresh the live store from the restored database
      await loadHistory();
      await loadSettings();
      showToast(`${t(mode === 'replace' ? 'toast.backup_replaced' : 'toast.backup_imported', lang)} · ${result.history}`);
    } catch (err) {
      showToast(err instanceof Error && err.message === 'invalid'
        ? t('toast.import_invalid', lang)
        : t('toast.import_failed', lang));
    }
  };

  return (
    <>
      {/* ─── Glass Intensity (advanced, one compact row) ─── */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1 mt-4" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.glass', lang)}
      </p>
      <GlassIntensityCard lang={lang} />

      {/* ─── Probe Controls ─── */}
      {hasConnection && (
        <>
          <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
            {t('settings.probe_controls', lang)}
          </p>
          <div className="grain-card overflow-hidden mb-6">
            <button
              onClick={syncProbeHistory}
              className="w-full flex justify-between items-center px-5 py-4 grain-row text-left"
              style={{ color: 'var(--gm-text-primary)' }}
            >
              <div className="flex items-center gap-3">
                <ArrowClockwise size={18} weight="bold" style={{ color: 'var(--gm-text-secondary)' }} />
                <span className="text-sm font-medium">{t('settings.sync_history', lang)}</span>
              </div>
              <span className="text-[11px]" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.sync_history_desc', lang)}</span>
            </button>
            <div className="grain-separator" />
            <button
              onClick={() => sendProbeCommand('wake')}
              className="w-full flex justify-between items-center px-5 py-4 grain-row text-left"
              style={{ color: 'var(--gm-text-primary)' }}
            >
              <div className="flex items-center gap-3">
                <Wrench size={18} weight="bold" style={{ color: 'var(--gm-text-secondary)' }} />
                <span className="text-sm font-medium">{t('settings.wake_probe', lang)}</span>
              </div>
              <span className="text-[11px]" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.wake_probe_desc', lang)}</span>
            </button>
          </div>
        </>
      )}

      {/* ─── Export / Data ─── */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.data', lang)}
      </p>
      <div className="grain-card overflow-hidden mb-8">
        {/* Decision columns toggle — controls BOTH CSV entry points
            (this row + the History header export) via settings.exportDecisions */}
        <div className="flex justify-between items-center gap-4 px-5 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--gm-accent-dim)' }}>
              <FileCsv size={18} weight="bold" style={{ color: 'var(--gm-accent)' }} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium" style={{ color: 'var(--gm-text-primary)' }}>{t('settings.export_decisions', lang)}</p>
              <p className="text-[10px] leading-snug mt-0.5" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.export_decisions_desc', lang)}</p>
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.exportDecisions}
            onChange={(e) => { updateSettings({ exportDecisions: e.target.checked }); haptic(e.target.checked, 10); }}
            className="grain-toggle shrink-0"
            aria-label={t('settings.export_decisions', lang)}
          />
        </div>
        <div className="grain-separator" />
        <button
          onClick={async () => {
            if (historyCount === 0) {
              showToast(t('toast.nothing_to_export', lang));
              return;
            }
            haptic(settings.hapticsEnabled, 8);
            try {
              /* Client-side builder — the readings live in this browser's
               * IndexedDB; a server route can never read them (the old
               * /api/export endpoint always failed with 500). Entries are
               * read at click time via getState() (always fresh, and no
               * per-packet re-render subscription on this panel). */
              const entries = useGrainStore.getState().historyEntries;
              const csv = buildReadingsCsv(entries, lang, settings.exportDecisions);
              const filename = `mochi-grain-readings-${format(Date.now(), 'yyyy-MM-dd')}.csv`;
              const outcome = await deliverCsv(csv, filename);
              if (outcome !== 'cancelled') showToast(tp('toast.exported', lang, { n: historyCount }));
            } catch {
              showToast(t('toast.export_failed', lang));
            }
          }}
          className="w-full flex justify-between items-center px-5 py-4 grain-row text-left"
          style={{ color: 'var(--gm-text-primary)' }}
        >
          <div className="flex items-center gap-3">
            <DownloadSimple size={18} weight="bold" style={{ color: 'var(--gm-text-secondary)' }} />
            <span className="text-sm font-medium">{t('settings.export_csv', lang)}</span>
          </div>
          <span className="text-[11px]" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.download', lang)}</span>
        </button>
        <div className="grain-separator" />
        <button
          onClick={async () => {
            try {
              const json = await exportBackupJSON();
              const blob = new Blob([json], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url;
              a.download = `grain-backup-${new Date().toISOString().split('T')[0]}.json`;
              a.click(); URL.revokeObjectURL(url);
              showToast(t('toast.backup_exported', lang));
            } catch { showToast(t('toast.export_failed', lang)); }
          }}
          className="w-full flex justify-between items-center px-5 py-4 grain-row text-left"
          style={{ color: 'var(--gm-text-primary)' }}
        >
          <div className="flex items-center gap-3">
            <Archive size={18} weight="bold" style={{ color: 'var(--gm-text-secondary)' }} />
            <span className="text-sm font-medium">{t('settings.export_backup', lang)}</span>
          </div>
          <span className="text-[11px]" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.full_data', lang)}</span>
        </button>
        <div className="grain-separator" />
        <button
          onClick={() => openImportPicker('merge')}
          className="w-full flex justify-between items-center px-5 py-4 grain-row text-left"
          style={{ color: 'var(--gm-text-primary)' }}
        >
          <div className="flex items-center gap-3">
            <UploadSimple size={18} weight="bold" style={{ color: 'var(--gm-text-secondary)' }} />
            <span className="text-sm font-medium">{t('settings.import_backup', lang)}</span>
          </div>
          <span className="text-[11px]" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.full_data', lang)}</span>
        </button>
        <div className="grain-separator" />
        <button
          onClick={openReplaceModal}
          className="w-full flex justify-between items-center px-5 py-4 grain-row text-left"
          style={{ color: '#EF4444' }}
        >
          <div className="flex items-center gap-3">
            <ArrowsClockwise size={18} weight="bold" style={{ color: '#EF4444' }} />
            <span className="text-sm font-medium">{t('settings.replace_data', lang)}</span>
          </div>
          <span className="text-[11px]" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.replace_desc', lang)}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImportFile}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* Replace-all confirmation modal (glass, app-token themed)
            Portaled into .grain-app: CSS vars are scoped there, and it has no
            transform/filter, so position:fixed still tracks the viewport. */}
        {confirmReplace && typeof document !== 'undefined' && createPortal(
          <div
            ref={overlayRef}
            className="grain-modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="grain-replace-title"
            onClick={(e) => { if (e.target === e.currentTarget) setConfirmReplace(false); }}
            onKeyDown={(e) => { if (e.key === 'Escape') setConfirmReplace(false); }}
          >
            <div className="grain-modal-card">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-3" style={{ background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.25)' }}>
                <Warning size={20} weight="fill" style={{ color: '#EF4444' }} />
              </div>
              <h3 id="grain-replace-title" className="text-base font-bold tracking-tight mb-1.5" style={{ color: 'var(--gm-text-primary)' }}>
                {t('settings.replace_confirm_title', lang)}
              </h3>
              <p className="text-[12px] leading-relaxed mb-5" style={{ color: 'var(--gm-text-secondary)' }}>
                {t('settings.replace_confirm_desc', lang)}
              </p>
              <div className="flex gap-3">
                <button
                  autoFocus
                  onClick={() => setConfirmReplace(false)}
                  className="flex-1 py-3 rounded-xl text-xs font-bold tracking-wide transition-all active:scale-95 grain-modal-cancel"
                >
                  {t('settings.cancel', lang)}
                </button>
                <button
                  onClick={() => {
                    setConfirmReplace(false);
                    openImportPicker('replace');
                  }}
                  className="flex-1 py-3 rounded-xl text-xs font-bold tracking-wide transition-all active:scale-95"
                  style={{ background: 'rgba(239, 68, 68, 0.14)', color: '#EF4444', border: '1px solid rgba(239, 68, 68, 0.32)' }}
                >
                  {t('settings.replace_confirm_action', lang)}
                </button>
              </div>
            </div>
          </div>,
          document.querySelector('.grain-app') ?? document.body,
        )}
        <div className="grain-separator" />
        {/* Clear history — animated delete control. Clicking NEVER deletes:
            it arms the shared confirmation dialog; only an explicit confirm
            performs the destructive write. The row's free space sits to the
            LEFT of the control, so the hover expansion shifts nothing. */}
        <div className="flex justify-between items-center gap-3 py-2.5 pl-5 pr-3">
          <div className="flex items-center gap-3 min-w-0">
            <Trash size={18} weight="bold" style={{ color: '#EF4444', flexShrink: 0 }} />
            <div className="min-w-0">
              <p className="text-sm font-medium m-0" style={{ color: '#EF4444' }}>{t('settings.clear_history', lang)}</p>
              <p className="text-[10px] mt-0.5 mb-0" style={{ color: 'var(--gm-text-tertiary)' }}>{t('settings.local_only', lang)}</p>
            </div>
          </div>
          <DeleteButton
            ariaLabel={t('settings.clear_history', lang)}
            revealText={t('settings.delete', lang)}
            onActivate={() => setConfirmClear(true)}
            hapticsEnabled={settings.hapticsEnabled}
          />
        </div>

        {/* Clear-history confirmation (shared glass dialog; Android Back
            closes this first, Escape cancels, focus is trapped+restored). */}
        <ConfirmDialog
          open={confirmClear}
          onOpenChange={setConfirmClear}
          title={t('settings.clear_confirm_title', lang)}
          description={tp('settings.clear_confirm_desc', lang, { n: historyCount })}
          confirmLabel={t('settings.clear_confirm_action', lang)}
          cancelLabel={t('settings.cancel', lang)}
          hapticsEnabled={settings.hapticsEnabled}
          onConfirm={async () => {
            await clearHistory();
            showToast(t('toast.history_cleared', lang));
          }}
        />
      </div>

      {/* ─── Thresholds — the VERY LAST section of the entire Settings page
             (Advanced Settings → bottom): rare, deliberate, protective controls
             sit at the deepest point of the hierarchy so nobody touches the
             sliders unless it is genuinely necessary. ONE compact segmented
             panel (moisture | temperature). ─── */}
      <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-3 px-1 mt-2" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.thresholds', lang)}
      </p>
      <p className="text-[10px] leading-relaxed mb-3 px-1" style={{ color: 'var(--gm-text-tertiary)', opacity: 0.9 }}>
        {t('settings.thresholds_note', lang)}
      </p>
      <ThresholdsPanel lang={lang} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   THRESHOLD EDITING (Advanced Settings)
   ONE compact segmented panel: Moisture | Temperature. Only
   the selected metric's three rows are mounted — switching
   segments never touches stored values. Each row: severity
   chip, live numeric value, PrecisionSlider (ordering enforced
   by sliderBounds() — safe < warn < critical is unproducible).
   Persisted via the standard updateSettings() flow; Mochi
   re-evaluates automatically against the new thresholds.
   ═══════════════════════════════════════════════════════════ */

const THRESHOLD_ROW_META: Record<ThresholdKey, { labelKey: string; colorVar: string; unit: string; prefix: string }> = {
  safe:         { labelKey: 'settings.safe',         colorVar: 'var(--gm-band-excellent)', unit: '%',  prefix: '<' },
  warn:         { labelKey: 'settings.warn',         colorVar: 'var(--gm-band-fair)',      unit: '%',  prefix: '>' },
  critical:     { labelKey: 'settings.critical',     colorVar: 'var(--gm-band-risky)',     unit: '%',  prefix: '>' },
  tempSafe:     { labelKey: 'settings.safe',         colorVar: 'var(--gm-band-excellent)', unit: '°C', prefix: '<' },
  tempWarn:     { labelKey: 'settings.warn',         colorVar: 'var(--gm-band-fair)',      unit: '°C', prefix: '>' },
  tempCritical: { labelKey: 'settings.critical',     colorVar: 'var(--gm-band-risky)',     unit: '°C', prefix: '>' },
};

type ThresholdMetric = 'moisture' | 'temperature';

function ThresholdsPanel({ lang }: { lang: AppLanguage }) {
  /* Selector-based subscription — settings identity is stable while
     readings stream, so slider dragging and packet arrival never fight
     over re-renders. */
  const settings = useGrainStore((s) => s.settings);
  const updateSettings = useGrainStore((s) => s.updateSettings);
  const showToast = useGrainStore((s) => s.showToast);
  const [metric, setMetric] = useState<ThresholdMetric>('moisture');
  const hapticsEnabled = settings.hapticsEnabled;

  /* Read fresh state on every edit — no stale-neighbour clamping
     even if two change events batch into one render. */
  const update = (key: ThresholdKey, value: number) => {
    const current = useGrainStore.getState().settings.thresholds;
    const next = clampThresholdEdit(current, key, value);
    if (next === current) return; // clamped to the same value — no write
    updateSettings({ thresholds: next });
  };

  // Re-evaluating Mochi against the new thresholds happens automatically:
  // grain-store reads settings.thresholds on every evaluation.
  const commitToast = (key: ThresholdKey, committed: number) => {
    showToast(tp('toast.threshold_updated', lang, {
      v: `${committed.toFixed(1)}${THRESHOLD_ROW_META[key].unit}`,
    }));
  };

  const keys: ThresholdKey[] = metric === 'moisture' ? MOISTURE_KEYS : TEMPERATURE_KEYS;

  return (
    <div className="grain-card p-4 mb-2">
      {/* Segmented metric selector — switching NEVER alters stored values */}
      <div
        className="grain-seg grain-seg-lg mb-4"
        role="tablist"
        aria-label={t('settings.thresholds', lang)}
      >
        <button
          role="tab"
          aria-selected={metric === 'moisture'}
          className={metric === 'moisture' ? 'active' : ''}
          onClick={() => {
            if (metric === 'moisture') return;
            haptic(hapticsEnabled, HAPTIC_SELECT);
            setMetric('moisture');
          }}
        >
          {t('history.moisture', lang)}
        </button>
        <button
          role="tab"
          aria-selected={metric === 'temperature'}
          className={metric === 'temperature' ? 'active' : ''}
          onClick={() => {
            if (metric === 'temperature') return;
            haptic(hapticsEnabled, HAPTIC_SELECT);
            setMetric('temperature');
          }}
        >
          {t('history.temperature', lang)}
        </button>
      </div>

      <div className="space-y-4">
        {keys.map((key) => {
          const meta = THRESHOLD_ROW_META[key];
          const thresholds = settings.thresholds;
          const bounds = sliderBounds(thresholds, key);
          const value = thresholds[key];
          return (
            <div key={key} className="grain-th-row">
              <div className="flex justify-between items-center mb-0.5">
                <span className="grain-th-chip" style={{ color: meta.colorVar }}>
                  <span className="grain-th-chip-dot" style={{ background: meta.colorVar }} aria-hidden="true" />
                  {t(meta.labelKey, lang)}
                </span>
                <span className="text-sm font-bold grain-tabular" style={{ color: 'var(--gm-text-primary)' }}>
                  {meta.prefix} {value.toFixed(1)}{meta.unit}
                </span>
              </div>
              <PrecisionSlider
                min={bounds.min}
                max={bounds.max}
                step={0.5}
                value={value}
                onValueChange={(v) => update(key, v)}
                onValueCommit={(v) => commitToast(key, v)}
                ariaLabel={`${t(meta.labelKey, lang)} — ${metric === 'moisture' ? t('history.moisture', lang) : t('history.temperature', lang)}`}
                format={(v) => `${v.toFixed(1)}${meta.unit}`}
                hapticsEnabled={hapticsEnabled}
                colorVar={meta.colorVar}
              />
            </div>
          );
        })}
      </div>
      <p className="text-[10px] leading-relaxed mt-4 mb-0" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.thresholds_desc', lang)}
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   GLASS INTENSITY (Advanced Settings)
   One compact glass-control row driving computeGlassVars()
   live via settings.glassOpacity. 30% = subtle frosting ·
   100% = pronounced liquid glass. Persists through
   updateSettings — survives reloads, theme switches and
   (via IndexedDB) app restarts.
   ═══════════════════════════════════════════════════════════ */

function GlassIntensityCard({ lang }: { lang: AppLanguage }) {
  const { settings, updateSettings } = useGrainStore();
  const pct = Math.round(clampGlass(settings.glassOpacity) * 100);
  const minPct = Math.round(GLASS_MIN * 100);
  const maxPct = Math.round(GLASS_MAX * 100);

  return (
    <div className="grain-card p-4 mb-6">
      <div className="flex justify-between items-center mb-0.5">
        <span
          className="text-[10px] font-bold tracking-[0.14em] uppercase"
          style={{ color: 'var(--gm-text-secondary)' }}
        >
          {t('settings.glass', lang)}
        </span>
        <output
          className="text-sm font-bold grain-tabular"
          style={{ color: 'var(--gm-accent)' }}
        >
          {pct}%
        </output>
      </div>
      <PrecisionSlider
        min={minPct}
        max={maxPct}
        step={5}
        value={pct}
        onValueChange={(v) => updateSettings({ glassOpacity: v / 100 })}
        ariaLabel={t('settings.glass', lang)}
        format={(v) => `${Math.round(v)}%`}
        hapticsEnabled={settings.hapticsEnabled}
        colorVar="var(--gm-accent)"
      />
      <p className="text-[10px] leading-relaxed mt-2 mb-0" style={{ color: 'var(--gm-text-tertiary)' }}>
        {t('settings.glass_hint', lang)}
      </p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   THEME PILL SWITCH — premium neutral instrument toggle
   Slender track, precise circular thumb, sun/moon glyphs,
   restrained 240ms travel. Neutral track + thumb colors in
   BOTH themes (a tiny accent appears only on the leading icon
   box, never on the switch itself — the switch and the system
   chrome must never flood with the accent color).
   Proper switch semantics: role=switch, aria-checked,
   keyboard activation, visible focus ring.
   ═══════════════════════════════════════════════════════════ */

function ThemePillSwitch({
  isDark,
  label,
  onToggle,
}: {
  isDark: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={label}
      onClick={onToggle}
      className={`grain-theme-pill ${isDark ? 'is-dark' : 'is-light'}`}
    >
      <span className="grain-theme-pill-glyph glyph-left" aria-hidden="true">
        <Sun size={10} weight="fill" />
      </span>
      <span className="grain-theme-pill-glyph glyph-right" aria-hidden="true">
        <Moon size={10} weight="fill" />
      </span>
      <span className="grain-theme-pill-thumb" aria-hidden="true">
        {isDark ? <Moon size={11} weight="fill" /> : <Sun size={11} weight="fill" />}
      </span>
    </button>
  );
}
