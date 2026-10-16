'use client';

/* ═══════════════════════════════════════════════════════════════
   Service-worker registration + predictable update flow
   ═══════════════════════════════════════════════════════════════
   Update policy:
   - The page NEVER auto-reloads. A new waiting worker is surfaced as
     an "update ready" banner; the user applies it with an explicit tap.
   - The banner posts SKIP_WAITING; after controllerchange the page
     reloads exactly once (guarded against loops).
   - IndexedDB is untouched by SW updates — readings, settings, and
     language preferences survive every version bump. */

import { useEffect, useState, useCallback } from 'react';

export const SW_UPDATE_EVENT = 'mochi-sw-update-ready';

interface ServiceWorkerWindow extends Window {
  __mochiSwReloaded?: boolean;
}

/** Register /sw.js. Safe to call on every mount; idempotent. */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Only secure contexts (or localhost) support SWs — guard anyway
  if (typeof window !== 'undefined' && !window.isSecureContext) return;

  navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      // Surface an already-waiting worker (missed between page loads)
      if (registration.waiting && navigator.serviceWorker.controller) {
        window.dispatchEvent(new Event(SW_UPDATE_EVENT));
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // An update exists only when a controller is already driving the page
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            window.dispatchEvent(new Event(SW_UPDATE_EVENT));
          }
        });
      });
    })
    .catch(() => {
      // SW registration failure must never break the app
    });
}

/** Tell the waiting worker to take over; reload once it does. */
export function applySwUpdate(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const onControllerChange = () => {
    const w = window as ServiceWorkerWindow;
    if (w.__mochiSwReloaded) return;
    w.__mochiSwReloaded = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange, { once: true });

  navigator.serviceWorker.getRegistration().then((registration) => {
    if (registration?.waiting) {
      registration.waiting.postMessage('SKIP_WAITING');
    } else {
      // Nothing waiting anymore (worker activated meanwhile) — reload anyway
      onControllerChange();
    }
  });
}

/**
 * React hook for the update banner.
 * `updateReady` is true while a new version sits in the waiting state.
 */
export function useSwUpdate(): { updateReady: boolean; applyUpdate: () => void } {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const onReady = () => setUpdateReady(true);
    window.addEventListener(SW_UPDATE_EVENT, onReady);
    return () => window.removeEventListener(SW_UPDATE_EVENT, onReady);
  }, []);

  const apply = useCallback(() => {
    setUpdateReady(false);
    applySwUpdate();
  }, []);

  return { updateReady, applyUpdate: apply };
}
