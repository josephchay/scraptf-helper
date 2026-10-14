import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab should move focus to keep it inside a modal panel, or null to let
 * the browser move it. `items` are the panel's focusable elements in order;
 * `active` is the focused element, or null when focus is on the panel itself
 * or outside it.
 */
export function trapFocusTarget<T>(items: readonly T[], active: T | null, shift: boolean): T | null {
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return null;
  const i = active === null ? -1 : items.indexOf(active);
  if (shift) return i <= 0 ? last : null;
  return i === -1 || i === items.length - 1 ? first : null;
}

/** Right-hand panel over the page. Esc or the backdrop closes it; focus returns to the opener and stays inside while open. */
export function Drawer({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
        return;
      }
      // aria-modal: Tab and Shift+Tab cycle within the panel instead of reaching the hidden page behind it.
      if (e.key === 'Tab' && !e.defaultPrevented && panel.current) {
        const root = panel.current;
        const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
        if (!items.length) {
          e.preventDefault();
          root.focus();
          return;
        }
        const focused = document.activeElement;
        const active = focused instanceof HTMLElement && focused !== root && root.contains(focused) ? focused : null;
        const target = trapFocusTarget(items, active, e.shiftKey);
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const el = opener.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={panel} className="drawer" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
