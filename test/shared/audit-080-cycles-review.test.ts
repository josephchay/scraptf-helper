// 0.8 review, area "cycles": the confirmed findings on the buy-timing estimators and the rows that quote them.
// 1. Retention's one save a day past 7 d (bankStockThinning) was pooled with the user's hourly looks: those day-wide
//    brackets read a drop and then a sale as one 'gone' and merged drops, the median bracket rose to 24 h and the
//    short horizons went. Each page now has its own gap limit (scraptfGapLimitMs), so the daily tier is cut (cutAt,
//    wideStart), never pooled; the regression compares the thinned table with the dense one on a bank of known rates.
// 2. A flap restarts a row's listing (scraptfRunsOf) while the timing joins it to the run before: the Since listed
//    cell and the Dropping chip now count only the drops since the row's own baseline (dropsSinceListed).
// 3. Band-only counts say "of similar value" in the row titles, as the drawer does (ScraptfTimingBrief.scope).
// 4. The timing reads each page's look gap from the walk, never one sort per row.
// Synthetic saves only; nothing here touches the network or scrap.tf.

import { describe, expect, it } from 'vitest';
import { BANK_STOCK_DROPPING_MIN, bankStockCounts, bankStockDropped, bankStockFilterMatches, bankStockKey, bankStockRows, bankStockRunDrops, bankStockThinning } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { scraptfGapLimitMs, scraptfLookGapMs, scraptfRunsOf, type ScraptfSaveRows } from '../../src/shared/scraptfHistory';
import {
  SCRAPTF_TIMING_MIN_GAP_MS,
  scraptfBankCyclesOf,
  scraptfBankTurnover,
  scraptfTimingAt,
  scraptfTimingBrief,
  scraptfTimingForKey,
  scraptfTimingTableFor,
} from '../../src/shared/scraptfTiming';
import type { BankStockStored, Category, ScraptfTimingBrief } from '../../src/shared/types';
import { bankStockSinceListedCell } from '../../src/renderer/bankStockModel';
import { timingBadge, timingVerdictTitle } from '../../src/renderer/timingModel';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 600;
const PAGE = '/buy/hats';
const PROFIT = DEFAULT_SETTINGS.profit;

