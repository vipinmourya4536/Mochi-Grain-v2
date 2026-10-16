import type { NextConfig } from "next";

/* ═══════════════════════════════════════════════════════════════
   Dual build target
   ──────────────
   DEFAULT (no env): `output: "standalone"` — the hosted PWA
   deployment. The Node server stays; service worker handles offline.

   MOCHI_TARGET=capacitor: full STATIC EXPORT for the Android APK
   shell (Capacitor webDir: 'out'). The app is 100% client-side
   (no /api routes, no server-only imports), so a static export is
   valid. Isolated distDir '.next-capacitor' so the export NEVER
   clobbers the dev server's .next directory. Trigger with:
     MOCHI_TARGET=capacitor bunx next build
   (or `bun run android:web`).
   ═══════════════════════════════════════════════════════════════ */
const isCapacitorTarget = process.env.MOCHI_TARGET === "capacitor";

const nextConfig: NextConfig = isCapacitorTarget
  ? {
      output: "export",           // static site → out/
      distDir: ".next-capacitor", // keep away from the live dev server's .next
      images: { unoptimized: true }, // required by `output: export` (no server-side optimizer)
      typescript: {
        ignoreBuildErrors: true,
      },
      reactStrictMode: false,
    }
  : {
      output: "standalone",
      /* Allow the sandbox preview hosts to load /_next/* dev assets without
         triggering the cross-origin dev warning (Next dev-tools "Issue" badge). */
      allowedDevOrigins: ["preview-chat-*.space-z.ai"],
      /* The floating dev-tools indicator bubble overlaps the bottom-left nav
         item at mobile widths — disable it (dev-only, no production impact). */
      devIndicators: false,
      typescript: {
        ignoreBuildErrors: true,
      },
      reactStrictMode: false,
    };

export default nextConfig;
