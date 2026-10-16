'use client';

import type { CSSProperties } from 'react';

/* ═══════════════════════════════════════════════════════════════
   MOCHI LOADER — "three-body" kinetic loading mark
   ═══════════════════════════════════════════════════════════════
   Replaces the plain app-icon loading screen with a compact
   three-dot orbital animation (user-supplied reference, rebuilt
   as a typed component; geometry and timing preserved).

   Color defaults to the reference violet #5D3FD3; callers may
   pass `color` (any CSS color) to theme it. All animation lives
   in globals.css behind the prefers-reduced-motion guard. */

export interface MochiLoaderProps {
  size?: number;
  speedSeconds?: number;
  color?: string;
  className?: string;
}

export function MochiLoader({
  size = 35,
  speedSeconds = 0.8,
  color,
  className = '',
}: MochiLoaderProps) {
  const style = {
    '--uib-size': `${size}px`,
    '--uib-speed': `${speedSeconds}s`,
    ...(color ? { '--uib-color': color } : {}),
  } as CSSProperties;

  return (
    <div className={`mochi-three-body ${className}`} style={style} role="status" aria-live="polite">
      <span className="mochi-three-body__dot" />
      <span className="mochi-three-body__dot" />
      <span className="mochi-three-body__dot" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
