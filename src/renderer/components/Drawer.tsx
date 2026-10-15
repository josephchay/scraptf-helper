import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/**
 * Toast buttons sit outside the panel (the stack is above it), so the trap lets Tab reach them too:
 * otherwise a keyboard user could never press a toast's Undo (Block buyer, Record trade) while it is open.
 */
export const TOAST_FOCUSABLE = '.toasts button:not([disabled])';

/**
 * Where Tab should move focus to keep it inside a modal panel, or null to let
 * the browser move it. `items` are the panel's focusable elements in order;
 * `active` is the focused element, or null when focus is on the panel itself
 * or outside it.
 */
export function trapFocusTarget<T>(items: readonly T[], active: T | null, shift: boolean): T | null {
  return trapFocusTargetIn([items], active, shift);
}

/**
 * trapFocusTarget over several groups that are each in DOM order but not next to each other in the
 * page (the panel's controls, then the toast buttons). Tab cycles through all of them as one list:
 * inside a group the browser's own move is the same, so only a step across a group's edge, or the
 * wrap at either end, returns a target.
 */
export function trapFocusTargetIn<T>(groups: readonly (readonly T[])[], active: T | null, shift: boolean): T | null {
  const items = groups.flat();
  if (items.length === 0) return null;
  const i = active === null ? -1 : items.indexOf(active);
  if (i === -1) return (shift ? items[items.length - 1] : items[0]) ?? null;
  const step = shift ? -1 : 1;
  const j = (i + step + items.length) % items.length;
  const groupOf = (k: number): number => {
    let end = 0;
    for (let g = 0; g < groups.length; g++) {
      end += groups[g]!.length;
      if (k < end) return g;
    }
    return -1;
  };
  if (j === i + step && groupOf(i) === groupOf(j)) return null;
  return items[j] ?? null;
}

/** Right-hand panel over the page. Esc or the backdrop closes it; focus returns to the opener and stays inside (plus the toasts) while open. */
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
        const shown = (el: HTMLElement) => el.getClientRects().length > 0;
        const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown);
        if (!items.length) {
          e.preventDefault();
          root.focus();
          return;
        }
        const toastItems = [...document.querySelectorAll<HTMLElement>(TOAST_FOCUSABLE)].filter(shown);
        const focused = document.activeElement;
        const active = focused instanceof HTMLElement && focused !== root && (root.contains(focused) || toastItems.includes(focused)) ? focused : null;
        const target = trapFocusTargetIn([items, toastItems], active, e.shiftKey);
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
