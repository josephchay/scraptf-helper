// Row context menu (feature F9): right-click, Shift+F10 or the ContextMenu key
// on OppTable, PricesPage, LogPage, Shopping list and Live market rows. Open
// details, copy SKU / name / backpack.tf name, record a scrap.tf price (quick
// entry, prefilled), record a buy or a sale in the journal (F12, prefilled from
// the local 'item.detail') and the link groups from 'links.forSku', fetched
// lazily on open. URLs open only through 'links.open' (openOrCopy -> openLink
// in api.ts). Recording writes the user's own journal; nothing is traded (R4).
// "Open on scrap.tf (copies name)" (F14) copies the name for scrap.tf's own
// search and hands the static bank page (where the user last saw the item, F15,
// else its category's) to the user's browser; Flip Desk never loads scrap.tf on its own (R1).
// F19: it also arms the Live check ('check.arm', main only, in memory), so a price
// the user copies there on its own is checked as this item. F21: when the user has
// the opt-in scrap.tf window open Flip Desk's links (openLinksInWindow), main shows
// the same static page there instead (links.open answers openedIn: 'window'), and
// the toast and tooltips say so. 0.7.1 (ACT-11): a bank stock row's menu carries its exact copy
// (ItemMenuTarget.copy), and Record buy books that copy at the price its save listed. 0.8 (G1): "Watch on
// scrap.tf…" opens the Watch dialog (WatchDialog.tsx) for the row's copy (ItemMenuTarget.special): a local list.
//
// MenuPopover is the generic part (placement, roving focus, closing rules); the
// drawer's buyer actions menu (F3) uses it too.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import type { Category, ItemDetail, ScraptfBank, ScraptfSeenOn, Settings } from '../../shared/types';
import { openLink, rpc, windowKind } from '../api';
import { checkArmFor, checkReturnPath, scraptfBackHint } from '../checkModel';
import { copyText } from '../clipboard';
import { errorMessage } from '../format';
import { useApp, type ToastTone } from '../hooks/appContext';
import {
  copiedMessage,
  createMenuClosePolicy,
  flattenSections,
  isEnabledItem,
  itemMenuSections,
  modalHostOf,
  placeMenu,
  recordTradeInit,
  resolveMenuPoint,
  scraptfOpenedToast,
  stepIndex,
  typeaheadIndex,
  type AnchorBox,
  type ItemMenuAction,
  type LinksState,
  type MenuItemSpec,
  type MenuPoint,
  type MenuSection,
  type RecordBuyCopy,
} from '../itemMenuModel';
import { createLatestGate } from '../quickModel';
import { scraptfLinksInWindow } from '../scraptfWindowModel';
import { openOrCopy } from './ExternalLink';
import { Icon } from './Icon';
import { useRecordTrade } from './RecordTradeDialog';
import { useWatchDialog } from './WatchDialog';

export interface ItemMenuTarget {
  sku: string;
  name: string;
  /** backpack.tf full name when the row knows it (ItemDetail.bptfName); defaults to `name`. */
  bptfName?: string;
  /** The item's category when the row knows it: "Open on scrap.tf" then needs no links.forSku answer (F14). */
  category?: Category;
  /**
   * F15: the scrap.tf page the row comes from (the banks page's cards). "Open on scrap.tf" opens that
   * bank page; without it the menu reads where the user last saw the item (ItemDetail.seenOn).
   */
  bank?: ScraptfBank;
  /**
   * ACT-11, Record buy only: the exact copy the row shows (a bank stock row: bankStockBuyCopy), so a painted
   * copy is booked as painted, at the price its save listed, instead of the price sheet's newest price.
   */
  copy?: RecordBuyCopy;
  /** 0.8 (G1): the bank_stock special key of the row's copy ('' plain): Watch on scrap.tf… watches that copy; absent: the SKU's own. */
  special?: string;
}

export { isContextMenuKey, menuPointForRect } from '../itemMenuModel';

/**
 * F19: arm the Live check for this item, and word the toast from these settings (Settings → Live check;
 * UX-5: the scrap.tf window's readOnLoad, when the page opens there).
 */
export interface ScraptfArm {
  sku: string;
  settings: (Pick<Settings, 'check' | 'networkPaused'> & Partial<Pick<Settings, 'scraptfWindow'>>) | null | undefined;
}

/**
 * "Open on scrap.tf (copies name)" (F14): copies the name for scrap.tf's own search box, then hands
 * the page to the user's browser through 'links.open' (main's allowlist). Flip Desk never loads scrap.tf on its own (R1).
 * With `arm` (F19) it first tells main which item this is ('check.arm', kept in memory, never logged),
 * so the check hotkey or watcher checks a price copied there as this item.
 */
