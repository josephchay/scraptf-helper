// 0.8: the S3 notifier's rules (src/shared/bankStockNotify.ts) and alerts' part of src/shared/bankStock.ts. One ordered
// candidate list per told look (a watch hit G1, a new flip S3, a flip a read dropped under Pay up to G2, a flip or
// watched copy back on sale LC-7/G3, Wait to Buy now G4 behind notifications.buyTiming), one candidate per row, every
// toast and summary text, the summary's chip (G5) and G4's memory of Wait. Pure; nothing is fetched, and the timing is
// an estimate from the user's saves, never a forecast.

import { describe, expect, it } from 'vitest';
import {
  BANK_STOCK_MORE_BODY,
  BANK_STOCK_NOTIFY_AGE_NOTE_MS,
  bankStockDroppedIntoFlip,
  bankStockNewFlipNotice,
  bankStockOldSaveNotice,
  bankStockSaveAgeNote,
  bankStockSpecialKey,
} from '../../src/shared/bankStock';
import {
  BANK_STOCK_TIMING_MAX,
  BANK_STOCK_TIMING_MAX_AGE_MS,
  BANK_STOCK_WAIT_NOTE,
  BANK_STOCK_WAIT_NOTE_FIRST,
  bankStockBackNotice,
  bankStockBuyNowNotice,
  bankStockDroppedFlipNotice,
  bankStockNoticeOf,
  bankStockNotifyCandidates,
  bankStockNotifyKey,
  bankStockNotifyOrder,
  bankStockNotifyWords,
  bankStockOldSaveSummary,
  bankStockSaleText,
  bankStockSummaryChip,
  bankStockSummaryNotice,
  bankStockTimingNext,
  bankStockTimingParse,
  bankStockWaitKey,
  bankStockWatchNotice,
  bankStockWatchNotifyKey,
  bankStockWatchedOnSaleNotice,
  type BankStockLook,
  type BankStockLookRow,
  type BankStockNotifyArgs,
  type BankStockNotifyCandidate,
  type BankStockWaitMemo,
} from '../../src/shared/bankStockNotify';
import type { BankStockNotifyKind, BankStockRow, OrderSummary, ScraptfTimingBrief, ScraptfTimingVerdict, ScraptfWatch } from '../../src/shared/types';
import { EMPTY_WATCH_INDEX, watchIndexOf } from '../../src/shared/watches';

const K = 600;
const T = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const URL_HATS = 'https://scrap.tf/buy/hats';
const BASE = '378;6';
const PAINTED = bankStockSpecialKey({ paint: 15185211 });

