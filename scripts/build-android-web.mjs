#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   Isolated Capacitor web build — `bun run android:web`
   ═══════════════════════════════════════════════════════════════
   WHY THIS SCRIPT EXISTS
   ─────────────────────
   With Next.js 16 + `output: 'export'`, `next build` HARDCODES the
   production build output to `<project>/.next` (see
   next/dist/build/index.js: when distDir is customized under the
   export target, Next swaps configOutDir = distDir and forces
   config.distDir = '.next'). A custom `distDir` only relocates the
   final STATIC EXPORT, never the build itself.

   This project keeps a live dev server on port 3000 that owns
   `.next` — clobbering it with production artifacts on every
   Android build is not acceptable. So this script:

     1. Creates an isolated sandbox at <project>/.capacitor-build/
        containing copies of everything the frontend build needs
        (src/, public/, configs) plus a node_modules symlink.
     2. Runs `next build` there with MOCHI_TARGET=capacitor
        (build → .capacitor-build/.next, static export →
        .capacitor-build/.next-capacitor — both isolated).
     3. Copies the exported site to <project>/out/ — the Capacitor
        webDir consumed by `cap sync android`.

   The dev server's .next is never touched. Manual alternative
   (clobbers .next — avoid while the dev server is live):
     MOCHI_TARGET=capacitor bunx next build
   ═══════════════════════════════════════════════════════════════ */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = path.join(projectRoot, '.capacitor-build');
const exportDir = path.join(sandbox, '.next-capacitor');
const finalOut = path.join(projectRoot, 'out');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[android:web] skip (missing): ${path.relative(projectRoot, src)}`);
    return;
  }
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function du(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += fs.statSync(p).size;
    }
  };
  walk(dir);
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n += 1;
    }
  };
  walk(dir);
  return n;
}

console.log('[android:web] 1/4 — preparing isolated build sandbox .capacitor-build/');
rmrf(sandbox);
fs.mkdirSync(sandbox, { recursive: true });

// Frontend build inputs only — no prisma/, db/, android/, docs, etc.
for (const f of [
  'package.json',
  'next.config.ts',
  'tsconfig.json',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'capacitor.config.ts',
  'next-env.d.ts',
]) {
  copyIfExists(path.join(projectRoot, f), path.join(sandbox, f));
}
copyIfExists(path.join(projectRoot, 'src'), path.join(sandbox, 'src'));
copyIfExists(path.join(projectRoot, 'public'), path.join(sandbox, 'public'));

// node_modules + .env are shared via symlinks (single source of truth)
fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
if (fs.existsSync(path.join(projectRoot, '.env'))) {
  fs.symlinkSync(path.join(projectRoot, '.env'), path.join(sandbox, '.env'), 'file');
}

console.log('[android:web] 2/4 — next build (MOCHI_TARGET=capacitor) inside sandbox');
const nextBin = path.join(projectRoot, 'node_modules', '.bin', 'next');
const res = spawnSync(nextBin, ['build'], {
  cwd: sandbox,
  env: { ...process.env, MOCHI_TARGET: 'capacitor', NEXT_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
});
if (res.error) throw res.error;
if (res.status !== 0) {
  console.error(`[android:web] next build failed with exit code ${res.status}`);
  process.exit(res.status ?? 1);
}

if (!fs.existsSync(path.join(exportDir, 'index.html'))) {
  console.error('[android:web] expected static export at .capacitor-build/.next-capacitor/ but index.html is missing');
  process.exit(1);
}

console.log('[android:web] 3/4 — copying static export → out/');
rmrf(finalOut);
fs.cpSync(exportDir, finalOut, { recursive: true });

console.log('[android:web] 4/4 — cleaning sandbox');
rmrf(sandbox);

console.log(`[android:web] DONE — out/ ready for 'cap sync android' (${countFiles(finalOut)} files, ${du(finalOut)})`);