describe("finding 1: retention's daily tier is cut, never pooled with hourly looks", () => {
  /**
   * A 150-item bank whose every price state ends after min(drop ~ Exp(30 h), gone ~ Exp(60 h), rise ~ Exp(200 h)),
   * a drop taking 7 % off; about 3 new items an hour; saved exactly every hour for 45 days (deterministic).
   */
  function bank(): ScraptfSaveRows[] {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const exp = (mean: number): number => -Math.log(1 - rnd()) * mean;
    const T0 = Date.UTC(2026, 8, 1);
    type Item = { id: number; price: number; ends: number; kind: 'drop' | 'gone' | 'rise'; alive: boolean };
    const next = (it: Item, at: number): void => {
      const d = exp(30 * HOUR);
      const g = exp(60 * HOUR);
      const r = exp(200 * HOUR);
      const m = Math.min(d, g, r);
      it.ends = at + m;
      it.kind = m === d ? 'drop' : m === g ? 'gone' : 'rise';
    };
    let id = 1;
    const items: Item[] = [];
    for (let i = 0; i < 150; i++) {
      const it: Item = { id: id++, price: 100 + Math.floor(rnd() * 100), ends: 0, kind: 'drop', alive: true };
      next(it, T0 - exp(20 * HOUR));
      items.push(it);
    }
    const saves: ScraptfSaveRows[] = [];
    for (let t = T0, batch = 1; t < T0 + 45 * DAY; t += HOUR) {
      for (const it of items) {
        while (it.alive && it.ends <= t) {
          if (it.kind === 'gone') it.alive = false;
          else {
            it.price = it.kind === 'drop' ? Math.max(1, Math.round(it.price * 0.93)) : Math.round(it.price * 1.05);
            next(it, it.ends);
          }
        }
      }
      const arrivals = Math.floor(exp(1) * 3);
      for (let k = 0; k < arrivals; k++) {
        const at = t - rnd() * HOUR;
        const it: Item = { id: id++, price: 100 + Math.floor(rnd() * 100), ends: 0, kind: 'drop', alive: true };
        next(it, at);
        if (it.ends > t) items.push(it);
      }
      const rows: BankStockStored[] = items.filter((x) => x.alive).map((x) => ({ sku: `${x.id};6`, specialKey: '', name: `Item ${x.id}`, costKeys: 0, costScrap: x.price, stock: 1, assetId: `a${x.id}` }));
      saves.push({ batchId: batch++, savedAt: t, page: PAGE, rows });
    }
    return saves;
  }

  it('the thinned table agrees with the dense one (and the truth): no extra gones, the hourly resolution and the 6 h window kept', () => {
    const dense = bank();
    const now = dense[dense.length - 1]!.savedAt + 30 * MIN;
    const drop = bankStockThinning(
      dense.map((s) => ({ batchId: s.batchId, savedAt: s.savedAt, bank: 'hats' as const, page: s.page })),
      now,
    );
    const thinned = dense.filter((s) => !drop.has(s.batchId));
    // Retention kept every save of the last day, one an hour to 7 d and one a day past it.
    expect(thinned.length).toBeLessThan(dense.length / 4);
    expect(thinned.some((s) => now - s.savedAt > 30 * DAY)).toBe(true);

    const cd = scraptfBankCyclesOf('hats', dense, K);
    const ct = scraptfBankCyclesOf('hats', thinned, K);
    // The page is looked at every hour round the clock: its gap limit is the 2 h floor, so a day-wide gap is cut.
    expect(ct.life.lookGaps!.get(PAGE)).toBe(HOUR);
    expect(scraptfGapLimitMs(ct.life.pageSaves.get(PAGE)!)).toBe(SCRAPTF_TIMING_MIN_GAP_MS);

    const td = scraptfTimingTableFor(cd, 150, K);
    const tt = scraptfTimingTableFor(ct, 150, K);
    // The daily tier's states are left out on the start side (wideStart), not read as events.
    expect(tt.imprecise).toBeGreaterThan(td.imprecise);
    const lam = 1 / 30 + 1 / 60 + 1 / 200;
    const truth = (h: number) => ({ drop: ((1 / 30) / lam) * (1 - Math.exp(-h * lam)), gone: ((1 / 60) / lam) * (1 - Math.exp(-h * lam)) });
    for (const h of [6, 24, 72]) {
      const d = scraptfTimingAt(td, h * HOUR);
      const t = scraptfTimingAt(tt, h * HOUR);
      // Before the fix, at 72 h: dropped .508 and gone .407 thinned against .586 / .297 dense (truth .595 / .297).
      expect(Math.abs(t.F_drop - d.F_drop), `F_drop(${h} h)`).toBeLessThan(0.04);
      expect(Math.abs(t.F_gone - d.F_gone), `F_gone(${h} h)`).toBeLessThan(0.04);
      expect(Math.abs(t.F_drop - truth(h).drop), `F_drop(${h} h) vs truth`).toBeLessThan(0.04);
      expect(Math.abs(t.F_gone - truth(h).gone), `F_gone(${h} h) vs truth`).toBeLessThan(0.04);
    }
    // The resolution is the user's hour, not the daily tier's 24 h (before: 24 h, so 6 h and 1 d were never offered).
    expect(tt.resolutionMs).toBeLessThanOrEqual(2 * HOUR);
    // The turnover's median stays with the dense one (before: 48 h against 43 h).
    const md = scraptfBankTurnover(cd).medianMs!;
    const mt = scraptfBankTurnover(ct).medianMs!;
    expect(Math.abs(mt - md)).toBeLessThanOrEqual(3 * HOUR);

    // Verdicts: the short window is offered again, and the thinned saves rarely judge a copy otherwise.
    const buy = { revenueScrap: 200, maxCostScrap: 180 };
    let both = 0;
    let differ = 0;
    let sixHours = 0;
    for (const r of thinned[thinned.length - 1]!.rows) {
      const key = bankStockKey(r.sku, r.specialKey);
      const a = scraptfTimingForKey({ cycles: cd, key, buy, profit: PROFIT, keyScrap: K, now });
      const b = scraptfTimingForKey({ cycles: ct, key, buy, profit: PROFIT, keyScrap: K, now });
      if (!a || !b || a.verdict === 'not-enough-data' || b.verdict === 'not-enough-data') continue;
      both++;
      if (a.verdict !== b.verdict) differ++;
      if (b.horizonMs === 6 * HOUR) sixHours++;
    }
    expect(both).toBeGreaterThan(100);
    expect(differ).toBeLessThanOrEqual(5);
    expect(sixHours).toBeGreaterThan(50);
  });
});

