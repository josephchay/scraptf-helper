// Row context menu (feature F9): right-click, Shift+F10 or the ContextMenu key
// on OppTable, PricesPage, LogPage and Shopping list rows. Open details, copy
// SKU / name / backpack.tf name, record a scrap.tf price (quick entry,
// prefilled) and the link groups from 'links.forSku', fetched lazily on open.
// URLs open only through 'links.open' (openOrCopy -> openLink in api.ts).
//
// MenuPopover is the generic part (placement, roving focus, closing rules); the
// drawer's buyer actions menu (F3) uses it too.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { rpc, windowKind } from '../api';
import { copyText } from '../clipboard';
import { errorMessage } from '../format';
import { useApp } from '../hooks/appContext';
import {
  copiedMessage,
  flattenSections,
  isEnabledItem,
  itemMenuSections,
  modalHostOf,
  placeMenu,
  resolveMenuPoint,
  stepIndex,
  typeaheadIndex,
  type ItemMenuAction,
  type LinksState,
  type MenuItemSpec,
  type MenuPoint,
  type MenuSection,
} from '../itemMenuModel';
import { openOrCopy } from './ExternalLink';
import { Icon } from './Icon';

export interface ItemMenuTarget {
  sku: string;
  name: string;
  /** backpack.tf full name when the row knows it (ItemDetail.bptfName); defaults to `name`. */
  bptfName?: string;
}

export { isContextMenuKey, menuPointForRect } from '../itemMenuModel';

/** Where to open for a click or contextmenu event, falling back to the focused element for keyboard-triggered ones. */
export function menuPointFromEvent(at: MenuPoint): MenuPoint {
  const focused = document.activeElement;
  const rect = focused instanceof HTMLElement && focused !== document.body ? focused.getBoundingClientRect() : null;
  return resolveMenuPoint(at, rect, { width: window.innerWidth, height: window.innerHeight });
}

interface OpenState {
  seq: number;
  target: ItemMenuTarget;
  at: MenuPoint;
  /** Focus goes back here when the menu is dismissed from the keyboard. */
  opener: Element | null;
}

/**
 * A row's onContextMenu calls `open(target, { x: e.clientX, y: e.clientY })`
 * (for the keyboard, the row's bounding box, e.g. menuPointForRect); the page
 * renders `element` once.
 */
export function useItemMenu(): { open(target: ItemMenuTarget, at: { x: number; y: number }): void; element: ReactNode } {
  const [state, setState] = useState<OpenState | null>(null);
  const seq = useRef(0);
  const last = useRef<OpenState | null>(null);
  last.current = state;
  const open = useCallback((target: ItemMenuTarget, at: { x: number; y: number }) => {
    const active = document.activeElement;
    // Reopened while open (a keydown and the contextmenu it causes): keep the row as the opener, not the old menu.
    const opener = active instanceof Element && active.closest('.item-menu') ? (last.current?.opener ?? null) : active === document.body ? null : active;
    setState({ seq: ++seq.current, target, at: menuPointFromEvent(at), opener });
  }, []);
  const close = useCallback(() => setState(null), []);
  const element = state ? <ItemMenuView key={state.seq} state={state} onDone={close} /> : null;
  return { open, element };
}

