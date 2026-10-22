// Pure helpers behind the row context menu (ItemMenu, F9; placement and closing,
// H4) and the item drawer's buyer actions (F3), price actions (F8), copy buttons
// (F9) and trade recording prefills (F12). No DOM and no RPC here, so all of it
// is unit-tested; the components only wire it up.

import { bankStockPagePath } from '../shared/bankStock';
import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { valueScrap } from '../shared/currency';
import { SCRAPTF_BANK_PAGES, SCRAPTF_ITEMS_URL, bankForCategory, scraptfBankInfo, scraptfPageFor } from '../shared/links';
import { communityMaxAgeMs } from '../shared/referenceAge';
import {
  SCRAPTF_LIST_CRAFT_UNPROVEN,
  SCRAPTF_LIST_FAMILY_LABEL,
  bestExitOf,
  scraptfListCraftProven,
  scraptfListFresh,
  scraptfListIsFamily,
  scraptfListPriceSaved,
  scraptfListUsePrice,
} from '../shared/scraptfList';
import { priceIsForSku } from '../shared/priceCopy';
import { fromString } from '../shared/sku';
import { CATEGORIES, HOLDING_EXIT_VENUES } from '../shared/types';
import type {
  BuyerCheck,
  Category,
  ItemDetail,
  LinkGroup,
  LinkSpec,
  Opportunity,
  OrderSummary,
  Scrap,
  ScrapPrice,
  ScrapPriceInput,
  ScraptfBank,
  ScraptfListRow,
  ScraptfSeenOn,
  UnixMs,
} from '../shared/types';
import type { IconName } from './components/Icon';
import type { ItemMenuTarget } from './components/ItemMenu';
import type { RecordTradeInit } from './components/RecordTradeDialog';
import { fmtAgo, fmtDateTime, fmtInt, fmtKeysMetal, fmtRefOnly, truncate } from './format';
import { revenueOrderOf, type UseOrder } from './oppModel';
import { BUY_VENUE, LIST_PRICE_NOTE, listSellsText, previewRevenue, type PreviewSettings } from './quickModel';
import { WATCH_MENU_LABEL, WATCH_MENU_TITLE } from './watchesModel';

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface MenuPoint {
  x: number;
  y: number;
  /**
   * Where an upward menu's bottom edge goes (H4): the top of the button or row the menu hangs
   * from, so flipping up does not cover it. Defaults to `y` (a right-click's pointer).
   */
  upY?: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

/** Gap kept between a menu and the window edge. */
export const MENU_MARGIN = 8;

const finiteOr = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);
const clampTo = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Where a menu opened at `at` goes (H4): right of and below the pointer when it
 * fits, flipped left at the right edge. When it does not fit below, it opens
 * upward with its bottom edge at the pointer (or at `at.upY`, the top of the
 * button or row it hangs from), so it never covers the row it was opened on.
 * When it fits on neither side (a long link list in a short window), it takes
 * the side with more room and `maxHeight` gives it a scrollbar there. Always
 * clamped to the viewport.
 */
export function placeMenu(at: MenuPoint, size: MenuSize, viewport: MenuSize, margin = MENU_MARGIN): { left: number; top: number; maxHeight: number } {
  const vw = Math.max(0, finiteOr(viewport.width, 0));
  const vh = Math.max(0, finiteOr(viewport.height, 0));
  const maxW = Math.max(0, vw - 2 * margin);
  const maxH = Math.max(0, vh - 2 * margin);
  const w = Math.min(Math.max(0, finiteOr(size.width, 0)), maxW);
  const h = Math.min(Math.max(0, finiteOr(size.height, 0)), maxH);
  const x = clampTo(finiteOr(at.x, margin), 0, vw);
  const y = clampTo(finiteOr(at.y, margin), 0, vh);
  // Never below the pointer: an upward menu ending under it would cover what was clicked.
  const yUp = clampTo(finiteOr(at.upY ?? y, y), 0, y);
  const left = x + w <= vw - margin ? x : x - w;
  const below = Math.max(0, vh - margin - y);
  const above = Math.max(0, yUp - margin);
  let top: number;
  let maxHeight: number;
  if (h <= below) {
    top = y;
    maxHeight = maxH;
  } else if (h <= above || above >= below) {
    // Upward, bottom edge at the pointer (or the anchor's top); capped to the room above when even that is short.
    const shown = Math.min(h, above);
    top = yUp - shown;
    maxHeight = h <= above ? maxH : above;
  } else {
    top = y;
    maxHeight = below;
  }
  const shown = Math.min(h, maxHeight);
  return {
    left: Math.round(clampTo(left, margin, Math.max(margin, vw - margin - w))),
    top: Math.round(clampTo(top, margin, Math.max(margin, vh - margin - shown))),
    maxHeight: Math.round(maxHeight),
  };
}

// ---------------------------------------------------------------------------
// Closing on scroll (H4)
// ---------------------------------------------------------------------------

/** How far the menu's anchor may move under a scroll before the menu closes. */
export const MENU_ANCHOR_SLACK_PX = 4;

/** Keys that scroll the page when pressed outside the menu (the menu handles its own). */
const SCROLL_KEYS: ReadonlySet<string> = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar']);