function order(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'BuyBot',
    keys: 0,
    metalScrap: 60,
    valueScrap: 60,
    isBot: true,
    online: true,
    lastEventAt: T,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

/** A new flip by default: 4.00 ref, sells for 6.66 ref, +2.22 ref, Pay up to 5.00 ref. */
function row(sku: string = BASE, over: Partial<BankStockRow> = {}, special = ''): BankStockRow {
  return {
    sku,
    key: `${sku}|${special}`,
    name: 'Team Captain',
    category: 'hats',
    hasExtras: special !== '',
    costKeys: 0,
    costScrapRaw: 36,
    costScrap: 36,
    stock: 1,
    change: 'new',
    previousCostScrap: null,
    previousStock: null,
    revenueScrap: 60,
    revenueOrder: order(),
    buyerCount: 3,
    maxCostScrap: 45,
    profitScrap: 20,
    margin: 20 / 36,
    verdict: 'flip',
    confidence: 70,
    confidenceLevel: 'high',
    listedSince: null,
    firstSeenAt: null,
    changeSinceListed: null,
    ...over,
  };
}

/** A row that is no flip: sells for 3.33 ref, Pay up to 2.77 ref, a loss at 4.00 ref. */
const OVER: Partial<BankStockRow> = { revenueScrap: 30, revenueOrder: order({ valueScrap: 30 }), maxCostScrap: 25, profitScrap: -6, margin: -6 / 36, verdict: 'over' };

function brief(verdict: ScraptfTimingVerdict, dropsThisRun = 0, horizonMs: number | null = 6 * HOUR): ScraptfTimingBrief {
  return {
    verdict,
    why: verdict === 'wait' ? 'drop-likely' : verdict === 'buy-now' ? 'flip-now' : verdict === 'over' ? 'over' : verdict === 'no-buyers' ? 'no-buyers' : 'few-drops',
    bank: 'hats',
    key: `${BASE}|`,
    dropsThisRun,
    steps: [],
    lastSeenAt: T,
    horizonMs,
    pDrop: null,
    pGone: null,
    pRise: null,
    nextDropAt: null,
    n: { states: 40, copies: 12, atRisk: 20, dropCopies: 6 },
  };
}

function watch(over: Partial<ScraptfWatch> = {}): ScraptfWatch {
  return {
    id: 1,
    sku: BASE,
    specialKey: '',
    name: 'Team Captain',
    maxCostKeys: 0,
    maxCostScrap: 40,
    minProfitScrap: null,
    onRestock: false,
    enabled: true,
    createdAt: T - DAY,
    updatedAt: T - DAY,
    ...over,
  };
}

const lr = (r: BankStockRow, restock = false): BankStockLookRow => ({ row: r, restock });

function look(rows: BankStockLookRow[], over: Partial<BankStockLook> = {}): BankStockLook {
  return { bank: 'hats', page: '', savedAt: T, previousSavedAt: T - HOUR, rows, ...over };
}

function args(rows: BankStockLookRow[], over: Partial<BankStockNotifyArgs> = {}): BankStockNotifyArgs {
  return {
    look: look(rows),
    flips: true,
    watches: EMPTY_WATCH_INDEX,
    minConfidence: 50,
    minProfitScrap: 9,
    keyScrap: K,
    suspect: () => false,
    timing: false,
    waitOf: () => null,
    ...over,
  };
}

const kinds = (cs: readonly BankStockNotifyCandidate[]): BankStockNotifyKind[] => cs.map((c) => c.kind);

describe("alerts' part of shared/bankStock.ts", () => {
  it('reads a cheaper flip as dropped under Pay up to only when its previous price was over it', () => {
    expect(bankStockDroppedIntoFlip({ change: 'cheaper', verdict: 'flip', previousCostScrap: 50, maxCostScrap: 45 })).toBe(true);
    // Already a flip on the save before.
    expect(bankStockDroppedIntoFlip({ change: 'cheaper', verdict: 'flip', previousCostScrap: 45, maxCostScrap: 45 })).toBe(false);
    expect(bankStockDroppedIntoFlip({ change: 'cheaper', verdict: 'over', previousCostScrap: 50, maxCostScrap: 45 })).toBe(false);
    expect(bankStockDroppedIntoFlip({ change: 'new', verdict: 'flip', previousCostScrap: 50, maxCostScrap: 45 })).toBe(false);
    expect(bankStockDroppedIntoFlip({ change: 'cheaper', verdict: 'flip', previousCostScrap: null, maxCostScrap: 45 })).toBe(false);
    expect(bankStockDroppedIntoFlip({ change: 'cheaper', verdict: 'flip', previousCostScrap: 50, maxCostScrap: null })).toBe(false);
  });

  it("dates a save's age the same way on every body, and keeps 0.7.4's new-flip text", () => {
    expect(bankStockSaveAgeNote(3 * HOUR)).toBe('; in your save 3 h ago');
    expect(bankStockSaveAgeNote(BANK_STOCK_NOTIFY_AGE_NOTE_MS)).toBe('; in your save 15 min ago');
    expect(bankStockSaveAgeNote(BANK_STOCK_NOTIFY_AGE_NOTE_MS - 1)).toBe('');
    expect(bankStockSaveAgeNote(null)).toBe('');
    expect(bankStockSaveAgeNote(undefined)).toBe('');
    const r = row();
    const plain = { title: 'New on scrap.tf (Hats): Team Captain', body: '4.00 ref, sells for 6.66 ref to BuyBot, +2.22 ref' };
    expect(bankStockNewFlipNotice('Hats', r, K)).toEqual(plain);
    expect(bankStockNewFlipNotice('Hats', r, K, 0, null)).toEqual(plain);
    expect(bankStockNewFlipNotice('Hats', r, K, 3 * HOUR).body).toBe(`${plain.body}; in your save 3 h ago`);
    // G4's wait note goes before the age part.
    expect(bankStockNewFlipNotice('Hats', r, K, 3 * HOUR, BANK_STOCK_WAIT_NOTE).body).toBe(
      `${plain.body}; your saves say it may drop again (Wait); in your save 3 h ago`,
    );
    expect(BANK_STOCK_MORE_BODY).toBe('From the page you saved. Open TF2 Flip Desk to see them.');
  });
});

describe('the candidate list', () => {
  it('gives one candidate per row, by kind (watch, new, cheaper, back, timing), then profit, name and key', () => {
    const w = watch({ id: 4, sku: '200;6', specialKey: null });
    const cs = bankStockNotifyCandidates(
      args(
        [
          lr(row('100;6', { change: null, profitScrap: 60, timing: brief('buy-now', 1) })),
          lr(row('101;6', { profitScrap: 40 }), true),
          lr(row('102;6', { change: 'cheaper', previousCostScrap: 50, profitScrap: 50 })),
          lr(row('103;6', { profitScrap: 30, name: 'B hat' })),
          lr(row('104;6', { profitScrap: 30, name: 'A hat' })),
          lr(row('105;6', { profitScrap: 35 })),
          // A new flip and a watch hit: told once, as the watch.
          lr(row('200;6', { profitScrap: 10 })),
        ],
        { watches: watchIndexOf([w]), timing: true, waitOf: () => ({ at: T - HOUR, since: T - HOUR, drops: 0, horizonMs: 6 * HOUR }) },
      ),
    );
    expect(cs.map((c) => [c.kind, c.row.sku])).toEqual([
      ['watch', '200;6'],
      ['new', '105;6'],
      ['new', '104;6'],
      ['new', '103;6'],
      ['cheaper', '102;6'],
      ['back', '101;6'],
      ['timing', '100;6'],
    ]);
    expect(cs.map((c) => c.chip)).toEqual(['watched', 'new', 'new', 'new', 'flips', 'new', 'flips']);
    expect(cs.map((c) => c.dedupeKey)).toEqual(['hats|200;6|w4', 'hats|105;6', 'hats|104;6', 'hats|103;6', 'hats|102;6', 'hats|101;6', 'hats|100;6']);
    expect(cs[0]).toMatchObject({ watch: w, hit: 'price', flip: true, restock: false });
    expect(cs.slice(1).every((c) => c.watch === null && c.hit === null && c.flip)).toBe(true);
    // The list is in bankStockNotifyOrder already.
    expect([...cs].sort(bankStockNotifyOrder)).toEqual(cs);
  });

  it('orders by kind, then most profit (none as 0), then name, then key', () => {
    const c = (kind: BankStockNotifyKind, over: Partial<BankStockRow>, special = '') => ({ kind, row: row(BASE, over, special) });
    expect(bankStockNotifyOrder(c('watch', { profitScrap: 1 }), c('new', { profitScrap: 99 }))).toBeLessThan(0);
    expect(bankStockNotifyOrder(c('new', { profitScrap: null }), c('new', { profitScrap: -3 }))).toBeLessThan(0);
    expect(bankStockNotifyOrder(c('new', { name: 'A' }), c('new', { name: 'B' }))).toBeLessThan(0);
    expect(bankStockNotifyOrder(c('new', {}), c('new', {}, PAINTED))).toBeLessThan(0);
    expect(bankStockNotifyOrder(c('new', {}), c('new', {}))).toBe(0);
  });

  it('keys a painted and a clean copy of one base alike for S3, and a watch hit by its watch', () => {
    expect(bankStockNotifyKey('hats', BASE)).toBe('hats|378;6');
    expect(bankStockWatchNotifyKey('hats', BASE, 12)).toBe('hats|378;6|w12');
    expect(bankStockWaitKey('hats', `${BASE}|`)).toBe('hats|378;6|');
    const cs = bankStockNotifyCandidates(args([lr(row(BASE, {})), lr(row(BASE, { profitScrap: 25 }, PAINTED))]));
    expect(cs.map((c) => [c.row.key, c.dedupeKey])).toEqual([
      [`${BASE}|${PAINTED}`, 'hats|378;6'],
      [`${BASE}|`, 'hats|378;6'],
    ]);
  });

  it('tells a new flip never listed before as new, and one listed before as back on sale', () => {
    expect(kinds(bankStockNotifyCandidates(args([lr(row(), false)])))).toEqual(['new']);
    expect(bankStockNotifyCandidates(args([lr(row(), true)]))[0]).toMatchObject({ kind: 'back', restock: true, chip: 'new', dedupeKey: 'hats|378;6' });
  });

  it('tells a cheaper row only when it dropped under Pay up to on this read', () => {
    expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { change: 'cheaper', previousCostScrap: 50 }))])))).toEqual(['cheaper']);
    expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { change: 'cheaper', previousCostScrap: 44 }))])))).toEqual([]);
    expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { change: 'pricier', previousCostScrap: 30 }))])))).toEqual([]);
    expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { change: null }))])))).toEqual([]);
    expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { change: 'gone' }))])))).toEqual([]);
  });

  it("applies S3's gates: confidence, profit, a verified order, and the flip suspect check", () => {
    const one = (over: Partial<BankStockRow>, a: Partial<BankStockNotifyArgs> = {}) => kinds(bankStockNotifyCandidates(args([lr(row(BASE, over))], a)));
    expect(one({ confidence: 49 })).toEqual([]);
    expect(one({ confidence: null })).toEqual([]);
    expect(one({ confidence: null }, { minConfidence: 0 })).toEqual(['new']);
    expect(one({ profitScrap: 8 })).toEqual([]);
    expect(one({ profitScrap: null })).toEqual([]);
    expect(one({ revenueOrder: order({ flags: ['unverified'] }) })).toEqual([]);
    expect(one({ verdict: 'over' })).toEqual([]);
    expect(one({ listFamily: true, verdict: 'no-buyers', revenueScrap: null, profitScrap: null })).toEqual([]);
    expect(one({}, { suspect: (_r, what) => what === 'flip' })).toEqual([]);
    expect(one({}, { flips: false })).toEqual([]);
  });

  it('asks the suspect check last, once per row and kind, and only for a row a candidate needs', () => {
    const calls: string[] = [];
    const suspect = (r: BankStockRow, what: 'flip' | 'cost'): boolean => {
      calls.push(`${r.sku} ${what}`);
      return false;
    };
    bankStockNotifyCandidates(
      args(
        [
          // Unchanged flip, no watch, timing off: nothing to tell, nothing asked.
          lr(row('100;6', { change: null })),
          // Below the confidence bar: never asked.
          lr(row('101;6', { confidence: 10 })),
          // A watch hit on a new flip: the cost checks for the price hit, then the flip check for `flip`.
          lr(row(BASE)),
          lr(row('102;6')),
        ],
        { suspect, watches: watchIndexOf([watch()]) },
      ),
    );
    expect(calls).toEqual(['378;6 cost', '378;6 flip', '102;6 flip']);
  });

  describe("G4: Wait to Buy now (opt-in, notifications.buyTiming)", () => {
    const at = (i: number): number => T + i * 30 * MIN;

    /** Told looks of one unchanged flip, one after another, with G4's memory carried as the service does. */
    function tell(seq: { verdict: ScraptfTimingVerdict; drops?: number; horizonMs?: number | null; at: number }[], timing = true): BankStockNotifyKind[][] {
      let memo = new Map<string, BankStockWaitMemo>();
      let prev: number | null = at(-1);
      const out: BankStockNotifyKind[][] = [];
      for (const s of seq) {
        const r = row(BASE, { change: null, timing: brief(s.verdict, s.drops ?? 0, s.horizonMs === undefined ? 6 * HOUR : s.horizonMs) });
        const lk = look([lr(r)], { savedAt: s.at, previousSavedAt: prev });
        const memoNow = memo;
        out.push(kinds(bankStockNotifyCandidates(args([], { look: lk, timing, waitOf: (x) => memoNow.get(bankStockWaitKey('hats', x.key)) ?? null }))));
        if (timing) memo = bankStockTimingNext(memo, lk, s.at) ?? memo;
        prev = s.at;
      }
      return out;
    }

    it('fires on Buy now right after a Wait when a drop showed since the streak began', () => {
      expect(tell([{ verdict: 'wait', at: at(0) }, { verdict: 'buy-now', drops: 1, at: at(1) }])).toEqual([[], ['timing']]);
      expect(tell([{ verdict: 'wait', drops: 2, at: at(0) }, { verdict: 'wait', drops: 2, at: at(1) }, { verdict: 'buy-now', drops: 3, at: at(2) }])).toEqual([[], [], ['timing']]);
    });

    it("fires when the first Wait's horizon has passed", () => {
      expect(
        tell([
          { verdict: 'wait', horizonMs: 6 * HOUR, at: T },
          // A later Wait naming another horizon does not move the first one.
          { verdict: 'wait', horizonMs: DAY, at: T + 3 * HOUR },
          { verdict: 'buy-now', at: T + 6 * HOUR },
        ]),
      ).toEqual([[], [], ['timing']]);
      expect(tell([{ verdict: 'wait', horizonMs: 6 * HOUR, at: T }, { verdict: 'buy-now', at: T + 6 * HOUR - 1 }])).toEqual([[], []]);
      // No horizon named: only a drop can turn it.
      expect(tell([{ verdict: 'wait', horizonMs: null, at: T }, { verdict: 'buy-now', at: T + DAY }])).toEqual([[], []]);
    });

    it('never fires on aging alone, even when the verdict flips back and forth across one pooled event time', () => {
      expect(tell([{ verdict: 'wait', at: at(0) }, { verdict: 'buy-now', at: at(1) }])).toEqual([[], []]);
      expect(
        tell([
          { verdict: 'wait', at: at(0) },
          { verdict: 'buy-now', at: at(1) },
          { verdict: 'wait', at: at(2) },
          { verdict: 'buy-now', at: at(3) },
        ]),
      ).toEqual([[], [], [], []]);
    });

    it('never fires after a Wait from an older save, after not-enough-data, or on Buy now after Buy now', () => {
      const r = row(BASE, { change: null, timing: brief('buy-now', 5) });
      const older: BankStockWaitMemo = { at: T - 3 * HOUR, since: T - 3 * HOUR, drops: 0, horizonMs: 6 * HOUR };
      expect(kinds(bankStockNotifyCandidates(args([lr(r)], { timing: true, waitOf: () => older })))).toEqual([]);
      // A first save of the page has no read before.
      expect(kinds(bankStockNotifyCandidates(args([lr(r)], { look: look([lr(r)], { previousSavedAt: null }), timing: true, waitOf: () => ({ ...older, at: T - HOUR }) })))).toEqual([]);
      expect(tell([{ verdict: 'wait', at: at(0) }, { verdict: 'not-enough-data', at: at(1) }, { verdict: 'buy-now', drops: 1, at: at(2) }])).toEqual([[], [], []]);
      expect(tell([{ verdict: 'buy-now', at: at(0) }, { verdict: 'buy-now', drops: 1, at: at(1) }])).toEqual([[], []]);
      for (const v of ['over', 'no-buyers', 'not-enough-data'] as const) {
        expect(tell([{ verdict: 'wait', at: at(0) }, { verdict: v, drops: 1, at: at(1) }])).toEqual([[], []]);
      }
    });

    it('gives no timing candidate while notifications.buyTiming is off (the default)', () => {
      expect(tell([{ verdict: 'wait', at: at(0) }, { verdict: 'buy-now', drops: 1, at: at(1) }], false)).toEqual([[], []]);
    });

    it('lets a new or cheaper flip keep its own kind, and still needs the flip gates', () => {
      const waitOf = (): BankStockWaitMemo => ({ at: T - HOUR, since: T - HOUR, drops: 0, horizonMs: 6 * HOUR });
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { timing: brief('buy-now', 1) }))], { timing: true, waitOf })))).toEqual(['new']);
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { change: null, confidence: 10, timing: brief('buy-now', 1) }))], { timing: true, waitOf })))).toEqual([]);
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { change: null, timing: brief('buy-now', 1) }))], { timing: true, flips: false, waitOf })))).toEqual([]);
    });
  });

  describe('watches (G1, G3)', () => {
    const index = (over: Partial<ScraptfWatch> = {}) => watchIndexOf([watch(over)]);

    it('fires a met watch on a new or cheaper read, or a fresh one (a first save, a watch edited since)', () => {
      expect(bankStockNotifyCandidates(args([lr(row(BASE, OVER))], { watches: index() }))[0]).toMatchObject({ kind: 'watch', hit: 'price', flip: false, chip: 'watched', dedupeKey: 'hats|378;6|w1' });
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { ...OVER, change: 'cheaper', previousCostScrap: 50 }))], { watches: index() })))).toEqual(['watch']);
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { ...OVER, change: null }))], { watches: index() })))).toEqual([]);
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { ...OVER, change: null }))], { watches: index({ updatedAt: T - HOUR / 2 }) })))).toEqual(['watch']);
      const first = look([lr(row(BASE, { ...OVER, change: null }))], { previousSavedAt: null });
      expect(kinds(bankStockNotifyCandidates(args([], { look: first, watches: index() })))).toEqual(['watch']);
      // A profit hit, with S3's bar not reached.
      const profit = index({ maxCostScrap: null, minProfitScrap: 5 });
      expect(bankStockNotifyCandidates(args([lr(row(BASE, { profitScrap: 6 }))], { watches: profit }))[0]).toMatchObject({ kind: 'watch', hit: 'profit', flip: false });
    });

    it('skips a price hit on a flagged cost and a profit hit on a suspect margin', () => {
      const costFlag = (_r: BankStockRow, what: 'flip' | 'cost') => what === 'cost' || what === 'flip';
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, OVER))], { watches: index({ onRestock: true }), suspect: costFlag })))).toEqual([]);
      const marginOnly = (_r: BankStockRow, what: 'flip' | 'cost') => what === 'flip';
      expect(bankStockNotifyCandidates(args([lr(row())], { watches: index(), suspect: marginOnly }))[0]).toMatchObject({ kind: 'watch', hit: 'price', flip: false });
      // Under S3's bar, so only the profit target could tell it.
      const small = row(BASE, { profitScrap: 6 });
      expect(kinds(bankStockNotifyCandidates(args([lr(small)], { watches: index({ maxCostScrap: null, minProfitScrap: 0 }) })))).toEqual(['watch']);
      expect(kinds(bankStockNotifyCandidates(args([lr(small)], { watches: index({ maxCostScrap: null, minProfitScrap: 0 }), suspect: marginOnly })))).toEqual([]);
    });

    it('never judges a watch on an /items family row', () => {
      const fam = row(BASE, { ...OVER, listFamily: true, verdict: 'no-buyers', revenueScrap: null, revenueOrder: null, profitScrap: null, maxCostScrap: null });
      expect(kinds(bankStockNotifyCandidates(args([lr(fam, true)], { watches: index({ specialKey: null, onRestock: true }), look: look([lr(fam, true)], { previousSavedAt: null }) })))).toEqual([]);
    });

    it('tells a watched copy that is no flip on sale again as back, and at a first sighting as new, with its watch', () => {
      const w = watch({ maxCostScrap: 20, onRestock: true });
      const back = bankStockNotifyCandidates(args([lr(row(BASE, OVER), true)], { watches: watchIndexOf([w]) }));
      expect(back).toEqual([{ kind: 'back', row: row(BASE, OVER), restock: true, watch: w, hit: null, flip: false, doubt: null, tellsFlip: false, dedupeKey: 'hats|378;6', chip: 'new' }]);
      expect(bankStockNotifyCandidates(args([lr(row(BASE, OVER), false)], { watches: watchIndexOf([w]) }))[0]).toMatchObject({ kind: 'new', watch: w, flip: false });
      // A new flip with that watch is told as the flip it is.
      expect(bankStockNotifyCandidates(args([lr(row(), true)], { watches: watchIndexOf([w]) }))[0]).toMatchObject({ kind: 'back', watch: null, flip: true });
      // With the scrap.tf flips toggle off, the watch still asks for it.
      expect(bankStockNotifyCandidates(args([lr(row(), true)], { watches: watchIndexOf([w]), flips: false }))[0]).toMatchObject({ kind: 'back', watch: w, flip: false });
      // Not on sale again (unchanged), or no "back on sale" asked: nothing.
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, { ...OVER, change: null }))], { watches: watchIndexOf([w]) })))).toEqual([]);
      expect(kinds(bankStockNotifyCandidates(args([lr(row(BASE, OVER), true)], { watches: index({ maxCostScrap: 20 }) })))).toEqual([]);
    });

    it('tells nothing of a watch when watches are off, and only watches when the flips toggle is off', () => {
      const rows = [lr(row()), lr(row('5021;6', OVER))];
      const both = watchIndexOf([watch(), watch({ id: 2, sku: '5021;6' })]);
      expect(kinds(bankStockNotifyCandidates(args(rows, { watches: EMPTY_WATCH_INDEX })))).toEqual(['new']);
      expect(bankStockNotifyCandidates(args(rows, { watches: both, flips: false })).map((c) => [c.kind, c.row.sku, c.flip])).toEqual([
        ['watch', BASE, false],
        ['watch', '5021;6', false],
      ]);
      expect(bankStockNotifyCandidates(args(rows, { watches: both })).map((c) => [c.kind, c.row.sku, c.flip])).toEqual([
        ['watch', BASE, true],
        ['watch', '5021;6', false],
      ]);
    });

    it("doubts a verified sale a watch or G3 toast would quote, on F5's margin check, then the confidence bar", () => {
      const marginOnly = (_r: BankStockRow, what: 'flip' | 'cost') => what === 'flip';
      const one = (r: BankStockRow, a: Partial<BankStockNotifyArgs> = {}, restock = false) => bankStockNotifyCandidates(args([lr(r, restock)], { watches: index(), ...a }))[0];
      expect(one(row(), { suspect: marginOnly })).toMatchObject({ kind: 'watch', hit: 'price', doubt: 'suspect', tellsFlip: false });
      expect(one(row(BASE, { confidence: 30 }))).toMatchObject({ kind: 'watch', hit: 'price', doubt: 'low-confidence', tellsFlip: false });
      // Both: the margin is the reason given.
      expect(one(row(BASE, { confidence: 30 }), { suspect: marginOnly })).toMatchObject({ doubt: 'suspect' });
      expect(one(row())).toMatchObject({ doubt: null, tellsFlip: true });
      // No buyer or an unconfirmed order: the texts say so, nothing is doubted (and the suspect check is not asked).
      const asked: string[] = [];
      const none = row(BASE, { revenueScrap: null, revenueOrder: null, profitScrap: null, maxCostScrap: null, verdict: 'no-buyers', confidence: 0 });
      expect(one(none, { suspect: (_r, what) => (asked.push(what), false) })).toMatchObject({ doubt: null, tellsFlip: false });
      expect(asked).toEqual(['cost']);
      expect(one(row(BASE, { revenueOrder: order({ flags: ['unverified'] }), confidence: 0 }))).toMatchObject({ doubt: null, tellsFlip: false });
      // G3: only a flip's sale is quoted, so only a flip is doubted.
      const g3 = { watches: index({ maxCostScrap: 20, onRestock: true }) };
      expect(one(row(), { ...g3, suspect: marginOnly }, true)).toMatchObject({ kind: 'back', flip: false, doubt: 'suspect', tellsFlip: false });
      expect(one(row(BASE, { confidence: 30 }), g3, true)).toMatchObject({ kind: 'back', flip: false, doubt: 'low-confidence', tellsFlip: false });
      expect(one(row(BASE, { ...OVER, confidence: 30 }), { ...g3, suspect: marginOnly }, true)).toMatchObject({ kind: 'back', doubt: null, tellsFlip: false });
      // A profit hit already passed the margin check and the bar.
      expect(one(row(BASE, { profitScrap: 6 }), { watches: index({ maxCostScrap: null, minProfitScrap: 5 }) })).toMatchObject({ hit: 'profit', doubt: null, tellsFlip: true });
    });

    it('tells deps.told only of a toast that tells a flip the engine would tell (tellsFlip)', () => {
      const one = (r: BankStockRow, a: Partial<BankStockNotifyArgs> = {}, restock = false) => bankStockNotifyCandidates(args([lr(r, restock)], a))[0];
      // Every S3 kind passed the flip gates.
      expect(one(row())).toMatchObject({ kind: 'new', flip: true, tellsFlip: true });
      // A price hit on a verified flip at S3's bar, with the flips toggle off too (the engine's "Profit:" still tells it).
      expect(one(row(), { watches: index() })).toMatchObject({ kind: 'watch', flip: true, tellsFlip: true });
      expect(one(row(), { watches: index(), flips: false })).toMatchObject({ kind: 'watch', flip: false, tellsFlip: true });
      // Under S3's bar and no profit target: the engine would not tell it, so its later toast stays free.
      expect(one(row(BASE, { profitScrap: 6 }), { watches: index() })).toMatchObject({ kind: 'watch', hit: 'price', tellsFlip: false });
      // ...unless a watch's profit target is the engine's bar for this copy (path B), and the row is over it.
      expect(one(row(BASE, { profitScrap: 6 }), { watches: watchIndexOf([watch(), watch({ id: 2, specialKey: null, maxCostScrap: null, minProfitScrap: 5 })]) })).toMatchObject({
        kind: 'watch',
        hit: 'price',
        tellsFlip: true,
      });
      // No flip (a loss), no buyer or an unconfirmed order: never.
      expect(one(row(BASE, OVER), { watches: index() })).toMatchObject({ kind: 'watch', tellsFlip: false });
      expect(one(row(BASE, { revenueOrder: order({ flags: ['unverified'] }) }), { watches: index() })).toMatchObject({ kind: 'watch', tellsFlip: false });
      // G3 of a flip told only because the flips toggle is off: the engine would tell it.
      expect(one(row(), { watches: index({ maxCostScrap: 20, onRestock: true }), flips: false }, true)).toMatchObject({ kind: 'back', flip: false, tellsFlip: true });
    });
  });
});

