// Helpers for the scrap.tf price list (F14) in the dashboard: the shared
// "scrap.tf price list" card (status line, setup states, the three steps) and
// the Live market's "scrap.tf pays" and Stock cells plus the strip's "All items"
// chip. All pure except chooseWatchFolder, whose only effects are the two calls
// it is handed.
//
// The list is only ever what the user saved from scrap.tf/items with their own
// browser into the watch folder, or read in the opt-in scrap.tf window (R10).
// Nothing here, or anywhere in the app, fetches scrap.tf (R1): its address is only
// handed to links.open or, on a click, to the user's scrap.tf window.

import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { SCRAPTF_ITEMS_URL } from '../shared/links';
import { SCRAPTF_LIST_FRESH_MS, WATCH_WAITING_FOR_SCHEMA, scraptfListFresh } from '../shared/scraptfList';
import type { DeepPartial, ImportResult, MarketListResult, MarketRow, Scrap, ScraptfListStatus, Settings, UnixMs } from '../shared/types';
import { DASH, fmtAgo, fmtDateTime, fmtInt, fmtMoney } from './format';
import { SAVE_MODE } from './importModel';
import { coverageChip, coverageTone, type CoverageChip, type CoverageTone } from './marketModel';

/** Where the card sits: the top of the Live market page, or the Import page. */
export type ListCardPlacement = 'market' | 'import';

/** Where a setup note shows: the card, or the scrap.tf banks page header (F15), which is about every page. */
export type ListNotePlacement = ListCardPlacement | 'banks';

/** The card's one-line boundary note (R1): scrap.tf is only ever opened by the user, in their own browser. */
export const LIST_BOUNDARY_NOTE = `${SCRAPTF_BOUNDARY_SHORT} Your browser does, and you choose when.`;

/** The same note while the user has the opt-in scrap.tf window on (UX-7): they may browse it there too. */
export const LIST_BOUNDARY_NOTE_WINDOW = `${SCRAPTF_BOUNDARY_SHORT} You open it, in your browser or the Flip Desk window, and you choose when.`;

/** The boundary note for the user's settings (`windowOn`: scraptfWindowOn). */
export function listBoundaryNote(windowOn: boolean): string {
  return windowOn ? LIST_BOUNDARY_NOTE_WINDOW : LIST_BOUNDARY_NOTE;
}

/** Step 3: what one save updates. */
export const LIST_PICKUP_TEXT = 'Flip Desk picks it up within seconds and updates prices, the Live market, Holdings and the key price.';

/** Step 1's hint after the button. */
export const LIST_OPEN_HINT = "in your own browser: scrap.tf's public price list of every item it trades.";

/**
 * UX-4: what a first run is told first (the setup checklist, the empty Opportunities page): one save of
 * scrap.tf/items prices every item scrap.tf trades, far quicker than typing them.
 */
export const FIRST_PRICE_LEAD = 'Save scrap.tf/items once to price every item scrap.tf trades';

/** The first-run lead as a sentence; `windowOn` (scraptfWindowOn) adds the window as the other way in. */
export function firstPriceText(windowOn: boolean): string {
  return `${FIRST_PRICE_LEAD}${windowOn ? ', or browse it in the Flip Desk window' : ''}.`;
}

