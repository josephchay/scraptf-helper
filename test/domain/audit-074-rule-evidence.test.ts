// 0.7.4 (F78): a price-sheet rule never undercuts a price scrap.tf itself showed. The audited hats rule at
// 16 scrap made 1,092 'profitable' rows, among them hats the saved /items list sells at 455 keys (stock 0) and
// ones an older /buy/hats save had at 192 scrap. Now a rule row is evaluated at the higher of the rule's cost
// and the plain copy's newest on-sale price on the saved list (exact rows only) or a retained bank save,
// flagged 'rule-under-scraptf' with the page and date in its reasons; the Live market's rule verdict uses the
// same bound (ruleEvidence.ts). Candidates with no such evidence are unchanged. No parsing here: stub schema.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine } from '../../src/service/domain/engine';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createMarketIndex } from '../../src/service/domain/market';
import { boundRuleCost, ruleUnderScraptfReason, scraptfSeenPriceOf, type ScraptfSeenPrice } from '../../src/shared/ruleEvidence';
import { flagInfo } from '../../src/renderer/format';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ScraptfBank, ScraptfKeyRun, ScraptfListRow } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents } from './helpers';

const K = 567;
const DAY = 24 * HOUR;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function listRow(sku: string, sellsKeys: number, sellsScrapRaw: number, over: Partial<ScraptfListRow> = {}): ScraptfListRow {
  return {
    sku,
    name: sku,
    sellsKeys,
    sellsScrapRaw,
    sellsScrap: sellsKeys * K + sellsScrapRaw,
    paysKeys: null,
    paysScrapRaw: null,
    paysScrap: null,
    stock: 0,
    stockLimit: 1,
    full: false,
    observedAt: T0 - 14 * MIN,
    ...over,
  };
}

function run(sku: string, keys: number, scrap: number, lastSeenAt: number, specialKey = ''): ScraptfKeyRun {
  return { key: `${sku}|${specialKey}`, sku, specialKey, seenAt: lastSeenAt, firstSeenAt: lastSeenAt, lastSeenAt, listedSince: null, runStart: null, current: null, lastOnSale: { keys, scrap } };
}

describe('scraptfSeenPriceOf and boundRuleCost', () => {
  it('takes the highest of the exact list row and the bank saves, a tie to the newer', () => {
    const runs = new Map<ScraptfBank, Map<string, ScraptfKeyRun>>([
      ['hats', new Map([['1016;6|', run('1016;6', 0, 192, T0 - DAY)]])],
      ['items', new Map([['1016;6|', run('1016;6', 0, 192, T0 - HOUR)]])],
    ]);
    const sources = { listRow: () => null, runsFor: (b: ScraptfBank) => runs.get(b) ?? new Map() };
    expect(scraptfSeenPriceOf('1016;6', sources, K)).toEqual({ keys: 0, scrap: 192, at: T0 - HOUR, where: 'items' });
    const withList = { ...sources, listRow: (b: string) => listRow(b, 455, 0) };
    expect(scraptfSeenPriceOf('1016;6', withList, K)).toMatchObject({ keys: 455, scrap: 0, where: 'list' });
  });

  it('never reads a family list row, another copy (paint, sheen) or a broken source', () => {
    const painted = new Map([['1016;6|[1,[],[],null,null,false,false]', run('1016;6', 3, 0, T0, '[1,[],[],null,null,false,false]')]]);
    expect(
      scraptfSeenPriceOf(
        '1016;6',
        {
          listRow: (b) => listRow(b, 9, 0, { match: 'family' }),
          runsFor: (bank) => {
            if (bank === 'weapons') throw new Error('boom');
            return bank === 'hats' ? painted : new Map();
          },
        },
        K,
      ),
    ).toBeNull();
    expect(scraptfSeenPriceOf('1016;6', {}, K)).toBeNull();
  });

  it('raises a rule only: an equal or lower price leaves the rule cost', () => {
    const seen: ScraptfSeenPrice = { keys: 0, scrap: 192, at: T0, where: 'hats' };
    expect(boundRuleCost({ costKeys: 0, costScrap: 16 }, seen, K)).toEqual({ costKeys: 0, costScrapRaw: 192, costScrap: 192, underScraptf: true });
    expect(boundRuleCost({ costKeys: 1, costScrap: 0 }, seen, K)).toEqual({ costKeys: 1, costScrapRaw: 0, costScrap: K, underScraptf: false });
    expect(boundRuleCost({ costKeys: 0, costScrap: 192 }, seen, K).underScraptf).toBe(false);
    expect(boundRuleCost({ costKeys: 0, costScrap: 16 }, null, K).underScraptf).toBe(false);
  });

  it('words the reason with the page and the save date', () => {
    expect(ruleUnderScraptfReason({ keys: 0, scrap: 192, at: Date.UTC(2026, 9, 19, 15, 15), where: 'hats' }, 16, K)).toBe(
      "scrap.tf/buy/hats listed it at 21.33 ref on 2026-10-19, more than your rule's 1.77 ref: that price is the cost",
    );
    expect(ruleUnderScraptfReason({ keys: 455, scrap: 0, at: T0, where: 'list' }, 16, K)).toMatch(/^scrap\.tf\/items listed it at 455 keys/);
    expect(flagInfo('rule-under-scraptf').label).toBe('Above your rule');
  });
});

