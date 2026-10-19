// Pure helpers for the scrap.tf bank stock page (F17, pages/BankStockPage.tsx, route
// #/banks/<bank>/stock): every item on one scrap.tf page as the user's newest save of it shows
// it, what changed since their previous save, and its backpack.tf side, from 'scraptf.bankStock'.
// F20 adds how long each item has been listed across the user's saves and its price since then (the
// Listed and Since listed columns, the Listed > 24 h and Dropped since listed chips).
// Rows, counts, filters and order come from the service (or the mock) through the shared rules in
// src/shared/bankStock.ts; nothing is recomputed here. All pure except createBankStockLoader, whose
// only effect is the call it is handed.
//
// Labels, paths and the page's address always come from SCRAPTF_BANKS (scraptfBankInfo), whatever
// the service sent; the page hands that static address only to links.open or, on a click, to the
// user's scrap.tf window. Flip Desk never loads scrap.tf on its own (R1): the data is only the pages
// the user saved into the watch folder or read in that window (R10).

import {
  BANK_STOCK_DEFAULT_LIMIT,
  BANK_STOCK_KEEP_SAVES,
  BANK_STOCK_MAX_AGE_MS,
  BANK_STOCK_MAX_LIMIT,
  BANK_STOCK_MAX_SEARCH_CHARS,
  BANK_STOCK_SESSION_GAP_MS,
  SCRAPTF_LONG_LISTED_MS,
  bankStockDefaultDir,
} from '../shared/bankStock';
import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { scraptfBankInfo } from '../shared/links';
import { scraptfAgoText } from '../shared/scraptfHistory';
import { fromObject, fromString } from '../shared/sku';
import { BANK_STOCK_FILTERS, BANK_STOCK_SORTS } from '../shared/types';
import type { BankStockCounts, BankStockFilter, BankStockQuery, BankStockResult, BankStockRow, BankStockSort, BankStockVerdict, Scrap, ScraptfBank, UnixMs } from '../shared/types';
import { BANK_SAVE_TIP, LIST_SAVE_TIP, bankFreshness, bankPath, type BankFreshness } from './banksModel';
import { changePctText } from './changesModel';
import { SAVE_MODE } from './importModel';
import type { RecordBuyCopy } from './itemMenuModel';
import { DASH, PAINT_NAMES, errorMessage, fmtAgo, fmtDateTime, fmtInt, fmtKeysMetal, fmtMoney, fmtPct, fmtSignedMoney, paintHex, type Tone } from './format';

/** Rows per read; "Load more" adds as many, up to BANK_STOCK_MAX_LIMIT (a whole bank page). */
export const BANK_STOCK_PAGE = BANK_STOCK_DEFAULT_LIMIT;

/** The page re-reads at most this often on pushes (banksChanged, market.changed). */
export const BANK_STOCK_REFRESH_MS = 2_000;

/** Under the boundary line: a save is a snapshot, so changes are only as complete as the saves. */
export const BANK_STOCK_SNAPSHOT_NOTE = 'Each save is a snapshot of the page at that moment: what happened between two saves is unknown.';

export const BANK_STOCK_EXTRAS_TITLE =
  'A painted, spelled or otherwise special copy (paint, spells, parts, sheen, killstreaker or a name tag). Pay up to and the verdict are for a clean copy: buyers rarely pay for extras.';

/**
 * What a row's copy carries, read back from its key (`${sku}|${specialKey}`, the import's extras JSON:
 * paint, spells, parts, sheen, killstreaker, name tag, description tag), so a plain and a painted copy
 * of one SKU can be told apart. Empty for a clean copy or a key it cannot read.
 */
export function bankStockExtras(key: string): string[] {
  const v = specialOf(key);
  if (!v) return [];
  const [paint, spells, parts, sheen, killstreaker, customName, customDesc] = v;
  const names = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : []);
  const out: string[] = [];
  if (finite(paint) && paint > 0) out.push(`Paint: ${PAINT_NAMES[paint] ?? paintHex(paint)}`);
  for (const s of names(spells)) out.push(`Spell: ${s}`);
  for (const s of names(parts)) out.push(`Strange part: ${s}`);
  if (finite(sheen)) out.push('A sheen');
  if (finite(killstreaker)) out.push('A killstreaker');
  if (customName === true) out.push('A name tag');
  if (customDesc === true) out.push('A description tag');
  return out;
}

/** A row key's extras JSON (`${sku}|${specialKey}`) as its array, or null for a clean copy or a key it cannot read. */
function specialOf(key: string): unknown[] | null {
  const at = typeof key === 'string' ? key.indexOf('|') : -1;
  const raw = at >= 0 ? key.slice(at + 1) : '';
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as unknown[]) : null;
  } catch {
    return null;
  }
}

/** The paint a row's copy has (the extras' first entry), or null. */
export function bankStockPaintOf(key: string): number | null {
  const paint = specialOf(key)?.[0];
  return finite(paint) && paint > 0 ? paint : null;
}

/**
 * ACT-11: what Record buy books for a row: its exact copy (a painted copy under its painted SKU, as the
 * journal and Holdings key it) at the price the save listed (keys and metal as listed), noted "from your
 * save of scrap.tf/buy/hats" with its extras. A gone row is no longer on sale: no price is prefilled, and
 * the note gives its last one.
 */
