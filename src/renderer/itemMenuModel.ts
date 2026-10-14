// Pure helpers behind the row context menu (ItemMenu, F9) and the item drawer's
// buyer actions (F3), price actions (F8) and copy buttons (F9). No DOM and no
// RPC here, so all of it is unit-tested; the components only wire it up.

import { communityMaxAgeMs } from '../shared/referenceAge';
import type { BuyerCheck, ItemDetail, LinkGroup, LinkSpec, Opportunity, OrderSummary, Scrap, ScrapPrice, ScrapPriceInput, UnixMs } from '../shared/types';
import type { IconName } from './components/Icon';
import type { ItemMenuTarget } from './components/ItemMenu';
import { fmtAgo, truncate } from './format';
import { revenueOrderOf, type UseOrder } from './oppModel';

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface MenuPoint {
  x: number;
  y: number;
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
 * Where a menu opened at `at` goes: right of and below the pointer when it fits,
 * flipped left or up when it does not, and pinned inside the margin (with
 * `maxHeight` for a scrollbar) when even that does not fit, such as a long link
 * list in a short window.
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
  const left = x + w <= vw - margin ? x : x - w;
  const top = y + h <= vh - margin ? y : y - h;
  return {
    left: Math.round(clampTo(left, margin, Math.max(margin, vw - margin - w))),
    top: Math.round(clampTo(top, margin, Math.max(margin, vh - margin - h))),
    maxHeight: Math.round(maxH),
  };
}

/** Where a menu opened from the keyboard appears: just inside the focused row's lower-left corner. */
export function menuPointForRect(r: { left: number; top: number; width: number; height: number }): MenuPoint {
  return { x: Math.round(r.left + Math.min(24, r.width / 2)), y: Math.round(r.top + Math.min(r.height, 28)) };
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

export type ItemMenuAction = { kind: 'details' } | { kind: 'copy'; text: string } | { kind: 'quick-entry' } | { kind: 'link'; url: string };

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
 * scrap.tf price… (quick entry, prefilled); then the link groups once
 * 'links.forSku' answers.
 */
export function itemMenuSections(target: ItemMenuTarget, links: LinksState): MenuSection<ItemMenuAction>[] {
  const sections: MenuSection<ItemMenuAction>[] = [
    { id: 'open', items: [{ id: 'details', label: 'Open details', icon: 'chevronRight', action: { kind: 'details' } }] },
    {
      id: 'copy',
      items: copyTargets(target).map((c) => ({ id: `copy-${c.kind}`, label: c.label, title: c.text, icon: 'copy' as const, action: { kind: 'copy' as const, text: c.text } })),
    },
    { id: 'price', items: [{ id: 'quick-entry', label: 'Record scrap.tf price…', hint: 'Quick entry', icon: 'plus', action: { kind: 'quick-entry' } }] },
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

export type BuyerMenuAction = { kind: 'open'; url: string } | { kind: 'copy-id' } | { kind: 'check' } | { kind: 'block' } | { kind: 'unblock' };

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

/** The typed price the drawer form updates by default: the newest one the user typed (imports are left to re-imports). */
export function defaultPriceTarget(prices: readonly ScrapPrice[]): number | null {
  let best: ScrapPrice | null = null;
  for (const p of prices) if (p.source === 'user' && (best === null || p.observedAt > best.observedAt)) best = p;
  return best?.id ?? null;
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
    return { title: 'Found it on scrap.tf? Record the real price', hint: "The rule's cost is an estimate. Type the price scrap.tf shows; the app never visits scrap.tf itself." };
  return { title: 'Add / update scrap.tf price', hint: 'Type what you see on scrap.tf. The app never visits scrap.tf itself.' };
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