describe('the texts', () => {
  const r = row();

  it('words the sale, a loss included', () => {
    expect(bankStockSaleText(r, K)).toBe('sells for 6.66 ref to BuyBot, +2.22 ref');
    expect(bankStockSaleText(row(BASE, { ...OVER, revenueOrder: order({ userName: null }) }), K)).toBe('sells for 3.33 ref to 76561198000000001, -0.66 ref');
    expect(bankStockSaleText({ revenueScrap: 60, revenueOrder: null, profitScrap: 700 }, K)).toBe('sells for 6.66 ref to a buyer, +1 key 11.11 ref');
  });

  it('words "Cheaper on scrap.tf" with the drop and today\'s Pay up to', () => {
    const c = row(BASE, { change: 'cheaper', previousCostScrap: 50 });
    expect(bankStockDroppedFlipNotice('Hats', c, K)).toEqual({
      title: 'Cheaper on scrap.tf (Hats): Team Captain',
      body: '5.55 ref → 4.00 ref, now under Pay up to 5.00 ref; sells for 6.66 ref to BuyBot, +2.22 ref',
    });
    // The wait note only with G4 on (notifications.buyTiming); off, the default, the text has none.
    expect(bankStockDroppedFlipNotice('Hats', { ...c, timing: brief('wait', 1) }, K, 3 * HOUR, true).body).toBe(
      '5.55 ref → 4.00 ref, now under Pay up to 5.00 ref; sells for 6.66 ref to BuyBot, +2.22 ref; your saves say it may drop again (Wait); in your save 3 h ago',
    );
    expect(bankStockDroppedFlipNotice('Hats', { ...c, timing: brief('wait') }, K, 3 * HOUR).body).toBe(
      '5.55 ref → 4.00 ref, now under Pay up to 5.00 ref; sells for 6.66 ref to BuyBot, +2.22 ref; in your save 3 h ago',
    );
  });

  it('words "Back on scrap.tf" without saying it just came back', () => {
    const n = bankStockBackNotice('Hats', r, K);
    expect(n).toEqual({ title: 'Back on scrap.tf (Hats): Team Captain', body: '4.00 ref, sells for 6.66 ref to BuyBot, +2.22 ref; on sale again in your saves' });
    expect(n.body).not.toMatch(/\bjust\b/);
    // Back on sale: a new run with no drop yet, so the note says "may drop", not "again".
    expect(bankStockBackNotice('Hats', { ...r, timing: brief('wait') }, K, DAY, true).body).toBe(
      '4.00 ref, sells for 6.66 ref to BuyBot, +2.22 ref; on sale again in your saves; your saves say it may drop (Wait); in your save 24 h ago',
    );
    expect(bankStockBackNotice('Hats', { ...r, timing: brief('wait', 2) }, K, DAY, true).body).toContain('; your saves say it may drop again (Wait)');
    expect(bankStockBackNotice('Hats', { ...r, timing: brief('wait') }, K, DAY).body).toBe('4.00 ref, sells for 6.66 ref to BuyBot, +2.22 ref; on sale again in your saves; in your save 24 h ago');
  });

  it('words a watched copy on sale: a flip, no flip, no buyer, an unconfirmed order', () => {
    const w = watch({ maxCostScrap: 30, onRestock: true });
    expect(bankStockWatchedOnSaleNotice('Hats', r, watch({ maxCostScrap: null, onRestock: true }), true, K)).toEqual({
      title: 'Back on scrap.tf (Hats): Team Captain',
      body: '4.00 ref, on sale again in your saves; sells for 6.66 ref to BuyBot, +2.22 ref; you watch it (back on sale)',
    });
    expect(bankStockWatchedOnSaleNotice('Hats', row(BASE, OVER), w, false, K)).toEqual({
      title: 'New on scrap.tf (Hats): Team Captain',
      body: '4.00 ref; not a flip (sells for 3.33 ref, Pay up to 2.77 ref); you watch it (≤ 3.33 ref · back on sale)',
    });
    expect(bankStockWatchedOnSaleNotice('Hats', row(BASE, { ...OVER, maxCostScrap: null }), w, false, K).body).toBe(
      '4.00 ref; not a flip (sells for 3.33 ref); you watch it (≤ 3.33 ref · back on sale)',
    );
    const none = row(BASE, { revenueScrap: null, revenueOrder: null, profitScrap: null, maxCostScrap: null, verdict: 'no-buyers' });
    expect(bankStockWatchedOnSaleNotice('Hats', none, w, true, K, 3 * HOUR).body).toBe(
      '4.00 ref, on sale again in your saves; no backpack.tf buyer yet; you watch it (≤ 3.33 ref · back on sale); in your save 3 h ago',
    );
    expect(bankStockWatchedOnSaleNotice('Hats', row(BASE, { revenueOrder: order({ flags: ['unverified'] }) }), w, false, K).body).toBe(
      '4.00 ref; its buy order is unconfirmed; you watch it (≤ 3.33 ref · back on sale)',
    );
  });

  it('words a price hit, with the key price used when the target and the cost differ in keys', () => {
    expect(bankStockWatchNotice('Hats', r, watch(), 'price', false, K)).toEqual({
      title: 'Watch (Hats): Team Captain',
      body: '4.00 ref, at or under your ≤ 4.44 ref; sells for 6.66 ref to BuyBot, +2.22 ref',
    });
    expect(bankStockWatchNotice('Hats', r, watch(), 'price', true, K, 3 * HOUR).body).toBe(
      '4.00 ref, at or under your ≤ 4.44 ref, on sale again in your saves; sells for 6.66 ref to BuyBot, +2.22 ref; in your save 3 h ago',
    );
    const keysTarget = watch({ maxCostKeys: 1, maxCostScrap: 0 });
    const metal = row(BASE, { costScrap: 590, costScrapRaw: 590 });
    expect(bankStockWatchNotice('Hats', metal, keysTarget, 'price', false, K).body).toBe(
      '65.55 ref, at or under your ≤ 1 key; compared at 1 key = 66.66 ref; sells for 6.66 ref to BuyBot, +2.22 ref',
    );
    // The reverse: a metal target against a price in keys.
    const keyed = row(BASE, { costKeys: 1, costScrapRaw: 0, costScrap: 600 });
    expect(bankStockWatchNotice('Hats', keyed, watch({ maxCostScrap: 610 }), 'price', false, K).body).toBe(
      '1 key, at or under your ≤ 67.77 ref; compared at 1 key = 66.66 ref; sells for 6.66 ref to BuyBot, +2.22 ref',
    );
    // Same unit, or no key price known: no note.
    expect(bankStockWatchNotice('Hats', keyed, watch({ maxCostKeys: 1, maxCostScrap: 5 }), 'price', false, K).body).toBe(
      '1 key, at or under your ≤ 1 key 0.55 ref; sells for 6.66 ref to BuyBot, +2.22 ref',
    );
    expect(bankStockWatchNotice('Hats', metal, keysTarget, 'price', false, null).body).toBe('65.55 ref, at or under your ≤ 1 key; sells for 6.66 ref to BuyBot, +2.22 ref');
  });

  it('words why a price hit has no sale: an unconfirmed order or no buyer', () => {
    expect(bankStockWatchNotice('Hats', row(BASE, { revenueOrder: order({ flags: ['unverified'] }) }), watch(), 'price', false, K).body).toBe(
      '4.00 ref, at or under your ≤ 4.44 ref; its buy order is unconfirmed',
    );
    const none = row(BASE, { revenueScrap: null, revenueOrder: null, profitScrap: null, maxCostScrap: null, verdict: 'no-buyers' });
    expect(bankStockWatchNotice('Hats', none, watch(), 'price', false, K).body).toBe('4.00 ref, at or under your ≤ 4.44 ref; no backpack.tf buyer yet');
  });

  it("never quotes a profit F5's margin guard or the confidence bar holds back, on a price hit or a watched copy on sale", () => {
    // One non-bot buyer at 22.22 ref against a 3.33 ref cost, no reference: the margin is suspect.
    const outlier = row(BASE, { costScrap: 30, costScrapRaw: 30, revenueScrap: 200, revenueOrder: order({ userName: 'OneBuyer', valueScrap: 200, isBot: false }), profitScrap: 170, buyerCount: 1, confidence: 30 });
    const w = watch({ maxCostScrap: 60, onRestock: true });
    expect(bankStockWatchNotice('Hats', outlier, w, 'price', false, K, null, 'suspect').body).toBe(
      '3.33 ref, at or under your ≤ 6.66 ref; a suspect margin (few buy orders, no usable reference), so no profit is quoted',
    );
    expect(bankStockWatchNotice('Hats', outlier, w, 'price', false, K, null, 'low-confidence').body).toBe(
      '3.33 ref, at or under your ≤ 6.66 ref; its buy side is under your minimum confidence, so no profit is quoted',
    );
    expect(bankStockWatchedOnSaleNotice('Hats', outlier, w, true, K, null, 'suspect').body).toBe(
      '3.33 ref, on sale again in your saves; a suspect margin (few buy orders, no usable reference), so no profit is quoted; you watch it (≤ 6.66 ref · back on sale)',
    );
    for (const body of [bankStockWatchNotice('Hats', outlier, w, 'price', false, K, null, 'suspect').body, bankStockWatchedOnSaleNotice('Hats', outlier, w, false, K, null, 'low-confidence').body]) {
      expect(body).not.toMatch(/\+18\.88|22\.22/);
    }
    // No buyer and an unconfirmed order keep their own words; no flip quotes no profit anyway.
    expect(bankStockWatchNotice('Hats', row(BASE, { revenueOrder: order({ flags: ['unverified'] }) }), watch(), 'price', false, K, null, 'suspect').body).toMatch(/its buy order is unconfirmed$/);
    expect(bankStockWatchedOnSaleNotice('Hats', row(BASE, OVER), w, false, K, null, 'suspect').body).toContain('not a flip (sells for 3.33 ref, Pay up to 2.77 ref)');
    // The candidate's doubt picks the words.
    const marginOnly = (_r: BankStockRow, what: 'flip' | 'cost') => what === 'flip';
    const [c] = bankStockNotifyCandidates(args([lr(outlier)], { watches: watchIndexOf([w]), suspect: marginOnly }));
    expect(c).toMatchObject({ kind: 'watch', hit: 'price', doubt: 'suspect' });
    expect(bankStockNoticeOf(c!, 'Hats', K, null).body).toBe('3.33 ref, at or under your ≤ 6.66 ref; a suspect margin (few buy orders, no usable reference), so no profit is quoted');
    const [g3] = bankStockNotifyCandidates(args([lr(outlier, true)], { watches: watchIndexOf([watch({ maxCostScrap: null, onRestock: true })]), suspect: marginOnly }));
    expect(g3).toMatchObject({ kind: 'back', flip: false, doubt: 'suspect' });
    expect(bankStockNoticeOf(g3!, 'Hats', K, null).body).not.toContain('+');
  });

  it('words a profit hit', () => {
    expect(bankStockWatchNotice('Hats', r, watch({ maxCostScrap: null, minProfitScrap: 18 }), 'profit', false, K)).toEqual({
      title: 'Watch (Hats): Team Captain',
      body: '4.00 ref, sells for 6.66 ref to BuyBot, +2.22 ref: at or over your +2.00 ref',
    });
    expect(bankStockWatchNotice('Hats', r, watch({ maxCostScrap: null, minProfitScrap: 18 }), 'profit', true, K, 2 * DAY).body).toBe(
      '4.00 ref, sells for 6.66 ref to BuyBot, +2.22 ref: at or over your +2.00 ref, on sale again in your saves; in your save 2 d ago',
    );
  });

  it('words "Buy now" as an estimate from the saves, never a forecast', () => {
    const n = bankStockBuyNowNotice('Hats', r, K);
    expect(n).toEqual({
      title: 'Buy now (Hats): Team Captain',
      body: '4.00 ref, sells for 6.66 ref to BuyBot, +2.22 ref; your saves said wait on the read before, now buy now (an estimate from your saves, not a forecast)',
    });
    expect(n.body).not.toMatch(/\bwill\b|\blikely\b/);
    expect(bankStockBuyNowNotice('Hats', r, K, 3 * HOUR).body).toMatch(/not a forecast\); in your save 3 h ago$/);
  });

  it('picks the text by kind', () => {
    const w = watch({ onRestock: true });
    const base: BankStockNotifyCandidate = { kind: 'new', row: r, restock: false, watch: null, hit: null, flip: true, doubt: null, tellsFlip: true, dedupeKey: 'hats|378;6', chip: 'new' };
    const ago = 3 * HOUR;
    expect(bankStockNoticeOf(base, 'Hats', K, ago)).toEqual(bankStockNewFlipNotice('Hats', r, K, ago));
    const waiting = { ...base, row: { ...r, timing: brief('wait', 1) } };
    expect(bankStockNoticeOf(waiting, 'Hats', K, ago, true)).toEqual(bankStockNewFlipNotice('Hats', waiting.row, K, ago, BANK_STOCK_WAIT_NOTE));
    // A never-seen listing reading Wait on the bank's pooled saves alone has not dropped: no "again".
    const fresh = { ...base, row: { ...r, timing: brief('wait', 0) } };
    expect(bankStockNoticeOf(fresh, 'Hats', K, ago, true)).toEqual(bankStockNewFlipNotice('Hats', fresh.row, K, ago, BANK_STOCK_WAIT_NOTE_FIRST));
    expect(BANK_STOCK_WAIT_NOTE_FIRST).toBe('; your saves say it may drop (Wait)');
    expect(bankStockNoticeOf(fresh, 'Hats', K, ago).body).not.toMatch(/may drop/);
    // G4 off (the default): a new flip reading Wait is told with 0.7.4's text, as are cheaper and back.
    expect(bankStockNoticeOf(waiting, 'Hats', K, ago)).toEqual(bankStockNewFlipNotice('Hats', r, K, ago));
    expect(bankStockNoticeOf(waiting, 'Hats', K, ago, false).body).not.toContain(BANK_STOCK_WAIT_NOTE);
    expect(bankStockNoticeOf({ ...waiting, kind: 'cheaper', chip: 'flips' }, 'Hats', K, ago).body).not.toContain(BANK_STOCK_WAIT_NOTE);
    expect(bankStockNoticeOf({ ...waiting, kind: 'back', restock: true }, 'Hats', K, ago).body).not.toContain(BANK_STOCK_WAIT_NOTE);
    expect(bankStockNoticeOf({ ...waiting, kind: 'back', restock: true }, 'Hats', K, ago, true).body).toContain(BANK_STOCK_WAIT_NOTE);
    expect(bankStockNoticeOf({ ...base, flip: false, watch: w }, 'Hats', K, ago)).toEqual(bankStockWatchedOnSaleNotice('Hats', r, w, false, K, ago));
    expect(bankStockNoticeOf({ ...base, kind: 'back', restock: true }, 'Hats', K, ago)).toEqual(bankStockBackNotice('Hats', r, K, ago));
    expect(bankStockNoticeOf({ ...base, kind: 'back', restock: true, flip: false, watch: w }, 'Hats', K, ago)).toEqual(bankStockWatchedOnSaleNotice('Hats', r, w, true, K, ago));
    expect(bankStockNoticeOf({ ...base, kind: 'cheaper', chip: 'flips' }, 'Hats', K, ago)).toEqual(bankStockDroppedFlipNotice('Hats', r, K, ago));
    expect(bankStockNoticeOf({ ...base, kind: 'timing', chip: 'flips' }, 'Hats', K, ago)).toEqual(bankStockBuyNowNotice('Hats', r, K, ago));
    expect(bankStockNoticeOf({ ...base, kind: 'watch', watch: w, hit: 'price', restock: true, chip: 'watched' }, 'Hats', K, null)).toEqual(
      bankStockWatchNotice('Hats', r, w, 'price', true, K, null),
    );
  });
});

