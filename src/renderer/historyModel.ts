// Pure helpers for the item drawer's "scrap.tf history" block (F20 U1, components/ScraptfHistory.tsx):
// the price on each of the user's saves of the item's bank as a step chart with gaps, how long it has
// been listed, the 1 h / 24 h / 7 d / since-listed change chips, stock now and the last change events,
// all from 'scraptf.itemHistory'. Every value comes from pages the user saved (R10); a save is a
// snapshot, so nothing is claimed about the time between two saves. Nothing here loads scrap.tf (R1).

import { bankStockPagePath } from '../shared/bankStock';
import { scraptfBankInfo } from '../shared/links';
import { scraptfAgoText } from '../shared/scraptfHistory';
import type { Scrap, ScraptfBank, ScraptfChangeEvent, ScraptfHistoryPoint, ScraptfItemHistory, ScraptfPriceChange, UnixMs } from '../shared/types';
import { CHANGE_KIND_HELP, CHANGE_KIND_LABELS, CHANGE_KIND_TONES, changePctText, changePriceText, changeStockText, fmtSaveTime, fromToText } from './changesModel';
import { DASH, fmtAgo, fmtDateTime, fmtInt, fmtMoney, type Tone } from './format';

/** The block re-reads at most this often on pushes ('scraptf.changed', 'prices.changed'). */
export const HISTORY_REFRESH_MS = 2_000;
/** Change events listed before "Show all". */
export const HISTORY_EVENTS_SHOWN = 5;

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
 * when it was last on sale. Null without a bank (the empty state says why).
 */
export function historyListedLine(h: Pick<ScraptfItemHistory, 'bank' | 'listedSince' | 'lastSeenAt' | 'firstSeenAt'>, now: UnixMs): HistoryLine | null {
  const path = historyBankPath(h);
  if (!path) return null;
  const first = finite(h.firstSeenAt) ? ` Your saves kept first listed it on sale ${fmtDateTime(h.firstSeenAt)}.` : '';
  const gaps = ' What happened between two saves is unknown.';
  if (finite(h.listedSince)) {
    const since = Math.min(h.listedSince, now);
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

/** "Now 1.22 ref · 3 in stock", or what the newest save said instead. */
export function historyNowText(h: Pick<ScraptfItemHistory, 'bank' | 'current' | 'points'>, keyScrap: Scrap | null): HistoryLine | null {
  const path = historyBankPath(h);
  if (!path) return null;
  const c = h.current;
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
export function historyChips(h: Pick<ScraptfItemHistory, 'bank' | 'current' | 'change' | 'lastSeenAt'>, keyScrap: Scrap | null): HistoryChip[] {
  return CHIPS.map(({ id, label, ago }) => {
    const c = h.change[id];
    if (c && finite(h.lastSeenAt) && c.since >= h.lastSeenAt) {
      const title =
        id === 'listed'
          ? `On sale only since your newest save (${fmtDateTime(c.since)}): save the page again later to compare.`
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
}

/** ScraptfItemHistory.points as the chart reads them: the cost only where listed (it is 0 otherwise). */
export function historySeries(points: readonly ScraptfHistoryPoint[]): StepPoint[] {
  return [...points].filter((p) => finite(p.at)).sort((a, b) => a.at - b.at).map((p) => ({ at: p.at, value: p.listed && finite(p.costScrap) ? p.costScrap : null }));
}

const r1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/**
 * Geometry of the step chart over `points` (oldest first): a horizontal step from each listed save to
 * the next one when that one is listed too, then a vertical to its price; nothing across a gap. Null
 * when no save listed it on sale.
 */
export function stepChartGeom(points: readonly StepPoint[], box: StepBox = STEP_BOX): StepGeom | null {
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
  return { path: d, dots, gaps, xs, lo, hi, t0, t1 };
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
      body: 'Its scrap.tf price history starts with your first save of a bank page that lists it (Ctrl+S into your watch folder); every later save adds a point. The app never visits scrap.tf.',
    };
  }
  if (h.points.length <= 1) {
    return { title: 'One save so far', body: 'Save the page again later to see its price over time and what changed.' };
  }
  return null;
}
