// F14 and the key price: scrap.tf's own key prices come from the newer of the
// typed Settings values and the saved scrap.tf/items list's key row (5021;6).
// Without a list nothing changes; KeyPriceState.scraptfFromList shows the row
// exactly as the cap reads it, so Settings never calls an ignored price "in use".
// Engine and list cache wiring included. Nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine } from '../../src/service/domain/engine';
import { DEFAULT_KEY_SCRAP, effectiveScraptfKey, selectKeyPrice } from '../../src/service/domain/keyprice';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import type { KeyPriceQuote, KeyPriceState, ScraptfListKey, ScraptfListStored, Settings } from '../../src/shared/types';
import { KEY_SKU } from '../../src/shared/types';
import { FakeClock, FakeTimers, HOUR, MIN, T0, createStubSchema, makeDeps, recordingEvents, recordingLogger, silentLogger, testSettings } from './helpers';

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

const q = (source: KeyPriceQuote['source'], buyScrap: number | null, sellScrap: number | null, ageMs = 0): KeyPriceQuote => ({ source, buyScrap, sellScrap, observedAt: T0 - ageMs });
const listKey = (paysScrap: number | null, sellsScrap: number | null, at = T0): ScraptfListKey => ({ paysScrap, sellsScrap, observedAt: at });

/** The Settings page's "in use" rule as the contract states it for the renderer. */
function shownInUse(kp: KeyPriceState, s: Settings): boolean {
  const typed = typeof s.keyPrice.scraptfSellScrap === 'number' || typeof s.keyPrice.scraptfBuyScrap === 'number';
  const typedAt = s.keyPrice.scraptfObservedAt;
  return kp.scraptfFromList !== null && (!typed || typedAt === null || kp.scraptfFromList.observedAt > typedAt);
}

describe('KeyPriceState.scraptfFromList', () => {
  it('shows only the values the cap would use, and nothing when none is left', () => {
    expect(selectKeyPrice([], testSettings(), T0, listKey(575, 590)).scraptfFromList).toEqual({ paysScrap: 575, sellsScrap: 590, observedAt: T0 });
    // An insane price (under 2 ref, over 2000 ref) is dropped, field by field.
    expect(selectKeyPrice([], testSettings(), T0, listKey(5, 590)).scraptfFromList).toEqual({ paysScrap: null, sellsScrap: 590, observedAt: T0 });
    expect(selectKeyPrice([], testSettings(), T0, listKey(5, 20_000)).scraptfFromList).toBeNull();
    expect(selectKeyPrice([], testSettings(), T0, listKey(null, null)).scraptfFromList).toBeNull();
    expect(selectKeyPrice([], testSettings(), T0, { paysScrap: 575, sellsScrap: 590, observedAt: Number.NaN }).scraptfFromList).toBeNull();
    // Fractions are rounded as the cap rounds them.
    expect(selectKeyPrice([], testSettings(), T0, listKey(574.6, 589.2))!.scraptfFromList).toEqual({ paysScrap: 575, sellsScrap: 589, observedAt: T0 });
  });

  it('is reported in manual mode and on every automatic path, in use or not', () => {
    const lk = listKey(575, 590, T0 - HOUR);
    const typedNewer = testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: 560, scraptfObservedAt: T0 } });
    const manual = testSettings({ keyPrice: { mode: 'manual', manualScrap: 600 } });
    for (const [quotes, s] of [
      [[q('bptf', 600, null)], typedNewer],
      [[q('bptf', 600, null, 7 * HOUR)], typedNewer],
      [[], manual],
      [[q('manual', 555, null)], testSettings()],
      [[], testSettings()],
    ] as const) {
      expect(selectKeyPrice([...quotes], s, T0, lk).scraptfFromList).toEqual(lk);
    }
  });

  it("agrees with the Settings page's \"in use\" rule for every combination", () => {
    const typedCases: { at: number | null; pays: number | null; sells: number | null }[] = [
      { at: null, pays: null, sells: null },
      { at: null, pays: 560, sells: 600 },
      { at: T0 - 2 * HOUR, pays: 560, sells: 600 },
      { at: T0 - HOUR, pays: 560, sells: null }, // same time as the list: typed wins the tie
      { at: T0, pays: null, sells: 600 },
    ];
    const listCases: (ScraptfListKey | null)[] = [null, listKey(575, 590, T0 - HOUR), listKey(null, 590, T0 - HOUR), listKey(5, 7, T0 - HOUR)];
    for (const t of typedCases) {
      for (const lk of listCases) {
        const s = testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: t.pays, scraptfBuyScrap: t.sells, scraptfObservedAt: t.at } });
        const kp = selectKeyPrice([q('bptf', 600, null)], s, T0, lk);
        expect(shownInUse(kp, s)).toBe(effectiveScraptfKey(s, lk).source === 'list');
      }
    }
  });
});

