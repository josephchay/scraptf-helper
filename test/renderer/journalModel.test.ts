// 0.8 (J3) the Journal page's pure rules: periods on the local calendar (weeks from Monday, DST via Date),
// venue routes folded by venueLabel, the stats (win rate with break-even as neither, ROI not annualised,
// holds over sales only, fee-less flips counted), the losing flips, each row's P/L cell and its texts, the
// stat and cell views (muted below MIN_RATE_TRADES), and the edit and write-off prefills. Pure; no network.

import { describe, expect, it } from 'vitest';
import { journalSummary } from '../../src/shared/journal';
import type { JournalClosedTrade, JournalEntry } from '../../src/shared/types';
import { DASH, fmtDate, fmtDateTime, fmtHold as fmtHoldFormat } from '../../src/renderer/format';
import {
  JOURNAL_RESULTS_OPTIONS,
  JOURNAL_SIDE_LABELS,
  JOURNAL_SIDE_TONES,
  LOSSES_SHOWN,
  MIN_RATE_TRADES,
  WRITE_OFF_TITLE,
  feesCell,
  fmtHold,
  holdStat,
  journalByPeriod,
  journalByRoute,
  journalEditInit,
  journalIndex,
  journalLosses,
  journalResults,
  journalStats,
  journalTotals,
  loggedText,
  lossRowView,
  periodLabel,
  periodStart,
  rateCell,
  resultsNotes,
  roiStat,
  routeKey,
  routeLabel,
  tradePnl,
  winRateStat,
  writeOffInit,
  writtenOffText,
} from '../../src/renderer/journalModel';

const KEY = 568;
const DAY = 86_400_000;
const T0 = new Date(2026, 9, 20, 12, 0).getTime();

let seq = 0;
/** One booked pair; heldMs follows the two dates unless given. */
function pair(over: Partial<JournalClosedTrade> = {}): JournalClosedTrade {
  seq++;
  const boughtAt = over.boughtAt ?? T0 - 3 * DAY;
  const soldAt = over.soldAt ?? T0;
  return {
    sellId: 1000 + seq,
    buyId: seq,
    kind: 'sell',
    sku: '194;11',
    name: 'Strange Knife',
    boughtAt,
    soldAt,
    heldMs: Math.max(0, soldAt - boughtAt),
    buyVenue: 'scrap.tf',
    sellVenue: 'backpack.tf',
    costScrap: 40,
    proceedsScrap: 50,
    feesScrap: null,
    feesKnown: false,
    profitScrap: 10,
    keyPriceScrap: KEY,
    ...over,
  };
}

function entry(over: Partial<JournalEntry> & Pick<JournalEntry, 'id' | 'side' | 'ts'>): JournalEntry {
  return { venue: 'scrap.tf', sku: '194;11', name: 'Strange Knife', keys: 0, scrap: 40, keyPriceScrap: KEY, note: null, ...over };
}