describe('finding 2: after a flap, the Since listed cell and the Dropping chip count from the same save', () => {
  const T0 = Date.UTC(2026, 9, 20, 8);
  const hat = (p: number): BankStockStored => ({ sku: '100;6', specialKey: '', name: 'Hat', costKeys: 0, costScrap: p, stock: 1, assetId: null });
  const other: BankStockStored = { sku: '200;6', specialKey: '', name: 'Other', costKeys: 0, costScrap: 50, stock: 1, assetId: null };
  const KEY = bankStockKey('100;6', '');

  /** 100 at 08:00, 95 at 10:00, 90 at 12:00, absent at 12:10 (a partial look), 90 again at 12:20, then `more`. */
  function saves(more: { at: number; price: number }[] = []): ScraptfSaveRows[] {
    const list = [
      { at: T0 - HOUR, rows: [other] },
      { at: T0, rows: [other, hat(100)] },
      { at: T0 + 2 * HOUR, rows: [other, hat(95)] },
      { at: T0 + 4 * HOUR, rows: [other, hat(90)] },
      { at: T0 + 4 * HOUR + 10 * MIN, rows: [other] },
      { at: T0 + 4 * HOUR + 20 * MIN, rows: [other, hat(90)] },
      ...more.map((m) => ({ at: m.at, rows: [other, hat(m.price)] })),
    ];
    return list.map((s, i) => ({ batchId: i + 1, savedAt: s.at, page: PAGE, rows: s.rows }));
  }

  function rowOf(ss: ScraptfSaveRows[], now: number) {
    const runs = scraptfRunsOf(ss);
    const c = scraptfBankCyclesOf('hats', ss, K);
    const rows = bankStockRows({
      newest: ss[ss.length - 1]!.rows,
      previous: ss[ss.length - 2]!.rows,
      keyScrap: K,
      profit: PROFIT,
      categoryOf: () => 'hats' as Category,
      buySideOf: () => null,
      runOf: (k) => runs.get(k) ?? null,
      bank: 'hats',
      timingOf: (k) => {
        const t = scraptfTimingForKey({ cycles: c, key: k, buy: null, profit: PROFIT, keyScrap: K, now });
        return t ? scraptfTimingBrief(t) : null;
      },
    });
    return rows.find((r) => r.key === KEY)!;
  }

  it('no drop since it came back: "0 %", no " · 2×", and neither Dropped nor Dropping', () => {
    const r = rowOf(saves(), T0 + 5 * HOUR);
    // The flap joins the listing for the timing (2 drops in the chain), but the row's listing began at 12:20.
    expect(r.listedSince).toBe(T0 + 4 * HOUR + 20 * MIN);
    expect(r.timing).toMatchObject({ dropsThisRun: 2, dropsSinceListed: 0 });
    expect(bankStockRunDrops(r)).toBe(0);
    const cell = bankStockSinceListedCell(r, K);
    // Before the fix: "0 % · 2×", with the two drops from before 12:20 in the title.
    expect(cell.text).toBe('0 %');
    expect(cell.title).not.toContain('price drop');
    expect(bankStockDropped(r)).toBe(false);
    expect(bankStockFilterMatches(r, 'dropping')).toBe(false);
    expect(bankStockCounts([r], 1).dropping).toBe(0);
  });

  it('drops after it came back are counted, and only those are dated', () => {
    const r = rowOf(saves([{ at: T0 + 6 * HOUR, price: 85 }, { at: T0 + 8 * HOUR, price: 80 }]), T0 + 9 * HOUR);
    expect(r.timing).toMatchObject({ dropsThisRun: 4, dropsSinceListed: 2 });
    const cell = bankStockSinceListedCell(r, K);
    expect(cell.text).toMatch(/^↓ .* · 2×$/);
    expect(cell.title).toContain('2 price drops in this run in your saves: ');
    expect(cell.title).not.toContain('the newest');
    expect(bankStockDropped(r)).toBe(true);
    expect(BANK_STOCK_DROPPING_MIN).toBe(2);
    expect(bankStockFilterMatches(r, 'dropping')).toBe(true);
    expect(bankStockCounts([r], 1).dropping).toBe(1);
  });

  it('a brief without dropsSinceListed (built by hand) still counts its dropsThisRun', () => {
    expect(bankStockRunDrops({ timing: { dropsThisRun: 3 } })).toBe(3);
    expect(bankStockRunDrops({ timing: null })).toBe(0);
    expect(bankStockRunDrops({})).toBe(0);
  });
});

