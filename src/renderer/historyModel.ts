// Pure helpers for the item drawer's "scrap.tf history" block (F20 U1, components/ScraptfHistory.tsx):
// the price on each of the user's saves of the item's bank as a step chart with gaps, how long it has
// been listed, the 1 h / 24 h / 7 d / since-listed change chips, stock now and the last change events,
// all from 'scraptf.itemHistory'. Every value comes from pages the user saved (R10); a save is a
// snapshot, so nothing is claimed about the time between two saves. Nothing here loads scrap.tf (R1).
// 0.7.1: price changes and stock moves are listed apart (DM-6), and a sighting long past reads as one (DM-5).
// 0.8 (T5, LC-3): the Cycles block: the buy-timing verdict with its n and its save (historyTimingView), each
// listing run of the copy (historyRunLines) and the chart's down markers (stepChartGeom's `downs`).
// 0.9 (#10): the odds line carries the 90 % ranges, the money line the gain's low end for the picked wait taken alone,
// and a verdict that turns with save timing says so (timingModel's sentences).

import { bankStockPagePath } from '../shared/bankStock';
import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { valueScrap } from '../shared/currency';
import { scraptfBankInfo } from '../shared/links';
import { HISTORY_LAST_SEEN_STALE_MS, scraptfAgoText } from '../shared/scraptfHistory';
import type {
  Scrap,
  ScraptfBank,
  ScraptfBuyTiming,
  ScraptfChangeEvent,
  ScraptfHistoryPoint,
  ScraptfItemCycles,
  ScraptfItemHistory,
  ScraptfListingRun,
  ScraptfPriceChange,
  UnixMs,
} from '../shared/types';
import { CHANGE_KIND_HELP, CHANGE_KIND_LABELS, CHANGE_KIND_TONES, changePctText, changePriceText, changeStockText, fmtSaveTime, fromToText } from './changesModel';
import { DASH, fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtSignedMoney, type Tone } from './format';
import { TIMING_ESTIMATE_NOTE, timingBadge, timingDurText, timingRangesText, timingSaveTimingText, timingWhyText } from './timingModel';

/** The block re-reads at most this often on pushes ('scraptf.changed', 'prices.changed'). */
export const HISTORY_REFRESH_MS = 2_000;
/** Change events listed before "Show all" (price changes and stock moves each). */
export const HISTORY_EVENTS_SHOWN = 5;
/**
 * DM-5: a newest sighting older than this reads "last on sale … ago", not as a listing still running. 0.8: moved to
 * shared/scraptfHistory.ts (T3's 'stale-save' reads it too) and re-exported here.
 */
export { HISTORY_LAST_SEEN_STALE_MS };
/** 0.8 (LC-3): listing runs listed before "Show all". */
export const HISTORY_RUNS_SHOWN = 5;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** "scrap.tf/buy/hats" for the history's bank, from SCRAPTF_BANKS; null without one. */
export function historyBankPath(h: Pick<ScraptfItemHistory, 'bank'> | null | undefined): string | null {
  const info = h ? scraptfBankInfo(h.bank) : null;
  return info ? bankStockPagePath(info.url) : null;
}

// ---------------------------------------------------------------------------
// Listed since, stock now
// ---------------------------------------------------------------------------

export interface HistoryLine {
  text: string;
  title: string;
  tone: Tone;
}

/**
 * "Listed since 2 d 4 h (since your save on Oct 14 09:12)" while the newest save lists it on sale; else
 * when it was last on sale. DM-5: a run whose newest sighting (lastSeenAt) is over HISTORY_LAST_SEEN_STALE_MS
 * old reads "Last on sale 3 d ago …" instead, its span ending there. Null without a bank (the empty state
 * says why).
 */