describe('labels and small texts', () => {
  it('names and tones every side, and the Results groupings', () => {
    expect(JOURNAL_SIDE_LABELS).toEqual({ buy: 'Buy', sell: 'Sell', writeoff: 'Write-off' });
    expect(JOURNAL_SIDE_TONES).toEqual({ buy: 'info', sell: 'good', writeoff: 'bad' });
    expect(JOURNAL_RESULTS_OPTIONS.map((o) => o.value)).toEqual(['month', 'week', 'route']);
    expect(JOURNAL_RESULTS_OPTIONS.map((o) => o.label)).toEqual(['Month', 'Week', 'Venues']);
    expect(MIN_RATE_TRADES).toBe(5);
    expect(LOSSES_SHOWN).toBe(50);
    expect(WRITE_OFF_TITLE).toMatch(/Nothing is sold or traded\.$/);
  });

  it('words the Log a trade toast (buy and sell as before 0.8)', () => {
    expect(loggedText({ side: 'buy', name: 'Team Captain' })).toBe('Logged buy of Team Captain');
    expect(loggedText({ side: 'sell', name: 'Team Captain' })).toBe('Logged sell of Team Captain');
    expect(loggedText({ side: 'writeoff', name: 'Ghastly Gibus' })).toBe('Logged write-off of Ghastly Gibus');
  });

  it('writes a hold time, under a minute included', () => {
    expect(fmtHold(null)).toBe(DASH);
    expect(fmtHold(Number.NaN)).toBe(DASH);
    expect(fmtHold(0)).toBe('< 1 min');
    expect(fmtHold(59_999)).toBe('< 1 min');
    expect(fmtHold(60_000)).toBe('1 min');
    expect(fmtHold(2 * DAY + 5 * 3_600_000)).toBe('2 d');
    // format.ts's own, shared with Holdings and the drawer.
    expect(fmtHold).toBe(fmtHoldFormat);
    expect(fmtHold(undefined)).toBe(DASH);
  });

  it('counts write-offs in the Completed flips sub-line only when there are any', () => {
    expect(writtenOffText(0)).toBeNull();
    expect(writtenOffText(2)).toBe('incl. 2 written off');
  });
});

describe('periods on the local calendar (TZ-safe: local constructors only)', () => {
  const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

  it('starts a week on Monday 00:00: Sunday 18 Oct 2026 23:59 is in the week of 12 Oct, Monday 19 Oct starts its own', () => {
    expect(new Date(local(2026, 9, 18, 23, 59)).getDay()).toBe(0);
    expect(periodStart(local(2026, 9, 18, 23, 59), 'week')).toBe(local(2026, 9, 12));
    expect(periodStart(local(2026, 9, 19), 'week')).toBe(local(2026, 9, 19));
    expect(periodStart(local(2026, 9, 21, 15), 'week')).toBe(local(2026, 9, 19));
  });

  it('keeps a week across 25 Oct 2026 (a daylight-saving change in many zones) on its Mondays', () => {
    expect(periodStart(local(2026, 9, 25, 12), 'week')).toBe(local(2026, 9, 19));
    expect(periodStart(local(2026, 9, 25, 23, 59), 'week')).toBe(local(2026, 9, 19));
    expect(periodStart(local(2026, 9, 26, 0, 1), 'week')).toBe(local(2026, 9, 26));
    expect(periodStart(local(2026, 9, 28, 9), 'week')).toBe(local(2026, 9, 26));
  });

  it('starts a month on its 1st, across a month end', () => {
    expect(periodStart(local(2026, 9, 31, 23, 59), 'month')).toBe(local(2026, 9, 1));
    expect(periodStart(local(2026, 10, 1), 'month')).toBe(local(2026, 10, 1));
    expect(periodStart(local(2026, 11, 31, 12), 'month')).toBe(local(2026, 11, 1));
  });

  it('labels a month in fixed English and a week by its Monday', () => {
    expect(periodLabel(local(2026, 9, 1), 'month')).toBe('Oct 2026');
    expect(periodLabel(local(2027, 0, 1), 'month')).toBe('Jan 2027');
    expect(periodLabel(local(2026, 9, 12), 'week')).toBe(`Week of ${fmtDate(local(2026, 9, 12))}`);
    expect(periodLabel(local(2026, 9, 12), 'week')).toBe('Week of 2026-10-12');
  });
});