export async function openOnScraptf(url: string, name: string, toast: (text: string, tone?: ToastTone) => void, arm?: ScraptfArm): Promise<void> {
  const params = arm ? checkArmFor(arm.sku, name) : null;
  // Only the toast's wording needs it, so it runs alongside and never delays the copy.
  const hotkeys = arm ? rpc('app.hotkeys').catch(() => null) : null;
  // Arm before the copy: main's watcher polls every 700 ms and must already know the name is the app's own (M2).
  const armed = params ? await rpc('check.arm', params).then((r) => r.armedUntil !== null, () => false) : false;
  // Copy first: once the browser has focus, the clipboard API refuses an unfocused page.
  const copied = await copyText(name);
  // F21: worded through scraptfOpenTitle(…, inWindow), so main may put it in the scrap.tf window.
  const opened = await openLink(url, { allowWindow: true });
  const back = arm ? scraptfBackHint(checkReturnPath(arm.settings, (await hotkeys)?.check ?? null, armed)) : null;
  const t = scraptfOpenedToast(copied, opened, url, back, arm?.settings?.scraptfWindow?.readOnLoad !== false);
  toast(t.text, t.tone);
}

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
 * renders `element` once. It holds the Record trade dialog too, which outlives
 * the menu that opened it.
 */
export function useItemMenu(): { open(target: ItemMenuTarget, at: { x: number; y: number }): void; element: ReactNode } {
  const { settings } = useApp();
  const [state, setState] = useState<OpenState | null>(null);
  const seq = useRef(0);
  const last = useRef<OpenState | null>(null);
  last.current = state;
  const recordTrade = useRecordTrade();
  const openRecord = useRef(recordTrade.open);
  openRecord.current = recordTrade.open;
  // 0.8 (G1): Watch on scrap.tf… opens this dialog, which outlives the menu as Record trade's does.
  const watch = useWatchDialog();
  const openWatch = useRef(watch.open);
  openWatch.current = watch.open;
  const onWatch = useCallback((t: ItemMenuTarget) => openWatch.current({ sku: t.sku, name: t.name, special: t.special ?? null }), []);
  const profit = useRef(settings?.profit ?? DEFAULT_SETTINGS.profit);
  profit.current = settings?.profit ?? DEFAULT_SETTINGS.profit;
  const [recordGate] = useState(createLatestGate);
  // A page left (or a menu opened again) before the prefill read answered: no dialog pops up later.
  useEffect(() => () => recordGate.cancel(), [recordGate]);

  const open = useCallback(
    (target: ItemMenuTarget, at: { x: number; y: number }) => {
      recordGate.cancel();
      const active = document.activeElement;
      // Reopened while open (a keydown and the contextmenu it causes): keep the row as the opener, not the old menu.
      const opener = active instanceof Element && active.closest('.item-menu') ? (last.current?.opener ?? null) : active === document.body ? null : active;
      setState({ seq: ++seq.current, target, at: menuPointFromEvent(at), opener });
    },
    [recordGate],
  );
  const close = useCallback(() => setState(null), []);

  // The prefill comes from the local book and price sheet ('item.detail', history off: no network).
  // Only the newest click opens the dialog; a failed read opens it without a price.
  const record = useCallback(
    (side: 'buy' | 'sell', target: ItemMenuTarget) => {
      const ticket = recordGate.next();
      rpc('item.detail', { sku: target.sku, history: false })
        .catch((): ItemDetail | null => null)
        .then((d) => {
          if (recordGate.isCurrent(ticket)) openRecord.current(recordTradeInit(side, target, d, profit.current));
        });
    },
    [recordGate],
  );

  const element = (
    <>
      {state ? <ItemMenuView key={state.seq} state={state} onDone={close} onRecord={record} onWatch={onWatch} /> : null}
      {recordTrade.element}
      {watch.element}
    </>
  );
  return { open, element };
}

