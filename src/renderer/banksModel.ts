// Helpers for the scrap.tf banks page (F15, pages/BanksPage.tsx) and the item drawer's
// "Seen on scrap.tf/buy/stranges · 12 min ago" line: one card per scrap.tf page the user
// saves (SCRAPTF_BANKS: the seven bank pages and the /items price list), built from
// 'scraptf.banks', which the service computes from local data only. All pure except
// createBanksLoader, whose only effect is the call it is handed. F17 adds each card's
// "What's new" line (bankWhatsNew) and the route of its stock page (#/banks/<bank>/stock).
//
// Labels and URLs always come from SCRAPTF_BANKS, whatever the service sent: the page only
// hands them to links.open (the user's own browser) or, on a click, to the user's scrap.tf
// window. Nothing here, or anywhere in the app, fetches scrap.tf (R1); its data only arrives
// through pages the user saves into the watch folder or reads in that window (R10). 0.7.1 adds
// the header's cross-bank flips line (UX-1) and the stock page's chip routes (F21-2).

import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { BANK_LOOK_FOR, BANK_TOP_FLIPS } from '../shared/banks';
import { SCRAPTF_BANKS, scraptfBankInfo, type ScraptfBankInfo } from '../shared/links';
import { cleanCategoryCounts, isEmptyBankSave } from '../shared/market';
import { BANK_STOCK_OPEN_FILTERS } from '../shared/types';
import { fromString } from '../shared/sku';
import type {
  BankStockOpenFilter,
  ConfidenceLevel,
  ImportBatch,
  ItemDetail,
  Scrap,
  ScraptfBank,
  ScraptfBankFlip,
  ScraptfBankLookFor,
  ScraptfBankSummary,
  ScraptfBanksResult,
  ScraptfSeenOn,
  UnixMs,
} from '../shared/types';
import { CONFIDENCE_LABELS, errorMessage, fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtSignedMoney } from './format';
import { SAVE_MODE, SAVE_MODE_ALT, SAVE_MODE_LIST_NOTE, SAVE_MODE_REASON } from './importModel';
import { coverageTone, type CoverageTone } from './marketModel';

/** "Saved in the last hour" in the page header. */
export const BANKS_RECENT_MS = 3_600_000;

/** The page refetches 'scraptf.banks' at most this often; the mock pushes every change unthrottled. */
export const BANKS_REFRESH_MS = 2_000;

/**
 * The save tip as plain text, for Open in browser's tooltip: which save type and why (F18). The card
 * renders a shorter one with Ctrl+S as keys; the page header gives the alternative and the reason.
 */
export const BANK_SAVE_TIP = `Save it with Ctrl+S into your watch folder as '${SAVE_MODE}' (or '${SAVE_MODE_ALT}') ${SAVE_MODE_REASON}; it updates here within seconds.`;

/** The All items card's tip: scrap.tf/items gets no Single File alternative (SAVE_MODE_LIST_NOTE). */
export const LIST_SAVE_TIP = `Save it with Ctrl+S into your watch folder as '${SAVE_MODE}' ${SAVE_MODE_REASON}; it updates here within seconds. ${SAVE_MODE_LIST_NOTE}`;

/** The banks page's route (#/banks, or #/banks/<bank> to focus that card). */
export const BANKS_ROUTE = 'banks';