function ItemMenuView({ state, onDone }: { state: OpenState; onDone: () => void }) {
  const { openItem, toast } = useApp();
  const { target } = state;
  const [links, setLinks] = useState<LinksState>({ status: 'loading' });

  // Lazily, once per open: the menu is often used only to copy or open details.
  useEffect(() => {
    let alive = true;
    rpc('links.forSku', { sku: target.sku })
      .then((l) => {
        if (alive) setLinks({ status: 'ready', links: l });
      })
      .catch((e: unknown) => {
        if (alive) setLinks({ status: 'error', message: errorMessage(e) });
      });
    return () => {
      alive = false;
    };
  }, [target.sku]);

  const sections = useMemo(() => itemMenuSections(target, links), [target, links]);

  const run = (a: ItemMenuAction) => {
    switch (a.kind) {
      case 'details':
        // The quick-entry window has no drawer; main shows the dashboard and opens it there.
        if (windowKind() === 'quick-entry') rpc('app.openItem', { sku: target.sku }).catch((e: unknown) => toast(`Could not open the item: ${errorMessage(e)}`, 'bad'));
        else openItem(target.sku);
        return;
      case 'copy':
        void copyText(a.text).then((ok) => toast(copiedMessage(a.text, ok), ok ? 'good' : 'bad'));
        return;
      case 'quick-entry':
        rpc('app.showQuickEntry', { sku: target.sku }).catch((e: unknown) => toast(`Could not open quick entry: ${errorMessage(e)}`, 'bad'));
        return;
      case 'link':
        void openOrCopy(a.url, toast);
        return;
    }
  };

  return (
    <MenuPopover
      at={state.at}
      label={`Actions for ${target.name}`}
      title={target.name}
      sections={sections}
      opener={state.opener}
      onClose={onDone}
      onAction={(a) => run(a)}
    />
  );
}

// ---------------------------------------------------------------------------
// Generic menu popover
// ---------------------------------------------------------------------------

