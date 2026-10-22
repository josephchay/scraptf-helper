// 0.8 (cycles: T3-T7, LC-4, LC-5) mock parity: the browser mock joins the buy-timing verdict to the drawer's item
// history, the bank stock rows (with the bank's turnover), the Live market's page and the Opportunities' import rows,
// and Health's asset-id stability, all from the shared rules (scraptfTiming.ts) over its own saves, as the service's
// history index does. The mock's saves are internal, so parity is checked across its answers: every surface quotes
// the one verdict scraptfTimingForKey gives for that copy. Fake data; nothing leaves the page.

import { afterEach, describe, expect, it } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { BANK_STOCK_DROPPING_MIN, BANK_STOCK_MAX_LIMIT, bankStockKey, bankStockTargetOf } from '../../src/shared/bankStock';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { scraptfTimingBrief } from '../../src/shared/scraptfTiming';
import type { BankStockResult, BankStockRow, ScraptfBank } from '../../src/shared/types';

let bridge: MockBridge | null = null;
const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

function make(): MockBridge {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  return bridge;
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
});

/** The banks the mock has saved (killstreaks once; skins and items never). */
const SAVED: ScraptfBank[] = ['hats', 'unusuals', 'stranges', 'weapons', 'killstreaks', 'list'];

async function stockOf(b: MockBridge, bank: ScraptfBank): Promise<BankStockResult> {
  return b.rpc('scraptf.bankStock', { bank, limit: BANK_STOCK_MAX_LIMIT });
}

/** A row's special key (its key is `${sku}|${specialKey}`, bankStockKey). */
function specialOf(r: Pick<BankStockRow, 'sku' | 'key'>): string {
  return r.key.slice(r.sku.length + 1);
}

describe('0.8 (T4): bank stock rows carry the shared verdict of their copy', () => {
  it('each on-sale hats row quotes the verdict its item history reads (scraptfTimingBrief of the same timing)', async () => {
    const b = make();
    const page = await stockOf(b, 'hats');
    const onSale = page.rows.filter((r) => r.change !== 'gone');
    expect(onSale.length).toBeGreaterThan(5);
    let compared = 0;
    for (const r of onSale) {
      const h = await b.rpc('scraptf.itemHistory', { sku: r.sku, special: specialOf(r) });
      if (h.bank !== 'hats') continue;
      compared++;
      expect(h.timing === null || h.timing === undefined ? undefined : scraptfTimingBrief(h.timing), r.key).toEqual(r.timing);
      if (r.timing) expect(r.timing).toMatchObject({ bank: 'hats', key: r.key });
      // The drawer's runs are the copy's in that bank: the last run began when the runs index says it was listed.
      expect(h.cycles, r.key).toBeDefined();
      if (h.listedSince !== null) expect(h.cycles!.runs.at(-1)!.firstOnSaleAt, r.key).toBe(h.listedSince);
      expect(h.cycles!.runsTotal).toBeGreaterThanOrEqual(h.cycles!.runs.length);
      for (const at of h.cycles!.dropAts) expect(h.points.some((p) => p.at === at), `${r.key} drop at ${at}`).toBe(true);
    }
    expect(compared).toBeGreaterThan(5);
  });

  it('gone rows never carry one, and the hats bank shows Buy now, Over and Not enough data', async () => {
    const b = make();
    const page = await stockOf(b, 'hats');
    expect(page.rows.filter((r) => r.change === 'gone').every((r) => r.timing === undefined)).toBe(true);
    const verdicts = new Set(page.rows.map((r) => r.timing?.verdict));
    // The seeded saves give no 'wait' with these rules (the rules are never tuned to the mock):
    // scraptfTiming.test.ts covers every verdict.
    for (const v of ['buy-now', 'over', 'not-enough-data'] as const) expect(verdicts.has(v), v).toBe(true);
    for (const r of page.rows) {
      if (!r.timing) continue;
      expect(r.timing.steps.length).toBeLessThanOrEqual(5);
      expect(r.timing.n.atRisk).toBeLessThanOrEqual(r.timing.n.states);
      expect(r.timing.n.copies).toBeLessThanOrEqual(r.timing.n.states);
    }
  });

  it("counts.dropping is the rows the 'dropping' filter shows, in every saved bank", async () => {
    const b = make();
    let dropping = 0;
    for (const bank of SAVED) {
      const page = await stockOf(b, bank);
      const want = page.rows.filter((r: BankStockRow) => r.change !== 'gone' && (r.timing?.dropsThisRun ?? 0) >= BANK_STOCK_DROPPING_MIN).length;
      expect(page.counts.dropping, bank).toBe(want);
      const chip = await b.rpc('scraptf.bankStock', { bank, filter: 'dropping', limit: BANK_STOCK_MAX_LIMIT });
      expect(chip.total, bank).toBe(want);
      dropping += want;
    }
    expect(dropping).toBeGreaterThan(0);
  });

  it("carries each saved bank's turnover (LC-4), the same on every read", async () => {
    const b = make();
    for (const bank of SAVED) {
      const page = await stockOf(b, bank);
      expect(page.turnover, bank).toBeDefined();
      expect(page.turnover!.bank).toBe(bank);
      expect(page.turnover!.ended + page.turnover!.open + page.turnover!.wideGap + page.turnover!.imprecise).toBeGreaterThan(0);
      expect((await stockOf(b, bank)).turnover).toEqual(page.turnover);
    }
    // A bank never saved has none.
    expect((await stockOf(b, 'skins')).turnover).toBeUndefined();
  });
});

