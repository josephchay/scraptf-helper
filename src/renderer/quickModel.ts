// Pure helpers for the quick-entry window's live preview (feature F2) and its
// prefill (F8). Kept out of QuickEntry.tsx so the rules are unit-tested.

import { frictionOf, maxCostFor, type CeilingSettings } from '../shared/ceiling';
import type { ItemDetail, ItemRevenue, LinkSpec, OpportunityStatus, OrderSummary, ProfitSettings, Scrap } from '../shared/types';
import { fmtMoney } from './format';
import { statusFor } from './oppModel';

/** Quiet time after a pick before 'item.detail' runs, so arrowing through picks does not fire a request each. */
export const PREVIEW_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Stale-response guard
// ---------------------------------------------------------------------------

export interface LatestGate {
  /** Starts a request; the returned ticket is current until the next call or cancel(). */
  next(): number;
  isCurrent(ticket: number): boolean;
  /** Makes every outstanding ticket stale (item cleared, window reset). */
  cancel(): void;
}

/** Only the newest request may land: a slow answer for an earlier pick must not overwrite a later one. */
export function createLatestGate(): LatestGate {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (ticket) => ticket === current,
    cancel: () => {
      current++;
    },
  };
}

// ---------------------------------------------------------------------------
// Revenue and profit preview
// ---------------------------------------------------------------------------

export type PreviewSettings = CeilingSettings & Pick<ProfitSettings, 'useOrder'>;

function topBy(orders: readonly OrderSummary[], keep: (o: OrderSummary) => boolean): OrderSummary | null {
  let best: OrderSummary | null = null;
  for (const o of orders) if (keep(o) && (best === null || o.valueScrap > best.valueScrap)) best = o;
  return best;
}

/**
 * The revenue the preview prices against: the service's own (detail.revenue)
 * when it sent one. Otherwise the same picks the engine makes, read from the
 * book the service already classified (eligible, outlier flag): best is the top
 * eligible order, conservative the top non-outlier, instant the top non-outlier bot.
 */
export function previewRevenue(d: Pick<ItemDetail, 'revenue' | 'buyOrders'>, p: PreviewSettings): ItemRevenue {
  if (d.revenue) return d.revenue;
  const eligible = d.buyOrders.filter((o) => o.eligible);
  const best = topBy(eligible, () => true);
  const cons = topBy(eligible, (o) => !o.flags.includes('outlier'));
  const instant = topBy(eligible, (o) => o.isBot && !o.flags.includes('outlier'));
  const order = p.useOrder === 'best' ? best : p.useOrder === 'instant' ? instant : cons;
  const revenueScrap = order?.valueScrap ?? null;
  return {
    bestScrap: best?.valueScrap ?? null,
    consScrap: cons?.valueScrap ?? null,
    instantScrap: instant?.valueScrap ?? null,
    useOrder: p.useOrder,
    revenueScrap,
    order,
    maxCostScrap: maxCostFor(revenueScrap, p),
    eligibleCount: eligible.length,
  };
}

export interface ProfitPreview {
  costScrap: Scrap;
  /** revenue − cost − friction, as the engine computes it; null without revenue. */
  profitScrap: Scrap | null;
  /** profit / cost; null without revenue or for a free item (as the engine stores it). */
  margin: number | null;
  status: OpportunityStatus;
  /** cost ≤ Pay up to. False when there is revenue but no price clears the thresholds; null without revenue. */
  underCeiling: boolean | null;
  /** Pay up to − cost (negative when over); null without a ceiling. */
  headroomScrap: Scrap | null;
}

/** Live profit for a typed cost, computed locally with the engine's rules (friction, profitStatus). */
export function profitPreview(costScrap: Scrap, rev: Pick<ItemRevenue, 'revenueScrap' | 'maxCostScrap'> | null, p: CeilingSettings): ProfitPreview {
  const revenue = rev?.revenueScrap ?? null;
  const ceiling = rev?.maxCostScrap ?? null;
  const profitScrap = revenue === null ? null : revenue - costScrap - frictionOf(p);
  return {
    costScrap,
    profitScrap,
    margin: profitScrap === null || costScrap <= 0 ? null : profitScrap / costScrap,
    status: statusFor(profitScrap, costScrap, p),
    underCeiling: ceiling !== null ? costScrap <= ceiling : revenue === null ? null : false,
    headroomScrap: ceiling === null ? null : ceiling - costScrap,
  };
}

