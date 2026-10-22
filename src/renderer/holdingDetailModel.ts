// Pure helpers for the item drawer's "Your holding & trades" section (0.8, H7, components/HoldingSection.tsx):
// the recorded exit runs as a step chart with gaps where nothing was recorded, the open lots, the closed trades
// and the user's typical hold, all from 'holdings.detail'. A run is what the app saw while it ran with the live
// feed on (H1); a gap is "not watched", never filled in or interpolated. Nothing here loads or opens anything.

import { HOLDING_MARK_GAP_MS, markExitScrap, tradableAtOf } from '../shared/holdingAdvice';
import { venueLabel } from '../shared/venues';
import type { HoldingDetail, HoldingMark, JournalClosedTrade, JournalLot, Scrap, TradeLockMode, TypicalHold, UnixMs } from '../shared/types';
import { fmtSaveTime } from './changesModel';
import { fmtAge, fmtDateTime, fmtHold, fmtInt, fmtKeysMetal, fmtMoney, fmtRefOnly, fmtSignedMoney } from './format';
import { stepChartGeom, type StepGeom } from './historyModel';
import { typicalHoldText } from './holdingsModel';

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** "Oct 20": a local day, as the drawer's lines name it. */
function fmtDay(ts: UnixMs): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** One point of the exit chart: a run's start or end at its exit, a run with no exit, or a stretch nothing was recorded. */
export interface HoldingChartPoint {
  at: UnixMs;
  value: Scrap | null;
  kind: 'run' | 'no-exit' | 'unwatched';
  mark: HoldingMark | null;
}

/**
 * Oldest first: each run gives a point at fromAt and one at toAt when later (the step holds its exit); a run with
 * no exit gives null ('no-exit'); a silence longer than HOLDING_MARK_GAP_MS before the next run adds a null point at
 * toAt + 1 ('unwatched'). Never interpolated.
 */
export function holdingChartSeries(marks: readonly HoldingMark[], keyScrap: Scrap | null): HoldingChartPoint[] {
  const runs = (Array.isArray(marks) ? marks : []).filter((m) => m && finite(m.fromAt) && finite(m.toAt)).sort((a, b) => a.fromAt - b.fromAt || a.id - b.id);
  const out: HoldingChartPoint[] = [];
  runs.forEach((m, i) => {
    const value = markExitScrap(m, keyScrap);
    const kind = value === null ? 'no-exit' : 'run';
    out.push({ at: m.fromAt, value, kind, mark: m });
    if (m.toAt > m.fromAt) out.push({ at: m.toAt, value, kind, mark: m });
    const next = runs[i + 1];
    // App closed or the feed off: the line breaks here rather than carrying the last exit across.
    if (next && next.fromAt - m.toAt > HOLDING_MARK_GAP_MS) out.push({ at: m.toAt + 1, value: null, kind: 'unwatched', mark: null });
  });
  // Stable, so the chart's indices (stepChartGeom sorts by time too) are this list's.
  return out.sort((a, b) => a.at - b.at);
}

/** stepChartGeom over the series (only its time and value; no third argument, so the result has no `downs` key). */
export function holdingChartGeom(points: readonly HoldingChartPoint[]): StepGeom | null {
  return stepChartGeom(points.map((p) => ({ at: p.at, value: p.value })));
}

/** "Oct 14 09:12 · 1.33 ref · 3 buyers" / "… · no buyer or scrap.tf price" / "… · not recorded (Flip Desk was closed or the live feed was off)". */
export function holdingChartReadout(p: HoldingChartPoint | undefined, keyScrap: Scrap | null): string {
  if (!p) return '';
  const when = fmtSaveTime(p.at);
  if (p.kind === 'unwatched') return `${when} · not recorded (Flip Desk was closed or the live feed was off)`;
  if (p.value === null) return `${when} · no buyer or scrap.tf price`;
  const n = p.mark?.buyerCount;
  return `${when} · ${fmtMoney(p.value, keyScrap)}${finite(n) ? ` · ${fmtInt(n)} ${n === 1 ? 'buyer' : 'buyers'}` : ''}`;
}