export function historyListedLine(h: Pick<ScraptfItemHistory, 'bank' | 'listedSince' | 'lastSeenAt' | 'firstSeenAt'>, now: UnixMs): HistoryLine | null {
  const path = historyBankPath(h);
  if (!path) return null;
  const first = finite(h.firstSeenAt) ? ` Your saves kept first listed it on sale ${fmtDateTime(h.firstSeenAt)}.` : '';
  const gaps = ' What happened between two saves is unknown.';
  if (finite(h.listedSince)) {
    const since = Math.min(h.listedSince, now);
    const last = finite(h.lastSeenAt) ? Math.max(since, Math.min(h.lastSeenAt, now)) : null;
    if (last !== null && now - last > HISTORY_LAST_SEEN_STALE_MS) {
      // A run of one save (a page saved once, long ago) has no span to name: "after 0 m listed" says nothing.
      const span = last - since >= 60_000;
      return {
        text: `Last on sale ${fmtAgo(last, now)} (your save on ${fmtSaveTime(last)})${span ? `, after ${scraptfAgoText(last - since)} listed` : ''}`,
        title: `${span ? `On sale on ${path} in every one of your saves of its page from ${fmtDateTime(h.listedSince)} to ${fmtDateTime(last)}` : `On sale on ${path} in your save of ${fmtDateTime(last)}`}; no newer save of it shows it, so it may be gone.${first}${gaps}`,
        tone: 'muted',
      };
    }
    return {
      text: `Listed since ${scraptfAgoText(now - since)} (since your save on ${fmtSaveTime(h.listedSince)})`,
      title: `On sale on ${path} in every one of your saves of its page since ${fmtDateTime(h.listedSince)}.${first}${gaps}`,
      tone: 'info',
    };
  }
  if (finite(h.lastSeenAt)) {
    return {
      text: `Not on sale in your newest save (last on sale in your save on ${fmtSaveTime(h.lastSeenAt)})`,
      title: `Your newest save of ${path} does not list it on sale: sold, sold out or taken off. It was on sale in your save of ${fmtDateTime(h.lastSeenAt)}.${first}${gaps}`,
      tone: 'muted',
    };
  }
  return { text: 'Listed in your saves, but never on sale', title: `Your saves of ${path} list it only sold out or without a price.${gaps}`, tone: 'muted' };
}

/**
 * 0.7.4 (F65): a newer look of the history's page that stored no save (the drawer's unsavedLookOf), when it
 * is newer than every save the history read: the newest save is then no "Now".
 */
export interface HistoryUnsavedLook {
  bank: ScraptfBank;
  at: UnixMs;
  stock: number | null;
  stockLimit: number | null;
}

/** The history's newest save time (0 without one). */
function newestSaveAt(h: Pick<ScraptfItemHistory, 'points'>): UnixMs {
  return h.points.reduce((m, p) => (finite(p.at) && p.at > m ? p.at : m), 0);
}

function unsavedAfter(h: Pick<ScraptfItemHistory, 'bank' | 'points'>, u: HistoryUnsavedLook | null | undefined): HistoryUnsavedLook | null {
  if (!u || u.bank !== h.bank || !finite(u.at)) return null;
  return u.at > newestSaveAt(h) ? u : null;
}

/** "Now 1.22 ref · 3 in stock", or what the newest save said instead (0.7.4: "In your save of …" when a newer look stored none). */
export function historyNowText(h: Pick<ScraptfItemHistory, 'bank' | 'current' | 'points'>, keyScrap: Scrap | null, unsaved?: HistoryUnsavedLook | null): HistoryLine | null {
  const path = historyBankPath(h);
  if (!path) return null;
  const c = h.current;
  const later = unsavedAfter(h, unsaved);
  if (c && later) {
    const stock = finite(c.stock) ? `${fmtInt(c.stock)} in stock` : 'that save showed no stock';
    const read = finite(later.stock) ? `; your look of ${fmtSaveTime(later.at)} showed stock ${fmtInt(later.stock)}${finite(later.stockLimit) ? `/${fmtInt(later.stockLimit)}` : ''}` : '';
    return {
      text: `In your save of ${fmtSaveTime(newestSaveAt(h))}: ${fmtMoney(c.costScrap, keyScrap)} · ${stock}${read}`,
      title: `scrap.tf's price and stock on ${path} in your newest save of its page, at today's key price. Your look of ${fmtDateTime(later.at)} showed it too but stored no save (cut short or partial), so this is not now: read the page again and let it finish.`,
      tone: 'muted',
    };
  }
  if (c) {
    const stock = finite(c.stock) ? `${fmtInt(c.stock)} in stock` : 'stock not shown';
    return {
      text: `Now ${fmtMoney(c.costScrap, keyScrap)} · ${stock}`,
      title: `scrap.tf's price and stock on ${path} in your newest save of its page, at today's key price.${finite(c.stock) ? '' : ' The page showed no stock count.'}`,
      tone: 'info',
    };
  }
  const last = h.points[h.points.length - 1];
  const soldOut = last !== undefined && last.stock === 0;
  return {
    text: soldOut ? 'Sold out in your newest save' : 'Not in your newest save',
    title: soldOut ? `Your newest save of ${path} lists it with no stock left.` : `Your newest save of ${path} does not list it on sale.`,
    tone: 'muted',
  };
}

