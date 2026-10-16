import { MochiLoader } from '@/components/grain/mochi-loader';

/* ═══════════════════════════════════════════════════════════════
   BOOT LOADING SCREEN — three-body kinetic mark
   ═══════════════════════════════════════════════════════════════
   Shown by the App Router while the client page boots (first
   load, cold offline start, SW-served navigations). Replaces the
   old static app-icon splash with the three-body animation on
   the neutral system-chrome background (matches theme-color:
   #09090b dark / #f5f5f7 light — never the accent color).

   Styles: .boot-screen in globals.css (theme via
   prefers-color-scheme; the --gm-* tokens are scoped to .grain-app,
   which does not exist yet at this point, so literal neutrals). */

export default function Loading() {
  return (
    <div className="boot-screen" aria-busy="true">
      <MochiLoader size={35} speedSeconds={0.8} />
      <p className="boot-screen-brand">MOCHI GRAIN</p>
    </div>
  );
}
