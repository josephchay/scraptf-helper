// Confidence score 0–100 (design brief §5.7). Every adjustment adds a reason of
// the form "<signed delta> <plain English>", which the dashboard renders.

import { ORDER_CONFIRMED_MS, orderSeenRecently } from '../../shared/buyerSeen';
import { costSanity, costSanityReason } from '../../shared/ceiling';
import { formatScrap } from '../../shared/currency';
import type { ConfidenceLevel, InputKind, ProfitSettings, ReferencePrices, Scrap, UnixMs } from '../../shared/types';
import { UNVERIFIED_AFTER_MS } from './matcher';
import { hasReferenceValue, isUnverifiedOrder, usableReferences } from './pricing';
import type { ValuedOrderLike } from './pricing';
import { LOW_CAP, MEDIUM_CAP, confidenceLevel } from './tiers';

export const BASE_SCORE = 50;
/** Bot considered active when its userAgent pulsed within this window. */
export const BOT_PULSE_MS = 30 * 60 * 1000;
/** Order counts as recently confirmed (event or snapshot) within this window (shared with the renderer's online lines). */
export const CONFIRMED_MS = ORDER_CONFIRMED_MS;
/** scrap.tf price counts as fresh within this window. */
export const FRESH_INPUT_MS = 15 * 60 * 1000;
/** With this many eligible orders the median outlier rule can sanity-check the price, so the suspect-margin guard stays off. */
export const SUSPECT_MIN_ORDERS = 3;
const DEFAULT_INPUT_STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SUSPECT_MARGIN = 2;

export interface ConfidenceInput {
  /** The order the profit is based on (the conservative order by default). */
  order: (ValuedOrderLike & { flags?: readonly string[] }) | null;
  /** All eligible orders, for the "distinct buyers within 10%" check. */
  eligible: readonly ValuedOrderLike[];
  /** As stored on the opportunity; stale ones are ignored here (profit.referenceMaxAgeMs). */
  references: ReferencePrices;
  inputKind: InputKind;
  inputObservedAt: UnixMs;
  isUnusual: boolean;
  revenueScrap: Scrap | null;
  /**
   * profit / cost (Infinity for a free item with a positive profit), for the
   * suspect-margin guard; omitted or null skips the guard.
   */
  margin?: number | null;
  /**
   * 0.7.4 (F22, F70): the scrap.tf cost in scrap, for the cost checks against PriceDB (costSanity);
   * omitted or null skips them (the Live market's buy side has no cost).
   */
  costScrap?: Scrap | null;
  /**
   * 0.7.4 (F70): the item's craftability twin (5040;6 for 5040;6;uncraftable and the other way round):
   * its craftability and its references, read only when the cost is far under this item's PriceDB band.
   */
  twin?: { craftable: boolean; references(): ReferencePrices | null } | null;
  keyScrap: Scrap;
  now: UnixMs;
  profit: Pick<ProfitSettings, 'inputStaleMs' | 'unusualRiskKeys' | 'referenceMaxAgeMs' | 'suspectMargin'>;
}

export interface ConfidenceResult {
  score: number;
  level: ConfidenceLevel;
  reasons: string[];
  /** Opportunity flags raised while scoring, e.g. 'no-reference', 'stale-input'. */
  flags: string[];
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return Number.isInteger(h) ? `${h} h` : `${Math.round(ms / 60_000)} min`;
}