// ---------------------------------------------------------------------------
// Change chips: 1 h / 24 h / 7 d / since listed
// ---------------------------------------------------------------------------

export type HistoryChipId = 'h1' | 'h24' | 'd7' | 'listed';

export interface HistoryChip {
  id: HistoryChipId;
  label: string;
  /** "↓ 0.11 ref (−8 %)", "↑ …", "no change" or "—". */
  text: string;
  tone: Tone;
  title: string;
}

const CHIPS: readonly { id: HistoryChipId; label: string; ago: string }[] = [
  { id: 'h1', label: '1 h', ago: 'an hour' },
  { id: 'h24', label: '24 h', ago: 'a day' },
  { id: 'd7', label: '7 d', ago: 'a week' },
  { id: 'listed', label: 'Since listed', ago: '' },
];

/** One change as a chip's text: the arrow, the difference and the percentage. */
export function priceChangeText(c: ScraptfPriceChange, keyScrap: Scrap | null): { text: string; tone: Tone } {
  if (!finite(c.deltaScrap) || c.deltaScrap === 0) return { text: 'no change', tone: 'muted' };
  const pct = changePctText(c.pct);
  const down = c.deltaScrap < 0;
  return { text: `${down ? '↓' : '↑'} ${fmtMoney(Math.abs(c.deltaScrap), keyScrap)}${pct ? ` (${pct})` : ''}`, tone: down ? 'good' : 'bad' };
}

/**
 * The four chips; a missing comparison reads "—" and says why. A chip whose earlier save is the newest
 * save itself compares a save with itself: a dash, not "no change". For 1 h / 24 h / 7 d that is no save
 * since that long ago; for Since listed, a run that began in the newest save.
 */
export function historyChips(
  h: Pick<ScraptfItemHistory, 'bank' | 'current' | 'change' | 'lastSeenAt'> & Partial<Pick<ScraptfItemHistory, 'points'>>,
  keyScrap: Scrap | null,
  unsaved?: HistoryUnsavedLook | null,
): HistoryChip[] {
  // 0.7.4 (F65): a newer look that stored no save is why there is nothing newer to compare with.
  const later = unsavedAfter({ bank: h.bank, points: h.points ?? [] }, unsaved);
  const notSaved = later ? ` Your look of ${fmtDateTime(later.at)} stored no save (cut short or partial): read the page again and let it finish.` : '';
  return CHIPS.map(({ id, label, ago }) => {
    const c = h.change[id];
    if (c && finite(h.lastSeenAt) && c.since >= h.lastSeenAt) {
      const title =
        id === 'listed'
          ? `On sale only since your newest save (${fmtDateTime(c.since)}): save the page again later to compare.${notSaved}`
          : later
            ? `Your newest save of it (${fmtDateTime(c.since)}) is already at least ${ago} old.${notSaved}`
            : `Your newest save of it (${fmtDateTime(c.since)}) is already at least ${ago} old: save the page again to compare.`;
      return { id, label, text: DASH, tone: 'muted', title };
    }
    if (!c) {
      const why = !h.current
        ? 'It is not on sale in your newest save, so there is nothing to compare.'
        : id === 'listed'
          ? 'No run of saves to compare with.'
          : `None of your saves from at least ${ago} ago listed it on sale (or none is that old).`;
      return { id, label, text: DASH, tone: 'muted', title: why };
    }
    const t = priceChangeText(c, keyScrap);
    const then = id === 'listed' ? `When your saves began listing it in this run (${fmtDateTime(c.since)})` : `In your save of ${fmtDateTime(c.since)}, at least ${ago} ago`;
    return {
      id,
      label,
      text: t.text,
      tone: t.tone,
      title: `${then}: ${fmtMoney(c.fromScrap, keyScrap)}. Now: ${fmtMoney(c.toScrap, keyScrap)} (${fromToText(c.fromScrap, c.toScrap, keyScrap)}, both at today's key price).`,
    };
  });
}

// ---------------------------------------------------------------------------
// 0.8 Cycles: buy timing and listing runs (T5, LC-3)
// ---------------------------------------------------------------------------

/** "Oct 24": a save's day (fmtSaveTime without the time). */
function fmtSaveDay(ts: UnixMs): string {
  return fmtSaveTime(ts).split(' ').slice(0, 2).join(' ');
}

