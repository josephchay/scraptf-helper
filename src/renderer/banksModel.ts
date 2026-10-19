// Helpers for the scrap.tf banks page (F15, pages/BanksPage.tsx) and the item drawer's
// "Seen on scrap.tf/buy/stranges · 12 min ago" line: one card per scrap.tf page the user
// saves (SCRAPTF_BANKS: the seven bank pages and the /items price list), built from
// 'scraptf.banks', which the service computes from local data only. All pure except
// createBanksLoader, whose only effect is the call it is handed. F17 adds each card's
// "What's new" line (bankWhatsNew) and the route of its stock page (#/banks/<bank>/stock).
//
// Labels and URLs always come from SCRAPTF_BANKS, whatever the service sent: the page only
// hands them to links.open (the user's own browser). Nothing here, or anywhere in the app,
// fetches scrap.tf (R1); its data only arrives through pages the user saves into the watch
// folder (R10).

import { BANK_LOOK_FOR, BANK_TOP_FLIPS } from '../shared/banks';
import { SCRAPTF_BANKS, scraptfBankInfo, type ScraptfBankInfo } from '../shared/links';
import { isEmptyBankSave } from '../shared/market';
import type { ConfidenceLevel, Scrap, ScraptfBank, ScraptfBankFlip, ScraptfBankLookFor, ScraptfBankSummary, ScraptfBanksResult, ScraptfSeenOn, UnixMs } from '../shared/types';
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
  lookFor: { rows: BankLookForRow[]; empty: string | null; seeAll: string | null; seeAllTitle: string } | null;
  openTitle: string;
}

function validRow(r: unknown): r is { sku: string; name: string } {
  return typeof r === 'object' && r !== null && typeof (r as { sku?: unknown }).sku === 'string' && typeof (r as { name?: unknown }).name === 'string';
}

/** The page's cards, one per SCRAPTF_BANKS entry in that order. */
export function bankCards(result: Pick<ScraptfBanksResult, 'banks'> | null | undefined, keyScrap: Scrap | null, now: UnixMs): BankCardView[] {
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
      lookFor: isList ? null : { rows: look.map((l) => bankLookForRow(l, keyScrap)), ...bankLookForText({ unchecked: s.unchecked, lookFor: look }) },
      openTitle: `Opens ${path} in your own browser; the app never visits it. ${isList ? LIST_SAVE_TIP : BANK_SAVE_TIP}`,
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
    title: `The newest scrap.tf price imported for this item (for a painted item with none of its own, for another copy of it) came from your saved copy of ${path}${at === null ? '' : ` (${fmtDateTime(at)})`}. The app never visits scrap.tf.`,
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
 * window was no save, so the remedy is to read it again there once the items show.
 */
export function importBankText(
  bank: ScraptfBank | null | undefined,
  stored?: number | null,
  savedWithoutCards?: boolean,
  fromWindow = false,
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
    const what =
      savedWithoutCards === false
        ? 'The skipped items say why.'
        : fromWindow
          ? 'If it was read before its items showed, press Read page now in the window once they show.'
          : savedWithoutCards === true
            ? `Save it again as '${SAVE_MODE}'.`
            : `If it was saved before its items showed, save it again as '${SAVE_MODE}'.`;
    return {
      text: `${info.label} · ${path} · not counted`,
      title: `Not counted as a save of ${path}: it stored no items, so the scrap.tf banks page and the Live market strip pass over it. ${what}`,
    };
  }
  return { text: `${info.label} · ${path}`, title: `Counted as a save of ${path} on the scrap.tf banks page and the Live market strip.` };
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