export function isScrollKey(e: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean {
  return SCROLL_KEYS.has(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey;
}

export interface AnchorBox {
  left: number;
  top: number;
}

/**
 * True when the anchor moved more than `slack` px since `before`, or is gone (null: unmounted).
 * A scroll that leaves the anchor in place (a programmatic smooth scroll elsewhere, a live
 * refresh that keeps the rows still) does not count.
 */
export function anchorMoved(before: AnchorBox | null, after: AnchorBox | null, slack = MENU_ANCHOR_SLACK_PX): boolean {
  if (before === null) return false;
  if (after === null) return true;
  return Math.abs(after.left - before.left) > slack || Math.abs(after.top - before.top) > slack;
}

export type MenuCloseEvent =
  | { type: 'wheel' | 'touchmove'; inside: boolean }
  | { type: 'key'; key: string; inside: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; editable?: boolean }
  | { type: 'scroll'; inside: boolean; anchor: AnchorBox | null; at: number };

export interface MenuClosePolicy {
  /** Whether this event closes the menu. */
  closes(e: MenuCloseEvent): boolean;
}

/**
 * When an open menu closes because of scrolling (H4). Only a user scroll does it: the wheel,
 * a touch drag, or a scroll key pressed outside the menu; or a scroll of something around the
 * anchor that moves it more than MENU_ANCHOR_SLACK_PX. A bare 'scroll' event (a programmatic
 * smooth scroll, scroll anchoring after a live refresh) does not. During the first `graceMs`
 * a scroll moves the baseline instead: the click that opened the menu may select its row,
 * and the page then scrolls it into view.
 */
export function createMenuClosePolicy(anchorAtOpen: AnchorBox | null, openedAt: number, graceMs = 200): MenuClosePolicy {
  let base = anchorAtOpen;
  return {
    closes(e) {
      if (e.inside) return false;
      switch (e.type) {
        case 'wheel':
        case 'touchmove':
          return true;
        case 'key':
          return !e.editable && isScrollKey(e);
        case 'scroll':
          if (e.at - openedAt <= graceMs) {
            // A row that went away during the grace still closes the menu on the next scroll.
            if (base !== null && e.anchor !== null) base = e.anchor;
            return false;
          }
          return anchorMoved(base, e.anchor);
      }
    },
  };
}

/**
 * Where a menu opened from the keyboard appears: just inside the focused row's lower-left corner,
 * or, when it does not fit below, above the row (upY), not over it.
 */
export function menuPointForRect(r: { left: number; top: number; width: number; height: number }): MenuPoint {
  return { x: Math.round(r.left + Math.min(24, r.width / 2)), y: Math.round(r.top + Math.min(r.height, 28)), upY: Math.round(r.top) };
}

/**
 * The point to open at. A keyboard-triggered contextmenu event (Shift+F10, the
 * ContextMenu key) can report 0,0 or nothing usable; then the menu goes next to
 * the focused element, or near the top of the window when nothing is focused.
 */
export function resolveMenuPoint(at: MenuPoint, focusedRect: { left: number; top: number; width: number; height: number } | null, viewport: MenuSize): MenuPoint {
  const usable = Number.isFinite(at.x) && Number.isFinite(at.y) && (at.x > 0 || at.y > 0) && at.x <= viewport.width && at.y <= viewport.height;
  if (usable) return at;
  if (focusedRect && (focusedRect.width > 0 || focusedRect.height > 0)) return menuPointForRect(focusedRect);
  return { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 4) };
}

export const MODAL_SELECTOR = '[aria-modal="true"]';

/**
 * The modal dialog an element sits in (the item drawer), or null. A menu opened
 * from inside one is portalled into it, because assistive tech treats everything
 * outside an aria-modal dialog as inert.
 */
export function modalHostOf<T>(el: { closest(selector: string): T | null } | null | undefined): T | null {
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest(MODAL_SELECTOR);
}

/** Structural, so the walks below run on the DOM and on the tests' minimal DOM alike. */
interface TreeNode {
  nodeType?: number;
  getAttribute?(name: string): string | null;
  childNodes?: ArrayLike<TreeNode>;
}

/**
 * The open modal on top (aria-modal="true", last in document order: the Record trade dialog is
 * portalled into the drawer or after the app), or null. Focus goes back there when a toast that
 * held it goes away, instead of dropping to <body> behind the modal.
 */
export function topmostModalIn<T extends TreeNode>(root: T): T | null {
  let found: T | null = null;
  const walk = (n: TreeNode): void => {
    const kids = n.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!;
      if (c.nodeType === 1 && c.getAttribute?.('aria-modal') === 'true') found = c as T;
      walk(c);
    }
  };
  walk(root);
  return found;
}

interface UpNode {
  parentNode: UpNode | null;
  getAttribute?(name: string): string | null;
}

/** Whether a node sits in the toast stack, whose Undo stays reachable while a modal is open. */
export function inToastStack(n: UpNode | null): boolean {
  for (let c: UpNode | null = n; c; c = c.parentNode) {
    const cls = typeof c.getAttribute === 'function' ? c.getAttribute('class') : null;
    if (cls && cls.split(/\s+/).includes('toasts')) return true;
  }
  return false;
}

/** Shift+F10 or the ContextMenu key: the keyboard ways to open a row's context menu. */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

// ---------------------------------------------------------------------------
// Roving focus
// ---------------------------------------------------------------------------

/**
 * Next active index for a menu key: arrows wrap and skip disabled items, Home
 * and End jump to the first and last enabled one. -1 when nothing is enabled;
 * any other key keeps `current`.
 */
export function stepIndex(enabled: readonly boolean[], current: number, key: string): number {
  const n = enabled.length;
  const first = enabled.indexOf(true);
  if (first === -1) return -1;
  if (key === 'Home') return first;
  if (key === 'End') return enabled.lastIndexOf(true);
  const delta = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  if (delta === 0) return current;
  let i = current < 0 || current >= n ? (delta > 0 ? -1 : n) : current;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (enabled[i]) return i;
  }
  return current;
}