function ItemMenuView({
  state,
  onDone,
  onRecord,
  onWatch,
}: {
  state: OpenState;
  onDone: () => void;
  onRecord: (side: 'buy' | 'sell', target: ItemMenuTarget) => void;
  onWatch: (target: ItemMenuTarget) => void;
}) {
  const { openItem, toast, settings } = useApp();
  const { target } = state;
  const [links, setLinks] = useState<LinksState>({ status: 'loading' });
  // 0.7.4 (R28): where a save last showed the item, and the bank its kind is sold on, kept apart (as the drawer).
  const [scraptf, setScraptf] = useState<{ seenOn: Pick<ScraptfSeenOn, 'bank'> | null; kindBank: ScraptfBank | null }>({ seenOn: null, kindBank: null });

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

  // F15: "Open on scrap.tf" goes to the bank page the user last saw the item on (a local read, no
  // history). Until it answers, or when it fails, the category's bank stands in; a row that names its
  // page (target.bank) needs no read.
  const namedBank = target.bank;
  useEffect(() => {
    if (namedBank) return;
    let alive = true;
    rpc('item.detail', { sku: target.sku, history: false })
      .then((d) => {
        // 0.7.4 (F36): an item no save names goes to the bank its kind is sold on (ItemDetail.kindBank).
        // 0.7.4 (R28): so does one last seen on the /items list, which names no bank page.
        if (alive) setScraptf({ seenOn: d?.seenOn ?? null, kindBank: d?.kindBank ?? null });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [target.sku, namedBank]);

  // F21: the scrap.tf action's tooltip says where main opens it (the user's scrap.tf window or the browser).
  const inWindow = scraptfLinksInWindow(settings);
  const sections = useMemo(() => itemMenuSections(target, links, scraptf.seenOn, inWindow, scraptf.kindBank), [target, links, scraptf, inWindow]);

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
      case 'record':
        onRecord(a.side, target);
        return;
      case 'scraptf':
        // F19: armed with the menu's item and exactly the name it copies.
        void openOnScraptf(a.url, a.name, toast, { sku: target.sku, settings });
        return;
      case 'link':
        void openOrCopy(a.url, toast);
        return;
      case 'watch':
        onWatch(target);
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
  /**
   * What the menu hangs from: a scroll that moves it more than 4 px closes the menu (H4). Defaults
   * to the element under `at` when the menu opens (the row), else the opener.
   */
  anchor?: Element | null;
  onClose: () => void;
  onAction: (action: A, item: MenuItemSpec<A>) => void;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

function restoreFocus(el: Element | null): void {
  if (el instanceof HTMLElement && document.contains(el)) el.focus({ preventScroll: true });
}

/**
 * The row under the opening point (else the element there), skipping any menu still on screen;
 * else the opener. The row, not the cell text: a live refresh may replace a cell's inner
 * elements, and a detached anchor would close the menu on the next scroll.
 */
function anchorAt(at: MenuPoint, opener: Element | null): Element | null {
  const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(at.x, at.y) : null;
  if (hit && hit !== document.body && hit !== document.documentElement && !hit.closest('.item-menu')) return hit.closest('[role="row"], tr') ?? hit;
  return opener && opener !== document.body ? opener : null;
}

/** Its position on screen, or null once it left the document (its row was unmounted). */
function boxOf(el: Element | null): AnchorBox | null {
  if (!el || !document.contains(el)) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top };
}

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

/**
 * Positioned popover menu in a portal: clamped to the viewport, roving focus
 * with arrows / Home / End / type-ahead, Enter or click to run, Esc or Tab to
 * dismiss. It closes on an outside pointer, a user scroll outside it (wheel,
 * touch, scroll keys) or a scroll that moves its anchor, a resize, the window
 * losing focus, focus moving elsewhere, or a route change. A programmatic
 * scroll that leaves the anchor in place does not close it.
 */
export function MenuPopover<A>({ at, label, title, sections, opener, container, anchor, onClose, onAction }: MenuPopoverProps<A>) {
  const { segments, itemSku } = useApp();
  // Fixed once per open, so the portal never moves under the user.
  const [host] = useState<Element>(() => container ?? modalHostOf(opener) ?? document.body);
  // Read during the first render, before this menu is on screen.
  const [anchorEl] = useState<Element | null>(() => anchor ?? anchorAt(at, opener));
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
    const policy = createMenuClosePolicy(boxOf(anchorEl), performance.now());
    const onPointer = (e: PointerEvent) => {
      if (!inside(e.target)) onCloseRef.current();
    };
    const onUserScroll = (e: Event) => {
      if (policy.closes({ type: e.type === 'wheel' ? 'wheel' : 'touchmove', inside: inside(e.target) })) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      const ev = { type: 'key' as const, key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, inside: inside(e.target), editable: isEditable(e.target) };
      if (policy.closes(ev)) onCloseRef.current();
    };
    const onScroll = (e: Event) => {
      if (policy.closes({ type: 'scroll', inside: inside(e.target), anchor: boxOf(anchorEl), at: performance.now() })) onCloseRef.current();
    };
    const onAway = () => onCloseRef.current();
    const passive = { capture: true, passive: true };
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('wheel', onUserScroll, passive);
    window.addEventListener('touchmove', onUserScroll, passive);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, passive);
    window.addEventListener('resize', onAway);
    window.addEventListener('blur', onAway);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('wheel', onUserScroll, true);
      window.removeEventListener('touchmove', onUserScroll, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('blur', onAway);
    };
  }, [anchorEl]);

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