describe('selectKeyPrice without a saved list is unchanged (0.3 parity)', () => {
  it('caps automatic values only by the typed scrap.tf pays price, exactly as before', () => {
    const settingsCases: Settings[] = [
      testSettings(),
      testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: 580 } }),
      testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: 580, scraptfObservedAt: T0 - HOUR } }),
      testSettings({ keyPrice: { mode: 'auto', scraptfBuyScrap: 500 } }),
      testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: 10 } }), // insane: ignored
      testSettings({ keyPrice: { mode: 'manual', manualScrap: 600, scraptfSellScrap: 580 } }),
      testSettings({ keyPrice: { mode: 'manual', manualScrap: null, scraptfSellScrap: 560 } }),
    ];
    const quoteCases: KeyPriceQuote[][] = [[], [q('bptf', 600, null)], [q('pricedb', 570, 575)], [q('bptf', 590, null, 7 * HOUR), q('pricedb', 565, null, 8 * HOUR)], [q('manual', 555, null)]];
    for (const s of settingsCases) {
      for (const quotes of quoteCases) {
        const plain = selectKeyPrice(quotes, s, T0);
        expect(selectKeyPrice(quotes, s, T0, null)).toEqual(plain);
        expect(plain.scraptfFromList).toBeNull();
        // 0.3's rule: an automatic value is capped by the sane typed scrap.tf pays price; manual is not.
        const cap = s.keyPrice.scraptfSellScrap;
        const sane = typeof cap === 'number' && cap >= 18 && cap <= 18_000 ? cap : null;
        if (plain.source === 'bptf' || plain.source === 'pricedb') {
          const raw = selectKeyPrice(quotes, testSettings({ keyPrice: { ...s.keyPrice, scraptfSellScrap: null, scraptfBuyScrap: null } }), T0).valueScrap;
          expect(plain.valueScrap).toBe(sane !== null && sane < raw ? sane : raw);
        }
      }
    }
  });
});

describe('the list key row through the engine and the list cache', () => {
  function newRepo(): Repo {
    const repo = openRepo(':memory:');
    openRepos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 600, sellScrap: 603, observedAt: T0 });
    return repo;
  }

  const keyRow = (over: Partial<ScraptfListStored> = {}): ScraptfListStored => ({
    sku: KEY_SKU,
    name: 'Mann Co. Supply Crate Key',
    sellsKeys: 0,
    sellsScrap: 590,
    paysKeys: 0,
    paysScrap: 575,
    stock: 120,
    stockLimit: 300,
    batchId: 1,
    observedAt: T0 - 5 * MIN,
    ...over,
  });

  it('caps the engine key price by what the saved list says scrap.tf pays, and survives a failing list', () => {
    const repo = newRepo();
    const clock = new FakeClock();
    const settings = testSettings();
    const timers = new FakeTimers(clock);
    const log = recordingLogger();
    const list = createScraptfListCache({ repo, log: silentLogger, keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow()) });
    const engine = createEngine({ ...makeDeps(repo, clock, () => settings, log), schema: createStubSchema(), events: recordingEvents(), timers, scraptfKey: () => list.keyRow() });
    expect(engine.keyPrice()).toMatchObject({ valueScrap: 600, scraptfFromList: null });

    repo.upsertScraptfList([keyRow()]);
    list.refresh();
    expect(engine.keyPrice()).toMatchObject({ valueScrap: 575, source: 'pricedb', scraptfFromList: { paysScrap: 575, sellsScrap: 590, observedAt: T0 - 5 * MIN } });

    // A typed value dated after the save wins again.
    const typed = testSettings({ keyPrice: { mode: 'auto', scraptfSellScrap: 585, scraptfObservedAt: T0 } });
    const engine2 = createEngine({ ...makeDeps(repo, clock, () => typed, log), schema: createStubSchema(), events: recordingEvents(), timers, scraptfKey: () => list.keyRow() });
    expect(engine2.keyPrice().valueScrap).toBe(585);

    const broken = createEngine({
      ...makeDeps(repo, clock, () => settings, log),
      schema: createStubSchema(),
      events: recordingEvents(),
      timers,
      scraptfKey: () => {
        throw new Error('list read failed');
      },
    });
    expect(broken.keyPrice()).toMatchObject({ valueScrap: 600, scraptfFromList: null });
    expect(log.lines.some((l) => l.level === 'warn' && /scrap\.tf list key price/.test(l.msg))).toBe(true);
  });

  it('ignores a key row priced in keys, and values list rows at the capped key price without a cycle', () => {
    const repo = newRepo();
    const clock = new FakeClock();
    const settings = testSettings();
    let reads = 0;
    const list = createScraptfListCache({
      repo,
      log: silentLogger,
      keyPrice: () => {
        reads++;
        return selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
      },
    });
    // A key "priced" in keys says nothing about a key's value.
    repo.upsertScraptfList([keyRow({ sellsKeys: 1, sellsScrap: 0, paysKeys: 1, paysScrap: 0 })]);
    list.refresh();
    expect(list.keyRow()).toBeNull();
    expect(selectKeyPrice(repo.keyQuotes(), settings, T0, list.keyRow())).toMatchObject({ valueScrap: 600, scraptfFromList: null });

    repo.upsertScraptfList([
      keyRow({ observedAt: T0 - MIN }),
      { sku: '30920;6', name: 'Taunt', sellsKeys: 1, sellsScrap: 9, paysKeys: 1, paysScrap: 0, stock: 1, stockLimit: 4, batchId: 2, observedAt: T0 - MIN },
    ]);
    list.refresh();
    // Valued at the engine's key price, which the list's own key row caps (575): read once, no recursion.
    expect(list.rowFor('30920;6')).toMatchObject({ sellsScrap: 575 + 9, paysScrap: 575 });
    expect(reads).toBe(1);
    expect(list.rowFor('30920;6', 600)).toMatchObject({ sellsScrap: 609, paysScrap: 600 });
    expect(reads).toBe(1);
  });

  it('falls back to the default key value when nothing at all is known', () => {
    expect(selectKeyPrice([], testSettings(), T0, null)).toMatchObject({ valueScrap: DEFAULT_KEY_SCRAP, source: 'default', scraptfFromList: null });
  });
});