describe('summaries (G5)', () => {
  const c = (kind: BankStockNotifyKind, flip: boolean, chip: BankStockNotifyCandidate['chip'] = kind === 'watch' ? 'watched' : kind === 'new' || kind === 'back' ? 'new' : 'flips') => ({ kind, flip, chip });

  it('counts by word in a fixed order, watched copies that are no flip as watched', () => {
    expect(bankStockNotifyWords([c('new', true), c('new', true), c('cheaper', true), c('watch', false)])).toBe('2 new, 1 cheaper, 1 watched');
    expect(bankStockNotifyWords([c('timing', true), c('watch', true), c('back', false), c('back', true), c('new', false), c('cheaper', true), c('new', true)])).toBe(
      '1 new, 1 cheaper, 1 back on sale, 1 buy now, 3 watched',
    );
    expect(bankStockNotifyWords([])).toBe('');
  });

  it("keeps 0.7.4's summary for new flips alone, and names the kinds otherwise", () => {
    expect(bankStockSummaryNotice([c('new', true), c('new', true)], URL_HATS)).toEqual({ title: '+2 more new flips on scrap.tf/buy/hats', body: BANK_STOCK_MORE_BODY });
    expect(bankStockSummaryNotice([c('new', true)], 'https://scrap.tf/items')).toEqual({ title: '+1 more new flip on scrap.tf/items', body: BANK_STOCK_MORE_BODY });
    expect(bankStockSummaryNotice([c('new', true), c('cheaper', true), c('watch', false), c('new', false)], URL_HATS)).toEqual({
      title: '+4 more on scrap.tf/buy/hats: 1 new, 1 cheaper, 2 watched',
      body: BANK_STOCK_MORE_BODY,
    });
  });

  it("keeps 0.7.4's old-save summary for new flips alone, and names the kinds otherwise", () => {
    expect(bankStockOldSaveSummary([c('new', true), c('new', true), c('new', true)], URL_HATS, 2 * DAY)).toEqual(bankStockOldSaveNotice(3, URL_HATS, 2 * DAY));
    const old = bankStockOldSaveNotice(1, URL_HATS, 2 * DAY);
    expect(bankStockOldSaveSummary([c('watch', false)], URL_HATS, 2 * DAY)).toEqual({ title: '1 item in your save of scrap.tf/buy/hats from 2 d ago: 1 watched', body: old.body });
    expect(bankStockOldSaveSummary([c('back', true), c('timing', true)], URL_HATS, 5 * HOUR).title).toBe('2 items in your save of scrap.tf/buy/hats from 5 h ago: 1 back on sale, 1 buy now');
  });

  it('opens on the common chip, else Flips when all are flips, else Watched', () => {
    expect(bankStockSummaryChip([c('new', true), c('back', true)])).toBe('new');
    expect(bankStockSummaryChip([c('watch', false), c('watch', true)])).toBe('watched');
    expect(bankStockSummaryChip([c('new', true), c('cheaper', true)])).toBe('flips');
    expect(bankStockSummaryChip([c('watch', true), c('timing', true)])).toBe('flips');
    expect(bankStockSummaryChip([c('watch', false), c('new', true)])).toBe('watched');
    expect(bankStockSummaryChip([c('new', false), c('cheaper', true)])).toBe('watched');
    expect(bankStockSummaryChip([])).toBe('new');
  });
});