describe('Results', () => {
  const local = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

  it("counts a flip in its sale's period, newest period first", () => {
    const a = pair({ boughtAt: local(2026, 8, 28), soldAt: local(2026, 9, 2), profitScrap: 10 });
    const b = pair({ boughtAt: local(2026, 8, 20), soldAt: local(2026, 8, 30), profitScrap: -5 });
    const c = pair({ boughtAt: local(2026, 9, 10), soldAt: local(2026, 9, 20), profitScrap: 7 });
    const months = journalByPeriod([a, b, c], 'month');
    expect(months.map((r) => [r.label, r.trades, r.profitScrap])).toEqual([
      ['Oct 2026', 2, 17],
      ['Sep 2026', 1, -5],
    ]);
    expect(months[0]!.start).toBe(local(2026, 9, 1, 0));
    const weeks = journalByPeriod([a, b, c], 'week');
    expect(weeks.map((r) => r.label)).toEqual(['Week of 2026-10-19', 'Week of 2026-09-28']);
    expect(weeks[1]!.trades).toBe(2);
    expect(journalResults([a, b, c], 'month')).toEqual(months);
    expect(journalResults([a, b, c], 'week')).toEqual(weeks);
  });

  it("groups by venue route, folding aliases ('Steam' is the Steam Community Market), a write-off going to Written off", () => {
    const flips = [
      pair({ sellVenue: 'Steam', profitScrap: 5 }),
      pair({ sellVenue: 'Steam Community Market', profitScrap: 6 }),
      pair({ buyVenue: 'Scrap.TF', sellVenue: 'scm', profitScrap: 1 }),
      pair({ sellVenue: 'backpack.tf', profitScrap: 50 }),
      pair({ kind: 'writeoff', sellVenue: 'Written off', profitScrap: -40, proceedsScrap: 0 }),
    ];
    expect(routeKey(flips[0]!)).toBe(routeKey(flips[1]!));
    expect(routeLabel(flips[0]!)).toBe('scrap.tf → Steam Community Market');
    expect(routeLabel(flips[4]!)).toBe('scrap.tf → Written off');
    // A write-off is "Written off" whatever its stored venue says.
    expect(routeLabel(pair({ kind: 'writeoff', sellVenue: 'oops' }))).toBe('scrap.tf → Written off');
    const routes = journalByRoute(flips);
    expect(routes.map((r) => [r.label, r.trades, r.profitScrap])).toEqual([
      ['scrap.tf → Steam Community Market', 3, 12],
      ['scrap.tf → backpack.tf', 1, 50],
      ['scrap.tf → Written off', 1, -40],
    ]);
    expect(routes.every((r) => r.start === null)).toBe(true);
    expect(journalResults(flips, 'route')).toEqual(routes);
  });

  it('works out the stats: null rates at 0 flips or 0 cost, break-even as neither, holds over sales only', () => {
    expect(journalStats([])).toMatchObject({ trades: 0, winRate: null, roi: null, avgHeldMs: null, medianHeldMs: null, feesScrap: 0, feesRecorded: 0, feesMissing: 0 });
    expect(journalStats([pair({ costScrap: 0, profitScrap: 5 })]).roi).toBeNull();
    const s = journalStats([
      pair({ profitScrap: 10, costScrap: 40, heldMs: 1 * DAY, feesScrap: 2, feesKnown: true }),
      pair({ profitScrap: 0, costScrap: 40, heldMs: 3 * DAY, feesScrap: 1, feesKnown: false }),
      pair({ profitScrap: -6, costScrap: 40, heldMs: 2 * DAY }),
      pair({ kind: 'writeoff', profitScrap: -40, costScrap: 40, heldMs: 30 * DAY, proceedsScrap: 0, feesScrap: null, feesKnown: true }),
    ]);
    expect(s).toMatchObject({ trades: 4, sales: 3, writeoffs: 1, wins: 1, losses: 2, breakEven: 1, profitScrap: -36, costScrap: 160, feesScrap: 3, feesRecorded: 2, feesMissing: 2 });
    expect(s.winRate).toBe(1 / 4);
    expect(s.roi).toBe(-36 / 160);
    // The write-off's 30 d is not a hold.
    expect(s.medianHeldMs).toBe(2 * DAY);
    expect(s.avgHeldMs).toBe(2 * DAY);
  });

  it('has enough flips for the rates at MIN_RATE_TRADES', () => {
    expect(journalTotals([pair(), pair(), pair(), pair()]).enough).toBe(false);
    expect(journalTotals([pair(), pair(), pair(), pair(), pair()]).enough).toBe(true);
  });

  it('lists the losing flips worst first, then newest sale, write-offs included', () => {
    const w = pair({ kind: 'writeoff', profitScrap: -40, soldAt: T0 - DAY });
    const a = pair({ profitScrap: -5, soldAt: T0 - 2 * DAY });
    const b = pair({ profitScrap: -5, soldAt: T0 });
    const win = pair({ profitScrap: 5 });
    const even = pair({ profitScrap: 0 });
    expect(journalLosses([a, win, b, even, w])).toEqual([w, b, a]);
  });
});