/** "scrap.tf/items": the price list's page as the buttons name it. */
export const SCRAPTF_ITEMS_PATH = SCRAPTF_ITEMS_URL.replace(/^https:\/\//, '');

/** Step 1's hint with the opt-in scrap.tf window on (UX-5): its button is the whole routine there. */
export function listWindowOpenHint(readOnLoad: boolean): string {
  return `scrap.tf's public price list of every item it trades. In the Flip Desk window it is ${readOnLoad ? 'read as it loads' : 'read when you press Read page now'}; you browse it yourself.`;
}

/**
 * How often the card re-reads 'scraptf.listStatus' on its own while shown (IPC to the local service
 * only, no network): a folder watch that fails later pushes nothing, so its error would otherwise wait
 * for the next import.
 */
export const LIST_POLL_MS = 60_000;

/** While a configured watch is still starting (a status read raced the settings save), re-read sooner. */
export const LIST_STARTING_POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * What stands between the user and a working one-save sync, in the order it has to be fixed.
 * 'window-only' (UX-5): no watch folder, but the user has the opt-in scrap.tf window on, which imports
 * what it reads without one; the folder is optional then, and nothing needs fixing.
 * 'watch-waiting' (0.7.1, P3): the service holds the watch until the item schema has loaded
 * (WATCH_WAITING_FOR_SCHEMA); it starts by itself, so it is a wait, not an error to fix.
 */
export type ListSetupState = 'import-off' | 'no-folder' | 'window-only' | 'watch-error' | 'watch-waiting' | 'watch-starting' | 'ready';

/** `windowOn` (scraptfWindowOn): the user's scrap.tf window is on, so a missing folder is optional. */
export function listSetupState(s: Pick<ScraptfListStatus, 'importEnabled' | 'watchFolder' | 'watchActive' | 'watchError'>, windowOn = false): ListSetupState {
  if (!s.importEnabled) return 'import-off';
  if (!s.watchFolder) return windowOn ? 'window-only' : 'no-folder';
  if (s.watchActive) return 'ready';
  if (s.watchError === WATCH_WAITING_FOR_SCHEMA) return 'watch-waiting';
  // The service always names why a configured watch is not running; the fallback covers a race at start.
  return s.watchError ? 'watch-error' : 'watch-starting';
}

export interface ListSetupNote {
  tone: 'warn' | 'info' | 'bad' | 'muted';
  text: string;
  /** go-import: open the Import page; pick-folder: main's folder dialog, then settings. */
  action: 'go-import' | 'pick-folder' | null;
  actionLabel: string | null;
}

/** The line under the status that says what to fix, with its one action; null once the sync works. */
export function listSetupNote(state: ListSetupState, placement: ListNotePlacement, watchError: string | null = null): ListSetupNote | null {
  switch (state) {
    case 'import-off':
      // On the Import page the acknowledgement is right there, so there is nowhere to link to.
      if (placement === 'banks') return { tone: 'warn', text: 'Saved-page import is off, so the scrap.tf pages you save are not read.', action: 'go-import', actionLabel: 'Turn on Import first' };
      return placement === 'market'
        ? { tone: 'warn', text: 'Saved-page import is off, so a saved list is not read.', action: 'go-import', actionLabel: 'Turn on Import first' }
        : { tone: 'warn', text: 'Turn on saved-page import above first; a saved list is not read while it is off.', action: null, actionLabel: null };
    case 'no-folder':
      return {
        tone: 'info',
        text: `No watch folder yet. Choose one, then save ${placement === 'banks' ? 'the scrap.tf pages' : 'scrap.tf/items'} into it.`,
        action: 'pick-folder',
        actionLabel: 'Choose a watch folder',
      };
    case 'window-only': {
      // Muted: the window already imports what it reads; a folder only adds pages saved with Ctrl+S.
      const what = placement === 'banks' ? 'the scrap.tf pages you save' : 'scrap.tf/items when you save it';
      return {
        tone: 'muted',
        text: `No watch folder: optional while you read pages in the Flip Desk window. Choose one to also import ${what} with Ctrl+S.`,
        action: 'pick-folder',
        actionLabel: 'Choose a watch folder',
      };
    }
    case 'watch-error': {
      const why = (watchError ?? '').trim() || 'the folder could not be watched';
      return { tone: 'bad', text: `Watch error: ${why}${/[.!?]$/.test(why) ? '' : '.'}`, action: 'pick-folder', actionLabel: 'Choose another folder' };
    }
    case 'watch-waiting':
      return { tone: 'muted', text: 'Waiting for item data to load; the folder watch starts by itself once it has.', action: null, actionLabel: null };
    case 'watch-starting':
      return { tone: 'muted', text: 'Starting the folder watch…', action: null, actionLabel: null };
    case 'ready':
      return null;
  }
}

/**
 * How often the card re-reads its status (local IPC only): soon while the watch is starting, which
 * pushes nothing when it is up, else LIST_POLL_MS so a watch that fails later still shows.
 */
export function listPollMs(s: Parameters<typeof listSetupState>[0] | null | undefined): number {
  const state = s ? listSetupState(s) : null;
  return state === 'watch-starting' || state === 'watch-waiting' ? LIST_STARTING_POLL_MS : LIST_POLL_MS;
}

/** The steps can be followed only once import is on (R10's acknowledgement). */
export function listStepsDisabled(s: Pick<ScraptfListStatus, 'importEnabled'> | null | undefined): boolean {
  return s ? !s.importEnabled : false;
}

export interface ListStatusLine {
  text: string;
  tone: CoverageTone;
  /** "3 saved pages, the oldest 26 h ago": only when the rows come from more than one save. */
  detail: string | null;
  title: string;
}

/**
 * "All scrap.tf items: 2,341 from your saved price list, saved 3 min ago", toned by the newest save
 * like the coverage chips (green ≤ 15 min, amber ≤ 2 h, muted older); "Not saved yet" without a list.
 */
export function listStatusLine(s: Pick<ScraptfListStatus, 'items' | 'newestAt' | 'oldestAt' | 'pages'> | null | undefined, now: UnixMs): ListStatusLine {
  if (!s) return { text: 'All scrap.tf items: …', tone: 'muted', detail: null, title: 'Reading your saved scrap.tf price list…' };
  const items = Number.isFinite(s.items) ? Math.max(0, Math.floor(s.items)) : 0;
  const newest = s.newestAt !== null && Number.isFinite(s.newestAt) ? s.newestAt : null;
  if (items === 0 || newest === null) {
    return {
      text: 'All scrap.tf items: Not saved yet',
      tone: 'muted',
      detail: null,
      title: `Save scrap.tf/items as '${SAVE_MODE}' into your watch folder to add every item scrap.tf trades: what it charges, what it pays and its stock.`,
    };
  }
  // A file time a little ahead of the clock (another machine's mtime) reads "just now", not "in 2 min".
  const saved = fmtAgo(Math.min(newest, now), now);
  const pages = Number.isFinite(s.pages) ? Math.max(0, Math.floor(s.pages)) : 0;
  const oldest = s.oldestAt !== null && Number.isFinite(s.oldestAt) ? s.oldestAt : null;
  const detail = pages > 1 && oldest !== null ? `${fmtInt(pages)} saved pages, the oldest ${fmtAgo(Math.min(oldest, now), now)}` : null;
  const from = pages > 1 ? ` from ${fmtInt(pages)} saved pages` : '';
  const span = oldest !== null && oldest < newest ? ` Newest saved ${fmtDateTime(newest)}, oldest ${fmtDateTime(oldest)}.` : ` Saved ${fmtDateTime(newest)}.`;
  return {
    text: `All scrap.tf items: ${fmtInt(items)} from your saved price list, saved ${saved}`,
    tone: coverageTone(newest, now),
    detail,
    title: `${fmtInt(items)} ${items === 1 ? 'item' : 'items'}${from} of scrap.tf/items.${span} Prices and stock are as of each save; save the page again for current ones.`,
  };
}

/**
 * The Live market's automatic choice: the steps are open until the sync works and a list was saved (a
 * working sync needs only the status line and the Open button). The card makes it once per visit, from
 * the first status it reads, so steps the user is following do not fold away as the sync starts working.
 * `windowOn` (UX-5): the card head's "Open in Flip Desk window" is the whole routine then, so the save
 * steps are not forced open (a setup note still shows outside them).
 */
export function listStepsAutoOpen(s: Pick<ScraptfListStatus, 'items'> & Parameters<typeof listSetupState>[0], windowOn = false): boolean {
  if (windowOn) return false;
  return s.items === 0 || listSetupState(s) !== 'ready';
}

/**
 * Whether the steps are shown. The Import page always shows them; the Live market follows the user's
 * last toggle, else the automatic choice (`auto`, listStepsAutoOpen; null until the status is known:
 * closed, so a working setup does not flash open and shut on every visit).
 */
export function listStepsOpen(placement: ListCardPlacement, pref: boolean | null, auto: boolean | null): boolean {
  if (placement === 'import') return true;
  if (pref !== null) return pref;
  return auto === true;
}

/** The persisted steps toggle: true / false, or null (automatic). */
export function sanitizeStepsPref(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * Main's folder dialog only returns the chosen path; the watch starts once the folder is saved in
 * settings (the service watches settings.import.watchFolder). Returns the saved folder, or null when
 * the dialog was cancelled or saving failed (updateSettings reports that failure itself).
 */
export async function chooseWatchFolder(
  pick: () => Promise<{ folder: string | null }>,
  save: (patch: DeepPartial<Settings>) => Promise<Settings | null>,
): Promise<string | null> {
  const { folder } = await pick();
  if (!folder) return null;
  const next = await save({ import: { watchFolder: folder } });
  return next?.import.watchFolder ?? null;
}

// ---------------------------------------------------------------------------
// Live market cells and the strip's "All items" chip
// ---------------------------------------------------------------------------

type ListFields = Pick<MarketRow, 'scraptfPaysScrap' | 'scraptfStock' | 'scraptfStockLimit' | 'scraptfFull' | 'scraptfListAt'>;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// The row cannot tell "scrap.tf does not trade it" from "no list saved yet", so the tip names both.
const NOT_ON_LIST = `Not on your saved scrap.tf/items list. scrap.tf may not trade it, or the list is not saved yet: save scrap.tf/items (Ctrl+S) as '${SAVE_MODE}' into your watch folder to add every item scrap.tf trades.`;

/** "saved 3 min ago" for a list row, clamped like the status line. */
function savedAgo(at: UnixMs, now: UnixMs): string {
  return `saved ${fmtAgo(Math.min(at, now), now)}`;
}

/** "5/12", "5" without a limit, null without a stock. */
export function stockText(stock: number | null, limit: number | null): string | null {
  if (!finite(stock)) return null;
  return finite(limit) ? `${fmtInt(stock)}/${fmtInt(limit)}` : fmtInt(stock);
}

/** The stock sentence both cells' tooltips use; null without a stock. */
function stockSentence(r: ListFields): string | null {
  const text = stockText(r.scraptfStock, r.scraptfStockLimit);
  if (text === null) return null;
  // A 0/0 row is full and out of stock at once: scrap.tf neither buys nor sells it right now.
  if (r.scraptfFull && r.scraptfStock === 0) return `Stock ${text}: scrap.tf is at its limit and out of stock, so it neither buys nor sells it right now.`;
  if (r.scraptfFull) return `Stock ${text}: scrap.tf is at its limit, so it will not buy more right now. You can still buy it there.`;
  if (r.scraptfStock === 0) return `Stock ${text}: out of stock, so you cannot buy it on scrap.tf right now. scrap.tf still buys it.`;
  return `Stock ${text}${finite(r.scraptfStockLimit) ? ` (scrap.tf buys up to ${fmtInt(r.scraptfStockLimit)})` : ''}.`;
}

export interface ListPaysCell {
  scrap: Scrap | null;
  /** Full, or a list over a day old: shown, but not a price scrap.tf would pay you right now. */
  dim: boolean;
  full: boolean;
  title: string;
}

/**
 * The "scrap.tf pays" cell: what scrap.tf's bank pays you, from the saved list (valued by the service
 * at the read's key price). A full or stale row is dimmed, as Holdings would not use it as an exit.
 */
export function listPaysCell(r: ListFields & Pick<MarketRow, 'revenueScrap'>, keyScrap: Scrap | null, now: UnixMs): ListPaysCell {
  const at = r.scraptfListAt;
  if (at === null || !finite(at)) return { scrap: null, dim: false, full: false, title: NOT_ON_LIST };
  const stale = !scraptfListFresh({ observedAt: at }, now);
  const stock = stockSentence(r);
  const staleText = stale ? ` That list is over ${Math.round(SCRAPTF_LIST_FRESH_MS / 3_600_000)} h old; save scrap.tf/items again for current prices.` : '';
  if (!finite(r.scraptfPaysScrap)) {
    return {
      scrap: null,
      dim: false,
      full: r.scraptfFull,
      title: `Your saved scrap.tf/items list (${savedAgo(at, now)}) shows no "Price we pay" for it.${stock ? ` ${stock}` : ''}`,
    };
  }
  const pays = r.scraptfPaysScrap;
  const more = finite(r.revenueScrap) && pays > r.revenueScrap ? ' That is more than the backpack.tf buyer here pays.' : '';
  return {
    scrap: pays,
    dim: r.scraptfFull || stale,
    full: r.scraptfFull,
    title: `scrap.tf's bank pays ${fmtMoney(pays, keyScrap)} for it, per your saved scrap.tf/items list (${savedAgo(at, now)}).${more}${stock ? ` ${stock}` : ''}${staleText}`,
  };
}

export interface ListStockCell {
  /** "5/12", or a dash off the list or without a stock. */
  text: string;
  full: boolean;
  /** Stock 0: nothing to buy on scrap.tf right now. */
  out: boolean;
  dim: boolean;
  title: string;
}

/** The Stock cell: scrap.tf's stock n of its limit, as of the saved list, with Full when n ≥ limit. */
export function listStockCell(r: ListFields, now: UnixMs): ListStockCell {
  const at = r.scraptfListAt;
  if (at === null || !finite(at)) return { text: DASH, full: false, out: false, dim: false, title: NOT_ON_LIST };
  const text = stockText(r.scraptfStock, r.scraptfStockLimit);
  const stale = !scraptfListFresh({ observedAt: at }, now);
  if (text === null) return { text: DASH, full: r.scraptfFull, out: false, dim: false, title: `Your saved scrap.tf/items list (${savedAgo(at, now)}) shows no stock for it.` };
  return {
    text,
    full: r.scraptfFull,
    out: r.scraptfStock === 0,
    dim: stale,
    title: `${stockSentence(r)} As of your saved scrap.tf/items list (${savedAgo(at, now)}); stock changes between saves.`,
  };
}

// ---------------------------------------------------------------------------
// The Import page's result for a saved scrap.tf/items page
// ---------------------------------------------------------------------------

/**
 * The "Price list" line of an import result: how many list rows a saved scrap.tf/items page wrote.
 * Null for any other page. Out-of-stock rows count here though they are skipped as prices, which is
 * why "Stored" alone undersells a list save.
 */
export function importListRowsText(r: Pick<ImportResult, 'pageKind' | 'listRows'>): string | null {
  if (r.pageKind !== 'items-list' || !finite(r.listRows)) return null;
  if (r.listRows <= 0) return 'No list rows changed: a newer save of scrap.tf/items is already stored.';
  return `${fmtInt(r.listRows)} scrap.tf ${r.listRows === 1 ? 'item' : 'items'} updated on your price list, out-of-stock ones included.`;
}

/** The toast after a manual import ("Import saved page…"). */
export function importToastText(r: Pick<ImportResult, 'stored' | 'parsed' | 'fileName' | 'pageKind' | 'listRows'>): { text: string; tone: 'good' | 'warn' } {
  const base = `Imported ${r.stored} of ${r.parsed} items from ${r.fileName}`;
  const list = r.pageKind === 'items-list' && finite(r.listRows) ? r.listRows : null;
  if (list === null) return { text: base, tone: r.stored ? 'good' : 'warn' };
  return { text: `${base}; ${fmtInt(list)} price list ${list === 1 ? 'row' : 'rows'} updated`, tone: r.stored || list ? 'good' : 'warn' };
}

/** The "All items" chip's tooltip. */
export const ALL_ITEMS_TIP = `See your saved price list on the scrap.tf banks page: save scrap.tf/items (Ctrl+S) as '${SAVE_MODE}' into your watch folder to update every scrap.tf price at once`;

/**
 * The strip's "All items (scrap.tf/items)" chip, beside the bank pages' (F13), or null while import is
 * off (the strip hides). A click opens the list's card on the scrap.tf banks page (F15); its address is
 * always the static scrap.tf/items one, which only that card hands to the user's browser.
 */
export function allItemsChip(s: Pick<MarketListResult['scraptf'], 'importEnabled' | 'allItems'> | null | undefined, now: UnixMs): CoverageChip | null {
  if (!s?.importEnabled || !s.allItems) return null;
  const c = coverageChip({ label: s.allItems.label, url: SCRAPTF_ITEMS_URL, lastSavedAt: s.allItems.lastSavedAt, items: s.allItems.items }, now);
  return { ...c, kind: 'list', bank: 'list', title: ALL_ITEMS_TIP, ariaLabel: `${c.label}: ${c.status}. Opens the scrap.tf/items card on the scrap.tf banks page.` };
}