export interface MenuPopoverProps<A> {
  at: MenuPoint;
  /** Accessible name of the menu. */
  label: string;
  /** Optional visible caption above the items (the item or buyer name). */
  title?: string;
  sections: readonly MenuSection<A>[];
  /** Element focused before the menu opened; focus returns to it after a keyboard dismissal or an action. */
  opener: Element | null;
  /**
   * Where the menu is portalled; defaults to the modal dialog around the opener, else document.body.
   * Inside an aria-modal dialog (the item drawer) it must stay in the dialog, or assistive tech hides it.
   */
  container?: Element | null;
  onClose: () => void;
  onAction: (action: A, item: MenuItemSpec<A>) => void;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();
const SCROLL_GRACE_MS = 200;

function restoreFocus(el: Element | null): void {
  if (el instanceof HTMLElement && document.contains(el)) el.focus({ preventScroll: true });
}

/**
 * Positioned popover menu in a portal: clamped to the viewport, roving focus
 * with arrows / Home / End / type-ahead, Enter or click to run, Esc or Tab to
 * dismiss. It closes on an outside pointer, a scroll outside it, a resize,
 * the window losing focus, focus moving elsewhere, or a route change.
 */
export function MenuPopover<A>({ at, label, title, sections, opener, container, onClose, onAction }: MenuPopoverProps<A>) {
  const { segments, itemSku } = useApp();
  // Fixed once per open, so the portal never moves under the user.
  const [host] = useState<Element>(() => container ?? modalHostOf(opener) ?? document.body);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const items = useMemo(() => flattenSections(sections), [sections]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const dismiss = useCallback(
    (refocus: boolean) => {
      onCloseRef.current();
      if (refocus) restoreFocus(opener);
    },
    [opener],
  );

  // Re-placed when the content changes size (links arriving).
  const layoutKey = items.map((i) => `${i.id}:${i.label}`).join('|');
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setPos(placeMenu(at, { width: el.offsetWidth, height: el.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at, layoutKey]);

  // Keep the active item valid (the first enabled one on open), and focused.
  useEffect(() => {
    const current = activeId === null ? undefined : items.find((i) => i.id === activeId);
    if (!current || !isEnabledItem(current)) {
      const first = items.find(isEnabledItem);
      if (first) {
        if (first.id !== activeId) setActiveId(first.id);
      } else {
        menuRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    const el = itemRefs.current.get(current.id);
    if (!el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    // Scroll only the menu itself (a scroll anywhere else would close it).
    const menu = menuRef.current;
    if (menu && menu.scrollHeight > menu.clientHeight) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (top < menu.scrollTop) menu.scrollTop = top;
      else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
    }
  }, [activeId, items]);

  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && menuRef.current !== null && menuRef.current.contains(t);
    const onPointer = (e: PointerEvent) => {
      if (!inside(e.target)) onCloseRef.current();
    };
    // The click that opened the menu may select its row, and the page then scrolls it into view: not a user scroll.
    const openedAt = performance.now();
    const onScroll = (e: Event) => {
      if (!inside(e.target) && performance.now() - openedAt > SCROLL_GRACE_MS) onCloseRef.current();
    };
    const onAway = () => onCloseRef.current();
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onAway);
    window.addEventListener('blur', onAway);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('blur', onAway);
    };
  }, []);

  // Navigating away (hash route, drawer item) leaves the menu's row behind.
  const routeKey = `${segments.join('/')}|${itemSku ?? ''}`;
  const openedOn = useRef(routeKey);
  useEffect(() => {
    if (routeKey !== openedOn.current) onCloseRef.current();
  }, [routeKey]);

  const activate = (item: MenuItemSpec<A>) => {
    if (!isEnabledItem(item) || item.action === null) return;
    // Close first so focus is back on the row before the action opens a drawer or window.
    dismiss(true);
    onAction(item.action, item);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Page shortcuts (j/k, Enter, "/") and the drawer's Esc must not see keys meant for the menu.
    e.stopPropagation();
    const enabled = items.map(isEnabledItem);
    const cur = items.findIndex((i) => i.id === activeId);
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End': {
        e.preventDefault();
        const next = stepIndex(enabled, cur, e.key);
        if (next >= 0) setActiveId(items[next]!.id);
        return;
      }
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        dismiss(true);
        return;
      case 'ContextMenu':
      case 'F10':
        // Already open. Closing here would refocus the row, whose contextmenu event would reopen it at once.
        e.preventDefault();
        return;
      default:
        if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const next = typeaheadIndex(
            items.map((i) => i.label),
            enabled,
            cur,
            e.key,
          );
          if (next !== cur && next >= 0) {
            e.preventDefault();
            setActiveId(items[next]!.id);
          }
        }
    }
  };

  const style = pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { left: at.x, top: at.y, visibility: 'hidden' as const };

  return createPortal(
    <div
      ref={menuRef}
      className="item-menu"
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={-1}
      style={style}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // Focus moved to another control (not just to nothing): the menu is done.
        const next = e.relatedTarget;
        if (next instanceof Node && !menuRef.current?.contains(next)) onCloseRef.current();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
    >
      {title ? (
        <div className="item-menu-title" aria-hidden="true" title={title}>
          {title}
        </div>
      ) : null}
      {sections.map((s, si) => (
        <Fragment key={s.id}>
          {si > 0 ? <div role="separator" className="item-menu-sep" /> : null}
          <div role="group" aria-label={s.label} className="item-menu-group">
            {s.label ? (
              <div className="item-menu-heading" aria-hidden="true">
                {s.label}
              </div>
            ) : null}
            {s.items.map((it) => {
              const enabled = isEnabledItem(it);
              return (
                <button
                  key={it.id}
                  ref={(el) => {
                    if (el) itemRefs.current.set(it.id, el);
                    else itemRefs.current.delete(it.id);
                  }}
                  type="button"
                  role="menuitem"
                  className={`item-menu-item${it.id === activeId ? ' active' : ''}${it.tone ? ` tone-${it.tone}` : ''}`}
                  tabIndex={it.id === activeId ? 0 : -1}
                  aria-disabled={enabled ? undefined : true}
                  title={it.title}
                  onMouseMove={(e) => {
                    // Only a real pointer move: a menu opened under a resting cursor keeps its first item active.
                    if (enabled && it.id !== activeId && (e.movementX !== 0 || e.movementY !== 0)) setActiveId(it.id);
                  }}
                  onClick={() => activate(it)}
                >
                  {it.icon ? <Icon name={it.icon} size={14} /> : <span className="item-menu-icon-gap" aria-hidden="true" />}
                  <span className="item-menu-label">{it.label}</span>
                  {it.hint ? <span className="item-menu-hint">{it.hint}</span> : null}
                </button>
              );
            })}
          </div>
        </Fragment>
      ))}
    </div>,
    host,
  );
}