describe("each trade's P/L cell", () => {
  const b1 = entry({ id: 1, side: 'buy', ts: T0 - 5 * DAY, feeKeys: 0, feeScrap: 0 });
  const s1 = entry({ id: 2, side: 'sell', ts: T0 - 3 * DAY, venue: 'backpack.tf', scrap: 70, feeKeys: 0, feeScrap: 2 });
  const b2 = entry({ id: 3, side: 'buy', ts: T0 - 2 * DAY });
  const s2 = entry({ id: 4, side: 'sell', ts: T0 - DAY, sku: '5021;6', name: 'Key', scrap: 500 });
  const b3 = entry({ id: 5, side: 'buy', ts: T0 - 6 * DAY, sku: '116;6', name: 'Ghastly Gibus' });
  const w1 = entry({ id: 6, side: 'writeoff', ts: T0 - DAY, sku: '116;6', name: 'Ghastly Gibus', scrap: 0, venue: 'Written off' });
  const b4 = entry({ id: 8, side: 'buy', ts: T0 - 9 * DAY, sku: '30359;6', name: 'Juggernaut Jacket' });
  const s4 = entry({ id: 9, side: 'sell', ts: T0 - 8 * DAY, sku: '30359;6', name: 'Juggernaut Jacket', scrap: 60, feeKeys: 0, feeScrap: 2 });
  const junk = { ...entry({ id: 7, side: 'buy', ts: T0 }), side: 'hold' } as unknown as JournalEntry;
  const rows = [b1, s1, b2, s2, b3, w1, b4, s4, junk];
  const s = journalSummary(rows);
  const idx = journalIndex(s);

  it('indexes both rows of each pair, the open lots and the waiting sales', () => {
    expect([...idx.closedBySell.keys()].sort()).toEqual([2, 6, 9]);
    expect([...idx.closedByBuy.keys()].sort()).toEqual([1, 5, 8]);
    expect([...idx.openBuys]).toEqual([3]);
    expect([...idx.waiting]).toEqual([4]);
  });

  it('a sale shows its booked profit, the buy it closed, the hold and its fees', () => {
    const v = tradePnl(s1, idx, KEY);
    expect(v).toEqual({
      kind: 'profit',
      profitScrap: 28,
      text: '+3.11 ref',
      title: `Closed the buy of ${fmtDateTime(b1.ts)} on scrap.tf (cost 4.44 ref); held 2 d between the logged buy and sale. Fees 0.22 ref.`,
    });
    // One side without a recorded fee.
    expect(tradePnl(s4, idx, KEY).title).toMatch(/held 1 d between the logged buy and sale\. Fees 0\.22 ref \(one side not recorded\)\.$/);
  });

  it('a write-off shows its loss; its buy says it was written off', () => {
    expect(tradePnl(w1, idx, KEY)).toMatchObject({ kind: 'profit', profitScrap: -40, text: '-4.44 ref' });
    expect(tradePnl(w1, idx, KEY).title).toMatch(/between the logged buy and write-off\. No fees recorded\.$/);
    expect(tradePnl(b3, idx, KEY)).toEqual({ kind: 'written-off', profitScrap: -40, text: 'written off', title: `Written off ${fmtDate(w1.ts)}: -4.44 ref` });
  });

  it('a sold buy, an open buy, a waiting sale and anything else', () => {
    expect(tradePnl(b1, idx, KEY)).toEqual({ kind: 'sold', profitScrap: 28, text: 'sold', title: `Sold ${fmtDate(s1.ts)} on backpack.tf: +3.11 ref` });
    expect(tradePnl(b2, idx, KEY)).toEqual({ kind: 'open', profitScrap: null, text: 'open', title: "Still held: Holdings prices it against today's buyers." });
    expect(tradePnl(s2, idx, KEY)).toEqual({ kind: 'waiting', profitScrap: null, text: 'no buy', title: 'No buy of this item dated before it, so it books nothing yet.' });
    expect(tradePnl(junk, idx, KEY)).toEqual({ kind: 'none', profitScrap: null, text: DASH, title: undefined });
    expect(tradePnl(s1, null, KEY)).toEqual({ kind: 'none', profitScrap: null, text: DASH, title: undefined });
  });

  it('opens the edit dialog with the pair and its other row, or none', () => {
    expect(journalEditInit(s1, idx, rows)).toEqual({ side: 'sell', sku: '194;11', name: 'Strange Knife', editOf: s1, editPair: { closed: idx.closedBySell.get(2), other: b1 } });
    expect(journalEditInit(b1, idx, rows).editPair).toEqual({ closed: idx.closedByBuy.get(1), other: s1 });
    expect(journalEditInit(w1, idx, rows).editPair?.other).toBe(b3);
    expect(journalEditInit(b2, idx, rows).editPair).toBeNull();
    expect(journalEditInit(s2, idx, rows).editPair).toBeNull();
    // Review fix: the other row outside the loaded list (the page lists the newest 2000) keeps the booked pair with
    // other null, so the dialog shows its profit instead of calling it a sale with no buy.
    expect(journalEditInit(s1, idx, [s1]).editPair).toEqual({ closed: idx.closedBySell.get(2), other: null });
    expect(journalEditInit(s1, idx, undefined).editPair).toEqual({ closed: idx.closedBySell.get(2), other: null });
    // No summary yet: no pair to compare with.
    expect(journalEditInit(s1, null, rows)).toMatchObject({ editOf: s1, editPair: null });
  });

  it("opens Write off… on the position's item", () => {
    expect(writeOffInit({ sku: '194;11', name: 'Strange Knife' })).toEqual({ side: 'writeoff', sku: '194;11', name: 'Strange Knife', venue: 'Written off' });
  });
});