/** "a", "a and b", "a, b and c". */
function listText(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const VERDICT_PILLS: Readonly<Record<Exclude<ScraptfBuyTiming['verdict'], 'wait' | 'buy-now'>, { text: string; tone: Tone }>> = {
  over: { text: 'Over Pay up to', tone: 'bad' },
  'no-buyers': { text: 'No buyers', tone: 'muted' },
  'not-enough-data': { text: 'Not enough data', tone: 'muted' },
};

/** The drops line: the run's reprice-downs and the rhythm, a rhythm already seen and never a probability (E.1-3). */
function dropsLine(t: ScraptfBuyTiming, path: string, now: UnixMs): string | null {
  const steps = t.steps.map((s) => changePctText(s.pct)).filter((p): p is string => p !== null);
  const head =
    t.dropsThisRun > 0
      ? `${fmtInt(t.dropsThisRun)} ${t.dropsThisRun === 1 ? 'drop' : 'drops'} in this run${steps.length ? ` (${t.dropsThisRun > steps.length ? '… ' : ''}${steps.join(', ')})` : ''}`
      : 'No drop in this run yet';
  if (t.cadenceSource === 'own' && finite(t.cadenceMs)) {
    const due = finite(t.nextDropAt)
      ? t.nextDropAt < now
        ? `; by that rhythm a drop was due ${fmtSaveDay(t.nextDropAt)}: save the page again to see`
        : `; by that rhythm the next drop would be due around ${fmtSaveDay(t.nextDropAt)}`
      : '';
    return `${head}, about every ${timingDurText(t.cadenceMs)} in your saves${due}`;
  }
  if (t.cadenceSource === 'bank' && finite(t.cadenceMs)) {
    return `${head}; drops${t.scope === 'band' ? ' of prices of similar value' : ''} on ${path} in your saves came a median ${timingDurText(t.cadenceMs)} after the price was set (${fmtInt(t.n.drops)} ${t.n.drops === 1 ? 'drop' : 'drops'})`;
  }
  return t.dropsThisRun > 0 ? head : null;
}

/**
 * The odds line: every percentage over its own denominator (n.atRisk), then the prices and items behind the table.
 * 0.9 (#10): the ranges sentence (timingRangesText, with the items behind it) before "From your save", when present.
 */
function oddsLine(t: ScraptfBuyTiming, path: string, now: UnixMs): string | null {
  if (!finite(t.horizonMs) || !finite(t.pDrop)) return null;
  const similar = t.scope === 'band' ? ' of similar value' : '';
  const end = finite(t.n.atRiskEnd) ? `; ${fmtInt(t.n.atRiskEnd)} ${t.n.atRiskEnd === 1 ? 'was' : 'were'} still at their price at the end of that time` : '';
  const pct = (p: number) => `${Math.round(Math.max(0, Math.min(1, p)) * 100)} %`;
  const ranges = timingRangesText(t);
  return (
    `On ${path} in your saves, of the ${fmtInt(t.n.atRisk)} prices${similar} still at their price at this age (${fmtInt(t.n.states)} prices of ${fmtInt(t.n.copies)} ${t.n.copies === 1 ? 'item' : 'items'}): ` +
    `within ${timingDurText(t.horizonMs)} ${pct(t.pDrop)} dropped, ${pct((t.pGone ?? 0) + (t.pRise ?? 0))} went or rose first${end}. ${ranges ? `${ranges} ` : ''}From your save ${fmtAgo(Math.min(t.lastSeenAt, now), now)}.`
  );
}

/** T9-3b: the drop size the Wait check's low end took, as whole percents (", at a drop of 6 %"), or '' when it has none. */
function gateDropText(u: ScraptfBuyTiming['uncertainty']): string {
  const d = u?.dropLow;
  if (!finite(d) || d <= 0) return '';
  return `, at a drop of ${d < 0.005 ? 'under 1' : Math.round(d * 100)} %`;
}

/**
 * The money line: the expected profit of waiting against buying now, both through flipProfit (scraptfTimingEv).
 * 0.9 (#10): when the Wait check ran (`uncertainty.gainLowScrap`), the gain's low end for the picked wait taken alone
 * (and the drop size it took, T9-3b); never a claim of 95 % over the pick.
 */
function moneyLine(t: ScraptfBuyTiming, keyScrap: Scrap | null): string | null {
  if (!finite(t.horizonMs) || !finite(t.evWaitScrap) || !finite(t.evBuyScrap)) return null;
  const sells = finite(t.revenueScrap) ? `Sells for ${fmtMoney(t.revenueScrap, keyScrap)}` : null;
  const pay = finite(t.maxCostScrap) ? `Pay up to ${fmtMoney(t.maxCostScrap, keyScrap)}` : null;
  const ctx = [sells, pay].filter(Boolean).join(', ');
  const g = t.uncertainty?.gainLowScrap;
  const drop = gateDropText(t.uncertainty);
  const low = !finite(g)
    ? ''
    : g >= 1
      ? `; allowing for chance in the odds, waiting adds at least ${fmtSignedMoney(g, keyScrap)} (the low end for the wait your saves picked, taken alone${drop})`
      : `; allowing for chance in the odds, waiting may add nothing (low end ${fmtSignedMoney(g, keyScrap)} for the wait your saves picked${drop})`;
  return `Wait ${timingDurText(t.horizonMs)}: expected ${fmtSignedMoney(t.evWaitScrap, keyScrap)} vs ${fmtSignedMoney(t.evBuyScrap, keyScrap)} now${ctx ? ` (${ctx})` : ''}${low}`;
}

/**
 * 0.8 (T5): the drawer's buy-timing block: a pill ('Wait ~1 d' warn, 'Buy now' good, 'Over Pay up to' bad, 'No buyers'
 * and 'Not enough data' muted), its lines (the run's drops and rhythm, the odds with n.atRisk as their denominator
 * and n.states / n.copies / n.atRiskEnd behind it, the expected profits (with the gain's low end, 0.9), whether the
 * verdict depends on save timing (0.9), the earlier runs' last prices, or why there is not enough data), each only
 * when its data exists, and TIMING_ESTIMATE_NOTE. Null without a timing. 0.9 (#10): the pill comes from timingBadge,
 * so a flagged one reads 'Wait ~1 d?' (muted).
 */
export function historyTimingView(
  t: ScraptfBuyTiming | null | undefined,
  h: Pick<ScraptfItemHistory, 'bank'>,
  keyScrap: Scrap | null,
  now: UnixMs,
): { pill: { text: string; tone: Tone; title: string }; lines: string[]; note: string } | null {
  if (!t) return null;
  const path = historyBankPath({ bank: t.bank ?? h.bank }) ?? 'scrap.tf';
  const badge = timingBadge(t, now);
  const why = timingWhyText(t.why, { path, n: t.n, lookGapMs: t.lookGapMs, lastSeenAt: t.lastSeenAt, now, scope: t.scope });
  const fixed = t.verdict === 'wait' || t.verdict === 'buy-now' ? null : VERDICT_PILLS[t.verdict];
  const pill = badge ?? { text: fixed!.text, tone: fixed!.tone, title: `${why}. From your save ${fmtAgo(Math.min(t.lastSeenAt, now), now)}; an estimate, not a forecast.` };
  const lines: string[] = [];
  // Without a verdict to explain, the reason comes first.
  if (t.verdict === 'not-enough-data' || t.verdict === 'no-buyers') lines.push(why);
  const drops = dropsLine(t, path, now);
  if (drops) lines.push(drops);
  const odds = oddsLine(t, path, now);
  if (odds) lines.push(odds);
  const money = moneyLine(t, keyScrap);
  if (money) lines.push(money);
  // 0.9 (#10): a verdict that turns with save timing says so, under the money.
  const saveTiming = timingSaveTimingText(t);
  if (saveTiming) lines.push(saveTiming);
  const ends = t.earlierRunEnds.filter((e) => finite(e.lastScrap)).map((e) => fmtMoney(e.lastScrap, keyScrap));
  if (ends.length) lines.push(`Earlier ${ends.length === 1 ? 'run' : 'runs'} ended at ${listText(ends)} (the lowest seen so far is not a floor)`);
  return { pill, lines, note: TIMING_ESTIMATE_NOTE };
}

const RUN_ENDS: Readonly<Record<NonNullable<ScraptfListingRun['endedAs']>, string>> = {
  absent: 'then gone from the page',
  'sold-out': 'then sold out',
  untradable: 'then turned untradable (the same item showed as not tradable)',
};

/**
 * 0.8 (LC-3): the drawer's listing runs, newest first: "Listed 3 times in your saves (back 2 times)" and one line per
 * run with its days, how long it was listed (bracketed by your saves: [lastOnSaleAt - firstOnSaleAt, endedAt -
 * startAfter]), its first and last price at today's key price (`h.keyPrice`, else `keyScrap`), its drops (a lower
 * bound) and how it ended, plus its qualifiers: already listed at the first save of its page, a flap (back within the
 * hour at the same price, not counted as gone), and, only while the bank's asset ids are stable, whether the same
 * item came back. Null without runs.
 */
export function historyRunLines(
  c: ScraptfItemCycles | null | undefined,
  h: Pick<ScraptfItemHistory, 'bank' | 'keyPrice'>,
  keyScrap: Scrap | null,
  now: UnixMs,
): { head: string; title: string; lines: { key: string; text: string; title: string; tone: Tone }[] } | null {
  if (!c || !Array.isArray(c.runs) || c.runs.length === 0) return null;
  const K = h.keyPrice?.valueScrap ?? keyScrap;
  const value = (raw: { keys: number; scrap: Scrap }): Scrap => valueScrap(raw.keys, raw.scrap, finite(K) && K > 0 ? K : 0);
  const path = historyBankPath(h) ?? 'scrap.tf';
  const total = finite(c.runsTotal) ? c.runsTotal : c.runs.length;
  const times = (n: number) => (n === 1 ? 'once' : `${fmtInt(n)} times`);
  const back = c.returns > 0 ? ` (back ${times(c.returns)})` : '';
  const lines = [...c.runs].reverse().map((r, idx) => {
    const open = r.endedAt === null;
    const stale = open && now - r.lastOnSaleAt > HISTORY_LAST_SEEN_STALE_MS;
    const listedFor = Math.max(0, r.lastOnSaleAt - r.firstOnSaleAt);
    let span: string;
    let days: string;
    if (open) {
      span = `${scraptfAgoText(listedFor)} so far`;
      days = `${fmtSaveDay(r.firstOnSaleAt)} → ${stale ? fmtSaveDay(r.lastOnSaleAt) : 'now'}`;
    } else {
      const upper = r.startAfter !== null ? Math.max(listedFor, r.endedAt! - r.startAfter) : null;
      span = upper !== null ? `${scraptfAgoText(listedFor)}–${scraptfAgoText(upper)}` : `at least ${scraptfAgoText(listedFor)}`;
      days = `${fmtSaveDay(r.firstOnSaleAt)} → ${fmtSaveDay(r.lastOnSaleAt)}`;
    }
    const from = value(r.startRaw);
    const to = value(r.endRaw);
    const prices = from === to ? `at ${fmtMoney(from, K)}` : `${fmtMoney(from, K)} → ${fmtMoney(to, K)}`;
    const drops = r.drops > 0 ? `${fmtInt(r.drops)} ${r.drops === 1 ? 'drop' : 'drops'}` : 'no drop';
    const ending = open
      ? stale
        ? 'listed in your newest save of its page'
        : 'listed now'
      : r.flap
        ? 'then back at the same price within the hour (a partial look, not counted as gone)'
        : r.endedAs
          ? RUN_ENDS[r.endedAs]
          : 'then off sale';
    const quals: string[] = [];
    if (r.startAfter === null) quals.push('already listed at your first save of its page');
    if (c.assetIdsStable && r.sameAssetAsBefore === true) quals.push('the same item came back');
    if (c.assetIdsStable && r.sameAssetAsBefore === false) quals.push('another copy (or the same one traded back)');
    if (r.family) quals.push('one scrap.tf/items row for every copy');
    const text = `${days} (${span}), ${prices}, ${drops}${open ? ' · ' : ', '}${ending}${quals.length ? ` · ${quals.join(' · ')}` : ''}`;
    const before = r.startAfter !== null ? ` Your save of its page before it, without it on sale: ${fmtDateTime(r.startAfter)}.` : '';
    const after = r.endedAt !== null ? ` The first save without it on sale: ${fmtDateTime(r.endedAt)}.` : '';
    return {
      key: `${r.firstOnSaleAt}-${idx}`,
      text,
      title: `On sale in ${fmtInt(r.saves)} of your saves of ${path}, from ${fmtDateTime(r.firstOnSaleAt)} to ${fmtDateTime(r.lastOnSaleAt)}.${before}${after} Prices at today's key price; drops are counted between saves (a lower bound).`,
      tone: (open ? 'info' : r.endedAs === 'untradable' ? 'warn' : 'muted') as Tone,
    };
  });
  return {
    head: `Listed ${times(total)} in your saves${back}`,
    title: `Each run is an unbroken stretch of your saves of ${path} listing it on sale; how long it lasted is bracketed by your saves (from its last save on sale to the first without it). A return at the same price within the hour is the same listing, and 'gone from the page' can be a sale, a reservation or a move.${total > c.runs.length ? ` The newest ${fmtInt(c.runs.length)} of ${fmtInt(total)} runs are listed.` : ''}`,
    lines,
  };
}

// ---------------------------------------------------------------------------
// The step chart: one point per save, a gap where it was not on sale
// ---------------------------------------------------------------------------

/** One save: the price valued now, or null where the save did not list it on sale. */
export interface StepPoint {
  at: UnixMs;
  value: Scrap | null;
}

export interface StepBox {
  w: number;
  h: number;
  padX: number;
  padY: number;
}

/** The chart's viewBox and padding (the SVG stretches to the drawer's width). */
export const STEP_BOX: Readonly<StepBox> = Object.freeze({ w: 360, h: 90, padX: 6, padY: 10 });

export interface StepGeom {
  /** The step line (the price held until the next save), broken where a save did not list it on sale. */
  path: string;
  /** Each save that listed it on sale. */
  dots: { x: number; y: number; i: number }[];
  /** Each save that covered it without it on sale: a tick on the baseline. */
  gaps: { x: number; i: number }[];
  /** x of every point, for the hover. */
  xs: number[];
  lo: Scrap;
  hi: Scrap;
  t0: UnixMs;
  t1: UnixMs;
  /**
   * 0.8 (T5): the dots of the saves that showed a lower price after a reprice-down (marks.downAts), each drawn with a
   * tick under it. Present only when stepChartGeom was given `marks.downAts` ([] when none matches), so a chart without
   * marks has exactly 0.7.4's geometry.
   */
  downs?: { x: number; y: number; i: number }[];
}

/** ScraptfItemHistory.points as the chart reads them: the cost only where listed (it is 0 otherwise). */
export function historySeries(points: readonly ScraptfHistoryPoint[]): StepPoint[] {
  return [...points].filter((p) => finite(p.at)).sort((a, b) => a.at - b.at).map((p) => ({ at: p.at, value: p.listed && finite(p.costScrap) ? p.costScrap : null }));
}

const r1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/**
 * Geometry of the step chart over `points` (oldest first): a horizontal step from each listed save to
 * the next one when that one is listed too, then a vertical to its price; nothing across a gap. Null
 * when no save listed it on sale. 0.8 (T5): `marks.downAts` (ScraptfItemCycles.dropAts) adds `downs`, the
 * dots of those saves; without it the result has no `downs` key.
 */
export function stepChartGeom(points: readonly StepPoint[], box: StepBox = STEP_BOX, marks: { downAts?: readonly UnixMs[] } = {}): StepGeom | null {
  const pts = [...points].filter((p) => finite(p.at)).sort((a, b) => a.at - b.at);
  const vals = pts.map((p) => p.value).filter((v): v is number => finite(v));
  if (vals.length === 0) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  // A flat price sits mid-chart rather than on an edge.
  const flat = hi === lo;
  const yLo = flat ? lo - 1 : lo;
  const yHi = flat ? hi + 1 : hi;
  const t0 = pts[0]!.at;
  const t1 = pts[pts.length - 1]!.at;
  const span = t1 - t0;
  const innerW = box.w - 2 * box.padX;
  const innerH = box.h - 2 * box.padY;
  const x = (t: number): number => (span > 0 ? box.padX + ((t - t0) / span) * innerW : box.w / 2);
  const y = (v: number): number => box.padY + (1 - (v - yLo) / (yHi - yLo)) * innerH;
  let d = '';
  const dots: StepGeom['dots'] = [];
  const gaps: StepGeom['gaps'] = [];
  const xs = pts.map((p) => x(p.at));
  pts.forEach((p, i) => {
    if (!finite(p.value)) {
      gaps.push({ x: xs[i]!, i });
      return;
    }
    const py = y(p.value);
    dots.push({ x: xs[i]!, y: py, i });
    const prev = pts[i - 1];
    // The pen arrives here along the previous step's horizontal: drop (or rise) to this price.
    d += prev && finite(prev.value) ? `V${r1(py)}` : `M${r1(xs[i]!)},${r1(py)}`;
    const next = pts[i + 1];
    if (next && finite(next.value)) d += `H${r1(xs[i + 1]!)}`;
  });
  if (!Array.isArray(marks.downAts)) return { path: d, dots, gaps, xs, lo, hi, t0, t1 };
  const downAt = new Set(marks.downAts);
  const downs = dots.filter((p) => downAt.has(pts[p.i]!.at));
  return { path: d, dots, gaps, xs, lo, hi, t0, t1, downs };
}

/** The point nearest to `fx` (a viewBox x), for the hover. */
export function nearestStep(xs: readonly number[], fx: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  xs.forEach((x, i) => {
    const dist = Math.abs(x - fx);
    if (dist < bestD) {
      bestD = dist;
      best = i;
    }
  });
  return best;
}

/** The readout over the chart: "Oct 14 09:12 · 1.33 ref · 3 in stock" or "Oct 14 09:12 · not on sale". */
export function historyReadout(p: ScraptfHistoryPoint | undefined, keyScrap: Scrap | null): string {
  if (!p) return '';
  const when = fmtSaveTime(p.at);
  if (!p.listed) return `${when} · ${p.stock === 0 ? 'sold out' : 'not on sale'}`;
  return `${when} · ${fmtMoney(p.costScrap, keyScrap)}${finite(p.stock) ? ` · ${fmtInt(p.stock)} in stock` : ''}`;
}

/** The chart's accessible name: the span of saves and the price range. */
export function historyChartLabel(g: StepGeom, saves: number, keyScrap: Scrap | null): string {
  const range = g.lo === g.hi ? `at ${fmtMoney(g.lo, keyScrap)}` : `between ${fmtMoney(g.lo, keyScrap)} and ${fmtMoney(g.hi, keyScrap)}`;
  return `scrap.tf price in ${fmtInt(saves)} ${saves === 1 ? 'save' : 'saves'} from ${fmtDateTime(g.t0)} to ${fmtDateTime(g.t1)}, ${range}; gaps where a save did not list it on sale`;
}

// ---------------------------------------------------------------------------
// Change events, empty state
// ---------------------------------------------------------------------------

export interface HistoryEventLine {
  id: number;
  /** "Oct 14 09:12" */
  when: string;
  whenTitle: string;
  kind: string;
  tone: Tone;
  kindTitle: string;
  /** "1.33 → 1.22 ref (−8 %), stock 5 → 3". */
  text: string;
  priceTone: Tone;
  priceTitle: string;
  /** The bank's SCRAPTF_BANKS label when the change was on another bank than the chart's (the /items list, say); else null. */
  bank: string | null;
}

/**
 * DM-6: the copy's events split into price changes (new, restocked, cheaper, pricier, gone) and stock moves
 * (same price, another count), each newest first as sent, so a run of stock moves never buries a price drop.
 */
export function historyEventGroups(events: readonly ScraptfChangeEvent[]): { price: ScraptfChangeEvent[]; stock: ScraptfChangeEvent[] } {
  const price: ScraptfChangeEvent[] = [];
  const stock: ScraptfChangeEvent[] = [];
  for (const e of Array.isArray(events) ? events : []) (e.kind === 'stock' ? stock : price).push(e);
  return { price, stock };
}

/**
 * The copy's change events (newest first, as the service sends them), at most `max`. They cover every
 * bank that listed the copy, while the chart reads one (`chartBank`): a line from another bank names it.
 */
export function historyEventLines(
  events: readonly ScraptfChangeEvent[],
  keyScrap: Scrap | null,
  now: UnixMs,
  max: number = HISTORY_EVENTS_SHOWN,
  chartBank: ScraptfBank | null = null,
): HistoryEventLine[] {
  return [...events]
    .sort((a, b) => b.id - a.id)
    .slice(0, Math.max(0, max))
    .map((e) => {
      const price = changePriceText(e, keyScrap);
      const stock = changeStockText(e);
      const info = scraptfBankInfo(e.bank);
      const path = info ? bankStockPagePath(info.url) : e.bank;
      return {
        id: e.id,
        when: fmtSaveTime(e.at),
        whenTitle: `Your save of ${path}, ${fmtDateTime(e.at)} (${fmtAgo(Math.min(e.at, now), now)}), against your previous save of that page.`,
        kind: CHANGE_KIND_LABELS[e.kind] ?? e.kind,
        tone: CHANGE_KIND_TONES[e.kind] ?? 'muted',
        kindTitle: CHANGE_KIND_HELP[e.kind] ?? '',
        text: [price.text !== DASH ? price.text : null, stock].filter(Boolean).join(', ') || DASH,
        priceTone: price.tone,
        priceTitle: price.title,
        bank: chartBank !== null && e.bank !== chartBank ? (info?.label ?? e.bank) : null,
      };
    });
}

/** Why there is no history to show, or a note about a short one; null when the chart says it all. */
export function historyNote(h: Pick<ScraptfItemHistory, 'bank' | 'points'> | null | undefined): { title: string; body: string } | null {
  if (!h || h.bank === null) {
    return {
      title: 'Not in your saved scrap.tf pages yet',
      body: `Its scrap.tf price history starts with your first save of a bank page that lists it (Ctrl+S into your watch folder, or a read in the Flip Desk window); every later save adds a point. ${SCRAPTF_BOUNDARY_SHORT}`,
    };
  }
  if (h.points.length <= 1) {
    return { title: 'One save so far', body: 'Save the page again later to see its price over time and what changed.' };
  }
  return null;
}