export function bankStockBuyCopy(r: Pick<BankStockRow, 'sku' | 'key' | 'costKeys' | 'costScrapRaw' | 'change'>, bank: ScraptfBank): RecordBuyCopy {
  const info = scraptfBankInfo(bank);
  const path = info ? bankPath(info.url) : 'scrap.tf';
  const paint = bankStockPaintOf(r.key);
  let sku = r.sku;
  if (paint !== null) {
    try {
      sku = fromObject({ ...fromString(r.sku), paint });
    } catch {
      // An unreadable SKU stays as the row has it.
    }
  }
  const extras = bankStockExtras(r.key);
  const tail = extras.length ? ` (${extras.join(', ')})` : '';
  const keys = finite(r.costKeys) && r.costKeys > 0 ? Math.floor(r.costKeys) : 0;
  const scrap = finite(r.costScrapRaw) ? Math.max(0, Math.round(r.costScrapRaw)) : 0;
  if (r.change === 'gone') return { sku, note: `last price ${fmtKeysMetal(keys, scrap)} in your save of ${path}, gone from your newest save${tail}` };
  return { sku, keys, scrap, note: `from your save of ${path}${tail}` };
}

/** The "extras" badge's hover: which extras this copy has, then the clean-copy caveat. */
export function bankStockExtrasTitle(key: string): string {
  const list = bankStockExtras(key);
  return list.length ? `This copy has extras: ${list.join(', ')}. Pay up to and the verdict are for a clean copy: buyers rarely pay for extras.` : BANK_STOCK_EXTRAS_TITLE;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** F20 S1: how long saves are kept for price history (bankStockThinning). */
const KEPT_DAYS = Math.round(BANK_STOCK_MAX_AGE_MS / 86_400_000);
// F20: the thinning never drops a page's newest save or its compare save, whatever their age. 0.7.1 (DM-3,
// CQ-1): the tiers are B's bankStockThinning ones (every save for 2 h, then 10-minute, hourly and daily buckets).
export const RETENTION_NOTE = `For price history your saves are kept up to ${KEPT_DAYS} days: every save from the last 2 hours, then one every 10 minutes for the rest of the day, then one an hour for a week, then one a day; a page's newest save and the ones it is compared with always stay.`;

/** 0.7.1 (CQ-2): what "your latest run of saves" means (BANK_STOCK_SESSION_GAP_MS). */
export const SESSION_NOTE = `Saves less than ${Math.round(BANK_STOCK_SESSION_GAP_MS / 60_000)} min apart count as one run, so reading the page again soon after does not clear what changed.`;

function sinceWhen(previousSavedAt: UnixMs | null, now: UnixMs): string {
  return previousSavedAt === null ? 'your previous save' : `your previous save (${fmtAgo(Math.min(previousSavedAt, now), now)})`;
}

// ---------------------------------------------------------------------------
// The view the user picks: filter, search and order, remembered per bank
// ---------------------------------------------------------------------------

export interface BankStockView {
  filter: BankStockFilter;
  search: string;
  sort: BankStockSort;
  dir: 'asc' | 'desc';
}

export const DEFAULT_BANK_STOCK_VIEW: Readonly<BankStockView> = Object.freeze<BankStockView>({ filter: 'all', search: '', sort: 'profit', dir: 'desc' });

/** usePersistentState key: each bank keeps its own filter, search and order. */
export function bankStockPrefKey(bank: ScraptfBank): string {
  return `bankStock.view.${bank}`;
}

/** The saved view, from storage that may hold anything. */
export function sanitizeBankStockView(v: unknown): BankStockView {
  const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const filter = BANK_STOCK_FILTERS.find((f) => f === o['filter']) ?? DEFAULT_BANK_STOCK_VIEW.filter;
  const sort = BANK_STOCK_SORTS.find((s) => s === o['sort']) ?? DEFAULT_BANK_STOCK_VIEW.sort;
  const dir = o['dir'] === 'asc' || o['dir'] === 'desc' ? o['dir'] : bankStockDefaultDir(sort);
  const search = typeof o['search'] === 'string' ? o['search'].slice(0, BANK_STOCK_MAX_SEARCH_CHARS) : '';
  return { filter, search, sort, dir };
}

/** 'scraptf.bankStock' params for the view: the first `limit` rows (clamped to 1..2000), search trimmed. */
export function bankStockQueryOf(bank: ScraptfBank, view: BankStockView, limit: number = BANK_STOCK_PAGE): BankStockQuery {
  const search = view.search.trim().slice(0, BANK_STOCK_MAX_SEARCH_CHARS);
  const n = finite(limit) ? Math.min(BANK_STOCK_MAX_LIMIT, Math.max(1, Math.floor(limit))) : BANK_STOCK_PAGE;
  const q: BankStockQuery = { bank, filter: view.filter, sort: view.sort, dir: view.dir, limit: n, offset: 0 };
  if (search) q.search = search;
  return q;
}

/** The CSV export's query: the same rows in the same order, every one of them (paging dropped). */
export function bankStockExportQuery(bank: ScraptfBank, view: BankStockView): BankStockQuery {
  const { limit: _limit, offset: _offset, ...rest } = bankStockQueryOf(bank, view);
  return rest;
}

/** Identifies what the rows answer apart from paging: a new key starts at the top with one page. */
export function bankStockQueryKey(q: BankStockQuery): string {
  return JSON.stringify([q.bank, q.filter ?? 'all', q.search ?? '', q.sort ?? 'profit', q.dir ?? null]);
}

/**
 * "Load more" is pending: a read is in flight while the rows shown answer this same query (`queryKey`,
 * paging aside) at a smaller page size than `limit`, the one asked for. A background refresh (a push,
 * about every 2 s on a busy feed) reads the page size already shown, so it neither relabels nor
 * disables the button; a click during one is safe, since the loader runs the newer query next.
 */
export function bankStockLoadingMore(busy: boolean, answered: BankStockQuery | null, queryKey: string, limit: number): boolean {
  if (!busy || answered === null || bankStockQueryKey(answered) !== queryKey) return false;
  const shown = finite(answered.limit) ? answered.limit : BANK_STOCK_PAGE;
  return finite(limit) && shown < limit;
}

/** A header click: the same column flips the direction, another one starts at its default. */
export function bankStockSortChange(view: Pick<BankStockView, 'sort' | 'dir'>, sort: BankStockSort): Pick<BankStockView, 'sort' | 'dir'> {
  if (view.sort === sort) return { sort, dir: view.dir === 'asc' ? 'desc' : 'asc' };
  return { sort, dir: bankStockDefaultDir(sort) };
}

export const BANK_STOCK_SORT_LABELS: Readonly<Record<BankStockSort, string>> = {
  profit: 'Profit',
  margin: 'Margin',
  cost: 'scrap.tf price',
  payUpTo: 'Pay up to',
  name: 'Name',
  // F20: how long it has been listed (longest first) and its price since then (biggest drop first).
  listed: 'Listed',
  sinceListed: 'Since listed',
};

/** The sorts the picker offers, F20's two after F17's. */
export const BANK_STOCK_PICKER_SORTS: readonly BankStockSort[] = ['profit', 'margin', 'cost', 'name', 'payUpTo', 'listed', 'sinceListed'];

/** "Showing 200 of 1,234" under the table, and how far "Load more" goes; null when every row shows. */
export function bankStockMore(shown: number, total: number): { text: string; next: number | null; title: string } | null {
  if (!finite(shown) || !finite(total) || total <= shown) return null;
  if (shown >= BANK_STOCK_MAX_LIMIT) {
    return {
      text: `Showing the first ${fmtInt(shown)} of ${fmtInt(total)}. Narrow the search, or Export CSV for every item.`,
      next: null,
      title: `At most ${fmtInt(BANK_STOCK_MAX_LIMIT)} rows show at once; the CSV has them all.`,
    };
  }
  const next = Math.min(BANK_STOCK_MAX_LIMIT, shown + BANK_STOCK_PAGE, total);
  return { text: `Showing ${fmtInt(shown)} of ${fmtInt(total)}`, next, title: `Shows the next ${fmtInt(next - shown)} in this order.` };
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

export const BANK_STOCK_FILTER_LABELS: Readonly<Record<BankStockFilter, string>> = {
  all: 'All',
  new: 'New',
  flips: 'Flips',
  changed: 'Price changes',
  gone: 'Gone',
  // F20: from the run of the user's saves that list an item on sale (BankStockRow.listedSince).
  'long-listed': 'Listed > 24 h',
  dropped: 'Dropped since listed',
};

export const BANK_STOCK_FILTER_HELP: Readonly<Record<BankStockFilter, string>> = {
  all: 'Everything on sale in your newest save: a price to buy, and in stock.',
  new: 'On sale in your newest save but not in your previous one: new on the page, or back in stock.',
  flips: 'On sale now, and a backpack.tf buyer pays enough to clear your profit thresholds.',
  changed: 'On sale in both saves at another price: cheaper or pricier.',
  gone: 'On sale in your previous save but not in your newest one: sold, sold out or taken off the page.',
  // DM-5: measured to the newest save that lists it, so a page saved once long ago counts no time.
  'long-listed': 'On sale in every one of your saves of this page for at least a day, up to the newest one that lists it: listed since then without a break.',
  dropped: 'On sale now, and cheaper than when your saves first listed it in its current run.',
};

/** The chips the page shows: F17's, then F20's Listed > 24 h and Dropped since listed. */
export const BANK_STOCK_CHIP_FILTERS: readonly BankStockFilter[] = ['all', 'new', 'flips', 'changed', 'gone', 'long-listed', 'dropped'];

const CHANGE_FILTERS: ReadonlySet<BankStockFilter> = new Set<BankStockFilter>(['new', 'changed', 'gone']);

/** The chips that compare two saves: with one save there is nothing to compare. */
export function isChangeFilter(f: BankStockFilter): boolean {
  return CHANGE_FILTERS.has(f);
}

export interface BankStockChip {
  filter: BankStockFilter;
  label: string;
  /** The count, "…" until the first answer, a dash while the chip needs a second save. */
  count: string;
  title: string;
  disabled: boolean;
  tone: Tone;
}

const CHIP_TONES: Readonly<Record<BankStockFilter, Tone>> = { all: 'info', new: 'good', flips: 'good', changed: 'warn', gone: 'muted', 'long-listed': 'info', dropped: 'good' };

function chipCount(c: BankStockCounts, f: BankStockFilter): number {
  switch (f) {
    case 'all':
      return c.inStock;
    case 'new':
      return c.new;
    case 'flips':
      return c.flips;
    case 'changed':
      return c.cheaper + c.pricier;
    case 'gone':
      return c.gone;
    case 'long-listed':
      return c.longListed;
    case 'dropped':
      return c.dropped;
  }
}

/** All (in stock), New, Flips, Price changes, Gone, with counts over the whole bank (filter and search ignored). */
export function bankStockChips(r: Pick<BankStockResult, 'counts' | 'previousSavedAt'> | null): BankStockChip[] {
  // A first save (or none) compares nothing: the change chips wait for a second save.
  const single = r !== null && r.previousSavedAt === null;
  return BANK_STOCK_CHIP_FILTERS.map((f) => {
    const disabled = single && isChangeFilter(f);
    const n = r ? chipCount(r.counts, f) : null;
    let title = BANK_STOCK_FILTER_HELP[f];
    if (disabled) title = `${title} Save the page again later to see this.`;
    else if (f === 'changed' && r) title = `${title} ${fmtInt(r.counts.cheaper)} cheaper, ${fmtInt(r.counts.pricier)} pricier.`;
    else if (f === 'new' && r && r.counts.newFlips > 0) title = `${title} ${fmtInt(r.counts.newFlips)} of them ${r.counts.newFlips === 1 ? 'is a flip' : 'are flips'}.`;
    return { filter: f, label: BANK_STOCK_FILTER_LABELS[f], count: disabled ? DASH : n === null ? '…' : fmtInt(n), title, disabled, tone: CHIP_TONES[f] };
  });
}

/**
 * True when an answer leaves the view's filter nothing to show: a change filter (remembered from an
 * earlier visit) on a bank whose newest save has no previous one. The page then goes back to All.
 */
export function bankStockFilterUnavailable(filter: BankStockFilter, r: Pick<BankStockResult, 'previousSavedAt'> | null): boolean {
  return r !== null && r.previousSavedAt === null && isChangeFilter(filter);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export interface BankStockHeaderView {
  bank: ScraptfBank;
  label: string;
  /** The static SCRAPTF_BANKS address: only ever handed to links.open. */
  url: string;
  /** "scrap.tf/buy/hats" */
  path: string;
  /** "Hats stock" */
  title: string;
  freshness: BankFreshness;
  /** "saved 12 min ago · 48 items (31 in stock)", or why there is nothing. */
  saved: { text: string; title: string };
  /** "previous save 3 h ago", or "first save"; null before an answer and for a page never saved. */
  previous: { text: string; title: string } | null;
  /** One save only: nothing is new, gone or repriced yet. */
  firstSave: boolean;
  openTitle: string;
}

/**
 * The header for `bank` from SCRAPTF_BANKS, dated by the answer (null until it arrives); null for an unknown
 * bank. F21-9 `inWindow` (scraptfLinksInWindow): main opens the page's Open in the user's scrap.tf window.
 */
export function bankStockHeader(
  bank: ScraptfBank,
  r: Pick<BankStockResult, 'savedAt' | 'previousSavedAt' | 'saves' | 'counts' | 'pages' | 'oldestSavedAt'> | null,
  now: UnixMs,
  inWindow = false,
): BankStockHeaderView | null {
  const info = scraptfBankInfo(bank);
  if (!info) return null;
  const path = bankPath(info.url);
  const savedAt = r && finite(r.savedAt) ? r.savedAt : null;
  const prevAt = r && finite(r.previousSavedAt) ? r.previousSavedAt : null;
  const base = {
    bank: info.bank,
    label: info.label,
    url: info.url,
    path,
    title: `${info.label} stock`,
    freshness: bankFreshness(savedAt, now),
    // The list gets no Single File alternative: such a save of it is refused (SAVE_MODE_LIST_NOTE).
    openTitle: inWindow
      ? `Opens ${path} in the Flip Desk window, where you browse it yourself.`
      : `Opens ${path} in your own browser. ${SCRAPTF_BOUNDARY_SHORT} ${info.bank === 'list' ? LIST_SAVE_TIP : BANK_SAVE_TIP}`,
  };
  if (!r) return { ...base, saved: { text: 'Reading your saves…', title: '' }, previous: null, firstSave: false };
  if (savedAt === null) {
    return {
      ...base,
      saved: { text: 'Not saved yet', title: `No save of ${path} is kept: save the page as '${SAVE_MODE}' into your watch folder to see its items here.` },
      previous: null,
      firstSave: false,
    };
  }
  const items = finite(r.counts.items) ? Math.max(0, r.counts.items) : 0;
  const inStock = Math.min(items, finite(r.counts.inStock) ? Math.max(0, r.counts.inStock) : 0);
  const saves = finite(r.saves) ? Math.max(0, r.saves) : 0;
  // Several pages of the bank (/items and /items/2, say): the rows are each page's newest save, so the
  // header says so and how old the oldest of them is, rather than dating them all by the newest.
  const pages = finite(r.pages) && r.pages > 1 ? Math.floor(r.pages) : 1;
  const oldestAt = pages > 1 && finite(r.oldestSavedAt) ? r.oldestSavedAt : null;
  const pagesText = pages > 1 ? ` · ${fmtInt(pages)} pages${oldestAt !== null && oldestAt < savedAt ? `, oldest saved ${fmtAgo(Math.min(oldestAt, now), now)}` : ''}` : '';
  const pagesTitle =
    pages > 1
      ? ` The items come from ${fmtInt(pages)} pages of it you saved (your newest save of each${oldestAt !== null ? `, the oldest ${fmtDateTime(oldestAt)}` : ''}); each page is compared only with your previous save of that same page.`
      : '';
  const saved = {
    text: `saved ${fmtAgo(Math.min(savedAt, now), now)}${pagesText} · ${fmtInt(items)} ${items === 1 ? 'item' : 'items'} (${fmtInt(inStock)} in stock)`,
    title: `Your newest save of ${path}: ${fmtDateTime(savedAt)}. ${fmtInt(items)} ${items === 1 ? 'item' : 'items'} listed, ${fmtInt(inStock)} on sale as of that save.${pagesTitle} ${fmtInt(saves)} recent ${saves === 1 ? 'save' : 'saves'} read for changes (the ${BANK_STOCK_KEEP_SAVES} newest of each page). ${RETENTION_NOTE}`,
  };
  if (prevAt === null) {
    return { ...base, saved, previous: { text: 'first save', title: 'Only one save of this page so far: save it again later to see what is new, gone or repriced.' }, firstSave: true };
  }
  return {
    ...base,
    saved,
    // 0.7.1 (CQ-2): previousSavedAt is the session baseline, the save before your latest run of saves, so
    // a window read 30 s after the last one still shows what changed since you last looked.
    previous: {
      text: `previous save ${fmtAgo(Math.min(prevAt, now), now)}`,
      title:
        pages > 1
          ? `Changes are counted page by page, each against your save of that page from before your latest run of saves (the earliest: ${fmtDateTime(prevAt)}). ${SESSION_NOTE}`
          : `Changes are counted against your save from before your latest run of saves (${fmtDateTime(prevAt)}). ${SESSION_NOTE}`,
    },
    firstSave: false,
  };
}

/**
 * DM-5: "2 older pages (last saved 3 d ago)" for BankStockResult.olderPages: pages of the bank saved long
 * before its newest page, left out of the counts, the chips and "What's new" (history keeps them). null
 * when none were left out (or the answer is from before 0.7.1).
 */
export function bankStockOlderPages(r: Pick<BankStockResult, 'olderPages'> | null | undefined, now: UnixMs): { text: string; title: string } | null {
  const o = r?.olderPages;
  if (!o || !finite(o.count) || o.count < 1) return null;
  const n = Math.floor(o.count);
  const at = finite(o.newestSavedAt) ? o.newestSavedAt : null;
  const when = at === null ? '' : ` (last saved ${fmtAgo(Math.min(at, now), now)})`;
  const one = n === 1;
  return {
    text: `${fmtInt(n)} older ${one ? 'page' : 'pages'}${when}`,
    title: `${fmtInt(n)} ${one ? 'page' : 'pages'} of this bank you saved long before its newest page${at === null ? '' : ` (the newest of them ${fmtDateTime(at)})`}: left out of the counts, the chips and What's new until you save ${one ? 'it' : 'them'} again. The item history keeps every save.`,
  };
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export interface BankStockChangeTag {
  kind: 'new' | 'cheaper' | 'pricier' | 'gone';
  /** "New", "↓ was 3.11 ref", "↑ was 3.11 ref", "Gone". */
  text: string;
  tone: Tone;
  title: string;
}

/** The Item cell's change mark: the New badge, "↓ was X" / "↑ was X", or Gone; null when unchanged. */
export function bankStockChangeTag(
  r: Pick<BankStockRow, 'change' | 'costScrap' | 'previousCostScrap' | 'previousStock' | 'stock'>,
  keyScrap: Scrap | null,
  previousSavedAt: UnixMs | null,
  now: UnixMs,
): BankStockChangeTag | null {
  const since = sinceWhen(previousSavedAt, now);
  const prev = finite(r.previousCostScrap) ? r.previousCostScrap : null;
  switch (r.change) {
    case 'new': {
      // Listed before without being on sale: sold out then. A list row with neither a price nor a stock
      // count looks like an absent one here, so the other wording claims nothing about the page.
      const back = r.previousStock === 0 || prev !== null;
      return {
        kind: 'new',
        text: 'New',
        tone: 'good',
        title: back ? `Back on sale: listed but not on sale in ${since}, on sale in your newest save.` : `New since ${since}: not on sale then, on sale in your newest save.`,
      };
    }
    case 'cheaper':
    case 'pricier': {
      const down = r.change === 'cheaper';
      const was = prev !== null ? fmtMoney(prev, keyScrap) : null;
      return {
        kind: r.change,
        text: was !== null ? `${down ? '↓' : '↑'} was ${was}` : down ? '↓ cheaper' : '↑ pricier',
        tone: down ? 'good' : 'bad',
        title: `${down ? 'Cheaper' : 'Pricier'} than in ${since}: ${fmtMoney(r.costScrap, keyScrap)} now${was !== null ? `, ${was} then` : ''} (both at today's key price).`,
      };
    }
    case 'gone':
      return {
        kind: 'gone',
        text: 'Gone',
        tone: 'muted',
        title: `On sale in ${since}; ${r.stock === 0 ? 'your newest save lists it sold out' : 'your newest save no longer lists it'}. Shown at its last price.`,
      };
    default:
      return null;
  }
}

/** Stock on the newest save, with "5 → 3" when the previous save showed another count. */
export function bankStockStockCell(r: Pick<BankStockRow, 'stock' | 'previousStock'>, hasPrevious: boolean): { text: string; title: string; muted: boolean } {
  if (!finite(r.stock)) return { text: DASH, title: 'Your saved page showed no stock count for this item.', muted: true };
  const prev = hasPrevious && finite(r.previousStock) ? r.previousStock : null;
  if (prev !== null && prev !== r.stock) {
    return { text: `${fmtInt(prev)} → ${fmtInt(r.stock)}`, title: `${fmtInt(prev)} in stock in your previous save, ${fmtInt(r.stock)} in your newest.`, muted: false };
  }
  return { text: fmtInt(r.stock), title: `${fmtInt(r.stock)} in stock in your newest save.`, muted: false };
}

/** The Gone view's "Last seen": when the previous save (the last one it was on sale in) was made. */
export function bankStockLastSeen(r: Pick<BankStockRow, 'stock'>, previousSavedAt: UnixMs | null, now: UnixMs): { text: string; title: string } {
  const still = r.stock === 0 ? 'Your newest save still lists it, sold out.' : 'Your newest save does not list it.';
  if (previousSavedAt === null || !finite(previousSavedAt)) return { text: DASH, title: still };
  return { text: fmtAgo(Math.min(previousSavedAt, now), now), title: `Last on sale in your previous save (${fmtDateTime(previousSavedAt)}). ${still}` };
}

export interface BankStockListedCell {
  /** "2 d 4 h", or a dash without a run. */
  text: string;
  title: string;
  muted: boolean;
  /** Listed at least SCRAPTF_LONG_LISTED_MS (the Listed > 24 h chip). */
  long: boolean;
}

/** DM-5: a row whose newest sighting is older than this reads "last seen N ago", not as a listing still running. */
export const BANK_STOCK_LAST_SEEN_STALE_MS = 48 * 3_600_000;

/**
 * F20 Listed: how long every one of the user's saves of the page has listed it on sale, since the run
 * began (BankStockRow.listedSince); a dash for a gone row or one with no run. DM-5: the span ends at the
 * newest save that listed it (BankStockRow.lastSeenAt; absent: now, as before), and a sighting over
 * BANK_STOCK_LAST_SEEN_STALE_MS old reads "last seen 3 d ago" instead.
 */
export function bankStockListedCell(r: Pick<BankStockRow, 'listedSince' | 'firstSeenAt' | 'change'> & Partial<Pick<BankStockRow, 'lastSeenAt'>>, now: UnixMs): BankStockListedCell {
  if (!finite(r.listedSince)) {
    return { text: DASH, title: r.change === 'gone' ? 'Not on sale in your newest save.' : 'Not on sale in a run of your saves yet.', muted: true, long: false };
  }
  const last = finite(r.lastSeenAt) ? Math.max(r.listedSince, Math.min(r.lastSeenAt, now)) : null;
  const dur = Math.max(0, (last ?? now) - r.listedSince);
  const ago = scraptfAgoText(dur);
  // An earlier run means it was off sale for a while in between.
  const first = finite(r.firstSeenAt) && r.firstSeenAt < r.listedSince ? ` Your saves first listed it on sale ${fmtDateTime(r.firstSeenAt)}; it was off sale for a while since.` : '';
  if (last !== null && now - last > BANK_STOCK_LAST_SEEN_STALE_MS) {
    const seen = fmtAgo(last, now);
    // A run of one save has no span to name.
    const after = dur >= 60_000 ? `, after ${ago} on sale in your saves since ${fmtDateTime(r.listedSince)}` : '';
    return {
      text: `last seen ${seen}`,
      title: `Last on sale in your save of ${fmtDateTime(last)} (${seen})${after}. No newer save of its page shows it, so it may be gone.${first} What happened between two saves is unknown.`,
      muted: true,
      long: dur >= SCRAPTF_LONG_LISTED_MS,
    };
  }
  return {
    text: ago,
    title: `On sale in every one of your saves of its page since ${fmtDateTime(r.listedSince)} (${ago}).${first} What happened between two saves is unknown.`,
    muted: false,
    long: dur >= SCRAPTF_LONG_LISTED_MS,
  };
}

/**
 * F20 Since listed: the price now against the first save of the current run (raw keys + metal, both at
 * today's key price), "↓ 8 %" (cheaper, good for a buyer), "↑ 5 %" or "0 %"; a dash without a run.
 */
export function bankStockSinceListedCell(r: Pick<BankStockRow, 'changeSinceListed'>, keyScrap: Scrap | null): { text: string; title: string; tone: Tone } {
  const c = r.changeSinceListed;
  if (!c || !finite(c.deltaScrap)) return { text: DASH, title: 'Not on sale in a run of your saves, so there is nothing to compare.', tone: 'muted' };
  const then = `${fmtMoney(c.fromScrap, keyScrap)} when your saves began listing it (${fmtDateTime(c.since)})`;
  if (c.deltaScrap === 0) return { text: '0 %', title: `Same price as ${then}.`, tone: 'muted' };
  const down = c.deltaScrap < 0;
  const pct = changePctText(c.pct);
  const by = fmtMoney(Math.abs(c.deltaScrap), keyScrap);
  // The arrow carries the sign; a move under 0.05 % shows its amount instead of "0 %".
  return {
    text: `${down ? '↓' : '↑'} ${pct && pct !== '0 %' ? pct.slice(1) : by}`,
    title: `${then}, ${fmtMoney(c.toScrap, keyScrap)} now: ${down ? 'cheaper' : 'pricier'} by ${by}${pct ? ` (${pct})` : ''}, both at today's key price.`,
    tone: down ? 'good' : 'bad',
  };
}

/** The price cell's hover: the price as listed (keys and metal), and its value at today's key price. */
export function bankStockPriceTitle(r: Pick<BankStockRow, 'costKeys' | 'costScrapRaw' | 'costScrap' | 'change' | 'hasExtras'>, keyScrap: Scrap | null): string {
  const what = r.change === 'gone' ? 'Last price on scrap.tf, from your previous save' : 'scrap.tf sells it for this, as of your newest save';
  let listed = '';
  if (finite(r.costKeys) && r.costKeys > 0) {
    const raw = fmtKeysMetal(r.costKeys, r.costScrapRaw);
    const valued = fmtMoney(r.costScrap, keyScrap);
    // Only a listing with more metal than a key reads differently once valued.
    listed = raw === valued ? ` Listed as ${raw}.` : ` Listed as ${raw}: ${valued} at today's key price.`;
  }
  return `${what}.${listed}${r.hasExtras ? ' This copy has extras.' : ''}`;
}

function buyerOf(o: NonNullable<BankStockRow['revenueOrder']>): string {
  return o.userName || (o.isBot ? 'Bot' : 'Human');
}

/** "Sells for": the buyer your settings sell to, bot or human, online, and how many buyers there are. */
export function bankStockSellsTitle(r: Pick<BankStockRow, 'revenueScrap' | 'revenueOrder' | 'buyerCount'>, keyScrap: Scrap | null): string {
  if (!finite(r.revenueScrap)) return r.buyerCount > 0 ? 'Every eligible order looks unrealistic, so no sale price is assumed.' : 'No eligible backpack.tf buy orders for this item in the live book.';
  const o = r.revenueOrder;
  const online = o ? (o.online === true ? 'online' : o.online === false ? 'offline' : 'online status unknown') : null;
  const who = o ? ` to ${o.userName || o.steamid} (${o.isBot ? 'bot' : 'human'}, ${online})` : '';
  return `Sells for ${fmtMoney(r.revenueScrap, keyScrap)}${who} on backpack.tf. ${fmtInt(r.buyerCount)} ${r.buyerCount === 1 ? 'buyer' : 'buyers'} with eligible orders.`;
}

/** The buyer's name for the Sells for cell, or null without an order. */
export function bankStockBuyer(r: Pick<BankStockRow, 'revenueOrder'>): string | null {
  return r.revenueOrder ? buyerOf(r.revenueOrder) : null;
}

/** "Pay up to": the ceiling, where scrap.tf's price sits against it, and the clean-copy caveat. */
export function bankStockPayTitle(r: Pick<BankStockRow, 'maxCostScrap' | 'revenueScrap' | 'costScrap' | 'hasExtras'>, keyScrap: Scrap | null): string {
  const extras = r.hasExtras ? ' The ceiling is for a clean copy; this one has extras.' : '';
  if (!finite(r.maxCostScrap)) {
    return (finite(r.revenueScrap) ? 'No scrap.tf price clears your thresholds against these buyers.' : 'No eligible buy orders, so there is no ceiling.') + extras;
  }
  const head = `Pay up to ${fmtMoney(r.maxCostScrap, keyScrap)} on scrap.tf: the highest price that still clears your thresholds.`;
  const d = r.maxCostScrap - r.costScrap;
  const where = d === 0 ? " scrap.tf's price is exactly at it." : d > 0 ? ` scrap.tf's price is ${fmtMoney(d, keyScrap)} under it.` : ` scrap.tf's price is ${fmtMoney(-d, keyScrap)} over it.`;
  return `${head}${where}${extras}`;
}

export const BANK_STOCK_VERDICT_TONES: Readonly<Record<BankStockVerdict, Tone>> = { flip: 'good', over: 'bad', 'no-buyers': 'muted' };

export interface BankStockVerdictPill {
  tone: Tone;
  /** "Flip +1.33 ref (25%)", "Over by 2.00 ref", "No buyers". */
  text: string;
  title: string;
}

/** The Verdict cell: Flip +X (m%), Over by Y, or No buyers (a gone row is judged at its last price). */
export function bankStockVerdictPill(
  r: Pick<BankStockRow, 'verdict' | 'profitScrap' | 'margin' | 'costScrap' | 'maxCostScrap' | 'hasExtras' | 'change'>,
  keyScrap: Scrap | null,
): BankStockVerdictPill {
  const tone = BANK_STOCK_VERDICT_TONES[r.verdict] ?? 'muted';
  const at = r.change === 'gone' ? 'At its last price: ' : '';
  const extras = r.hasExtras ? ' Judged as a clean copy: this one has extras.' : '';
  const cost = fmtMoney(r.costScrap, keyScrap);
  switch (r.verdict) {
    case 'flip': {
      const profit = fmtSignedMoney(r.profitScrap, keyScrap);
      const pct = finite(r.margin) ? fmtPct(r.margin, 0) : null;
      return {
        tone,
        text: `Flip ${profit}${pct ? ` (${pct})` : ''}`,
        title: `${at}buy it on scrap.tf for ${cost}, sell it to the backpack.tf buyer: ${profit} after friction${pct ? `, a ${pct} margin` : ''}.${finite(r.maxCostScrap) ? ` Pay up to ${fmtMoney(r.maxCostScrap, keyScrap)}.` : ''}${extras}`,
      };
    }
    case 'over': {
      if (finite(r.maxCostScrap) && r.costScrap > r.maxCostScrap) {
        const by = fmtMoney(r.costScrap - r.maxCostScrap, keyScrap);
        return { tone, text: `Over by ${by}`, title: `${at}scrap.tf's price ${cost} is ${by} over Pay up to (${fmtMoney(r.maxCostScrap, keyScrap)}): not a flip at that price.${extras}` };
      }
      return { tone, text: 'Over', title: `${at}buyers exist, but scrap.tf's price ${cost} does not clear your thresholds against them.${extras}` };
    }
    default:
      return { tone: 'muted', text: 'No buyers', title: `${at}no eligible backpack.tf buy order for this item in the live book.${extras}` };
  }
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

export type BankStockEmptyReason = 'never-saved' | 'import-off' | 'search' | 'filter' | 'nothing-on-sale';

/** Why the table is empty, or null when it has rows. */
export function bankStockEmptyReason(
  r: Pick<BankStockResult, 'savedAt' | 'rows'>,
  view: Pick<BankStockView, 'filter' | 'search'>,
  importOff: boolean,
): BankStockEmptyReason | null {
  if (r.rows.length > 0) return null;
  if (r.savedAt === null) return importOff ? 'import-off' : 'never-saved';
  if (view.search.trim()) return 'search';
  return view.filter === 'all' ? 'nothing-on-sale' : 'filter';
}

/** The empty table under a chip with nothing in it (or All, when nothing is on sale). */
export function bankStockFilterEmpty(filter: BankStockFilter): { title: string; body: string } {
  switch (filter) {
    case 'new':
      return { title: 'Nothing new since your previous save', body: 'Everything on sale now was on sale in your previous save too.' };
    case 'flips':
      return {
        title: 'No flips on this page right now',
        body: "Nothing on sale here clears your profit thresholds against today's backpack.tf buyers. Pay up to shows the most you could pay for each item.",
      };
    case 'changed':
      return { title: 'No price changes', body: 'Everything on sale in both saves kept its price.' };
    case 'gone':
      return { title: 'Nothing gone', body: 'Everything on sale in your previous save is still on sale in your newest one.' };
    // F20: from the run of the user's saves listing each item on sale.
    case 'long-listed':
      return { title: 'Nothing listed for over a day', body: 'No item on sale has been in every one of your saves of this page for a day or more. Saving the page regularly fills in its history.' };
    case 'dropped':
      return { title: 'Nothing dropped since listed', body: 'No item on sale is cheaper now than when your saves first listed it in its current run.' };
    case 'all':
      return {
        title: 'Nothing on sale in your newest save',
        // F18: a save without any card keeps no snapshot, so this is mostly "sold out"; the save type
        // is named in case an "HTML only" save caught only cards that were not on sale.
        body: `The page you saved lists no item with a price to buy and stock: everything may have been sold out, or the page was saved before scrap.tf added its cards. Save it again as '${SAVE_MODE}'.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/** Row keys besides moving: Enter (or Space) opens the item. */
export function bankStockKeyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): 'open' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  return e.key === 'Enter' || e.key === ' ' ? 'open' : null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface BankStockLoader {
  /** Reads `q` (a new filter, search, order or page size): an answer to an earlier query is dropped. */
  load(q: BankStockQuery): void;
  /** Reads the current query again (a push), or once more right after the read in flight. */
  refresh(): void;
  /** Nothing is reported after this. */
  dispose(): void;
}

/**
 * One 'scraptf.bankStock' read at a time, as createBanksLoader: a refresh or a new query during a
 * read runs once after it, so a burst of pushes costs at most two reads and the newest state always
 * lands. The stale-response guard: reads never overlap, so an older answer can never replace a newer
 * one, and an answer to a query the user has since changed (or for another bank) is dropped. The
 * service's generatedAt is not compared: a clock stepped back would freeze the page.
 */
export function createBankStockLoader(
  call: (q: BankStockQuery) => Promise<BankStockResult>,
  on: { data(r: BankStockResult, q: BankStockQuery): void; error(message: string): void; busy?(busy: boolean): void },
): BankStockLoader {
  let current: BankStockQuery | null = null;
  let gen = 0;
  let inFlight = false;
  let again = false;
  let disposed = false;
  const run = (): void => {
    const q = current;
    if (!q) return;
    const g = gen;
    inFlight = true;
    again = false;
    on.busy?.(true);
    let p: Promise<BankStockResult>;
    try {
      p = call(q);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (r) => {
        if (disposed || g !== gen) return;
        if (!r || r.bank !== q.bank) return;
        on.data(r, q);
      },
      (e: unknown) => {
        if (!disposed && g === gen) on.error(errorMessage(e));
      },
    ).finally(() => {
      inFlight = false;
      if (disposed) return;
      if (again) run();
      else on.busy?.(false);
    });
  };
  const request = (): void => {
    if (disposed || !current) return;
    if (inFlight) {
      again = true;
      return;
    }
    run();
  };
  return {
    load(q) {
      if (disposed) return;
      current = q;
      gen++;
      request();
    },
    refresh: request,
    dispose() {
      disposed = true;
    },
  };
}
