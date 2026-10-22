// Pure helpers for the buy-timing verdict (0.8, T3-T7, LC-5): the Wait / Buy now tag beside an item's name on the
// bank stock page, the Live market and Opportunities, the sentence appended to a bank stock row's Verdict title, the
// not-enough-data reasons the item drawer shares, and Health's asset-id stability lines. The verdict comes from
// shared/scraptfTiming.ts over the user's own saves (R10), so every text says it is an estimate from those saves,
// quotes each percentage with its own denominator and the save it rests on, and never forecasts a price, a time or
// a fill. Nothing here loads scrap.tf (R1) or builds a URL.
// 0.9 (#10): the odds carry their 90 % ranges with the items behind them, a verdict that turns with save timing says
// so (and its tag ends in '?'), and 'unsure-gain' says waiting looked worth more but may add nothing.

import { BANK_STOCK_SESSION_GAP_MS, bankStockPagePath } from '../shared/bankStock';
import { copyExtrasWords } from '../shared/copyExtras';
import { scraptfBankInfo } from '../shared/links';
import { SCRAPTF_ASSET_STABLE_MIN_PAIRS, SCRAPTF_ASSET_STABLE_SHARE, scraptfAgoText } from '../shared/scraptfHistory';
import {
  SCRAPTF_TIMING_MIN_AT_RISK,
  SCRAPTF_TIMING_MIN_AT_RISK_END,
  SCRAPTF_TIMING_MIN_COPIES,
  SCRAPTF_TIMING_MIN_DROPS,
  SCRAPTF_TIMING_MIN_ENDED,
  SCRAPTF_TIMING_RANGE_PCT,
} from '../shared/scraptfTiming';
import type {
  Scrap,
  ScraptfAssetIdsHealth,
  ScraptfBank,
  ScraptfBuyTiming,
  ScraptfSaveTimingAlt,
  ScraptfShareRange,
  ScraptfTimingBrief,
  ScraptfTimingUncertainty,
  ScraptfTimingWhy,
  UnixMs,
} from '../shared/types';
import { DASH, PAINT_NAMES, fmtAge, fmtAgo, fmtInt, fmtMoney, paintHex, type Tone } from './format';
import { CHECKOUT_GUARD_TAG } from '../shared/checkoutGuard';

/**
 * Under every timing figure: what the estimate rests on and what it cannot see (E.1-3, E.1-4). 0.9 (#10): what the
 * ranges allow for and what not, and that the Wait check's low end is for the picked wait taken alone, with the drop
 * size at its own low end (T9-3b).
 */