export type PreviewTone = 'good' | 'warn' | 'bad' | 'muted';

/** Green only when the price is at or under Pay up to (the spec's "mark it green"). */
export function previewTone(pv: Pick<ProfitPreview, 'status' | 'underCeiling'>): PreviewTone {
  if (pv.underCeiling === true) return 'good';
  if (pv.status === 'unprofitable') return 'bad';
  if (pv.status === 'no-buyers') return 'muted';
  return 'warn';
}

/** Short comparison with the ceiling, e.g. "0.22 ref under" or "1 key over". */
export function ceilingVerdict(pv: Pick<ProfitPreview, 'underCeiling' | 'headroomScrap'>, keyScrap: Scrap | null): string {
  if (pv.underCeiling === null) return 'No buyer';
  if (pv.headroomScrap === null) return 'No price clears your thresholds';
  if (pv.headroomScrap === 0) return 'At the ceiling';
  const amount = fmtMoney(Math.abs(pv.headroomScrap), keyScrap);
  return pv.underCeiling ? `${amount} under` : `${amount} over`;
}

export function buyerCountLabel(n: number): string {
  return n === 1 ? '1 buyer' : `${n} buyers`;
}

/** Hover text for "Sells for": all three revenue picks, so the one Settings uses can be compared. */
export function revenueBreakdown(rev: Pick<ItemRevenue, 'bestScrap' | 'consScrap' | 'instantScrap'>, keyScrap: Scrap | null): string {
  return `Best ${fmtMoney(rev.bestScrap, keyScrap)} · conservative ${fmtMoney(rev.consScrap, keyScrap)} · instant ${fmtMoney(rev.instantScrap, keyScrap)}`;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface CompactLink {
  link: LinkSpec;
  /** Short label for the one-line row; the full label goes in the tooltip. */
  short: string;
}

/** The links the user reaches for while checking a price, in row order. Alternatives share a slot. */
const COMPACT_LINK_SLOTS: readonly { ids: readonly string[]; short: string }[] = [
  { ids: ['bptf-stats'], short: 'Stats' },
  { ids: ['bptf-classifieds-accurate', 'bptf-classifieds'], short: 'Classifieds' },
  { ids: ['scraptf-page'], short: 'scrap.tf page' },
  { ids: ['mptf'], short: 'mp.tf' },
  { ids: ['stn'], short: 'STN' },
  { ids: ['scm'], short: 'SCM' },
  { ids: ['pricedb'], short: 'PriceDB' },
];

/** At most `max` links from detail.links for the quick window's link row; the drawer has the full menu. */
export function compactLinks(links: readonly LinkSpec[], max = 6): CompactLink[] {
  const byId = new Map(links.map((l) => [l.id, l] as const));
  const out: CompactLink[] = [];
  for (const slot of COMPACT_LINK_SLOTS) {
    if (out.length >= max) break;
    const link = slot.ids.map((id) => byId.get(id)).find((l) => l !== undefined);
    if (link) out.push({ link, short: slot.short });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keys and the "checked" marker
// ---------------------------------------------------------------------------

/** Shift+Enter is "Check only" anywhere in the form; plain Enter keeps saving. */
export function isCheckKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.isComposing !== true;
}

export interface CheckedEntry {
  sku: string;
  text: string;
  unit: string;
}

/** A "Check only" result stays shown only while the item and the price text are unchanged. */
export function isChecked(checked: CheckedEntry | null, now: { sku: string | null; text: string; unit: string }): boolean {
  return checked !== null && checked.sku === now.sku && checked.text === now.text && checked.unit === now.unit;
}