describe('0.8 (T7): the Live market and Opportunities quote the same verdict', () => {
  it("market rows: the listed copy's verdict in the row's 'seen' bank, as its bank stock row shows it", async () => {
    const b = make();
    const { rows } = await b.rpc('market.list', { limit: 2000 });
    const timed = rows.filter((r) => r.scraptfTiming);
    expect(timed.length).toBeGreaterThan(10);
    const pages = new Map<ScraptfBank, Map<string, BankStockRow>>();
    for (const r of timed) {
      expect(r.scraptfLink.source, r.sku).toBe('seen');
      const t = r.scraptfTiming!;
      expect(t.bank).toBe(r.scraptfLink.bank);
      expect(bankStockTargetOf(t.key.split('|')[0]!)?.base ?? t.key.split('|')[0]).toBe(r.sku);
      let page = pages.get(t.bank);
      if (!page) pages.set(t.bank, (page = new Map((await stockOf(b, t.bank)).rows.map((x) => [x.key, x]))));
      const stock = page.get(t.key);
      if (!stock) continue;
      // The copy scraptfListedOf picks: its run is the one the row's time listed reads.
      expect(stock.listedSince, t.key).toBe(r.scraptfListedSince);
      expect(stock.timing, t.key).toEqual(t);
    }
    expect(rows.filter((r) => r.scraptfLink.source !== 'seen').every((r) => r.scraptfTiming === undefined)).toBe(true);
  });

  it('opportunities: import rows carry the verdict of the copy they price; user and rule rows never do', async () => {
    const b = make();
    const { rows } = await b.rpc('opps.list', { limit: 5000 });
    const timed = rows.filter((o) => o.timing);
    expect(timed.length).toBeGreaterThan(0);
    expect(timed.every((o) => o.inputKind === 'import')).toBe(true);
    expect(rows.some((o) => o.inputKind !== 'import')).toBe(true);
    for (const o of timed) {
      const base = bankStockTargetOf(o.sku)?.base ?? o.sku;
      expect(o.timing!.key, o.key).toBe(bankStockKey(base, o.copyKey ?? ''));
      // Judged against the row's own Sells for: no revenue is 'no-buyers'.
      expect(o.timing!.verdict === 'no-buyers', o.key).toBe(o.revenueScrap === null);
    }
  });
});

describe('0.8 (T5, LC-5): the drawer and Health', () => {
  it('an item never saved has no cycles or timing; a saved one has both', async () => {
    const b = make();
    const never = await b.rpc('scraptf.itemHistory', { sku: '5021;6' });
    expect(never.bank).toBeNull();
    expect(never).not.toHaveProperty('cycles');
    expect(never).not.toHaveProperty('timing');
    const row = (await stockOf(b, 'unusuals')).rows.find((r) => r.timing)!;
    const h = await b.rpc('scraptf.itemHistory', { sku: row.sku, special: specialOf(row) });
    expect(h).toHaveProperty('cycles');
    expect(h).toHaveProperty('timing');
  });

  it("health.get has each saved bank's asset-id stability, in SCRAPTF_BANKS order", async () => {
    const b = make();
    const h = await b.rpc('health.get', undefined as never);
    const want = SCRAPTF_BANKS.map((x) => x.bank).filter((bank) => SAVED.includes(bank));
    expect(h.scraptfAssetIds?.map((x) => x.bank)).toEqual(want);
    for (const a of h.scraptfAssetIds!) {
      expect(a.same).toBeLessThanOrEqual(a.pairs);
      expect(a.share).toBe(a.pairs > 0 ? a.same / a.pairs : null);
      // The seeded rows carry no asset ids: no pair, so no id label is ever shown.
      expect(a.stable).toBe(false);
    }
  });
});
