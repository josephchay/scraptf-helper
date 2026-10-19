// 0.7.1 (DM-7, CQ-3): the Live market's coverage strip and the banks cards date a bank from the same
// per-bank newest-save query (Repo.bankNewestSaves) over every import batch, so 500 newer window reads of
// one bank never turn another bank into "never saved" on the strip while its card still dates it. Real
// in-memory repo, market index and banks summary; fake clock and timers. No network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBanksSummary } from '../../src/service/domain/banks';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { COVERAGE_BATCHES, createMarketIndex } from '../../src/service/domain/market';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { mergeBankNewestSaves, scraptfBankSaves, scraptfCoverage } from '../../src/shared/market';
import type { ScraptfBank } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, recordingLogger } from './helpers';

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock(T0);
  const timers = new FakeTimers(clock);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    schema: createStubSchema(),
    timers,
    keyPrice: () => selectKeyPrice(repo.keyQuotes(), settings, clock.now()),
    onChanged: () => undefined,
    folderWatchActive: () => false,
  });
  market.start();
  timers.advance(0);
  const banks = createBanksSummary({
    clock,
    log: recordingLogger(),
    repo,
    market,
    scraptfList: { summary: () => ({ items: 0, newestAt: null, oldestAt: null, batches: 0 }), all: () => [], version: () => 1 },
    settings: () => settings,
    folderWatch: () => ({ active: false, error: null }),
    timers,
  });
  return { repo, market, banks, clock };
}

function batch(repo: Repo, bank: ScraptfBank, at: number, items: number): number {
  return repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: items, categories: { [bank]: items }, bank, origin: 'window' });
}

describe('coverage past COVERAGE_BATCHES batches (DM-7)', () => {
  it('one skins save, then 500 hats reads: the strip and the card both date skins', () => {
    const h = setup();
    batch(h.repo, 'skins', T0 - 3 * DAY, 5);
    for (let i = 0; i < COVERAGE_BATCHES; i++) batch(h.repo, 'hats', T0 - 2 * DAY + i * MIN, 40);
    // The 500 newest batches alone no longer hold the skins save.
    expect(scraptfBankSaves(h.repo.listImportBatches(COVERAGE_BATCHES), () => []).newest.has('skins')).toBe(false);

    const strip = h.market.list({}, T0).scraptf.coverage;
    expect(strip.find((c) => c.label === 'Skins')).toMatchObject({ lastSavedAt: T0 - 3 * DAY, items: 5 });
    expect(strip.find((c) => c.label === 'Hats')).toMatchObject({ lastSavedAt: T0 - 2 * DAY + (COVERAGE_BATCHES - 1) * MIN, items: 40 });
    const card = h.banks.summary(T0).banks.find((b) => b.bank === 'skins')!;
    expect(card).toMatchObject({ lastSavedAt: T0 - 3 * DAY, items: 5 });
    // One source for both: the card's date is the strip's.
    for (const c of h.banks.summary(T0).banks) {
      const chip = strip.find((x) => x.url === c.url);
      if (chip) expect(c.lastSavedAt, c.bank).toBe(chip.lastSavedAt);
    }
  });

  it('a bank page that stored nothing never dates its bank, from either source', () => {
    const h = setup();
    batch(h.repo, 'skins', T0 - 3 * DAY, 5);
    batch(h.repo, 'skins', T0 - DAY, 0);
    for (let i = 0; i < COVERAGE_BATCHES; i++) batch(h.repo, 'hats', T0 - 20 * HOUR + i * MIN, 40);
    expect(h.market.list({}, T0).scraptf.coverage.find((c) => c.label === 'Skins')).toMatchObject({ lastSavedAt: T0 - 3 * DAY, items: 5 });
    expect(h.banks.summary(T0).banks.find((b) => b.bank === 'skins')).toMatchObject({ lastSavedAt: T0 - 3 * DAY });
  });
});

describe('mergeBankNewestSaves', () => {
  it('takes the newer save of the two sources, the higher id on a tie, and skips an empty bank page', () => {
    const newest = new Map([['hats' as ScraptfBank, { at: 100, id: 5, items: 3 }]]);
    const merged = mergeBankNewestSaves(newest, [
      { bank: 'hats', batchId: 4, savedAt: 100, itemCount: 9 },
      { bank: 'skins', batchId: 2, savedAt: 50, itemCount: 7 },
      { bank: 'weapons', batchId: 3, savedAt: 60, itemCount: 0 },
      { bank: 'list', batchId: 1, savedAt: 70, itemCount: 0 },
    ]);
    expect([...merged]).toEqual([
      ['hats', { at: 100, id: 5, items: 3 }],
      ['skins', { at: 50, id: 2, items: 7 }],
      ['list', { at: 70, id: 1, items: 0 }],
    ]);
    expect(newest.size).toBe(1);
    expect(mergeBankNewestSaves(newest, null)).toEqual(newest);
    expect(scraptfCoverage([], () => [], [{ bank: 'skins', batchId: 2, savedAt: 50, itemCount: 7 }]).find((c) => c.label === 'Skins')).toMatchObject({ lastSavedAt: 50, items: 7 });
  });
});