describe('stat cards and cells', () => {
  const five = [pair({ profitScrap: 10 }), pair({ profitScrap: 20 }), pair({ profitScrap: 30 }), pair({ profitScrap: -10 }), pair({ profitScrap: 0 })];

  it('win rate: shown from 5 flips with every count, muted below', () => {
    expect(winRateStat(journalTotals([]))).toEqual({ value: DASH, sub: 'no closed flips yet', muted: true, title: 'Flips that made money, of every closed flip (write-offs included).' });
    expect(winRateStat(journalTotals(five.slice(0, 4)))).toMatchObject({ value: DASH, sub: '3 won · 1 lost · needs 5 flips', muted: true });
    expect(winRateStat(journalTotals(five))).toMatchObject({ value: '60%', sub: '3 won · 1 lost · 1 even', muted: false });
  });

  it('ROI: profit over cost from 5 flips, naming the flips without fees', () => {
    const t = journalTotals(five);
    expect(roiStat(t, KEY)).toEqual({
      value: '25.0%',
      sub: 'on 22.22 ref cost · 5 without fees',
      muted: false,
      title: 'Realised profit over what the sold items cost, fees included where recorded. Not annualised.',
    });
    expect(roiStat(journalTotals(five.slice(0, 2)), KEY)).toMatchObject({ value: DASH, muted: true });
    expect(roiStat(journalTotals([]), KEY)).toMatchObject({ value: DASH, sub: 'on 0.00 ref cost', muted: true });
    const known = five.map((c) => ({ ...c, feesKnown: true }));
    expect(roiStat(journalTotals(known), KEY).sub).toBe('on 22.22 ref cost');
  });

  it('hold time: the median over sales, muted below 5 sales', () => {
    expect(holdStat(journalTotals([]))).toEqual({ value: DASH, sub: 'no sales yet', muted: true, title: 'Median time between the logged buy and the logged sale; write-offs are not counted.' });
    const holds = [1, 2, 3, 4, 5].map((d) => pair({ heldMs: d * DAY }));
    expect(holdStat(journalTotals(holds))).toMatchObject({ value: '3 d', sub: 'avg 3 d · 5 sales', muted: false });
    expect(holdStat(journalTotals([pair({ heldMs: 0 })]))).toMatchObject({ value: '< 1 min', sub: 'avg < 1 min · 1 sale', muted: true });
  });

  it('rate and fee cells', () => {
    expect(rateCell(0.6, 5)).toEqual({ text: '60%', muted: false, title: undefined });
    expect(rateCell(0.5, 2, 1)).toEqual({ text: '50.0%', muted: true, title: 'Only 2 flips: too few to read much into.' });
    expect(rateCell(1, 1).title).toBe('Only 1 flip: too few to read much into.');
    expect(rateCell(null, 0).text).toBe(DASH);
    expect(feesCell({ feesScrap: 0, feesRecorded: 0, feesMissing: 3, trades: 3 }, KEY)).toEqual({ text: DASH, title: '3 of 3 flips lack a fee on one side or both' });
    expect(feesCell({ feesScrap: 4, feesRecorded: 2, feesMissing: 0, trades: 2 }, KEY)).toEqual({ text: '0.44 ref', title: undefined });
  });

  it('notes under Results: fees, waiting sales, and how the figures are booked', () => {
    const always = "Profit is booked at each sale's key price. ROI is profit over cost, not annualised. Hold time runs from the logged buy to the logged sale.";
    expect(resultsNotes(journalTotals(five), 0)).toEqual(['No flip has its fees recorded on both sides yet: profit and ROI are before fees.', always]);
    const some = journalTotals([...five.slice(0, 3), ...five.slice(3).map((c) => ({ ...c, feesKnown: true }))]);
    expect(resultsNotes(some, 1)).toEqual(['3 of 5 flips lack a recorded fee on one side or both: their profit may be before fees.', '1 sale without a recorded buy is not counted.', always]);
    const none = journalTotals(five.map((c) => ({ ...c, feesKnown: true })));
    expect(resultsNotes(none, 2)).toEqual(['2 sales without a recorded buy are not counted.', always]);
    // Review fix: a waiting write-off is named as a write-off, never counted as a sale.
    expect(resultsNotes(none, 0, 1)).toEqual(['1 write-off without a recorded buy is not counted.', always]);
    expect(resultsNotes(none, 0, 2)).toEqual(['2 write-offs without a recorded buy are not counted.', always]);
    expect(resultsNotes(none, 1, 1)).toEqual(['1 sale and 1 write-off without a recorded buy are not counted.', always]);
    expect(resultsNotes(none, 2, 0)).toEqual(resultsNotes(none, 2));
  });

  it('a losing flip as the Losing flips card shows it', () => {
    const sale = pair({ profitScrap: -6, buyVenue: 'scrap', sellVenue: 'bp.tf', feesScrap: 2, feesKnown: true });
    expect(lossRowView(sale, KEY)).toEqual({
      sku: '194;11',
      name: 'Strange Knife',
      bought: `${fmtDate(sale.boughtAt)} · scrap.tf`,
      sold: `${fmtDate(sale.soldAt)} · backpack.tf`,
      costScrap: 40,
      fees: '0.22 ref',
      profitScrap: -6,
      sellId: sale.sellId,
    });
    const w = pair({ kind: 'writeoff', profitScrap: -40 });
    expect(lossRowView(w, KEY)).toMatchObject({ sold: `${fmtDate(w.soldAt)} · written off`, fees: 'not recorded' });
  });
});