function world(seen: Record<string, ScraptfSeenPrice>) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const schema = createStubSchema({ categoryOf: () => 'hats', nameOf: (s) => `Hat ${s}` });
  const hook = (base: string): ScraptfSeenPrice | null => seen[base] ?? null;
  const engine = createEngine({ ...makeDeps(repo, clock, () => settings), schema, events: recordingEvents(), timers, scraptfSeenPriceOf: hook });
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    schema,
    timers,
    keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now()),
    onChanged: () => undefined,
    folderWatchActive: () => false,
    sliceNow: () => 0,
    scraptfSeenPriceOf: hook,
  });
  const book = (sku: string, keys: number, scrap: number) =>
    repo.upsertListings(
      [0, 1, 2].map((i) => makeListing({ id: `${sku}-${i}`, sku, baseSku: sku, steamid: `S${sku}-${i}`, keys, metalScrap: scrap - i, isBot: i === 0, userOnline: true, lastEventAt: T0 - MIN })),
    );
  repo.upsertRule({ name: 'Unique craftable hats', filter: { categories: ['hats'], qualities: [6], craftable: true, hasEffect: false }, costScrap: 16, observedAt: T0 - HOUR });
  return { repo, engine, market, timers, clock, book };
}

describe('the engine and the Live market agree', () => {
  it('a hat an older save had at 192 scrap is judged at 192, not 16; one with no evidence stays a 16 scrap candidate', async () => {
    const h = world({
      '1016;6': { keys: 0, scrap: 192, at: Date.UTC(2026, 9, 13, 15, 15), where: 'hats' },
      '1017;6': { keys: 0, scrap: 192, at: T0 - DAY, where: 'hats' },
      '1076;6': { keys: 455, scrap: 0, at: T0 - 14 * MIN, where: 'list' },
    });
    h.book('1016;6', 0, 400);
    h.book('1017;6', 0, 198);
    h.book('1076;6', 410, 0);
    h.book('30706;6', 0, 120);
    await h.engine.runNow();

    // Still a candidate against a 400-scrap buyer, at the 192 the save showed, flagged with where and when.
    const buck = h.repo.opportunitiesForSku('1016;6');
    expect(buck.map((o) => [o.inputKind, o.status, o.costScrap])).toEqual([['rule', 'profitable', 192]]);
    expect(buck[0]!.flags).toEqual(expect.arrayContaining(['rule-estimate', 'rule-under-scraptf']));
    expect(buck[0]!.reasons).toContain("scrap.tf/buy/hats listed it at 21.33 ref on 2026-10-13, more than your rule's 1.77 ref: that price is the cost");
    // 192 against 198: no longer a profitable candidate (6 scrap, under the thresholds).
    expect(h.repo.opportunitiesForSku('1017;6').filter((o) => o.status === 'profitable')).toEqual([]);
    // 455 keys against a 410-key buyer: no rule row at all.
    expect(h.repo.opportunitiesForSku('1076;6')).toEqual([]);
    // No evidence: the rule's 16 scrap, as before.
    const plain = h.repo.opportunitiesForSku('30706;6');
    expect(plain.map((o) => [o.inputKind, o.status, o.costScrap])).toEqual([['rule', 'profitable', 16]]);
    expect(plain[0]!.flags).not.toContain('rule-under-scraptf');

    h.market.start();
    h.timers.advance(0);
    const rows = h.market.all({}, h.clock.now());
    const row = (sku: string) => rows.find((r) => r.sku === sku)!;
    expect(row('1076;6')).toMatchObject({ ruleCostScrap: 455 * K, verdict: 'unchecked' });
    expect(row('1076;6').flags).toContain('rule-under-scraptf');
    expect(row('1017;6')).toMatchObject({ ruleCostScrap: 192 });
    expect(row('1017;6').verdict).not.toBe('rule-flip');
    expect(row('1016;6')).toMatchObject({ ruleCostScrap: 192, verdict: 'rule-flip' });
    expect(row('30706;6')).toMatchObject({ ruleCostScrap: 16, verdict: 'rule-flip' });
    expect(row('30706;6').flags).not.toContain('rule-under-scraptf');
  });

  it("0.8: the F78 flag and reason come before 'single-exit', which stays last (as the mock writes them)", async () => {
    const h = world({ '1018;6': { keys: 0, scrap: 192, at: T0 - DAY, where: 'hats' } });
    // One buyer: the rule row at 192 is a flip only that buyer makes.
    h.repo.upsertListings([makeListing({ id: '1018;6-0', sku: '1018;6', baseSku: '1018;6', steamid: 'S1018', keys: 0, metalScrap: 400, isBot: true, userOnline: true, lastEventAt: T0 - MIN })]);
    await h.engine.runNow();
    const [o] = h.repo.opportunitiesForSku('1018;6');
    expect(o).toMatchObject({ inputKind: 'rule', status: 'profitable', costScrap: 192 });
    expect(o!.flags.slice(-2)).toEqual(['rule-under-scraptf', 'single-exit']);
    expect(o!.reasons.at(-2)).toMatch(/^scrap\.tf\/buy\/hats listed it at 21\.33 ref on .*: that price is the cost$/);
    expect(o!.reasons.at(-1)).toMatch(/^0 Only this buyer makes it a flip/);
  });

  it('a failing hook is no evidence', async () => {
    const h = world({});
    const engine = createEngine({
      ...makeDeps(h.repo, h.clock, () => DEFAULT_SETTINGS),
      schema: createStubSchema({ categoryOf: () => 'hats' }),
      events: recordingEvents(),
      timers: new FakeTimers(h.clock),
      scraptfSeenPriceOf: () => {
        throw new Error('boom');
      },
    });
    h.book('30706;6', 0, 120);
    await engine.runNow();
    expect(h.repo.opportunitiesForSku('30706;6').map((o) => [o.status, o.costScrap])).toEqual([['profitable', 16]]);
  });
});