export const TIMING_ESTIMATE_NOTE =
  "An estimate from your saves, not a forecast: each step is dated at the save that showed it, several drops between two saves read as one, and 'gone' can be a sale, a reservation or a move. scrap.tf's own repricing rule is unknown. Ranges allow for chance between the items in your saves, not for when you happened to save or for scrap.tf changing its prices. The Wait check's low end is for the wait your saves picked, taken alone (that wait is the best of up to four, so it is less sure than it reads), and it takes the size of a drop at its low end too, from the drops seen between saves close together when there are enough.";

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A share as whole percents, "35 %" (the house's spaced percent). */
function pctText(p: number): string {
  return `${Math.round(Math.max(0, Math.min(1, p)) * 100)} %`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** "scrap.tf/buy/hats" for a bank, from SCRAPTF_BANKS; "scrap.tf" for anything else. */
function pathOf(bank: ScraptfBank | null | undefined): string {
  const info = scraptfBankInfo(bank ?? null);
  return info ? bankStockPagePath(info.url) : 'scrap.tf';
}

/** A horizon or a gap as its leading unit: '6 h', '1 d', '3 d', '7 d' (scraptfAgoText, trimmed); a dash-free '0 m' at worst. */
export function timingDurText(ms: number): string {
  return scraptfAgoText(ms).split(' ').slice(0, 2).join(' ');
}

/** The copy a timing read (its key is `${sku}|${specialKey}`): "Copy read: Team Shine, Fire Horns", or the plain copy. */
function copyReadText(key: string): string {
  const at = typeof key === 'string' ? key.indexOf('|') : -1;
  const words = at >= 0 ? copyExtrasWords(key.slice(at + 1), (paint) => PAINT_NAMES[paint] ?? `Paint ${paintHex(paint)}`) : [];
  return `Copy read: ${words.length ? words.join(', ') : 'the plain copy'}.`;
}

/** " of similar value" when the pool is the copy's value band (its n are of that band, not the whole page). */
function similarText(scope: 'band' | 'bank' | null | undefined): string {
  return scope === 'band' ? ' of similar value' : '';
}

/**
 * The odds sentence: each percentage over its own denominator (the prices still at their price at the copy's age,
 * n.atRisk), then the prices and items the table rests on (n.states, n.copies); never a bare n. A band's counts say
 * "of similar value", as the drawer's odds line does.
 */
function oddsText(t: ScraptfTimingBrief, path: string): string | null {
  if (!finite(t.horizonMs) || !finite(t.pDrop)) return null;
  const goneOrRose = (t.pGone ?? 0) + (t.pRise ?? 0);
  return `Of the ${plural(t.n.atRisk, 'price')}${similarText(t.scope)} on ${path} still at their price at this age (from ${plural(t.n.states, 'price')} of ${plural(t.n.copies, 'item')} in your saves), ${pctText(t.pDrop)} dropped within ${timingDurText(t.horizonMs)} and ${pctText(goneOrRose)} went or rose first.`;
}

/** 0.9 (#10): a range as whole percents, rounded outward (never narrower than computed): "48-86 %", or "50 %". */
export function timingRangeText(r: ScraptfShareRange): string {
  const lo = Math.floor(Math.max(0, Math.min(1, r.low)) * 100 + 1e-9);
  const hi = Math.ceil(Math.max(0, Math.min(1, r.high)) * 100 - 1e-9);
  return lo >= hi ? `${lo} %` : `${lo}-${hi} %`;
}

/**
 * 0.9 (#10): the ranges sentence, with the items behind them (the jackknife counts items, not prices); null without
 * uncertainty. "Allowing for chance across the 13 items behind these (a 90 % range): 48-86 % dropped, 3-28 % went or rose first."
 */
export function timingRangesText(t: { uncertainty?: ScraptfTimingUncertainty | null }): string | null {
  const u = t.uncertainty;
  if (!u || !(u.copies > 0)) return null;
  return `Allowing for chance across the ${plural(u.copies, 'item')} behind these (a ${SCRAPTF_TIMING_RANGE_PCT} % range): ${timingRangeText(u.pDrop)} dropped, ${timingRangeText(u.pGoneOrRose)} went or rose first.`;
}

/** 0.9 (#10): what the other placement's decision would suggest, in the save-timing sentence's words. */
const SAVE_TIMING_ALT: Readonly<Record<ScraptfSaveTimingAlt['verdict'], (H: string | null) => string>> = {
  wait: (H) => `waiting${H ? ` about ${H}` : ''}`,
  'buy-now': () => 'buying now',
  over: () => 'not buying (over Pay up to)',
};

/**
 * 0.9 (#10): the save-timing sentence, or null when the verdict does not depend on it (no `saveTiming`). It names the
 * decision the same rules give with every price change dated just after the save before it; it never changes the verdict.
 */
export function timingSaveTimingText(t: { saveTiming?: ScraptfSaveTimingAlt | null }): string | null {
  const s = t.saveTiming;
  if (!s || !Object.prototype.hasOwnProperty.call(SAVE_TIMING_ALT, s.verdict)) return null;
  const H = finite(s.horizonMs) ? timingDurText(s.horizonMs) : null;
  return `Depends on save timing: had each price change come just after your last save before it, not just before the save that showed it, your saves would suggest ${SAVE_TIMING_ALT[s.verdict](H)}.`;
}

/** "From your save 5 h ago; an estimate, not a forecast." (E.1-3: the save the estimate rests on.) */
function fromSaveText(t: Pick<ScraptfTimingBrief, 'lastSeenAt'>, now: UnixMs): string {
  return `From your save ${fmtAgo(Math.min(t.lastSeenAt, now), now)}; an estimate, not a forecast.`;
}

/** The verdict's lead sentence, for every verdict. */
function leadText(t: ScraptfTimingBrief, path: string): string {
  const H = finite(t.horizonMs) ? timingDurText(t.horizonMs) : null;
  switch (t.verdict) {
    case 'wait':
      return t.why === 'drop-makes-flip'
        ? `Your saves suggest waiting${H ? ` about ${H}` : ''}: over Pay up to now, a typical drop would bring it under.`
        : `Your saves suggest waiting${H ? ` about ${H}` : ''}.`;
    case 'buy-now':
      // 0.9 (#10): waiting cleared the bar on the estimate but not at the gain's low end.
      if (t.why === 'unsure-gain') return `Your saves suggest buying now: waiting${H ? ` ${H}` : ''} looked worth more, but allowing for chance it may add nothing.`;
      return t.why === 'gone-risk'
        ? `Your saves suggest buying now: prices like it on ${path} went or rose first at least as often as they dropped.`
        : `Your saves suggest buying now: waiting${H ? ` ${H}` : ''} is not expected to add enough to the profit.`;
    case 'over':
      return t.why === 'unsure-gain'
        ? 'Over Pay up to: a typical drop would bring it under, but allowing for chance waiting may add nothing.'
        : 'Over Pay up to: your saves show no drop likely enough to bring it under.';
    case 'no-buyers':
      return 'No backpack.tf buyer to judge the timing against.';
    case 'not-enough-data':
      return 'Not enough data to judge the timing.';
  }
}

/**
 * "Judged at 182 keys on scrap.tf/items, against Pay up to 183 keys 57.33 ref." The price the verdict rests on, for
 * a row that may show no scrap.tf price of the user's (the Live market's list-only rows); null without a key price
 * argument or a judged price.
 */
function judgedText(t: ScraptfTimingBrief, path: string, keyScrap: Scrap | null | undefined): string | null {
  if (keyScrap === undefined || !finite(t.costScrap)) return null;
  const against = finite(t.maxCostScrap) ? `, against Pay up to ${fmtMoney(t.maxCostScrap, keyScrap)}` : '';
  return `Judged at ${fmtMoney(t.costScrap, keyScrap)} on ${path}${against}.`;
}

/**
 * 0.8 (T6, T7): the tag beside an item's name (bank stock, Live market, Opportunities): 'Wait ~1 d' (warn) or
 * 'Buy now' (good), with a title quoting each percentage over its own denominator, the prices and items behind it,
 * the copy read and "from your save X ago". With `keyScrap` the title also names the scrap.tf price judged and the
 * Pay up to it was held against. Every other verdict gives null (the Verdict title says it).
 * 0.9 (#10): the ranges sentence after the odds, the save-timing sentence after it, and a '?' (muted) on a flagged
 * verdict ('Wait ~1 d?', 'Buy now?'); (#9) the checkout guard last on a Buy now.
 */
export function timingBadge(
  t: ScraptfTimingBrief | null | undefined,
  now: UnixMs,
  keyScrap?: Scrap | null,
): { text: string; tone: Tone; title: string } | null {
  if (!t || (t.verdict !== 'wait' && t.verdict !== 'buy-now')) return null;
  const path = pathOf(t.bank);
  const flagged = timingSaveTimingText(t) !== null;
  const base = t.verdict === 'wait' ? (finite(t.horizonMs) ? `Wait ~${timingDurText(t.horizonMs)}` : 'Wait') : 'Buy now';
  const odds = oddsText(t, path);
  return {
    // 0.9 (#10): a verdict that turns with save timing ends in '?' and is muted.
    text: flagged ? `${base}?` : base,
    tone: flagged ? 'muted' : t.verdict === 'wait' ? 'warn' : 'good',
    // 0.9 (#9): a Buy now tag suggests buying, so its title ends with the checkout guard (last; timing's ranges go before it).
    title: [
      leadText(t, path),
      judgedText(t, path, keyScrap),
      odds,
      timingRangesText(t),
      timingSaveTimingText(t),
      copyReadText(t.key),
      fromSaveText(t, now),
      t.verdict === 'buy-now' ? CHECKOUT_GUARD_TAG : null,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/**
 * 0.8 (T6, D23): the sentence appended to a bank stock row's Verdict title, for every verdict and every
 * not-enough-data reason, with the same denominators and "from your save X ago"; '' without a timing. 0.9 (#10): the
 * ranges and the save-timing sentences after the odds, when the timing has them.
 */
export function timingVerdictTitle(t: ScraptfTimingBrief | null | undefined, now: UnixMs): string {
  if (!t) return '';
  const path = pathOf(t.bank);
  if (t.verdict === 'not-enough-data') {
    const why = timingWhyText(t.why, { path, n: t.n, lookGapMs: null, lastSeenAt: t.lastSeenAt, now, scope: t.scope });
    return `Buy timing: not enough data. ${why ? `${why}.` : ''}`.trim();
  }
  if (t.verdict === 'no-buyers') return `Buy timing: ${leadText(t, path)}`;
  const odds = oddsText(t, path);
  return ['Buy timing:', leadText(t, path), odds, timingRangesText(t), timingSaveTimingText(t), fromSaveText(t, now)].filter(Boolean).join(' ');
}

/**
 * What timingWhyText reads: the bank's path, the n the timing carries (a row's brief has only four), the look gap,
 * and the pool's scope ('band': the n are of prices of similar value, and the text says so; absent: the whole bank).
 */
export interface TimingWhyContext {
  path: string;
  n: Partial<ScraptfBuyTiming['n']>;
  lookGapMs: number | null;
  lastSeenAt: UnixMs;
  now: UnixMs;
  scope?: 'band' | 'bank' | null;
}

/**
 * 0.8 (T3, E.1-2): why the verdict is what it is, one phrase per why code, shared by the Verdict title and the
 * drawer. The seven not-enough-data codes each say what is missing and how to get it (keep saving, look more
 * often, save the page again); a count the context lacks (a row's brief) is worded without a number.
 */
export function timingWhyText(why: ScraptfTimingWhy, ctx: TimingWhyContext): string {
  const { path, n } = ctx;
  // A band's counts are of prices of similar value, never the whole page's.
  const similar = similarText(ctx.scope);
  switch (why) {
    case 'few-drops': {
      const need = `${SCRAPTF_TIMING_MIN_DROPS} drops from ${SCRAPTF_TIMING_MIN_COPIES} items needed`;
      const items = finite(n.dropCopies) ? plural(n.dropCopies, 'item') : null;
      if (finite(n.drops) && n.drops >= SCRAPTF_TIMING_MIN_DROPS) {
        return `${plural(n.drops, 'price drop')}${similar} in your saves of ${path} so far, but from only ${items ?? 'a few items'} (${need}); keep saving it`;
      }
      if (finite(n.drops)) return `Only ${plural(n.drops, 'price drop')}${similar} in your saves of ${path} so far${items ? `, from ${items}` : ''} (${need}); keep saving it`;
      return `Too few price drops${similar} in your saves of ${path} so far${items ? `, from ${items}` : ''} (${need}); keep saving it`;
    }
    case 'few-ended':
      return finite(n.ended)
        ? `Only ${plural(n.ended, 'price')}${similar} in your saves of ${path} ended in a drop, going off sale or a rise so far (${SCRAPTF_TIMING_MIN_ENDED} needed)`
        : `Too few prices${similar} in your saves of ${path} ended in a drop, going off sale or a rise so far (${SCRAPTF_TIMING_MIN_ENDED} needed)`;
    case 'few-at-risk':
      // n.atRisk counts prices (states: one copy repriced three times is three), as the odds sentence does.
      return `Too few prices${similar} on ${path} stayed at their price this long in your saves (${finite(n.atRisk) ? `${fmtInt(n.atRisk)} of ${SCRAPTF_TIMING_MIN_AT_RISK}` : `${SCRAPTF_TIMING_MIN_AT_RISK} needed`})`;
    case 'left-censored':
      return 'It was already at this price in your first save of its page: how long it has been listed is unknown';
    case 'sparse-saves': {
      const looks = `saves within ${fmtAge(BANK_STOCK_SESSION_GAP_MS)} count as one look`;
      return finite(ctx.lookGapMs)
        ? `You look at its page about every ${timingDurText(ctx.lookGapMs)} (${looks}): too far apart to tell in time whether it dropped or went; look more often`
        : `Your looks at its page are too few or too far apart (${looks}) to tell in time whether it dropped or went; look more often`;
    }
    case 'past-data':
      return `Listed at this price longer than your saves of ${path} can follow (fewer than ${SCRAPTF_TIMING_MIN_AT_RISK_END} prices${similar} stayed listed that long)`;
    case 'stale-save':
      return `Your newest save of it is ${fmtAge(Math.max(0, ctx.now - ctx.lastSeenAt))} old; save the page again`;
    case 'drop-likely':
      return 'A drop within the wait was likely enough in your saves, and worth more than buying now';
    case 'drop-makes-flip':
      return 'Over Pay up to now; a typical drop in your saves would bring it under';
    case 'flip-now':
      return 'Waiting is not expected to add enough to the profit';
    case 'gone-risk':
      return 'Prices like it went or rose first at least as often as they dropped';
    case 'over':
      return 'Over Pay up to, and no drop likely enough to bring it under';
    // 0.9 (#10): the gain cleared the bar on the estimate but not at its low end (timing, Wave 2, produces it).
    case 'unsure-gain':
      return 'Waiting looked worth more on the estimate, but allowing for chance across the items in your saves it may add nothing; keep saving the page to settle it';
    case 'no-buyers':
      return 'No backpack.tf buyer to judge it against';
  }
}

/**
 * 0.8 (LC-5): Health's lines, one per saved bank: how often a single card kept its Steam item id between your looks
 * (good when the gate holds, warn when it does not, muted below SCRAPTF_ASSET_STABLE_MIN_PAIRS pairs). A pair is the
 * same single card on two looks of its page at least BANK_STOCK_SESSION_GAP_MS apart, so window reads within one
 * look never count. [] for an absent or empty list.
 */
export function assetIdsLines(list: readonly ScraptfAssetIdsHealth[] | undefined): { text: string; title: string; tone: Tone }[] {
  if (!Array.isArray(list)) return [];
  const gap = fmtAge(BANK_STOCK_SESSION_GAP_MS);
  const title = `A pair is the same single card (stock 1) on two looks of its page at least ${gap} apart; window reads within one look do not count. With at least ${Math.round(SCRAPTF_ASSET_STABLE_SHARE * 100)} % of ${SCRAPTF_ASSET_STABLE_MIN_PAIRS} or more pairs keeping their id, the item panel says when the same item came back or turned untradable; otherwise it never does.`;
  // Counted in pairs, never items: one card seen on five looks in a row is four pairs (the title defines a pair).
  return list.map((a) => {
    const label = scraptfBankInfo(a.bank)?.label ?? a.bank;
    if (!finite(a.pairs) || a.pairs < SCRAPTF_ASSET_STABLE_MIN_PAIRS) {
      return { text: `${label}: ${plural(finite(a.pairs) ? a.pairs : 0, 'pair')} so far (a single card on two looks in a row; ${SCRAPTF_ASSET_STABLE_MIN_PAIRS} needed)`, title, tone: 'muted' as Tone };
    }
    const share = finite(a.share) ? `${(a.share * 100).toFixed(1)} %` : DASH;
    const kept = `${label}: ${fmtInt(a.same)} of ${fmtInt(a.pairs)} pairs kept their item id between your looks (${share})`;
    return a.stable
      ? { text: `${kept}: used to tell when the same item comes back`, title, tone: 'good' as Tone }
      : { text: `${kept}: too unstable, so 'same item came back' is not shown`, title, tone: 'warn' as Tone };
  });
}