export function scoreConfidence(input: ConfidenceInput): ConfidenceResult {
  const { order, now } = input;
  const reasons: string[] = [];
  const flags: string[] = [];
  let score = BASE_SCORE;
  const add = (delta: number, why: string): void => {
    score += delta;
    reasons.push(`${signed(delta)} ${why}`);
  };
  const flag = (f: string): void => {
    if (!flags.includes(f)) flags.push(f);
  };

  // F4: stale references count as absent for the adjustments below and for the suspect-margin guard.
  const usable = usableReferences(input.references, input.profit.referenceMaxAgeMs, now);
  const refs = usable.references;
  if (usable.stale.length > 0) flag('stale-reference');

  let unverified = false;
  if (order === null) {
    reasons.push('No usable buy order');
    reasons.push(...usable.stale);
  } else {
    const l = order.listing;
    const pulse = typeof l.uaLastPulse === 'number' && Number.isFinite(l.uaLastPulse) ? l.uaLastPulse * 1000 : null;
    if (l.isBot && pulse !== null && now - pulse <= BOT_PULSE_MS) add(20, 'Buyer is a bot that was active in the last 30 min');
    // 0.7.4 (F23): the online flag is as old as the order's last event, so it counts only while that is recent.
    if (l.userOnline === true && orderSeenRecently(l.lastEventAt, now)) add(5, 'Buyer is online');

    const age = now - l.lastEventAt;
    if (age <= CONFIRMED_MS) add(10, 'Order confirmed by the live feed or a snapshot in the last 2 h');
    else if (age > UNVERIFIED_AFTER_MS) {
      add(-15, 'Order not confirmed for over 24 h');
      flag('unverified-orders');
      unverified = true;
    }

    // 0.7.4 (F29): only verified orders count as buyers near this price (a neighbour nobody has confirmed
    // for a day is as doubtful as the order), the order itself always. F19: never around a zero price
    // ("0.05 ref" orders round to 0 scrap), and zero-valued orders are no buyers near anything.
    const v = order.valueScrap;
    const doubtful = (o: ValuedOrderLike): boolean => isUnverifiedOrder(o) || !(now - o.listing.lastEventAt <= UNVERIFIED_AFTER_MS);
    if (v > 0) {
      const near = new Set<string>();
      for (const o of input.eligible) {
        if (!(o.valueScrap > 0) || (o.listing.id !== l.id && doubtful(o))) continue;
        if (o.valueScrap >= v * 0.9 && o.valueScrap <= v * 1.1) near.add(o.listing.steamid || o.listing.id);
      }
      if (near.size >= 2) add(10, `${near.size} buyers within 10% of this price`);
    }

    const pdbBuy = positive(refs.pricedb?.buyScrap);
    const comm = positive(refs.community?.valueScrap);
    reasons.push(...usable.stale);
    if (pdbBuy === null && comm === null) {
      add(-10, usable.stale.length > 0 ? 'No recent PriceDB or community price to compare with' : 'No PriceDB or community price to compare with');
      flag('no-reference');
    } else {
      const over = [pdbBuy !== null && v > 1.5 * pdbBuy ? 'PriceDB buy price' : null, comm !== null && v > 1.5 * comm ? 'backpack.tf community price' : null].filter(
        (s): s is string => s !== null,
      );
      const agrees = [
        pdbBuy !== null && v >= 0.8 * pdbBuy && v <= 1.2 * pdbBuy ? 'PriceDB buy price' : null,
        comm !== null && v >= 0.8 * comm && v <= 1.2 * comm ? 'backpack.tf community price' : null,
      ].filter((s): s is string => s !== null);
      // Agreeing with one reference does not cancel being far above the other.
      if (over.length > 0) add(-20, `Price is over 1.5x the ${over.join(' and the ')}`);
      else if (agrees.length > 0) add(10, `Price agrees with the ${agrees[0]} (0.8-1.2x)`);
    }

    const of = order.flags ?? [];
    if (of.includes('notes-flag')) {
      add(-10, "Buyer's note mentions paint, spells, parts, dupes or 'only'");
      flag('notes-flag');
    } else if (of.includes('has-extras')) {
      add(-10, 'Your copy has extras but this order is generic: you may be underselling');
    }
    if (of.includes('has-extras')) flag('has-extras');
  }

  const staleMs = Number.isFinite(input.profit.inputStaleMs) && input.profit.inputStaleMs > 0 ? input.profit.inputStaleMs : DEFAULT_INPUT_STALE_MS;
  if (input.inputKind === 'rule') {
    add(-25, 'Cost is a price-sheet rule estimate, not a price seen for this item');
    flag('rule-estimate');
  } else {
    const inputAge = now - input.inputObservedAt;
    if (inputAge <= FRESH_INPUT_MS) reasons.push('0 scrap.tf price is fresh (under 15 min)');
    else if (inputAge <= staleMs) add(-10, `scrap.tf price is between 15 min and ${hours(staleMs)} old`);
    else {
      add(-25, `scrap.tf price is over ${hours(staleMs)} old`);
      flag('stale-input');
    }
  }

  const riskKeys = Number.isFinite(input.profit.unusualRiskKeys) && input.profit.unusualRiskKeys > 0 ? input.profit.unusualRiskKeys : 10;
  if (input.isUnusual && input.revenueScrap !== null && input.keyScrap > 0 && input.revenueScrap > riskKeys * input.keyScrap) {
    add(-15, `Unusual worth over ${riskKeys} keys: get a background check (price manipulation, reversed trades)`);
    flag('unusual-risk');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  // Brief §8: rule estimates are capped at Medium; §2.1: unverified orders are never High.
  if (input.inputKind === 'rule' && score > MEDIUM_CAP) {
    score = MEDIUM_CAP;
    reasons.push('Capped at Medium: rule estimates are never High');
  } else if (unverified && score > MEDIUM_CAP) {
    score = MEDIUM_CAP;
    reasons.push('Capped at Medium: the order is unverified');
  }

  // F5: with few orders and no usable reference nothing checks the price, and a huge
  // margin is then most likely a unit or variant mix-up. Kept visible, never notified.
  if (isSuspectMargin(input.margin, input.eligible.length, hasReferenceValue(refs), input.profit.suspectMargin)) {
    flag('suspect-margin');
    score = Math.min(score, LOW_CAP);
    reasons.push(`Margin over ${Math.round(suspectMarginOf(input.profit.suspectMargin) * 100)}% with no reference and few buyers. Check the variant and units`);
  }

  // 0.7.4 (F22, F70): the references above check the buy order, nothing checked the cost. scrap.tf charging
  // well under what bots pay for this exact item is implausible: usually the price of another copy
  // (Non-Craftable, another quality or kit tier) stored under this SKU. PriceDB only, age-gated like every
  // reference (the twin too); rule estimates are cheap by design and skipped. Kept visible at Low, never notified.
  if (input.inputKind !== 'rule' && input.costScrap !== null && input.costScrap !== undefined) {
    const twin = input.twin ?? null;
    const twinPricedb = () => {
      const t = twin?.references() ?? null;
      return t ? usableReferences(t, input.profit.referenceMaxAgeMs, now).references.pricedb : null;
    };
    const sanity = costSanity(input.costScrap, refs.pricedb, twinPricedb);
    if (sanity) {
      flag(sanity.flag);
      score = Math.min(score, LOW_CAP);
      reasons.push(costSanityReason(sanity, twin?.craftable === true, (v) => formatScrap(v, input.keyScrap > 0 ? input.keyScrap : null)));
    }
  }
  return { score, level: confidenceLevel(score), reasons, flags };
}

/**
 * F5's suspect-margin rule: a margin above profit.suspectMargin (Infinity for a free item with a
 * profit) with fewer than SUSPECT_MIN_ORDERS eligible orders and no usable reference. Shared with the
 * "New on scrap.tf" notifications (F17), which read the Live market entry instead of an opportunity.
 */
export function isSuspectMargin(margin: number | null | undefined, eligibleCount: number, referenced: boolean, suspectMargin: number | undefined): boolean {
  const suspect = suspectMarginOf(suspectMargin);
  return suspect > 0 && typeof margin === 'number' && !Number.isNaN(margin) && margin > suspect && eligibleCount < SUSPECT_MIN_ORDERS && !referenced;
}

/** 0 turns the guard off; a missing or broken value uses the default (200%). */
function suspectMarginOf(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return DEFAULT_SUSPECT_MARGIN;
  return v;
}

function positive(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