describe("G4's memory of Wait", () => {
  const KEY = bankStockWaitKey('hats', `${BASE}|`);
  const waitRow = (drops = 2, horizonMs: number | null = 6 * HOUR) => lr(row(BASE, { change: null, timing: brief('wait', drops, horizonMs) }));

  it('starts a streak at a Wait, and lets it go on (only `at` moves) when the read before said Wait', () => {
    expect(bankStockTimingNext(new Map(), look([waitRow()]), T)).toEqual(new Map([[KEY, { at: T, since: T, drops: 2, horizonMs: 6 * HOUR }]]));
    const going = new Map([[KEY, { at: T - HOUR, since: T - 2 * HOUR, drops: 1, horizonMs: 6 * HOUR }]]);
    expect(bankStockTimingNext(going, look([waitRow(3, DAY)]), T)).toEqual(new Map([[KEY, { at: T, since: T - 2 * HOUR, drops: 1, horizonMs: 6 * HOUR }]]));
    // A Wait from an older save is no streak this read goes on: a new one starts.
    const older = new Map([[KEY, { at: T - 3 * HOUR, since: T - 4 * HOUR, drops: 1, horizonMs: DAY }]]);
    expect(bankStockTimingNext(older, look([waitRow(3, null)]), T)).toEqual(new Map([[KEY, { at: T, since: T, drops: 3, horizonMs: null }]]));
    // The same look told again changes nothing.
    expect(bankStockTimingNext(new Map([[KEY, { at: T, since: T - HOUR, drops: 1, horizonMs: null }]]), look([waitRow()]), T)).toBeNull();
    // A first save starts a streak too.
    expect(bankStockTimingNext(new Map(), look([waitRow()], { previousSavedAt: null }), T)?.get(KEY)).toEqual({ at: T, since: T, drops: 2, horizonMs: 6 * HOUR });
  });

  it('ends a streak on any other verdict, leaves rows without timing alone, and writes nothing when nothing changed', () => {
    const prev = new Map([[KEY, { at: T - HOUR, since: T - HOUR, drops: 1, horizonMs: null }]]);
    for (const v of ['buy-now', 'over', 'no-buyers', 'not-enough-data'] as const) {
      expect(bankStockTimingNext(prev, look([lr(row(BASE, { change: null, timing: brief(v) }))]), T)).toEqual(new Map());
    }
    expect(bankStockTimingNext(prev, look([lr(row(BASE, { change: null }))]), T)).toBeNull();
    expect(bankStockTimingNext(new Map(), look([lr(row(BASE, { change: null, timing: brief('buy-now') }))]), T)).toBeNull();
    // The memory read is never changed in place.
    expect(prev.get(KEY)).toEqual({ at: T - HOUR, since: T - HOUR, drops: 1, horizonMs: null });
  });

  it('drops memories older than 7 days or in the future, then the oldest past the cap', () => {
    const prev = new Map<string, BankStockWaitMemo>([
      ['hats|old|', { at: T - BANK_STOCK_TIMING_MAX_AGE_MS - 1, since: T - 8 * DAY, drops: 0, horizonMs: null }],
      ['hats|edge|', { at: T - BANK_STOCK_TIMING_MAX_AGE_MS, since: T - 8 * DAY, drops: 0, horizonMs: null }],
      ['hats|future|', { at: T + 1, since: T + 1, drops: 0, horizonMs: null }],
    ]);
    expect([...(bankStockTimingNext(prev, look([]), T)?.keys() ?? [])]).toEqual(['hats|edge|']);
    const full = new Map<string, BankStockWaitMemo>();
    for (let i = 0; i < BANK_STOCK_TIMING_MAX; i++) full.set(`hats|k${i}|`, { at: T - HOUR + i, since: T - HOUR, drops: 0, horizonMs: null });
    const next = bankStockTimingNext(full, look([waitRow()]), T)!;
    expect(next.size).toBe(BANK_STOCK_TIMING_MAX);
    expect(next.has('hats|k0|')).toBe(false);
    expect(next.has('hats|k1|')).toBe(true);
    expect(next.get(KEY)).toEqual({ at: T, since: T, drops: 2, horizonMs: 6 * HOUR });
  });

  it('reads the stored memory tolerantly', () => {
    const raw = JSON.stringify({
      [KEY]: { at: T, since: T - HOUR, drops: 2, horizonMs: 6 * HOUR },
      'hats|a|': { at: T, since: T, drops: 0, horizonMs: 'soon' },
      'hats|b|': { at: 'x', since: T, drops: 0, horizonMs: null },
      'hats|c|': { at: T, drops: 0 },
      'hats|d|': [1, 2],
      'hats|e|': null,
    });
    expect(bankStockTimingParse(raw)).toEqual(
      new Map([
        [KEY, { at: T, since: T - HOUR, drops: 2, horizonMs: 6 * HOUR }],
        ['hats|a|', { at: T, since: T, drops: 0, horizonMs: null }],
      ]),
    );
    for (const bad of [null, '', 'not json', '[]', 'null', '42']) expect(bankStockTimingParse(bad)).toEqual(new Map());
  });
});
