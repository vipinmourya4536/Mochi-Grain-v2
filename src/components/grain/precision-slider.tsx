'use client';

import { useMemo, useRef, useState } from 'react';
import { createHapticTicker, haptic, HAPTIC_SELECT } from '@/lib/haptics';

/* ═══════════════════════════════════════════════════════════════
   PRECISION SLIDER — compact instrument control for Mochi Grain
   ═══════════════════════════════════════════════════════════════
   A reusable slider for threshold values and glass intensity.

   Interaction model
   ─────────────────
   The REAL <input type="range"> stays in the DOM, stretched
   invisibly across the whole control. Drag, tap-to-jump, arrow
   keys, Home/End, screen-reader announcements and form semantics
   are all the browser's own battle-tested behavior — there is no
   custom drag math to break. The visible layer (slim rail, active
   fill, tactile thumb, drag bubble) is painted underneath and is
   purely decorative (aria-hidden).

   Visual behavior
   ───────────────
   • Rest: 4px rail, subtle active-range fill, 16px layered thumb.
   • Drag: thumb grows slightly, a small value bubble appears
     above it (clamped so it never leaves the card), the fill and
     thumb track the pointer with zero positional lag.
   • Keyboard focus: a restrained accent ring on the thumb.

   Haptics
   ───────
   A tiny tick fires only when the committed value crosses a
   discrete step (value actually changed) and the ticker's own
   throttle window (40 ms) has elapsed — never per pointer move,
   never per frame. A subtle confirmation tap fires on release.
   All feedback is gated by settings.hapticsEnabled and fails
   silently on platforms without a haptics engine.

   Reduced motion: every transition lives in CSS behind the
   prefers-reduced-motion guard in globals.css. */

export interface PrecisionSliderProps {
  min: number;
  max: number;
  step: number;
  value: number;
  /** Continuous update while dragging / on keyboard steps. */
  onValueChange: (value: number) => void;
  /** Fired once when a drag or keyboard interaction settles. */
  onValueCommit?: (value: number) => void;
  /** Accessible name (visible label is rendered by the caller). */
  ariaLabel: string;
  /** Formats the bubble + aria-valuetext, e.g. `14.5%`. */
  format?: (value: number) => string;
  /** Haptics gate — settings.hapticsEnabled. */
  hapticsEnabled?: boolean;
  /** CSS color for the active fill / thumb (defaults to accent). */
  colorVar?: string;
  disabled?: boolean;
  className?: string;
  /** Optional id for the inner native input (label htmlFor association). */
  inputId?: string;
}

/** Visible thumb diameter — keep in sync with the CSS tokens. */
const THUMB_PX = 16;

export function PrecisionSlider({
  min,
  max,
  step,
  value,
  onValueChange,
  onValueCommit,
  ariaLabel,
  format,
  hapticsEnabled = false,
  colorVar,
  disabled = false,
  className = '',
  inputId,
}: PrecisionSliderProps) {
  const [dragging, setDragging] = useState(false);
  /** Last value we haptic-ticked for, so we only fire on real steps. */
  const lastTickRef = useRef<number>(value);

  const tick = useMemo(() => createHapticTicker(hapticsEnabled), [hapticsEnabled]);

  const range = Math.max(max - min, Number.EPSILON);
  const pct = Math.min(1, Math.max(0, (value - min) / range));
  const display = format ? format(value) : String(value);

  /* Thumb center = pct × (track − thumb) + thumb/2 — identical to
     the browser's own thumb travel, so the visual and the real
     hit-position never drift apart. */
  const center = `calc(${pct} * (100% - ${THUMB_PX}px) + ${THUMB_PX / 2}px)`;
  /* Bubble center clamped inward so it can never clip against the
     card's overflow:hidden at the extreme ends. */
  const bubbleCenter = `clamp(26px, ${center}, calc(100% - 26px))`;

  const handleChange = (raw: number) => {
    const next = Math.min(max, Math.max(min, raw));
    if (next !== lastTickRef.current) {
      lastTickRef.current = next;
      tick(); // throttled inside createHapticTicker
    }
    onValueChange(next);
  };

  const settle = () => {
    if (!dragging) return; // keyboard commits are handled in onKeyDown
    setDragging(false);
    onValueCommit?.(value);
  };

  return (
    <div className={`grain-pslider ${dragging ? 'dragging' : ''} ${disabled ? 'disabled' : ''} ${className}`}>
      <input
        type="range"
        id={inputId}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={display}
        onChange={(e) => handleChange(parseFloat(e.target.value))}
        onPointerDown={() => { lastTickRef.current = value; setDragging(true); }}
        onPointerUp={settle}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(e) => {
          // Arrow/Home/End steps commit per-press (no drag session).
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
            window.setTimeout(() => onValueCommit?.(parseFloat((e.target as HTMLInputElement).value)), 0);
            haptic(hapticsEnabled, HAPTIC_SELECT);
          }
        }}
      />
      <div className="grain-pslider-vis" aria-hidden="true">
        <div className="grain-pslider-rail" />
        <div
          className="grain-pslider-fill"
          style={{
            width: `calc(${pct} * (100% - ${THUMB_PX}px) + ${THUMB_PX / 2}px)`,
            ...(colorVar ? { background: colorVar } : {}),
          }}
        />
        <div
          className="grain-pslider-bubble"
          style={{ left: bubbleCenter, ...(colorVar ? { color: colorVar } : {}) }}
        >
          {display}
        </div>
        <div
          className="grain-pslider-thumb"
          style={{ left: center, ...(colorVar ? { borderColor: colorVar, background: colorVar } : {}) }}
        />
      </div>
    </div>
  );
}
