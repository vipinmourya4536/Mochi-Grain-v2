'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash, Warning } from '@phosphor-icons/react/dist/ssr';
import { haptic, HAPTIC_TOGGLE } from '@/lib/haptics';
import { registerBackConsumer } from '@/lib/back-nav';

/* ═══════════════════════════════════════════════════════════════
   ANIMATED DELETE CONTROL + SHARED CONFIRMATION DIALOG
   ═══════════════════════════════════════════════════════════════
   Adapted from the supplied CSS reference: a compact circular
   control that smoothly expands into a destructive red pill
   revealing its label. Rebuilt as a proper React component with
   the app's design tokens — the snippet was NOT pasted verbatim.

   Safety contract (destructive actions)
   ──────────────────────────────────────
   • Clicking the button NEVER deletes anything by itself. It only
     arms `onActivate`, which the caller wires to open the shared
     ConfirmDialog below. Only the dialog's confirm button performs
     the destructive write.
   • Desktop (hover-capable pointers): the control expands on
     hover/focus into the pill. Touch devices keep the compact
     circle (tap → dialog) so nothing depends on hover.
   • The expansion consumes free flex space to the LEFT of the
     control (it is always the last child of its row), so adjacent
     content never shifts and nothing overflows the card.
   • Accessible: explicit aria-label, visible focus ring, keyboard
     activation, reduced-motion support.

   ConfirmDialog is the ONE shared destructive-confirmation sheet:
   glass card, focus trap, Escape + overlay-click cancel, Android
   Back closes it via the back-nav policy, focus returns to the
   opener. Both Clear History entry points use it. */

export interface DeleteButtonProps {
  /** Accessible name — always localized, never hover-only. */
  ariaLabel: string;
  /** Text revealed when the pill expands. */
  revealText: string;
  /** Opens the confirmation dialog — never performs deletion. */
  onActivate: () => void;
  hapticsEnabled?: boolean;
  disabled?: boolean;
}

export function DeleteButton({
  ariaLabel,
  revealText,
  onActivate,
  hapticsEnabled = false,
  disabled = false,
}: DeleteButtonProps) {
  return (
    <button
      type="button"
      className="grain-del-btn"
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        haptic(hapticsEnabled, 8);
        onActivate();
      }}
    >
      <Trash className="grain-del-icon" size={15} weight="bold" />
      <span className="grain-del-text" aria-hidden="true">{revealText}</span>
    </button>
  );
}

/* ── Shared destructive-confirmation dialog ── */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Disables confirm while a deletion is in flight. */
  processing?: boolean;
  /** Haptics gate — settings.hapticsEnabled. */
  hapticsEnabled?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onOpenChange,
  onConfirm,
  processing = false,
  hapticsEnabled = false,
}: ConfirmDialogProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  const requestClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  /* Focus restore — capture the opener before React moves focus. */
  useEffect(() => {
    if (open) {
      lastFocusRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open]);

  /* Focus trap + Escape (capture phase works even when focus sits
     on body) + focus restore on close. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        requestClose();
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
  }, [open, requestClose]);

  /* Android Back closes this dialog first — handled=true stops the
     shared policy from also navigating (tab → Home). */
  useEffect(() => {
    if (!open) return;
    return registerBackConsumer({
      id: 'mochi-confirm-dialog',
      priority: 30,
      onClose: () => {
        requestClose();
        return true;
      },
    });
  }, [open, requestClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="grain-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mochi-confirm-title"
      aria-describedby="mochi-confirm-desc"
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <div className="grain-modal-card">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center mb-3"
          style={{ background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.25)' }}
        >
          <Warning size={20} weight="fill" style={{ color: '#EF4444' }} />
        </div>
        <h3 id="mochi-confirm-title" className="text-base font-bold tracking-tight mb-1.5" style={{ color: 'var(--gm-text-primary)' }}>
          {title}
        </h3>
        <p id="mochi-confirm-desc" className="text-[12px] leading-relaxed mb-5" style={{ color: 'var(--gm-text-secondary)' }}>
          {description}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            autoFocus
            onClick={requestClose}
            className="flex-1 py-3 rounded-xl text-xs font-bold tracking-wide transition-all active:scale-95 grain-modal-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={processing}
            onClick={() => {
              haptic(hapticsEnabled, HAPTIC_TOGGLE);
              onConfirm();
            }}
            className="flex-1 py-3 rounded-xl text-xs font-bold tracking-wide transition-all active:scale-95 disabled:opacity-50"
            style={{ background: 'rgba(239, 68, 68, 0.14)', color: '#EF4444', border: '1px solid rgba(239, 68, 68, 0.32)' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.querySelector('.grain-app') ?? document.body,
  );
}

/* ── Convenience hook: delete flow with confirmation state ──
   Manages open/processing for a confirm-then-act destructive flow. */

export function useConfirmFlow() {
  const [open, setOpen] = useState(false);
  const [processing, setProcessing] = useState(false);

  const run = useCallback(async (action: () => Promise<void> | void) => {
    setProcessing(true);
    try {
      await action();
    } finally {
      setProcessing(false);
      setOpen(false);
    }
  }, []);

  return { open, setOpen, processing, run };
}
