// 0.9 (#2): break-even texts for every surface (Opportunities' Cost hover, the drawer's input card, Quick entry, the
// Live check popup, Holdings' Cost hover) and the drawer's Steam Market check (what you would receive, exact to the
// cent). Pure: no request, no loader, no opener (static.test.ts EXIT_FILES). Never a forecast.

import { breakEvensOf, type BreakEvenSettings } from '../shared/ceiling';
import { MANNCO_FEE_BPS, parseUsdCents, scmSellerNetCents, usdText } from '../shared/venues';
import type { BreakEvens, CheckResult, HoldingRow, Opportunity, Scrap } from '../shared/types';
import { DASH, fmtKeysMetal, fmtMoney, fmtPct, fmtRefOnly, ratioPctText } from './format';

/** "A", "A and B", "A, B and C" (as oppModel's private andList). */
function andList(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** 0.9 (#2): the sentence every break-even hover ends with: a price to clear, never a forecast. */
export const BREAK_EVEN_NOT_A_FORECAST = 'A price to clear, never a forecast that a buyer pays it.';

/** 0.9 (#2): "12.44 ref", the backpack.tf break-even; DASH without one. */
export function breakEvenText(b: BreakEvens | null | undefined, keyScrap: Scrap | null): string {
  return b ? fmtMoney(b.backpackScrap, keyScrap) : DASH;
}

/** 0.9 (#2): the other venues' sentence: each exit's value before its fee (value, never dollars: E-D2). */
export function venueBreakEvensText(b: BreakEvens, keyScrap: Scrap | null): string {
  return (
    `Before their fees, a sale must bring in at least ${fmtMoney(b.marketplaceScrap, keyScrap)} on marketplace.tf (your ${ratioPctText(b.marketplaceFeePct)} setting), ` +
    `${fmtMoney(b.manncoScrap, keyScrap)} on mannco.store (${MANNCO_FEE_BPS / 100}%) or ${fmtMoney(b.scmScrap, keyScrap)} in Steam Wallet funds on the Steam Market ` +
    '(5% Steam and 10% TF2; each fee is at least $0.01, so items under about $0.20 need more).'
  );
}

/**
 * 0.9 (#2): the break-even hover. 'buy': "Break-even 12.44 ref: the lowest backpack.tf sale price that loses nothing at
 * this cost (11.22 ref plus friction 0.11 ref and the 5% price-move reserve 0.66 ref). <venues> <not a forecast>".
 * 'sell': "... loses nothing on the oldest unit (it cost 11.22 ref plus friction 0.11 ref)...". `estimate`: a rule
 * row's note. Undefined without a break-even.
 */
export function breakEvenTitle(b: BreakEvens | null | undefined, keyScrap: Scrap | null, opts: { estimate?: boolean } = {}): string | undefined {
  if (!b) return undefined;
  // D7: destructured, never read as `.frictionScrap` (profitPath rule (1)), as oppModel reads ExitCosts.
  const { frictionScrap: friction, reserveScrap, reservePct } = b;
  const extras: string[] = [];
  if (friction > 0) extras.push(`friction ${fmtMoney(friction, keyScrap)}`);
  if (reserveScrap > 0) extras.push(`the ${ratioPctText(reservePct)} price-move reserve ${fmtMoney(reserveScrap, keyScrap)}`);
  const plus = extras.length > 0 ? ` plus ${andList(extras)}` : '';
  const at = fmtMoney(b.backpackScrap, keyScrap);
  const head =
    b.mode === 'sell'
      ? `Break-even ${at}: the lowest backpack.tf sale price that loses nothing on the oldest unit (it cost ${fmtMoney(b.costScrap, keyScrap)}${plus}).`
      : `Break-even ${at}: the lowest backpack.tf sale price that loses nothing at this cost (${fmtMoney(b.costScrap, keyScrap)}${plus}).`;
  const est = opts.estimate ? ' The cost is a rule estimate: check the real price on scrap.tf.' : '';
  return `${head}${est} ${venueBreakEvensText(b, keyScrap)} ${BREAK_EVEN_NOT_A_FORECAST}`;
}

/**
 * 0.9 (#2): Opportunities' Cost cell hover: "Entered as 1 key 1.33 ref (64.33 ref at the current key price)." when keyed,
 * then the 'buy' break-even (a rule row says its cost is an estimate). Undefined when neither applies.
 */
export function oppCostTitle(
  o: Pick<Opportunity, 'costScrap' | 'costKeys' | 'costScrapRaw' | 'inputKind'>,
  keyScrap: Scrap | null,
  p: BreakEvenSettings | null,
): string | undefined {
  const entered = o.costKeys ? `Entered as ${fmtKeysMetal(o.costKeys, o.costScrapRaw)} (${fmtRefOnly(o.costScrap)} at the current key price).` : null;
  const be = p ? breakEvenTitle(breakEvensOf(o.costScrap, p, 'buy'), keyScrap, { estimate: o.inputKind === 'rule' }) : undefined;
  const parts = [entered, be].filter((s): s is string => typeof s === 'string' && s !== '');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** 0.9 (#2): Holdings' Cost cell hover addition: the oldest unit's break-even ('sell': friction, never the reserve). */
export function holdingBreakEvenTitle(r: Pick<HoldingRow, 'nextLotCostScrap'>, keyScrap: Scrap | null, p: BreakEvenSettings | null): string | undefined {
  return p ? breakEvenTitle(breakEvensOf(r.nextLotCostScrap, p, 'sell'), keyScrap) : undefined;
}

/** 0.9 (#2): a Break-even line: the backpack.tf break-even and its hover. */
export interface BreakEvenView {
  scrap: Scrap;
  title: string;
}

/** 0.9 (#2): Quick entry's Break-even line for the typed cost ('buy'); null without a cost. */
export function quickBreakEvenView(costScrap: Scrap | null, p: BreakEvenSettings, keyScrap: Scrap | null): BreakEvenView | null {
  const b = costScrap === null ? null : breakEvensOf(costScrap, p, 'buy');
  return b ? { scrap: b.backpackScrap, title: breakEvenTitle(b, keyScrap)! } : null;
}

/** 0.9 (#2): the drawer input card's Break-even line ('buy'; a rule row says its cost is an estimate); null without a cost. */
export function inputBreakEvenView(o: Pick<Opportunity, 'costScrap' | 'inputKind'>, p: BreakEvenSettings, keyScrap: Scrap | null): BreakEvenView | null {
  const b = breakEvensOf(o.costScrap, p, 'buy');
  return b ? { scrap: b.backpackScrap, title: breakEvenTitle(b, keyScrap, { estimate: o.inputKind === 'rule' })! } : null;
}

/** 0.9 (#2): the Live check popup's break-even, beside the scrap.tf price. */
export interface CheckBreakEvenView {
  /** "break-even 1.88 ref". */
  text: string;
  title: string;
}

/** 0.9 (#2): the Live check popup's break-even (CheckResult.breakEven, valued at the result's key price); null without one. */
export function checkBreakEvenView(r: Pick<CheckResult, 'keyScrap'> & Partial<Pick<CheckResult, 'breakEven'>>): CheckBreakEvenView | null {
  const b = r.breakEven;
  if (!b) return null;
  const k = r.keyScrap ?? null;
  return { text: `break-even ${fmtMoney(b.backpackScrap, k)}`, title: breakEvenTitle(b, k)! };
}

/** 0.9 (#2): the drawer's Steam Market check: what the seller receives at the lowest and median price, exact to the cent. */
export interface ScmNetView {
  text: string;
  title: string;
}

/** 0.9 (#2): the SCM net line's hover: the cent rule, and that it reads the prices Steam showed, not a sale. */
export const SCM_NET_TITLE =
  'Steam keeps 5% and TF2 10% of what the seller gets, each rounded down to the cent and at least $0.01, so the cut is a larger share on cheap items. From the prices Steam showed, not a sale.';

/**
 * 0.9 (#2): "You get $1.93 of the $2.21 lowest (Steam and TF2 keep $0.28, 12.7%) and $1.98 of the $2.26 median, in Steam
 * Wallet funds, not cash." Only the readable prices of 3 cents or more (scmSellerNetCents); null when neither is.
 */
export function scmNetView(r: { lowest: string | null; median: string | null } | null | undefined): ScmNetView | null {
  const part = (label: 'lowest' | 'median', text: string | null | undefined) => {
    const paid = parseUsdCents(text);
    const net = paid === null ? null : scmSellerNetCents(paid);
    return paid === null || net === null ? null : { label, paid, net };
  };
  const lo = part('lowest', r?.lowest);
  const md = part('median', r?.median);
  const first = lo ?? md;
  if (!first) return null;
  const keep = first.paid - first.net;
  const head = `You get ${usdText(first.net)} of the ${usdText(first.paid)} ${first.label} (Steam and TF2 keep ${usdText(keep)}, ${fmtPct(keep / first.paid)})`;
  const tail = lo && md ? ` and ${usdText(md.net)} of the ${usdText(md.paid)} median` : '';
  return { text: `${head}${tail}, in Steam Wallet funds, not cash.`, title: SCM_NET_TITLE };
}
