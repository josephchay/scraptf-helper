// 0.7.4 (review R14, R40; F22, F70): the cost checks the engine applies to an opportunity's cost
// ('variant-suspect': under 0.9x the item's PriceDB band and within 10% of its craftability twin's;
// 'cost-below-market': under 0.95x its PriceDB buy by 1 ref or more; PriceDB only, age-gated) also keep a
// bank card out of the scrap.tf window's "N flips on this page" (BankStock.pageFlips) and the "New on
// scrap.tf" toast (newFlips, notifyNewBankFlips), so a card keyed to the wrong copy is never toasted there
// while Opportunities shows it at Low. core wires bankStockCostCheck. A real in-memory repo with PriceDB rows
// and a fake Live market entryFor; nothing touches the network.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { bankStockCostCheck, createBankStock, notifyNewBankFlips } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockStored, KeyPriceState, PricedbRow, ScraptfBank, Settings, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const K = 600;
const KEY: KeyPriceState = { valueScrap: K, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const HUE = '5040;6';
const CAPTAIN = '378;6';
const GIBUS = '940;6';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, keys: number, scrap: number, name = `Item ${sku}`): BankStockStored {
  return { sku, specialKey: '', name, costKeys: keys, costScrap: scrap, stock: 1, assetId: null };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows);
  return id;
}

function entry(revenueScrap: number, settings: Settings): MarketEval {
  const o = {
    listingId: `l-${revenueScrap}`,
    steamid: '76561198000000002',
    userName: 'Bot',
    keys: 0,
    metalScrap: revenueScrap,
    valueScrap: revenueScrap,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
  return {
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueScrap,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 3,
    eligibleCount: 3,
    maxCostScrap: maxCostFor(revenueScrap, settings.profit),
    confidence: 70,
    confidenceLevel: 'high',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

const pdb = (sku: string, name: string, buy: number, sell: number, at: UnixMs = NOW - HOUR): PricedbRow => ({
  sku,
  name,
  buyKeys: Math.floor(buy / K),
  buyScrap: buy % K,
  sellKeys: Math.floor(sell / K),
  sellScrap: sell % K,
  time: Math.floor(at / 1000),
  fetchedAt: at,
});

function setup(withCheck = true) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {});
  const log = recordingLogger();
  const entries = new Map<string, MarketEval>([
    // Craftable Hue's buyers (2 keys 236 scrap), Team Captain's (100 scrap) and the Ghastly Gibus' (100).
    [HUE, entry(2 * K + 236, settings)],
    [CAPTAIN, entry(100, settings)],
    [GIBUS, entry(100, settings)],
  ]);
  const stock = createBankStock({
    clock: { now: () => NOW },
    log,
    repo,
    market: { entryFor: (base) => entries.get(base) ?? null },
    keyPrice: () => KEY,
    settings: () => settings,
    categoryOf: () => 'other',
    ...(withCheck ? { costSuspect: bankStockCostCheck({ repo, keyPrice: () => KEY, settings: () => settings }) } : {}),
  });
  const sent: PushContract['notify'][] = [];
  const notify = (bank: ScraptfBank, batchId: number): number =>
    notifyNewBankFlips({ log, repo, stock, settings: () => settings, keyPrice: () => KEY, notify: (n) => sent.push(n) }, { bank, batchId }, NOW);
  return { repo, stock, sent, notify, log };
}

/** A /buy/items save, then a newer one adding the three cards (all flips against their buyers). */
function seed(h: ReturnType<typeof setup>): number {
  save(h.repo, 'items', NOW - 2 * HOUR, [s('5000;6', 0, 9)]);
  const id = save(h.repo, 'items', NOW - 5 * MIN, [
    s('5000;6', 0, 9),
    // 1 key 366 scrap: the Non-Craftable copy's price, under Craftable Hue's PriceDB band.
    s(HUE, 1, 366, 'A Distinctive Lack of Hue'),
    // 60 scrap, while PriceDB says bots pay 100 for it.
    s(CAPTAIN, 0, 60, 'Team Captain'),
    // 60 scrap with no PriceDB row: nothing to check against.
    s(GIBUS, 0, 60, 'Ghastly Gibus'),
  ]);
  h.stock.refresh();
  return id;
}

describe('bank stock flips skip a cost the engine would flag (R14, R40)', () => {
  it('without PriceDB data every card is a page flip and a new flip', () => {
    const h = setup();
    const id = seed(h);
    expect(h.stock.pageFlips('items', id).map((r) => r.sku).sort()).toEqual([CAPTAIN, GIBUS, HUE].sort());
  });

  it('leaves a variant-suspect and a below-market cost out of page flips, new flips and the toast', () => {
    const h = setup();
    h.repo.upsertPricedb([
      pdb(HUE, 'A Distinctive Lack of Hue', 2 * K + 76, 2 * K + 213),
      pdb(`${HUE};uncraftable`, 'Non-Craftable A Distinctive Lack of Hue', K + 333, K + 392),
      pdb(CAPTAIN, 'Team Captain', 100, 110),
    ]);
    const id = seed(h);
    // The Bank stock page still lists them as flips (shown, as Opportunities shows them at Low)...
    expect(h.stock.list({ bank: 'items', filter: 'flips' }, NOW).rows.map((r) => r.sku).sort()).toEqual([CAPTAIN, GIBUS, HUE].sort());
    // ...but the window's page flips and the S3 toast take only the unflagged one.
    expect(h.stock.pageFlips('items', id).map((r) => r.sku)).toEqual([GIBUS]);
    expect(h.stock.newFlips('items', id).map((r) => r.sku)).toEqual([GIBUS]);
    expect(h.notify('items', id)).toBe(1);
    expect(h.sent.map((n) => n.sku)).toEqual([GIBUS]);
  });

  it('a PriceDB price older than the reference age gate checks nothing, as the engine', () => {
    const h = setup();
    h.repo.upsertPricedb([pdb(CAPTAIN, 'Team Captain', 100, 110, NOW - 60 * DAY)]);
    const id = seed(h);
    expect(h.stock.pageFlips('items', id).map((r) => r.sku)).toContain(CAPTAIN);
  });

  it('a failing check counts as not suspect, logged once', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    const settings = mergeSettings(DEFAULT_SETTINGS, {});
    const log = recordingLogger();
    const stock = createBankStock({
      clock: { now: () => NOW },
      log,
      repo,
      market: { entryFor: (base) => (base === GIBUS ? entry(100, settings) : null) },
      keyPrice: () => KEY,
      settings: () => settings,
      categoryOf: () => 'other',
      costSuspect: () => {
        throw new Error('db gone');
      },
    });
    save(repo, 'items', NOW - 2 * HOUR, [s('5000;6', 0, 9)]);
    const id = save(repo, 'items', NOW - 5 * MIN, [s('5000;6', 0, 9), s(GIBUS, 0, 60)]);
    stock.refresh();
    expect(stock.pageFlips('items', id).map((r) => r.sku)).toEqual([GIBUS]);
    expect(stock.newFlips('items', id).map((r) => r.sku)).toEqual([GIBUS]);
    expect(log.lines.filter((l) => l.level === 'warn' && l.msg.includes('PriceDB'))).toHaveLength(1);
  });

  it('is what core wires', () => {
    const core = readFileSync(new URL('../../src/service/core.ts', import.meta.url), 'utf8');
    expect(core).toMatch(/createBankStock\(\{[\s\S]*?costSuspect: bankStockCostCheck\(\{ repo, schema,/);
  });
});