/** Type-to-select: the next enabled item after `current` whose label starts with `char`; `current` when none does. */
export function typeaheadIndex(labels: readonly string[], enabled: readonly boolean[], current: number, char: string): number {
  const c = char.trim().toLowerCase();
  if (c.length !== 1) return current;
  const n = labels.length;
  for (let step = 1; step <= n; step++) {
    const i = (((current < 0 ? -1 : current) + step) % n + n) % n;
    if (enabled[i] && labels[i]!.trim().toLowerCase().startsWith(c)) return i;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Menu model
// ---------------------------------------------------------------------------

export interface MenuItemSpec<A> {
  id: string;
  label: string;
  /** Short grey text on the right (a host name, for example). */
  hint?: string;
  /** Native tooltip: the full URL or the exact text a copy action copies. */
  title?: string;
  icon?: IconName;
  disabled?: boolean;
  /** 'warn' highlights an item the situation calls for (Check bans on a background-check order). */
  tone?: 'warn';
  /** null for an informational row (Loading links…). */
  action: A | null;
}

export interface MenuSection<A> {
  id: string;
  /** Group heading; sections without one are separated by a line only. */
  label?: string;
  items: MenuItemSpec<A>[];
}

export function flattenSections<A>(sections: readonly MenuSection<A>[]): MenuItemSpec<A>[] {
  return sections.flatMap((s) => s.items);
}

/** An informational row is never focusable, like a disabled item. */
export function isEnabledItem<A>(item: MenuItemSpec<A>): boolean {
  return !item.disabled && item.action !== null;
}

// ---------------------------------------------------------------------------
// Copy targets (drawer header and item menu)
// ---------------------------------------------------------------------------

export type CopyKind = 'sku' | 'name' | 'bptf';

export interface CopyTarget {
  kind: CopyKind;
  label: string;
  text: string;
}

/** Copy SKU, Copy name and Copy backpack.tf name; the bp.tf name falls back to the name. */
export function copyTargets(item: { sku: string; name: string; bptfName?: string | null | undefined }): CopyTarget[] {
  const name = item.name.trim() || item.sku;
  const bptf = item.bptfName?.trim() || name;
  return [
    { kind: 'sku', label: 'Copy SKU', text: item.sku },
    { kind: 'name', label: 'Copy name', text: name },
    { kind: 'bptf', label: 'Copy backpack.tf name', text: bptf },
  ];
}

export function copiedMessage(text: string, ok: boolean): string {
  return ok ? `Copied ${truncate(text, 80)}` : 'Could not copy to the clipboard.';
}

// ---------------------------------------------------------------------------
// Item menu (F9)
// ---------------------------------------------------------------------------

export type ItemMenuAction =
  | { kind: 'details' }
  | { kind: 'copy'; text: string }
  | { kind: 'quick-entry' }
  /** F12: open the Record trade dialog for this item (a journal row; nothing is traded). */
  | { kind: 'record'; side: 'buy' | 'sell' }
  /** F14: copy the name for scrap.tf's search, then open its page in the user's browser (links.open). */
  | { kind: 'scraptf'; url: string; name: string }
  | { kind: 'link'; url: string }
  /** 0.8 (G1): the Watch dialog (a local list; nothing is fetched or bought). */
  | { kind: 'watch' };

export type LinksState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; links: readonly LinkSpec[] };

export const LINK_GROUP_LABELS: Readonly<Record<LinkGroup, string>> = { backpack: 'backpack.tf', market: 'Markets', tools: 'Tools' };

/** Links grouped in the order their groups first appear (the link generator's order). */
export function groupLinks(links: readonly LinkSpec[]): { group: LinkGroup; label: string; links: LinkSpec[] }[] {
  const m = new Map<LinkGroup, LinkSpec[]>();
  for (const l of links) {
    const arr = m.get(l.group) ?? [];
    arr.push(l);
    m.set(l.group, arr);
  }
  return [...m.entries()].map(([group, list]) => ({ group, label: LINK_GROUP_LABELS[group] ?? group, links: list }));
}

/** The host without "www." (shown as a hint next to a link); empty for anything unparsable. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Item menu content: Open details; Copy SKU / name / backpack.tf name; Record
 * scrap.tf price… (quick entry, prefilled); Record buy… / Record sale… (the
 * journal, F12); Open on scrap.tf (copies name) (F14) and (0.8, G1) Watch on scrap.tf…; then the link groups
 * once 'links.forSku' answers. `seenOn` is the item's ItemDetail.seenOn once read (F15); a row
 * that names its scrap.tf page itself (ItemMenuTarget.bank, the banks page) goes there instead.
 * `inWindow` (F21, scraptfLinksInWindow) only words the scrap.tf action's tooltip: main decides where it opens.
 * 0.7.4 (R28): `kindBank` (ItemDetail.kindBank) is kept apart from `seenOn`, as the drawer's scraptfOpenUrl
 * call does, so an item last seen on scrap.tf/items (no bank page) opens the bank its kind is sold on.
 */
export function itemMenuSections(
  target: ItemMenuTarget,
  links: LinksState,
  seenOn: Pick<ScraptfSeenOn, 'bank'> | null = null,
  inWindow = false,
  kindBank: ScraptfBank | null = null,
): MenuSection<ItemMenuAction>[] {
  // A row that names its bank goes there; else the drawer's own call (seenOn, then the kind's bank).
  const stfUrl = scraptfOpenUrl(target.category, links, target.bank ? { bank: target.bank } : seenOn, target.bank ? null : kindBank);
  const stfName = scraptfSearchName(target);
  const sections: MenuSection<ItemMenuAction>[] = [
    { id: 'open', items: [{ id: 'details', label: 'Open details', icon: 'chevronRight', action: { kind: 'details' } }] },
    {
      id: 'copy',
      items: copyTargets(target).map((c) => ({ id: `copy-${c.kind}`, label: c.label, title: c.text, icon: 'copy' as const, action: { kind: 'copy' as const, text: c.text } })),
    },
    { id: 'price', items: [{ id: 'quick-entry', label: 'Record scrap.tf price…', hint: 'Quick entry', icon: 'plus', action: { kind: 'quick-entry' } }] },
    {
      id: 'trade',
      items: [
        { id: 'record-buy', label: 'Record buy…', hint: 'Journal', title: RECORD_BUY_TITLE, icon: 'cart', action: { kind: 'record', side: 'buy' } },
        { id: 'record-sale', label: 'Record sale…', hint: 'Journal', title: RECORD_SALE_TITLE, icon: 'journal', action: { kind: 'record', side: 'sell' } },
      ],
    },
    {
      id: 'scraptf',
      items: [
        {
          id: 'scraptf-open',
          label: OPEN_ON_SCRAPTF_LABEL,
          hint: 'scrap.tf',
          // Without the item's category the page is known once links.forSku answers.
          title: stfUrl ? scraptfOpenTitle(stfUrl, stfName, inWindow) : 'Finding the scrap.tf page for this item…',
          icon: 'external',
          disabled: stfUrl === null,
          action: stfUrl ? { kind: 'scraptf', url: stfUrl, name: stfName } : null,
        },
        // 0.8 (G1): judged only on the pages the user reads or saves; it opens nothing.
        { id: 'scraptf-watch', label: WATCH_MENU_LABEL, hint: 'Notify', title: WATCH_MENU_TITLE, icon: 'eye', action: { kind: 'watch' } },
      ],
    },
  ];
  if (links.status === 'loading') {
    sections.push({ id: 'links', label: 'Links', items: [{ id: 'links-loading', label: 'Loading links…', disabled: true, action: null }] });
  } else if (links.status === 'error') {
    sections.push({ id: 'links', label: 'Links', items: [{ id: 'links-error', label: 'Links unavailable', title: links.message, disabled: true, action: null }] });
  } else if (!links.links.length) {
    sections.push({ id: 'links', label: 'Links', items: [{ id: 'links-none', label: 'No links for this item', disabled: true, action: null }] });
  } else {
    for (const g of groupLinks(links.links)) {
      sections.push({
        id: `links-${g.group}`,
        label: g.label,
        items: g.links.map((l) => ({ id: `link-${l.id}`, label: l.label, hint: hostLabel(l.url), title: l.url, icon: 'external' as const, action: { kind: 'link' as const, url: l.url } })),
      });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Buyer actions (F3)
// ---------------------------------------------------------------------------

export function isSteamId64(id: string): boolean {
  return /^\d{17}$/.test(id);
}

/** The buyer's backpack.tf and Steam profile pages, or null for anything that is not a SteamID64. */
export function buyerProfileUrls(steamid: string): { backpack: string; steam: string } | null {
  const id = steamid.trim();
  if (!isSteamId64(id)) return null;
  // /profiles/<id>, never Steam's linkfilter redirector; both pass main's links.open allowlist.
  return { backpack: `https://backpack.tf/profiles/${id}`, steam: `https://steamcommunity.com/profiles/${id}` };
}

export type BuyerMenuAction = { kind: 'open'; url: string } | { kind: 'copy-id' } | { kind: 'record-sale' } | { kind: 'check' } | { kind: 'block' } | { kind: 'unblock' };

export function buyerMenuSections(
  order: Pick<OrderSummary, 'steamid'>,
  opts: { blocked: boolean; highlightCheck: boolean; checking: boolean },
): MenuSection<BuyerMenuAction>[] {
  const urls = buyerProfileUrls(order.steamid);
  const valid = urls !== null;
  return [
    {
      id: 'profiles',
      items: [
        { id: 'bptf', label: 'Open on backpack.tf', hint: 'backpack.tf', icon: 'external', disabled: !valid, title: urls?.backpack, action: urls ? { kind: 'open', url: urls.backpack } : null },
        { id: 'steam', label: 'Steam profile', hint: 'steamcommunity.com', icon: 'external', disabled: !valid, title: urls?.steam, action: urls ? { kind: 'open', url: urls.steam } : null },
      ],
    },
    { id: 'copy', items: [{ id: 'copy-id', label: 'Copy SteamID64', title: order.steamid, icon: 'copy', action: { kind: 'copy-id' } }] },
    // A journal row only (F12): it works for any order, valid id or not.
    { id: 'record', items: [{ id: 'record-sale', label: 'Record sale to this buyer', hint: 'Journal', title: RECORD_SALE_BUYER_TITLE, icon: 'journal', action: { kind: 'record-sale' } }] },
    {
      id: 'manage',
      items: [
        {
          id: 'check',
          label: opts.checking ? 'Checking bans…' : 'Check bans',
          hint: opts.highlightCheck ? 'Background check' : 'backpack.tf',
          icon: 'shield',
          disabled: !valid || opts.checking,
          ...(opts.highlightCheck ? { tone: 'warn' as const } : {}),
          action: { kind: 'check' },
        },
        opts.blocked
          ? { id: 'unblock', label: 'Remove from blocklist', icon: 'check', disabled: !valid, action: { kind: 'unblock' } }
          : { id: 'block', label: 'Block buyer', hint: 'Excluded from profit', icon: 'close', disabled: !valid, action: { kind: 'block' } },
      ],
    },
  ];
}

/** The blocklist with `id` added once; existing entries keep their order and duplicates are dropped. */
export function blocklistWith(list: readonly string[], id: string): string[] {
  return [...new Set([...list, id.trim()])];
}

/** The blocklist without `id`, duplicates dropped. */
export function blocklistWithout(list: readonly string[], id: string): string[] {
  const drop = id.trim();
  return [...new Set(list)].filter((x) => x !== drop);
}

export interface BlocklistDeps {
  /** settings.get: the stored settings, not the possibly stale copy the page holds. */
  getSettings(): Promise<{ blocklist: string[] }>;
  /** settings.set with the full list (arrays replace in mergeSettings); null when saving failed. */
  save(patch: { blocklist: string[] }): Promise<{ blocklist: string[] } | null>;
}

/**
 * Adds a buyer to the blocklist from a fresh read, so an edit made elsewhere
 * since the page loaded (Settings, another drawer) is never overwritten.
 */
export async function blockBuyer(id: string, deps: BlocklistDeps): Promise<'blocked' | 'already' | 'failed'> {
  const fresh = await deps.getSettings();
  if (fresh.blocklist.includes(id)) return 'already';
  const saved = await deps.save({ blocklist: blocklistWith(fresh.blocklist, id) });
  return saved?.blocklist.includes(id) ? 'blocked' : 'failed';
}

/** Undo or "Remove from blocklist": also from a fresh read. */
export async function unblockBuyer(id: string, deps: BlocklistDeps): Promise<'unblocked' | 'absent' | 'failed'> {
  const fresh = await deps.getSettings();
  if (!fresh.blocklist.includes(id)) return 'absent';
  const saved = await deps.save({ blocklist: blocklistWithout(fresh.blocklist, id) });
  return saved && !saved.blocklist.includes(id) ? 'unblocked' : 'failed';
}

/**
 * listingIds of the orders a 'background-check' opportunity takes its revenue
 * from. Their Check bans button is highlighted, because that is the buyer the
 * user would trade with.
 */
export function backgroundCheckListings(opps: readonly Opportunity[], useOrder: UseOrder): Set<string> {
  const ids = new Set<string>();
  for (const o of opps) {
    if (!o.flags.includes('background-check')) continue;
    const order = revenueOrderOf(o, useOrder);
    if (order) ids.add(order.listingId);
  }
  return ids;
}

export interface BuyerCheckView {
  tone: 'good' | 'warn' | 'bad' | 'muted';
  text: string;
  details: string[];
  /** When the result says when it was checked ("checked 3 min ago, from cache"). */
  when: string | null;
  /** The fix is in Settings (no access token, API off). */
  needsSettings: boolean;
  /** A transient failure (paused, 429, HTTP error): offer another click. Failures are never cached by the service. */
  retry: boolean;
}

export function describeBuyerCheck(c: BuyerCheck, now: UnixMs): BuyerCheckView {
  const when = `checked ${fmtAgo(Math.min(c.checkedAt, now), now)}${c.cached ? ', from cache' : ''}`;
  const who = c.name ? ` (${c.name})` : '';
  if (c.error) {
    const needsSettings = /settings/i.test(c.error);
    return { tone: 'warn', text: c.error, details: [], when: null, needsSettings, retry: !needsSettings };
  }
  const done = { when, needsSettings: false, retry: false };
  if (c.bptfBanned === true) return { tone: 'bad', text: `Banned on backpack.tf${who}. Do not trade.`, details: c.banDetails, ...done };
  if (c.bptfBanned === false && c.banDetails.length) return { tone: 'warn', text: `Not banned on backpack.tf${who}, but other bans are listed.`, details: c.banDetails, ...done };
  if (c.bptfBanned === false) return { tone: 'good', text: `No backpack.tf ban${who}.`, details: [], ...done };
  return { tone: 'muted', text: `Ban status unknown${who}.`, details: c.banDetails, ...done };
}

// ---------------------------------------------------------------------------
// Price actions (F8) and the ceiling (F1) in the drawer
// ---------------------------------------------------------------------------

/** "Seen now": the same price re-confirmed. Omitted extras (note, paint, stock) keep their stored values. */
export function reconfirmInput(p: ScrapPrice, now: UnixMs): ScrapPriceInput {
  return { id: p.id, sku: p.sku, name: p.name, costKeys: p.costKeys, costScrap: p.costScrap, source: p.source, observedAt: now };
}

/**
 * The typed price the drawer form updates by default: the newest one the user typed (imports are left to re-imports).
 * 0.7.3: with `sku`, only a price for that copy (drawerPriceTargets).
 */
export function defaultPriceTarget(prices: readonly ScrapPrice[], sku?: string): number | null {
  let best: ScrapPrice | null = null;
  for (const p of prices) {
    if (sku !== undefined && !priceIsForSku(p, sku)) continue;
    if (p.source === 'user' && (best === null || p.observedAt > best.observedAt)) best = p;
  }
  return best?.id ?? null;
}

/**
 * 0.7.3: the typed prices the drawer form of `sku` may update, newest first. A plain SKU's drawer lists every
 * copy stored under it, and updating a painted or spelled copy's row would give that copy the plain price
 * (the stored extras are kept, Repo.upsertScrapPrice), so only this copy's prices, as Record buy reads them.
 */
export function drawerPriceTargets(prices: readonly ScrapPrice[], sku: string): ScrapPrice[] {
  return prices.filter((p) => p.source === 'user' && priceIsForSku(p, sku)).sort((a, b) => b.observedAt - a.observedAt || b.id - a.id);
}

/** The drawer form's write: updates `target` (keeping its note unless one is typed) or adds a new typed price. */
export function drawerPriceInput(args: {
  sku: string;
  name: string;
  price: { keys: number; scrap: Scrap };
  note: string;
  target: ScrapPrice | null;
  now: UnixMs;
}): ScrapPriceInput {
  const note = args.note.trim();
  const { keys, scrap } = args.price;
  if (args.target) {
    // The stored base SKU, so paint and other recorded extras stay as they are.
    return { id: args.target.id, sku: args.target.sku, name: args.target.name, costKeys: keys, costScrap: scrap, source: 'user', observedAt: args.now, ...(note ? { note } : {}) };
  }
  return { sku: args.sku, name: args.name, costKeys: keys, costScrap: scrap, source: 'user', observedAt: args.now, note: note || null };
}

/** A rule suggested the item but the user has no price for it yet: the form asks for the real one. */
export function isRuleCandidate(d: Pick<ItemDetail, 'scrapPrices' | 'opportunities'>): boolean {
  return d.scrapPrices.length === 0 && d.opportunities.some((o) => o.inputKind === 'rule');
}

export function priceFormHeading(d: Pick<ItemDetail, 'scrapPrices' | 'opportunities'>): { title: string; hint: string } {
  if (isRuleCandidate(d))
    return { title: 'Found it on scrap.tf? Record the real price', hint: `The rule's cost is an estimate. Type the price scrap.tf shows. ${SCRAPTF_BOUNDARY_SHORT}` };
  return { title: 'Add / update scrap.tf price', hint: `Type what you see on scrap.tf. ${SCRAPTF_BOUNDARY_SHORT}` };
}

/** The item's "pay up to": from ItemDetail.revenue, else the inputs' ceilings (they share one revenue). */
export function drawerCeiling(d: Pick<ItemDetail, 'revenue' | 'opportunities'>): Scrap | null {
  if (d.revenue && d.revenue.maxCostScrap !== null) return d.revenue.maxCostScrap;
  let best: Scrap | null = null;
  for (const o of d.opportunities) if (o.maxCostScrap !== null && (best === null || o.maxCostScrap > best)) best = o.maxCostScrap;
  return best;
}

/** A cost against the ceiling: under (or at) it is a buy, over it is not. null when either is unknown. */
export function ceilingVerdict(costScrap: Scrap | null, maxCostScrap: Scrap | null): { under: boolean; diffScrap: Scrap } | null {
  if (costScrap === null || maxCostScrap === null || !Number.isFinite(costScrap) || !Number.isFinite(maxCostScrap)) return null;
  return { under: costScrap <= maxCostScrap, diffScrap: Math.abs(maxCostScrap - costScrap) };
}

/** True when a reference this old is ignored by the engine (Settings > profit.referenceMaxAgeMs). */
export function isReferenceTooOld(ageMs: number | null | undefined, maxAgeMs: number): boolean {
  return ageMs !== null && ageMs !== undefined && Number.isFinite(ageMs) && ageMs > maxAgeMs;
}

export interface ReferenceAgeGate {
  /** null when unknown (an unknown age counts as current). */
  ageMs: number | null;
  /** The engine ignores this reference (shown faded, "ignored"). */
  old: boolean;
  /** The limit it was judged against, for the label. */
  limitMs: number;
}

/**
 * The drawer's reference cards, gated exactly like the engine's usableReferences (F4):
 * a PriceDB price at profit.referenceMaxAgeMs, a community price at max(that, 1 year).
 */
export function referenceAgeGates(
  refs: ItemDetail['references'],
  maxAgeMs: number,
  now: UnixMs,
): { pricedb: ReferenceAgeGate; community: ReferenceAgeGate } {
  const pAge = refs.pricedb?.ageMs ?? null;
  const last = refs.community?.lastUpdate;
  const cAge = typeof last === 'number' && Number.isFinite(last) && last > 0 ? now - last * 1000 : null;
  const cLimit = communityMaxAgeMs(maxAgeMs);
  return {
    pricedb: { ageMs: pAge, old: refs.pricedb !== null && isReferenceTooOld(pAge, maxAgeMs), limitMs: maxAgeMs },
    community: { ageMs: cAge, old: refs.community !== null && isReferenceTooOld(cAge, cLimit), limitMs: cLimit },
  };
}

export function fmtDays(ms: number): string {
  const d = Math.round(ms / 86_400_000);
  return `${d} day${d === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Recording trades (F12): what the Record trade dialog opens with
// ---------------------------------------------------------------------------

/** Where a recorded buy happened by default: the flip loop buys on scrap.tf ... */
export const RECORD_BUY_VENUE = BUY_VENUE;
/** ... and sells to a backpack.tf buy order. */
export const RECORD_SALE_VENUE = 'backpack.tf';

export const RECORD_BUY_TITLE = 'Write a buy of this item to your journal, prefilled with your newest scrap.tf price. Nothing is bought.';
export const RECORD_SALE_TITLE = 'Write a sale of this item to your journal, prefilled with the buy order your profit uses. Nothing is sold.';
export const RECORD_SALE_BUYER_TITLE = "Write a sale to this buyer to your journal, at this order's price. Nothing is sold or offered.";

/** The buyer as a person reads it: the backpack.tf name, else the SteamID64. */
export function buyerLabel(o: Pick<OrderSummary, 'userName' | 'steamid'>): string {
  return o.userName?.trim() || o.steamid;
}

export function saleNote(o: Pick<OrderSummary, 'userName' | 'steamid'>): string {
  return `Sold to ${buyerLabel(o)}`;
}

/**
 * 0.7.2: the key price a prefill values keys at when the caller has none: the service's DEFAULT_KEY_SCRAP
 * (60 ref; the renderer does not import the service), which is also what the service values at then.
 */
export const RECORD_BUY_KEY_SCRAP: Scrap = 540;

/**
 * The newest scrap.tf price of yours, typed or from a saved page; null without one. 0.7.2: of several
 * seen at that one time, the cheapest at `keyScrap`, equal costs the higher id, as the Live market row
 * picks (the service's knownAt): a look stores a kit once per sheen/killstreaker combo, every copy at the
 * page's time, so the one stored last is not the price. A newer look still beats a cheaper older one.
 */
export function newestScrapPrice(prices: readonly ScrapPrice[], keyScrap: Scrap | null = RECORD_BUY_KEY_SCRAP): ScrapPrice | null {
  const K = typeof keyScrap === 'number' && Number.isFinite(keyScrap) && keyScrap > 0 ? keyScrap : RECORD_BUY_KEY_SCRAP;
  // A cost that is not a number never undercuts a real one (valueScrap would read NaN as 0).
  const cost = (p: ScrapPrice): number => {
    const keys = p.costKeys ?? 0;
    return Number.isFinite(keys) && Number.isFinite(p.costScrap) ? valueScrap(keys, p.costScrap, K) : Infinity;
  };
  let best: ScrapPrice | null = null;
  let bestCost = Infinity;
  for (const p of prices) {
    const c = cost(p);
    if (best === null || p.observedAt > best.observedAt || (p.observedAt === best.observedAt && (c < bestCost || (c === bestCost && p.id > best.id)))) {
      best = p;
      bestCost = c;
    }
  }
  return best;
}

// Whether a stored price is one for the copy a SKU names. 0.7.4 (F80): in src/shared/priceCopy.ts, so the
// service's 'prices.upsert' (replaceTyped) picks the same copy the drawer's form does.
export { priceIsForSku };

/**
 * ACT-11: the exact copy a row shows (a bank stock row: ItemMenuTarget.copy), for Record buy only. The
 * SKU is the copy's own (painted when the copy is painted); the price is the one its save listed, keys
 * and metal as listed; absent for a gone row, which has nothing on sale to prefill.
 */
export interface RecordBuyCopy {
  sku: string;
  keys?: number;
  scrap?: Scrap;
  /** "from your save of scrap.tf/buy/hats", with the copy's extras; a gone row's names its last price. */
  note: string;
}

/**
 * A buy on scrap.tf at your newest scrap.tf price for this very copy (keys and metal kept apart, as
 * typed). A painted or spelled copy's price is never borrowed: it would be recorded under this SKU
 * and give Holdings the wrong cost. Without one the dialog opens with the venue only. ACT-11 `copy`
 * (a bank stock row): that copy's SKU and listed price, and its note, in place of the price sheet's.
 * 0.7.2: `keyScrap` (the read's key price) picks among copies seen at one time, as the Live market row
 * does (newestScrapPrice); the price is still prefilled in keys and metal as stored.
 */
export function recordBuyInit(
  item: { sku: string; name: string },
  prices: readonly ScrapPrice[],
  copy: RecordBuyCopy | null = null,
  keyScrap: Scrap | null = RECORD_BUY_KEY_SCRAP,
): RecordTradeInit {
  if (copy && typeof copy.sku === 'string' && copy.sku.trim()) {
    const priced = typeof copy.keys === 'number' && Number.isFinite(copy.keys) && typeof copy.scrap === 'number' && Number.isFinite(copy.scrap);
    return {
      side: 'buy',
      sku: copy.sku.trim(),
      name: item.name,
      venue: RECORD_BUY_VENUE,
      ...(priced ? { keys: Math.max(0, Math.floor(copy.keys!)), scrap: Math.max(0, Math.round(copy.scrap!)) } : {}),
      ...(copy.note.trim() ? { note: copy.note.trim() } : {}),
    };
  }
  const p = newestScrapPrice(prices.filter((x) => priceIsForSku(x, item.sku)), keyScrap);
  return { side: 'buy', sku: item.sku, name: item.name, venue: RECORD_BUY_VENUE, ...(p ? { keys: p.costKeys, scrap: p.costScrap } : {}) };
}

/** The journal note of a sale to scrap.tf's bank at its saved list price (F14). */
export const SCRAPTF_SALE_NOTE = 'Sold to scrap.tf';

/**
 * A sale to scrap.tf at what its saved list pays, keys and metal as the list shows them (so the
 * journal books what scrap.tf hands over). Without a pays price only the venue is filled.
 */
export function scraptfSaleInit(item: { sku: string; name: string }, list: Pick<ScraptfListRow, 'paysKeys' | 'paysScrapRaw'>): RecordTradeInit {
  const keys = typeof list.paysKeys === 'number' && Number.isFinite(list.paysKeys) && list.paysKeys > 0 ? list.paysKeys : 0;
  const scrap = typeof list.paysScrapRaw === 'number' && Number.isFinite(list.paysScrapRaw) ? Math.max(0, Math.round(list.paysScrapRaw)) : 0;
  const base: RecordTradeInit = { side: 'sell', sku: item.sku, name: item.name, venue: HOLDING_EXIT_VENUES.scraptf };
  return keys || scrap ? { ...base, keys, scrap, note: SCRAPTF_SALE_NOTE } : base;
}

/**
 * A sale on backpack.tf at `order`'s price, noted "Sold to <buyer>"; without an order only the venue is filled.
 * With `exit` (the item's saved scrap.tf/items row and the time to judge it at), the sale goes to the better
 * exit by Holdings' own rule (bestExitOf: fresh, not full, pays more, backpack.tf wins a tie), so the drawer,
 * the item menu and Holdings prefill the same venue and price.
 */
export function recordSaleInit(item: { sku: string; name: string }, order: OrderSummary | null, exit: { list: ScraptfListRow | null; now: UnixMs } | null = null): RecordTradeInit {
  if (exit?.list && bestExitOf(order?.valueScrap ?? null, exit.list, exit.now).bestExit === 'scraptf') return scraptfSaleInit(item, exit.list);
  return {
    side: 'sell',
    sku: item.sku,
    name: item.name,
    venue: RECORD_SALE_VENUE,
    ...(order ? { keys: order.keys, scrap: order.metalScrap, note: saleNote(order) } : {}),
  };
}

/** A Record buy / Record sale button's tooltip: what the dialog opens with. */
export function recordInitTitle(init: RecordTradeInit): string {
  const what = init.side === 'buy' ? 'a buy' : 'a sale';
  const price = init.keys !== undefined || init.scrap !== undefined ? ` at ${fmtKeysMetal(init.keys ?? 0, init.scrap ?? 0)}` : '';
  const where = init.venue ? ` on ${init.venue}` : '';
  const note = init.note ? ` (${init.note})` : '';
  return `Write ${what}${price}${where}${note} to your journal; you can change it first. Nothing is traded.`;
}

/**
 * The item menu's prefill, from 'item.detail' (local only, history off). The sale uses the
 * revenue order (Settings: revenue used for profit), as the drawer does, or scrap.tf when the
 * saved list makes it the better exit (recordSaleInit). `d` null (the read failed) opens the
 * dialog with the venue only; the user types the price. 0.7.2: the buy picks at the read's key price.
 */
export function recordTradeInit(
  side: 'buy' | 'sell',
  target: Pick<ItemMenuTarget, 'sku' | 'name'> & Partial<Pick<ItemMenuTarget, 'copy'>>,
  d: (Pick<ItemDetail, 'name' | 'scrapPrices' | 'revenue' | 'buyOrders'> & Partial<Pick<ItemDetail, 'scraptfList' | 'keyPrice'>>) | null,
  p: PreviewSettings,
  now: UnixMs = Date.now(),
): RecordTradeInit {
  const item = { sku: target.sku, name: target.name.trim() || d?.name || target.sku };
  if (side === 'buy') return recordBuyInit(item, d?.scrapPrices ?? [], target.copy ?? null, d?.keyPrice?.valueScrap ?? null);
  return recordSaleInit(item, d ? previewRevenue(d, p).order : null, d?.scraptfList ? { list: d.scraptfList, now } : null);
}

// ---------------------------------------------------------------------------
// scrap.tf price list (F14): the drawer's block, "Use as my price" and
// "Open on scrap.tf (copies name)" (drawer and item menu)
// ---------------------------------------------------------------------------

export const OPEN_ON_SCRAPTF_LABEL = 'Open on scrap.tf (copies name)';
export const SCRAPTF_NAME_COPIED = "Name copied. Paste it into scrap.tf's search.";
/** F21: the same, when main opened the page in the user's scrap.tf window. */
export const SCRAPTF_NAME_COPIED_WINDOW = "Opened in the Flip Desk window. Name copied; paste it into scrap.tf's search.";

const BANK_PAGE_URLS: ReadonlySet<string> = new Set(SCRAPTF_BANK_PAGES.map((p) => p.url));

function isCategory(c: unknown): c is Category {
  return typeof c === 'string' && (CATEGORIES as readonly string[]).includes(c);
}

/**
 * F15: the static bank page where the user last saw the item (ItemDetail.seenOn), or null. The
 * /items list is not a bank page (nothing is bought there), so an item last seen on it falls back to
 * its category's bank like an item never seen on a saved page.
 */
export function seenBankPageUrl(seenOn: Pick<ScraptfSeenOn, 'bank'> | null | undefined): string | null {
  const info = scraptfBankInfo(seenOn?.bank);
  return info && info.categories.length > 0 ? info.url : null;
}

/**
 * Every "Open bank page": where the user last saw the item, else 0.7.4 (F36) the bank an item of its kind is
 * sold on (ItemDetail.kindBank, when the service sent it), else the bank of its category (bankForCategory).
 */
export function bankPageUrl(seenOn: Pick<ScraptfSeenOn, 'bank'> | null | undefined, category: Category, kindBank?: ScraptfBank | null): string {
  return seenBankPageUrl(seenOn) ?? seenBankPageUrl(kindBank ? { bank: kindBank } : null) ?? scraptfBankInfo(bankForCategory(category))!.url;
}

/**
 * The scrap.tf page "Open on scrap.tf" hands to the browser: the bank page the user last saw the item
 * on (F15, `seenOn`), else the item's bank page (scraptfPageFor) when its category is known, else the
 * one links.forSku gave ('scraptf-page'), else the full price list (scrap.tf/items lists every item).
 * null while the links are still loading. Every one of them is a static allowlisted page (links.ts);
 * the app never fetches them (R1). 0.7.4 (F36): `kindBank` (ItemDetail.kindBank) before the category's page,
 * so a strange cosmetic opens /buy/hats.
 */
export function scraptfOpenUrl(
  category: Category | null | undefined,
  links: LinksState | null,
  seenOn: Pick<ScraptfSeenOn, 'bank'> | null = null,
  kindBank: ScraptfBank | null = null,
): string | null {
  const seen = seenBankPageUrl(seenOn) ?? seenBankPageUrl(kindBank ? { bank: kindBank } : null);
  if (seen) return seen;
  if (isCategory(category)) return scraptfPageFor(category);
  if (links === null) return SCRAPTF_ITEMS_URL;
  if (links.status === 'loading') return null;
  if (links.status === 'ready') {
    const page = links.links.find((l) => l.id === 'scraptf-page' && BANK_PAGE_URLS.has(l.url));
    if (page) return page.url;
  }
  return SCRAPTF_ITEMS_URL;
}

/**
 * The name without the schema's " (Paint: X)" suffix (schemaNames.ts appends it to painted SKUs).
 * scrap.tf names and searches items unpainted, and its list rows are the unpainted base SKU.
 */
export function unpaintedName(name: string): string {
  return name.replace(/\s*\(Paint: [^()]*\)\s*$/, '').trim();
}

/**
 * 0.7.2: killstreak kits by defindex (6527 basic, 6523 specialized, 6526 professional). 0.7.4 (F17): and the
 * schema's legacy "X Killstreakifier Basic" kits (item_name "Kit"), which backpack.tf files some kit orders under.
 */
const KIT_DEFINDEXES: ReadonlySet<number> = new Set([
  6527, 6523, 6526, 5726, 5727, 5728, 5729, 5730, 5731, 5732, 5733, 5743, 5744, 5745, 5746, 5747, 5748, 5749, 5750, 5751, 5793, 5794, 5795, 5796, 5797,
  5798, 5799, 5800, 5801,
]);

/** A kit's name as the schema builds it (or backpack.tf names it): the weapon is what is left. */
const KIT_NAME_RE = /^(?:Non-Tradable\s+)?(?:Non-Craftable\s+)?(?:(?:Basic|Specialized|Professional)\s+)?(?:Killstreak\s+)?(.+?)\s+Kit$/i;

/**
 * 0.7.2: a killstreak kit's name (with a weapon) cut down to "<weapon> Kit", else null. scrap.tf titles a
 * kit "Professional Rocket Launcher Kit" (no "Killstreak"), so Steam's "Non-Craftable Professional
 * Killstreak Rocket Launcher Kit" is not part of it, while "Rocket Launcher Kit" is part of every form of
 * the title, without guessing which tier or craft words the page shows.
 */
function kitSearchName(sku: string, name: string): string | null {
  const obj = fromString(String(sku).trim());
  // A kit with no weapon (a bare "6526;6") is just "Professional Killstreak Kit": left as it is.
  if (!KIT_DEFINDEXES.has(obj.defindex) || typeof obj.target !== 'number' || obj.target <= 0) return null;
  const m = KIT_NAME_RE.exec(name.replace(/\s+/g, ' ').trim());
  const weapon = m?.[1]?.trim() ?? '';
  // A name the schema could not build (the SKU itself) or another shape keeps the usual search name.
  if (!weapon || /\b(?:Killstreak|Kit)\b/i.test(weapon)) return null;
  return `${weapon} Kit`;
}

/**
 * What to paste into scrap.tf's search box: the unpainted item name (the SKU when there is none).
 * 0.7.2: a killstreak kit's is "<weapon> Kit" (kitSearchName), which scrap.tf's kit titles contain.
 */
export function scraptfSearchName(item: { sku: string; name: string }): string {
  const plain = unpaintedName(item.name);
  return kitSearchName(item.sku, plain) ?? (plain || item.name.trim() || item.sku);
}

/** F21 `inWindow` (scraptfLinksInWindow): main opens the page in the user's scrap.tf window, not the browser. */
export function scraptfOpenTitle(url: string, name: string, inWindow = false): string {
  if (inWindow) return `Copies "${truncate(name, 60)}" for scrap.tf's search and opens ${url} in the Flip Desk window, where you browse it yourself.`;
  return `Copies "${truncate(name, 60)}" for scrap.tf's search and opens ${url} in your browser. ${SCRAPTF_BOUNDARY_SHORT}`;
}

/**
 * UX-5: the toast's hint for a page main opened in the scrap.tf window that reads pages as they load
 * (readOnLoad): the price found there comes back by itself, so the Live check's copy-a-price hint goes.
 */
export const SCRAPTF_WINDOW_READ_HINT = 'It is read when it loads; its price shows here by itself.';

/**
 * The toast after "Open on scrap.tf": copied and opened is the usual case. The name is copied first
 * (a page loses clipboard access once the browser takes focus), so either step may fail alone.
 * F19: `back` (checkModel's scraptfBackHint) says how the price found there comes back through the
 * Live check; with it the toast names the page it opened. F21: `opened.openedIn === 'window'` (main sent the
 * page to the user's scrap.tf window) says so instead of "your browser". UX-5 `readOnLoad` (the window's
 * setting): a page opened there is read as it loads, so SCRAPTF_WINDOW_READ_HINT replaces `back`.
 */
export function scraptfOpenedToast(
  copied: boolean,
  opened: { opened: boolean; reason: string | null; openedIn?: 'window' },
  url: string,
  back: string | null = null,
  readOnLoad = false,
): { text: string; tone: 'good' | 'warn' } {
  const hint = opened.opened && opened.openedIn === 'window' && readOnLoad ? SCRAPTF_WINDOW_READ_HINT : back;
  const tail = hint ? ` ${hint}` : '';
  if (opened.opened) {
    const where = opened.openedIn === 'window' ? 'the Flip Desk window' : 'your browser';
    if (!copied) return { text: `scrap.tf is open in ${where}, but the name could not be copied. Type it into scrap.tf's search.${tail}`, tone: 'warn' };
    if (hint) return { text: `Opened ${bankStockPagePath(url)} in ${where}. The name is copied; paste it into scrap.tf's search.${tail}`, tone: 'good' };
    return { text: opened.openedIn === 'window' ? SCRAPTF_NAME_COPIED_WINDOW : SCRAPTF_NAME_COPIED, tone: 'good' };
  }
  const why = opened.reason ?? 'The link could not be opened.';
  return copied
    ? { text: `${why} The name was copied: open ${url} in your browser and paste it into scrap.tf's search.${tail}`, tone: 'warn' }
    : { text: `${why} ${url}`, tone: 'warn' };
}

export interface ScraptfListView {
  /** "Price to buy" as the list shows it ("1 key 5.11 ref"), or "sold out" when it shows none. */
  sells: string;
  /** "Price we pay" as listed, or "—" when the list shows none. */
  pays: string;
  /** Hover for sells / pays: the value at today's key price (when keys are involved) or why there is none. */
  sellsTitle: string | undefined;
  paysTitle: string | undefined;
  /** "2/5", "3", or null when the list shows no stock. */
  stock: string | null;
  /** scrap.tf is at its limit (stock >= limit): it buys no more right now. */
  full: boolean;
  /** At most a day old (SCRAPTF_LIST_FRESH_MS): only then does Holdings count scrap.tf as an exit. */
  fresh: boolean;
  /** "saved 3 min ago" */
  saved: string;
  /** Hover for the whole block: the save time and what it means. */
  title: string;
  /** The list shows a price to buy (the line reads "sells X"; else "sold out"). */
  hasSells: boolean;
  /**
   * "Use as my price" has a price to save: a price to buy, scrap.tf has the item in stock, and 0.7.4 the row
   * is proven to price this very copy (scraptfListCraftProven).
   */
  canUse: boolean;
  /** Why "Use as my price" has nothing to save (sold out, stock 0, or a family row); null when it can. */
  unusable: string | null;
  /** The block's line: "sells X · pays Y · stock n/limit · saved 3 min ago". */
  line: string;
  /**
   * 0.7.4: which copy the row prices as the list shows it ("Non-Craftable", "Craftable"), or null for a
   * family row, which prices every copy at its price (`family`).
   */
  copy: string | null;
  /** 0.7.4: a row for every copy at its price (craft 'any', or read as the copy's family): its stock counts all of them. */
  family: boolean;
  /** 0.7.4: the family row's label and its hover (SCRAPTF_LIST_FAMILY_LABEL); null for a row of its own copy. */
  familyText: string | null;
  familyTitle: string | null;
}

/** The drawer's "scrap.tf price list" block for the item's row of the saved scrap.tf/items list. */
export function scraptfListView(row: ScraptfListRow, keyScrap: Scrap | null, now: UnixMs): ScraptfListView {
  const sellsText = listSellsText(row);
  const paysKeys = typeof row.paysKeys === 'number' && Number.isFinite(row.paysKeys) && row.paysKeys > 0 ? row.paysKeys : 0;
  const hasPays = typeof row.paysScrapRaw === 'number' && Number.isFinite(row.paysScrapRaw);
  const pays = hasPays ? fmtKeysMetal(paysKeys, Math.round(row.paysScrapRaw ?? 0)) : '—';
  const valued = (keys: number | null, v: Scrap | null): string | undefined =>
    keys && v !== null && keyScrap ? `${fmtRefOnly(v)} at today's key price (${fmtRefOnly(keyScrap)})` : undefined;
  const stock = typeof row.stock === 'number' && Number.isFinite(row.stock) ? (typeof row.stockLimit === 'number' && Number.isFinite(row.stockLimit) ? `${fmtInt(row.stock)}/${fmtInt(row.stockLimit)}` : fmtInt(row.stock)) : null;
  const fresh = scraptfListFresh(row, now);
  const saved = `saved ${fmtAgo(row.observedAt, now)}`;
  const title = [
    `Your saved copy of scrap.tf/items, ${fmtDateTime(row.observedAt)}.`,
    fresh ? 'Prices and stock may have changed since.' : 'Older than a day: Holdings no longer counts scrap.tf as a place to sell this. Save scrap.tf/items again.',
    row.full ? 'scrap.tf is at its limit for this item, so it buys no more right now.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const sells = sellsText ?? 'sold out';
  // A priced row with stock 0 is refused as a price by the import too (scraptfListUsePrice).
  const price = scraptfListUsePrice(row);
  // 0.7.4: and a family row (one row for every copy at its price, Craftable or not) is no cost of this copy,
  // as the import never stores one as a price: shown, never saved as the user's.
  const canUse = price !== null && scraptfListCraftProven(row);
  const family = scraptfListIsFamily(row);
  const copy = family ? null : row.craft === 'uncraftable' ? 'Non-Craftable' : row.craft === 'craftable' ? 'Craftable' : null;
  return {
    sells,
    pays,
    sellsTitle: sellsText ? valued(row.sellsKeys, row.sellsScrap) : 'The saved list shows no price to buy: scrap.tf has none in stock.',
    paysTitle: hasPays ? valued(row.paysKeys, row.paysScrap) : 'The saved list shows no price scrap.tf pays for this item.',
    stock,
    full: row.full,
    fresh,
    saved,
    title,
    hasSells: sellsText !== null,
    canUse,
    unusable: canUse
      ? null
      : sellsText === null
        ? 'The saved list shows no price to buy (sold out), so there is nothing to use.'
        : price === null
          ? 'Out of stock on scrap.tf (stock 0 in your saved list), so there is nothing to buy at this price.'
          : `${SCRAPTF_LIST_CRAFT_UNPROVEN}.`,
    line: [
      sellsText ? `sells ${sellsText}` : 'sold out',
      `pays ${pays}`,
      stock !== null ? `stock ${stock}${family ? ' for every copy' : ''}${row.full ? ' (full)' : ''}` : null,
      saved,
    ]
      .filter((x) => x !== null)
      .join(' · '),
    copy,
    family,
    familyText: family ? SCRAPTF_LIST_FAMILY_LABEL : null,
    familyTitle: family
      ? "scrap.tf/items lists this item on one row for every copy it sells at this price (Craftable or Non-Craftable, any killstreak tier, festivized), so its stock counts all of them and its price is no cost of one copy. Your saved bank page shows which copies scrap.tf has and each one's price."
      : null,
  };
}

/**
 * "Use as my price": the list's price to buy saved as a typed price (source 'user', LIST_PRICE_NOTE),
 * as an import of the list would store it: under the base SKU the list row is for (a plain copy),
 * keys and metal as listed, dated when the list was saved (an old list reads stale, as it should).
 * The name drops a painted drawer's "(Paint: X)": the row prices the unpainted copy. null when there
 * is nothing to buy: a sold-out row, or one with stock 0, which the import refuses as a price too; and
 * 0.7.4 for a row not proven to price this copy (a family row, scraptfListCraftProven), which the import
 * never stores as a price either: a typed copy would outlive every later import as the wrong copy's cost.
 */
export function listPriceInput(row: ScraptfListRow, item: { name: string }): ScrapPriceInput | null {
  const price = scraptfListUsePrice(row);
  if (price === null || !scraptfListCraftProven(row)) return null;
  return {
    sku: row.sku,
    name: unpaintedName(item.name) || row.name.trim() || row.sku,
    costKeys: price.keys,
    costScrap: price.scrap,
    source: 'user',
    observedAt: row.observedAt,
    note: LIST_PRICE_NOTE,
  };
}

/**
 * "Use as my price" already saved this very list price (same plain copy, keys and metal, list date and
 * note), so another click would only add the same row again (prices.upsert adds a row per call). A
 * painted drawer's prices never hold the plain copy's row: it reads ItemDetail.scraptfListSaved instead.
 */
export function listPriceAlreadySaved(
  row: ScraptfListRow,
  prices: readonly Pick<ScrapPrice, 'sku' | 'source' | 'note' | 'observedAt' | 'costKeys' | 'costScrap' | 'special'>[],
): boolean {
  return scraptfListPriceSaved(row, prices);
}

/** The confirmation after "Use as my price". */
export function listPriceSavedText(saved: Pick<ScrapPrice, 'name' | 'costKeys' | 'costScrap'>, observedAt: UnixMs, now: UnixMs): string {
  return `Saved ${saved.name} at ${fmtKeysMetal(saved.costKeys, saved.costScrap)}, from your scrap.tf list saved ${fmtAgo(observedAt, now)}.`;
}