/** The chart's accessible name: "Best exit in N recorded runs from <date> to <date>, between X and Y; gaps where nothing was recorded". */
export function holdingChartLabel(g: StepGeom, runs: number, keyScrap: Scrap | null): string {
  const range = g.lo === g.hi ? `at ${fmtMoney(g.lo, keyScrap)}` : `between ${fmtMoney(g.lo, keyScrap)} and ${fmtMoney(g.hi, keyScrap)}`;
  return `Best exit in ${fmtInt(runs)} recorded ${runs === 1 ? 'run' : 'runs'} from ${fmtDateTime(g.t0)} to ${fmtDateTime(g.t1)}, ${range}; gaps where nothing was recorded`;
}

/**
 * "Exit prices recorded since Oct 20 (14 runs). Gaps: Flip Desk was closed or the live feed was off; nothing is
 * filled in." ("the newest 500 runs" when truncated); null without marks.
 */
export function recordedSinceText(d: Pick<HoldingDetail, 'marks' | 'truncated'>): string | null {
  const marks = Array.isArray(d.marks) ? d.marks.filter((m) => m && finite(m.fromAt)) : [];
  if (marks.length === 0) return null;
  const first = Math.min(...marks.map((m) => m.fromAt));
  const runs = d.truncated ? `the newest ${fmtInt(marks.length)} runs` : `${fmtInt(marks.length)} ${marks.length === 1 ? 'run' : 'runs'}`;
  return `Exit prices recorded since ${fmtDay(first)} (${runs}). Gaps: Flip Desk was closed or the live feed was off; nothing is filled in.`;
}

/**
 * One line per open lot: "Bought Oct 12 · 1 key 2.00 ref · key 63.11 ref then · held 4 d" (the key price only for a lot
 * paid in keys). 0.9 (#1): with the user's 7-day Trade lock (`mode` '7d'), a lot still inside it adds
 * " · tradable 2026-10-19 12:00" (tradableAtOf > now); any other mode adds nothing.
 */
export function holdingLotLines(lots: readonly JournalLot[], keyScrap: Scrap | null, now: UnixMs, mode: TradeLockMode = 'unknown'): string[] {
  return (Array.isArray(lots) ? lots : []).map((l) => {
    const price = finite(l.keys) && finite(l.scrap) ? fmtKeysMetal(l.keys, l.scrap) : fmtMoney(l.costScrap, keyScrap);
    const key = finite(l.keys) && l.keys > 0 && finite(l.keyPriceScrap) && l.keyPriceScrap > 0 ? ` · key ${fmtRefOnly(l.keyPriceScrap)} then` : '';
    const at = tradableAtOf(l.ts, mode);
    const lock = at !== null && at > now ? ` · tradable ${fmtDateTime(at)}` : '';
    return `Bought ${finite(l.ts) ? fmtDay(l.ts) : '?'} · ${price}${key} · held ${fmtAge(now - l.ts)}${lock}`;
  });
}

/**
 * One line per closed trade: "Sold Oct 15 on backpack.tf after 2 d · +0.44 ref" (a write-off: "Written off Oct 15
 * after 9 d · -1.33 ref"), toned by the booked profit's sign (none at break-even).
 */
export function closedTradeLines(closed: readonly JournalClosedTrade[], keyScrap: Scrap | null): { text: string; tone: 'good' | 'bad' | null }[] {
  return (Array.isArray(closed) ? closed : []).map((c) => {
    const day = finite(c.soldAt) ? fmtDay(c.soldAt) : '?';
    const head = c.kind === 'writeoff' ? `Written off ${day}` : `Sold ${day} on ${venueLabel(c.sellVenue)}`;
    const tone = c.profitScrap > 0 ? 'good' : c.profitScrap < 0 ? 'bad' : null;
    // fmtHold: a sale logged in its buy's own minute holds 0, which fmtAge words as "now".
    return { text: `${head} after ${fmtHold(c.heldMs)} · ${fmtSignedMoney(c.profitScrap, keyScrap)}`, tone };
  });
}

/** D3: journal's typicalHoldText (holdingsModel), or null without one. The user's habit, never a forecast. */
export function typicalHoldLine(t: TypicalHold | null): string | null {
  return t ? typicalHoldText(t) : null;
}

/** 'Your holding & trades' (held), 'Your trades' (closed only), 'Recorded exit prices' (runs only); null: no section. */
export function holdingSectionTitle(d: HoldingDetail | null | undefined): string | null {
  if (!d) return null;
  if (d.row !== null || d.lots.length > 0) return 'Your holding & trades';
  if (d.closed.length > 0) return 'Your trades';
  if (d.marks.length > 0) return 'Recorded exit prices';
  return null;
}