// ---------------------------------------------------------------------------
// Values from the service, read defensively
// ---------------------------------------------------------------------------

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function scrapOf(v: unknown): Scrap {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

function timeOf(v: unknown): UnixMs | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function itemsWord(n: number): string {
  return n === 1 ? 'item' : 'items';
}

/** "scrap.tf/buy/hats" for a bank page's address: how the page and the drawer name it. */
export function bankPath(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

/** A bank that has no summary in the answer yet: never saved, nothing found. */
export function emptyBankSummary(info: ScraptfBankInfo): ScraptfBankSummary {
  return { bank: info.bank, label: info.label, url: info.url, lastSavedAt: null, pages: 0, items: 0, inStock: 0, flips: 0, flipProfitScrap: 0, top: [], unchecked: 0, lookFor: [], whatsNew: null };
}

/**
 * One summary per SCRAPTF_BANKS entry, in that order. A bank the answer lacks (or repeats, or an id
 * the dashboard does not know) cannot reorder or add cards; label and url are the static ones.
 */
export function banksInOrder(result: Pick<ScraptfBanksResult, 'banks'> | null | undefined): { info: ScraptfBankInfo; summary: ScraptfBankSummary }[] {
  const got = new Map<ScraptfBank, ScraptfBankSummary>();
  for (const b of Array.isArray(result?.banks) ? result.banks : []) {
    const info = scraptfBankInfo(b?.bank);
    if (info && !got.has(info.bank)) got.set(info.bank, b);
  }
  return SCRAPTF_BANKS.map((info) => {
    const s = got.get(info.bank);
    return { info, summary: s ? { ...s, bank: info.bank, label: info.label, url: info.url } : emptyBankSummary(info) };
  });
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** Banks saved within the last hour (a file time a little ahead of the clock counts as now). */
export function banksSavedRecently(banks: readonly Pick<ScraptfBankSummary, 'lastSavedAt'>[], now: UnixMs): number {
  let n = 0;
  for (const b of banks) {
    const at = timeOf(b.lastSavedAt);
    if (at !== null && now - at <= BANKS_RECENT_MS) n++;
  }
  return n;
}

/** "3 of 8 scrap.tf pages saved in the last hour". */
export function banksHeadline(result: Pick<ScraptfBanksResult, 'banks'> | null | undefined, now: UnixMs): { text: string; title: string } {
  const total = SCRAPTF_BANKS.length;
  const title =
    'The scrap.tf bank pages and the scrap.tf/items price list you saved into your watch folder in the last hour. Older saves still count; their prices and stock are as of each save.';
  if (!result) return { text: `… of ${total} scrap.tf pages saved in the last hour`, title };
  const n = banksSavedRecently(banksInOrder(result).map((b) => b.summary), now);
  return { text: `${fmtInt(n)} of ${fmtInt(total)} scrap.tf pages saved in the last hour`, title };
}

export interface BanksFlipsLine {
  count: number;
  /** "12 flips on your saves, newest 3 min ago". */
  text: string;
  title: string;
}

/**
 * UX-1: the header's "12 flips on your saves, newest 3 min ago" (with "View all", the Live market's
 * #/market/flips): the sum of the cards' flip counts (each equal to its stock page's Flips chip), dated
 * by the newest save of a page that has flips. null before an answer and while there are none.
 */
export function banksFlipsLine(result: Pick<ScraptfBanksResult, 'banks'> | null | undefined, now: UnixMs): BanksFlipsLine | null {
  if (!result) return null;
  let n = 0;
  let newest: UnixMs | null = null;
  for (const { summary: s } of banksInOrder(result)) {
    const flips = count(s.flips);
    if (flips === 0) continue;
    n += flips;
    const at = timeOf(s.lastSavedAt);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  if (n === 0) return null;
  // A file time a little ahead of the clock reads "just now", not "in 2 min".
  const ago = newest === null ? '' : `, newest ${fmtAgo(Math.min(newest, now), now)}`;
  return {
    count: n,
    text: `${fmtInt(n)} ${n === 1 ? 'flip' : 'flips'} on your saves${ago}`,
    title: `Flips on the newest saves of your scrap.tf pages, added up over the cards below${newest === null ? '' : ` (the newest save ${fmtDateTime(newest)})`}. View all lists them in the Live market, freshest price first. An item on two pages counts on each.`,
  };
}

// ---------------------------------------------------------------------------
// One card
// ---------------------------------------------------------------------------

export interface BankFreshness {
  tone: CoverageTone;
  label: string;
  title: string;
}

/** The card's pill: green up to 15 min, amber up to 2 h, else muted (the coverage chips' tones). */
export function bankFreshness(lastSavedAt: UnixMs | null | undefined, now: UnixMs): BankFreshness {
  const at = timeOf(lastSavedAt);
  if (at === null) {
    return { tone: 'muted', label: 'Never saved', title: `Not saved yet: open the page in your browser and save it (Ctrl+S) as '${SAVE_MODE}' into your watch folder.` };
  }
  const tone = coverageTone(at, now);
  if (tone === 'good') return { tone, label: 'Fresh', title: 'Saved in the last 15 minutes.' };
  if (tone === 'warn') return { tone, label: 'Aging', title: 'Saved 15 minutes to 2 hours ago. Save it again for current prices and stock.' };
  return { tone, label: 'Stale', title: 'Saved over 2 hours ago. Save it again for current prices and stock.' };
}

/** "saved 4 min ago · 48 items (31 in stock)", or "Not saved yet". */
export function bankSavedText(s: Pick<ScraptfBankSummary, 'lastSavedAt' | 'pages' | 'items' | 'inStock'>, now: UnixMs, isList = false): { text: string; title: string } {
  const at = timeOf(s.lastSavedAt);
  if (at === null) {
    return {
      text: 'Not saved yet',
      title: isList
        ? `Save scrap.tf/items as '${SAVE_MODE}' into your watch folder to add every item scrap.tf trades: what it charges, what it pays and its stock.`
        : `Save this page as '${SAVE_MODE}' into your watch folder to add its items, prices and stock.`,
    };
  }
  const items = count(s.items);
  const inStock = Math.min(items, count(s.inStock));
  const pages = count(s.pages);
  if (isList && items === 0) {
    // 0.7.4: a list read but no row kept: the upgrade (V14) cleared the rows stored before each read said
    // which copy it prices, or the page gave none. One more read fills it.
    return {
      text: `read ${fmtAgo(Math.min(at, now), now)} · no rows kept: read scrap.tf/items again`,
      title: `Your last read of scrap.tf/items (${fmtDateTime(at)}) left no rows on your price list. Flip Desk 0.7.4 cleared the rows saved before it read whether a row is the Craftable or the Non-Craftable copy: open scrap.tf/items once more (in the scrap.tf window, or save it with Ctrl+S as '${SAVE_MODE}') to read it again.`,
    };
  }
  // A file time a little ahead of the clock (another machine's mtime) reads "just now", not "in 2 min".
  const text = `saved ${fmtAgo(Math.min(at, now), now)} · ${fmtInt(items)} ${itemsWord(items)} (${fmtInt(inStock)} in stock)`;
  const from = pages > 1 ? ` from ${fmtInt(pages)} saved pages` : '';
  const what = isList ? 'on your saved price list' : 'on your newest save';
  return { text, title: `Newest save ${fmtDateTime(at)}${from}. ${fmtInt(items)} ${itemsWord(items)} ${what}, ${fmtInt(inStock)} in stock as of that save.` };
}

/** "Flips from this page: 3" and "(+2.11 ref)". */
export function bankFlipsText(
  s: Pick<ScraptfBankSummary, 'flips' | 'flipProfitScrap'>,
  keyScrap: Scrap | null,
  isList = false,
): { text: string; profit: string | null; title: string } {
  const flips = count(s.flips);
  const where = isList ? 'your price list' : 'this page';
  const profit = flips > 0 ? `(${fmtSignedMoney(scrapOf(s.flipProfitScrap), keyScrap)})` : null;
  const source = isList ? 'your saved scrap.tf/items list' : 'your saved copy of this page';
  return {
    text: `Flips from ${where}: ${fmtInt(flips)}`,
    profit,
    title:
      flips > 0
        ? `Profitable opportunities whose scrap.tf price came from ${source}, and their summed profit. The most profitable are listed below.`
        : `No profitable opportunity has its scrap.tf price from ${source} yet.`,
  };
}

export interface BankFlipRow {
  sku: string;
  name: string;
  /** "+12.44 ref" */
  profit: string;
  /** "buy 3.11 ref" */
  cost: string;
  level: ConfidenceLevel;
  confidence: string;
  title: string;
}

function levelOf(v: unknown): ConfidenceLevel {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

export function bankFlipRow(f: ScraptfBankFlip, keyScrap: Scrap | null): BankFlipRow {
  const level = levelOf(f.confidenceLevel);
  const name = f.name.trim() || f.sku;
  const profit = fmtSignedMoney(scrapOf(f.profitScrap), keyScrap);
  return {
    sku: f.sku,
    name,
    profit,
    cost: `buy ${fmtMoney(scrapOf(f.costScrap), keyScrap)}`,
    level,
    confidence: CONFIDENCE_LABELS[level],
    title: `${name}: buy it on scrap.tf for ${fmtMoney(scrapOf(f.costScrap), keyScrap)}, a backpack.tf buyer pays ${fmtMoney(scrapOf(f.revenueScrap), keyScrap)}: ${profit}. ${CONFIDENCE_LABELS[level]} confidence. Click for details, right-click for actions.`,
  };
}

export interface BankLookForRow {
  sku: string;
  name: string;
  /** "Pay up to 4.22 ref" */
  payUpTo: string;
  title: string;
}

export function bankLookForRow(l: ScraptfBankLookFor, keyScrap: Scrap | null): BankLookForRow {
  const name = l.name.trim() || l.sku;
  const max = fmtMoney(scrapOf(l.maxCostScrap), keyScrap);
  return {
    sku: l.sku,
    name,
    payUpTo: `up to ${max}`,
    title: `${name}: backpack.tf buyers pay ${fmtMoney(scrapOf(l.revenueScrap), keyScrap)}, so you can pay up to ${max} on scrap.tf for a flip. You have no scrap.tf price for it yet. Click for details, right-click for actions.`,
  };
}

/** What the "What to look for" block says besides its rows: why it is empty, and the "See all" link. */
export function bankLookForText(s: Pick<ScraptfBankSummary, 'unchecked' | 'lookFor'>): { empty: string | null; seeAll: string | null; seeAllTitle: string } {
  const unchecked = count(s.unchecked);
  const rows = Array.isArray(s.lookFor) ? s.lookFor.length : 0;
  const seeAllTitle = 'Opens the Live market with these categories and Not checked, highest Pay up to first.';
  if (unchecked === 0) return { empty: 'Nothing to look for: no item here with backpack.tf buyers is missing a scrap.tf price of yours.', seeAll: null, seeAllTitle };
  return {
    empty: rows === 0 ? `${fmtInt(unchecked)} ${itemsWord(unchecked)} with buyers ${unchecked === 1 ? 'has' : 'have'} no scrap.tf price of yours, none with a Pay up to above 0.` : null,
    seeAll: `See all ${fmtInt(unchecked)} not checked`,
    seeAllTitle,
  };
}

// ---------------------------------------------------------------------------
// What's new since the previous save (F17, U1)
// ---------------------------------------------------------------------------

export interface BankWhatsNewPart {
  /** "5 new", "3 gone", "2 cheaper", "1 pricier". */
  text: string;
  /** "(2 flips)" after the new count; null otherwise. */
  extra: string | null;
  tone: 'good' | 'bad' | 'muted' | null;
  /** The new count stands out ("**5 new** (2 flips)"). */
  strong: boolean;
}

export interface BankWhatsNewView {
  /** 'changes': two saves compared; 'first': one save, nothing to compare yet. */
  kind: 'changes' | 'first';
  /** "Since your save 3 h ago:", or the whole first-save sentence. */
  lead: string;
  /** Empty for a first save; "nothing changed" is one muted part. */
  parts: BankWhatsNewPart[];
  title: string;
}

export const BANK_FIRST_SAVE_TEXT = 'First save: save it again later to see what changed';

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The card's "What's new" line (ScraptfBankSummary.whatsNew): "Since your save 3 h ago: 5 new (2 flips) ·
 * 3 gone · 2 cheaper · 1 pricier"; "First save: …" while there is one save to compare (whatsNew null for
 * a saved page); null for a page never saved (the card already says so). Zero counts are left out.
 */
export function bankWhatsNew(s: Pick<ScraptfBankSummary, 'lastSavedAt' | 'whatsNew'>, now: UnixMs, path = 'this page'): BankWhatsNewView | null {
  if (timeOf(s.lastSavedAt) === null) return null;
  const w = s.whatsNew;
  if (!w || typeof w !== 'object') {
    return {
      kind: 'first',
      lead: BANK_FIRST_SAVE_TEXT,
      parts: [],
      title: `Only one save of ${path} so far. Each save is a snapshot of the page; save it again later and this line shows what is new, gone, cheaper or pricier since this one.`,
    };
  }
  const since = timeOf(w.since);
  const nNew = count(w.new);
  const flips = Math.min(nNew, count(w.newFlips));
  const gone = count(w.gone);
  const cheaper = count(w.cheaper);
  const pricier = count(w.pricier);
  const parts: BankWhatsNewPart[] = [];
  if (nNew > 0) parts.push({ text: `${fmtInt(nNew)} new`, extra: flips > 0 ? `(${fmtInt(flips)} ${plural(flips, 'flip', 'flips')})` : null, tone: flips > 0 ? 'good' : null, strong: true });
  if (gone > 0) parts.push({ text: `${fmtInt(gone)} gone`, extra: null, tone: null, strong: false });
  if (cheaper > 0) parts.push({ text: `${fmtInt(cheaper)} cheaper`, extra: null, tone: 'good', strong: false });
  if (pricier > 0) parts.push({ text: `${fmtInt(pricier)} pricier`, extra: null, tone: 'bad', strong: false });
  if (!parts.length) parts.push({ text: 'nothing new, gone or repriced', extra: null, tone: 'muted', strong: false });
  // A previous save's file time a little ahead of the clock reads "just now", not "in 2 min".
  const lead = since === null ? 'Since your previous save:' : `Since your save ${fmtAgo(Math.min(since, now), now)}:`;
  const when = since === null ? 'your previous save' : `your previous save (${fmtDateTime(since)})`;
  return {
    kind: 'changes',
    lead,
    parts,
    title:
      `Your newest save of ${path} against ${when}: ${fmtInt(nNew)} new on sale (${fmtInt(flips)} of them ${plural(flips, 'a flip', 'flips')}), ` +
      `${fmtInt(gone)} gone, ${fmtInt(cheaper)} cheaper, ${fmtInt(pricier)} pricier. Stock between the two saves is unknown.`,
  };
}

export interface BankCardView {
  bank: ScraptfBank;
  label: string;
  /** The static SCRAPTF_BANKS address: only ever handed to links.open. */
  url: string;
  /** "scrap.tf/buy/hats" */
  path: string;
  /** The /items price list (F14), not a bank page: no categories, so nothing to look for. */
  isList: boolean;
  freshness: BankFreshness;
  saved: { text: string; title: string };
  /** F17: what changed since the previous save; null when never saved. */
  whatsNew: BankWhatsNewView | null;
  /** F17: the bank's stock page route ("banks/hats/stock"). */
  stockPath: string;
  stockTitle: string;
  flips: { text: string; profit: string | null; title: string };
  top: BankFlipRow[];
  /** null for the list card. */
  lookFor: { title: { text: string; title: string }; rows: BankLookForRow[]; empty: string | null; seeAll: string | null; seeAllTitle: string } | null;
  openTitle: string;
}

function validRow(r: unknown): r is { sku: string; name: string } {
  return typeof r === 'object' && r !== null && typeof (r as { sku?: unknown }).sku === 'string' && typeof (r as { name?: unknown }).name === 'string';
}

const LOOK_FOR_TITLE = "Items with backpack.tf buyers in this page's categories that you have no scrap.tf price for yet, highest Pay up to first.";

/**
 * The "What to look for" block's heading. ACT-8: a page saved within `inputStaleMs` (profit.inputStaleMs)
 * showed what is on sale there now, and these items were not on it, so they are worth watching for a
 * restock rather than looking for: "Not in your save 12 min ago: watch for restocks".
 */
export function bankLookForTitle(lastSavedAt: UnixMs | null | undefined, now: UnixMs, inputStaleMs: number | null | undefined, path = 'this page'): { text: string; title: string } {
  const at = timeOf(lastSavedAt);
  const stale = typeof inputStaleMs === 'number' && Number.isFinite(inputStaleMs) && inputStaleMs > 0 ? inputStaleMs : null;
  if (at === null || stale === null || now - at > stale) return { text: 'What to look for', title: LOOK_FOR_TITLE };
  const ago = fmtAgo(Math.min(at, now), now);
  return {
    text: `Not in your save ${ago}: watch for restocks`,
    title: `Items with backpack.tf buyers in this page's categories that your save of ${path} ${ago} did not list on sale, highest Pay up to first. Save it again later to see whether one came back.`,
  };
}

/**
 * The page's cards, one per SCRAPTF_BANKS entry in that order. `inputStaleMs` (profit.inputStaleMs, when
 * known) words the "What to look for" heading of a page saved within it (bankLookForTitle).
 */
export function bankCards(result: Pick<ScraptfBanksResult, 'banks'> | null | undefined, keyScrap: Scrap | null, now: UnixMs, inputStaleMs: number | null = null): BankCardView[] {
  return banksInOrder(result).map(({ info, summary: s }) => {
    const isList = info.categories.length === 0;
    const path = bankPath(info.url);
    const top = (Array.isArray(s.top) ? s.top : []).filter(validRow).slice(0, BANK_TOP_FLIPS);
    const look = (Array.isArray(s.lookFor) ? s.lookFor : []).filter(validRow).slice(0, BANK_LOOK_FOR);
    return {
      bank: info.bank,
      label: info.label,
      url: info.url,
      path,
      isList,
      freshness: bankFreshness(s.lastSavedAt, now),
      saved: bankSavedText(s, now, isList),
      whatsNew: bankWhatsNew(s, now, path),
      stockPath: bankStockPath(info.bank) ?? BANKS_ROUTE,
      stockTitle: `Every item on your newest save of ${path}, with what changed since your previous save and its backpack.tf buyers.`,
      flips: bankFlipsText(s, keyScrap, isList),
      top: top.map((f) => bankFlipRow(f, keyScrap)),
      lookFor: isList
        ? null
        : {
            // /unusuals spans many pages and one save shows some of them, so an item missing there is not
            // known to be off sale: "What to look for" as before (the engine's ACT-8 rule skips it too).
            title: bankLookForTitle(s.lastSavedAt, now, info.bank === 'unusuals' ? null : inputStaleMs, path),
            rows: look.map((l) => bankLookForRow(l, keyScrap)),
            ...bankLookForText({ unchecked: s.unchecked, lookFor: look }),
          },
      openTitle: `Opens ${path} in your own browser. ${SCRAPTF_BOUNDARY_SHORT} ${isList ? LIST_SAVE_TIP : BANK_SAVE_TIP}`,
    };
  });
}

// ---------------------------------------------------------------------------
// The item drawer: where the user last saw the item
// ---------------------------------------------------------------------------

/**
 * "Seen on scrap.tf/buy/stranges · 12 min ago" from ItemDetail.seenOn, or null when no imported price
 * names a page. The path is the static bank's (SCRAPTF_BANKS), never the address the service sent. A
 * painted item none of whose own prices was imported is seen where another copy was (itemSeenOn), so
 * the tooltip never claims a price of its own.
 */
export function seenOnText(seenOn: Pick<ScraptfSeenOn, 'bank' | 'at'> | null | undefined, now: UnixMs): { text: string; title: string } | null {
  const info = scraptfBankInfo(seenOn?.bank);
  if (!info) return null;
  const path = bankPath(info.url);
  const at = timeOf(seenOn?.at);
  return {
    text: at === null ? `Seen on ${path}` : `Seen on ${path} · ${fmtAgo(Math.min(at, now), now)}`,
    title: `The newest scrap.tf price imported for this item (for a painted item with none of its own, for another copy of it) came from your saved copy of ${path}${at === null ? '' : ` (${fmtDateTime(at)})`}. ${SCRAPTF_BOUNDARY_SHORT}`,
  };
}

/** 0.7.4 (F65) unsavedLookOf: a newer look of a page than the save the drawer's stock line and history read. */
export interface UnsavedLook {
  bank: ScraptfBank;
  /** When that look was taken (the saved file's time, else its import). */
  at: UnixMs;
  /** What the look showed in stock (the /items list's row); null when unknown (a bank page's look). */
  stock: number | null;
  stockLimit: number | null;
}

/** Differences under a second are one look (a save and its prices share the file's time). */
const UNSAVED_LOOK_SLACK_MS = 1_000;

/**
 * 0.7.4 (F65): a look of the item's page newer than the stored save its stock line and history are read
 * from (ItemDetail.bankStock), that showed the item but stored no save: a window read cut short (ACT-4) or
 * a partial look (DM-2, P1) still stores its prices and list rows. For the /items list, the item's own list
 * row (an exact one: never a family row, never the plain row of a painted drawer) newer than the list save
 * it was read with, or with no stored save at all; for a bank page, the item's newest imported price from
 * that bank newer than that bank's save (a plain drawer only: a painted one may be seen as another copy).
 * null when the stored save is the newest look, so "Now" and "in your save" stand.
 */
export function unsavedLookOf(d: Pick<ItemDetail, 'sku' | 'bankStock' | 'seenOn' | 'scraptfList'>, now: UnixMs): UnsavedLook | null {
  let painted = false;
  try {
    painted = !!fromString(d.sku).paint;
  } catch {
    return null;
  }
  if (painted) return null;
  const saved = d.bankStock;
  const list = d.scraptfList;
  const newer = (at: unknown, than: UnixMs | null): at is UnixMs => timeOf(at) !== null && (than === null || (at as number) - than > UNSAVED_LOOK_SLACK_MS);
  if (list && (list.match ?? 'exact') === 'exact' && (saved === null || saved.bank === 'list') && newer(list.observedAt, saved?.savedAt ?? null)) {
    return { bank: 'list', at: Math.min(list.observedAt, now), stock: list.stock, stockLimit: list.stockLimit };
  }
  const seen = d.seenOn;
  if (saved && seen && seen.bank === saved.bank && saved.bank !== 'list' && newer(seen.at, saved.savedAt)) {
    return { bank: saved.bank, at: Math.min(seen.at, now), stock: null, stockLimit: null };
  }
  return null;
}

/** 0.7.4 (F65): the drawer's note under its stock line when a newer look stored no save (unsavedLookOf). */
export function unsavedLookText(u: UnsavedLook, now: UnixMs): { text: string; title: string } {
  const info = scraptfBankInfo(u.bank);
  const path = info ? bankPath(info.url) : 'scrap.tf';
  const stock = typeof u.stock === 'number' && Number.isFinite(u.stock) ? ` (it showed stock ${fmtInt(u.stock)}${typeof u.stockLimit === 'number' && Number.isFinite(u.stockLimit) ? `/${fmtInt(u.stockLimit)}` : ''})` : '';
  return {
    text: `Your newer look at ${path} ${fmtAgo(u.at, now)}${stock} stored no save, so the stock line and history are from an older save.`,
    title: `Your look at ${path} of ${fmtDateTime(u.at)} stored its prices but no bank stock save: it was cut short before the page settled, or caught only part of the page. Read the page again and let it finish loading to bring the history up to date. ${SCRAPTF_BOUNDARY_SHORT}`,
  };
}

// ---------------------------------------------------------------------------
// The Import page: which card a saved page counts for
// ---------------------------------------------------------------------------

/**
 * The Import page's "scrap.tf page" line for ImportResult.bank / ImportBatch.bank: the banks card a save
 * dates ("Stranges · scrap.tf/buy/stranges"), or why none. undefined: an answer without the field (says
 * nothing). Static labels and paths only, whatever the service sent. `stored` (ImportResult.stored /
 * ImportBatch.itemCount), when known: a bank page that stored nothing dates no card (isEmptyBankSave,
 * F18 S3), so the line says so instead of "Counted as a save". `savedWithoutCards`
 * (importSavedWithoutCards of the result; unknown for an ImportBatch, which keeps no warnings) decides
 * whether the save type is to blame: a page whose cards were all read but skipped (every price already
 * set by a newer save, say) was saved fine. F21 `fromWindow` (origin 'window'): a read of the scrap.tf
 * window was no save, so the remedy is to read it again there once the items show. 0.7.3
 * `removedByUpdate` (importBatchItemsRemoved of an ImportBatch): it did store items, which an update
 * removed later, so neither timing nor the save type is to blame. 0.7.3 `unusualsIndex`
 * (importUnusualsIndex of the result): the page was scrap.tf's bare Unusuals index, which lists no items,
 * so the remedy is to open one of its pages; an ImportBatch keeps no warnings, so an empty Unusuals save
 * in the history only adds that alternative to its hedge.
 */
export function importBankText(
  bank: ScraptfBank | null | undefined,
  stored?: number | null,
  savedWithoutCards?: boolean,
  fromWindow = false,
  removedByUpdate = false,
  unusualsIndex = false,
): { text: string; title: string } | null {
  if (bank === undefined) return null;
  const info = scraptfBankInfo(bank);
  if (!info) {
    return {
      text: 'Not recognised',
      title: `${fromWindow ? 'The page read in the Flip Desk window is not' : "The saved page's address did not name"} a scrap.tf page this app knows, so the banks page and the Live market strip file it by the categories of the items it stored.`,
    };
  }
  const path = bankPath(info.url);
  if (typeof stored === 'number' && isEmptyBankSave({ itemCount: stored }, info.bank)) {
    if (removedByUpdate) {
      return {
        text: `${info.label} · ${path} · not counted`,
        title: `Not counted as a save of ${path}: an update removed the items it stored (0.7.2 removed killstreak kits stored without their weapon), so the scrap.tf banks page and the Live market strip pass over it. It was not saved or read too early: the next save or read of ${path} counts as usual.`,
      };
    }
    const unusuals = info.bank === 'unusuals';
    const what =
      unusualsIndex && unusuals
        ? `This is the Unusuals index, which lists no items: open one of its pages (${path}/<n>), then save or read that page.`
        : savedWithoutCards === false
          ? 'The skipped items say why.'
          : fromWindow
            ? 'If it was read before its items showed, press Read page now in the window once they show.'
            : savedWithoutCards === true
              ? `Save it again as '${SAVE_MODE}'.`
              : `If it was saved before its items showed, save it again as '${SAVE_MODE}'.${unusuals ? ` If it was the Unusuals index itself (${path}), which lists no items, save one of its pages instead.` : ''}`;
    return {
      text: `${info.label} · ${path} · not counted`,
      title: `Not counted as a save of ${path}: it stored no items, so the scrap.tf banks page and the Live market strip pass over it. ${what}`,
    };
  }
  return { text: `${info.label} · ${path}`, title: `Counted as a save of ${path} on the scrap.tf banks page and the Live market strip.` };
}

/**
 * 0.7.3: a batch whose stored items an update removed afterwards. The bare-kit cleanup (schema V12) zeroes
 * item_count but keeps the categories counted at import, so a 0 count beside stored categories means such
 * a batch; a page saved or read before its cards showed stored categories {} (null here).
 */
export function importBatchItemsRemoved(b: Pick<ImportBatch, 'itemCount' | 'categories'>): boolean {
  return typeof b.itemCount === 'number' && Number.isFinite(b.itemCount) && b.itemCount <= 0 && cleanCategoryCounts(b.categories) !== null;
}

// ---------------------------------------------------------------------------
// Keyboard and routes
// ---------------------------------------------------------------------------

/**
 * The card an arrow key moves to in a grid of `columns` (left/right step one, up/down a row, Home and
 * End the ends); null for any other key, or when nothing would move.
 */
export function bankGridMove(index: number, key: string, total: number, columns: number): number | null {
  if (total <= 0) return null;
  const cols = Math.max(1, Math.floor(columns) || 1);
  const at = Math.min(Math.max(0, index), total - 1);
  let next: number;
  switch (key) {
    case 'ArrowRight':
      next = at + 1;
      break;
    case 'ArrowLeft':
      next = at - 1;
      break;
    case 'ArrowDown':
      next = at + cols;
      break;
    case 'ArrowUp':
      next = at - cols;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = total - 1;
      break;
    default:
      return null;
  }
  return next < 0 || next >= total || next === at ? null : next;
}

/** Columns of a wrapped grid, from its cards' top edges in order: the cards on the first row. */
export function gridColumns(tops: readonly number[]): number {
  if (!tops.length || !Number.isFinite(tops[0])) return 1;
  let n = 0;
  for (const t of tops) {
    if (Math.abs(t - tops[0]!) > 2) break;
    n++;
  }
  return Math.max(1, n);
}

/** "banks", or "banks/hats" to open the page on that card (the Live market's coverage chips). */
export function banksPath(bank?: ScraptfBank | null): string {
  const info = scraptfBankInfo(bank);
  return info ? `${BANKS_ROUTE}/${info.bank}` : BANKS_ROUTE;
}

/** The card a #/banks/<bank> route asks for, or null. */
export function banksRouteBank(segments: readonly string[]): ScraptfBank | null {
  if (segments[0] !== BANKS_ROUTE) return null;
  return scraptfBankInfo(segments[1])?.bank ?? null;
}

/** The last segment of a bank's stock page route, #/banks/<bank>/stock (F17). */
export const BANK_STOCK_SEGMENT = 'stock';

/** "banks/hats/stock" for a known bank, else null. */
export function bankStockPath(bank: ScraptfBank | null | undefined): string | null {
  const info = scraptfBankInfo(bank);
  return info ? `${BANKS_ROUTE}/${info.bank}/${BANK_STOCK_SEGMENT}` : null;
}

/** The bank a #/banks/<bank>/stock route shows, or null (#/banks and #/banks/<bank> stay the banks page). */
export function bankStockRouteBank(segments: readonly string[]): ScraptfBank | null {
  if (segments[0] !== BANKS_ROUTE || segments[2] !== BANK_STOCK_SEGMENT) return null;
  return scraptfBankInfo(segments[1])?.bank ?? null;
}

/**
 * F21-2: the chip a #/banks/<bank>/stock/<flips|new> route opens the stock page on (the toolbar's Show
 * flips, through 'ui.openBankStock'); null for a plain stock route or anything else.
 */
export function bankStockRouteFilter(segments: readonly string[]): BankStockOpenFilter | null {
  if (bankStockRouteBank(segments) === null) return null;
  return BANK_STOCK_OPEN_FILTERS.find((f) => f === segments[3]) ?? null;
}

/**
 * The route a 'ui.openBankStock' push asks for ("banks/hats/stock/flips"), from a known bank and chip
 * only; null for anything else (the push comes from main, but its payload is still checked).
 */
export function bankStockOpenPath(p: unknown): string | null {
  const o = typeof p === 'object' && p !== null ? (p as { bank?: unknown; filter?: unknown }) : {};
  const stock = bankStockPath(scraptfBankInfo(o.bank)?.bank);
  const filter = BANK_STOCK_OPEN_FILTERS.find((f) => f === o.filter);
  return stock && filter ? `${stock}/${filter}` : null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface BanksLoader {
  /** Reads 'scraptf.banks' now, or once more right after the read in flight. */
  refresh(): void;
  /** Nothing is reported after this. */
  dispose(): void;
}

/**
 * One 'scraptf.banks' read at a time: a refresh during a read runs once after it, so a burst of pushes
 * costs at most two reads and the newest state always lands. Because reads never overlap, an answer can
 * never be overtaken by an older one; that order is the stale-response guard. generatedAt is not compared:
 * it is the service's wall clock, and a clock stepped back would otherwise drop every newer answer until
 * it caught up. Nothing is reported after dispose (the page was left).
 */
export function createBanksLoader(call: () => Promise<ScraptfBanksResult>, on: { data(r: ScraptfBanksResult): void; error(message: string): void }): BanksLoader {
  let inFlight = false;
  let again = false;
  let disposed = false;
  const run = (): void => {
    inFlight = true;
    again = false;
    let p: Promise<ScraptfBanksResult>;
    try {
      p = call();
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (r) => {
        if (!disposed) on.data(r);
      },
      (e: unknown) => {
        if (!disposed) on.error(errorMessage(e));
      },
    ).finally(() => {
      inFlight = false;
      if (!disposed && again) run();
    });
  };
  return {
    refresh() {
      if (disposed) return;
      if (inFlight) {
        again = true;
        return;
      }
      run();
    },
    dispose() {
      disposed = true;
    },
  };
}