describe('finding 3: band-only counts say "of similar value" in the row titles', () => {
  const NOW = Date.UTC(2026, 9, 22, 12);
  const brief = (over: Partial<ScraptfTimingBrief>): ScraptfTimingBrief => ({
    verdict: 'not-enough-data',
    why: 'few-drops',
    bank: 'hats',
    key: '378;6|',
    dropsThisRun: 0,
    steps: [],
    lastSeenAt: NOW - HOUR,
    horizonMs: null,
    pDrop: null,
    pGone: null,
    pRise: null,
    nextDropAt: null,
    n: { states: 30, copies: 12, atRisk: 9, dropCopies: 2 },
    ...over,
  });

  it('the not-enough-data reasons and the odds name the band; the whole bank reads as before', () => {
    const band = timingVerdictTitle(brief({ scope: 'band' }), NOW);
    expect(band).toContain('Too few price drops of similar value in your saves of scrap.tf/buy/hats so far, from 2 items');
    const bank = timingVerdictTitle(brief({ scope: 'bank' }), NOW);
    expect(bank).toContain('Too few price drops in your saves of scrap.tf/buy/hats so far, from 2 items');
    expect(timingVerdictTitle(brief({}), NOW)).toBe(bank);
    expect(timingVerdictTitle(brief({ scope: 'band', why: 'few-at-risk' }), NOW)).toContain('Too few prices of similar value on scrap.tf/buy/hats');
    expect(timingVerdictTitle(brief({ scope: 'band', why: 'few-ended' }), NOW)).toContain('prices of similar value in your saves of scrap.tf/buy/hats');
    expect(timingVerdictTitle(brief({ scope: 'band', why: 'past-data' }), NOW)).toContain('prices of similar value stayed listed that long');
    const odds = { verdict: 'buy-now' as const, why: 'flip-now' as const, horizonMs: 6 * HOUR, pDrop: 0.2, pGone: 0.1, pRise: 0 };
    expect(timingBadge(brief({ ...odds, scope: 'band' }), NOW)!.title).toContain('Of the 9 prices of similar value on scrap.tf/buy/hats still at their price at this age');
    expect(timingBadge(brief({ ...odds, scope: 'bank' }), NOW)!.title).toContain('Of the 9 prices on scrap.tf/buy/hats still at their price at this age');
  });
});

describe("finding 4: the timing reads each page's look gap from the walk", () => {
  it('the lifecycle keeps every page look gap once; scraptfTimingForKey reads it, never re-sorting the page per row', () => {
    const T0 = Date.UTC(2026, 9, 1);
    const ss: ScraptfSaveRows[] = [];
    for (let h = 0; h <= 48; h++) {
      const rows: BankStockStored[] = Array.from({ length: 6 }, (_, i) => ({ sku: `${10 + i};6`, specialKey: '', name: 'x', costKeys: 0, costScrap: 100 - Math.floor((h + i) / 6), stock: 1, assetId: null }));
      ss.push({ batchId: h + 1, savedAt: T0 + h * HOUR, page: PAGE, rows });
    }
    const c = scraptfBankCyclesOf('hats', ss, K);
    expect(c.life.lookGaps!.get(PAGE)).toBe(scraptfLookGapMs(c.life.pageSaves.get(PAGE)!));
    // A marker in the walk's map is what the verdict quotes: the page's times are not read again.
    c.life.lookGaps!.set(PAGE, 5 * HOUR);
    const t = scraptfTimingForKey({ cycles: c, key: bankStockKey('10;6', ''), buy: { revenueScrap: 120, maxCostScrap: 111 }, profit: PROFIT, keyScrap: K, now: T0 + 48 * HOUR + MIN });
    expect(t!.lookGapMs).toBe(5 * HOUR);
  });
});
