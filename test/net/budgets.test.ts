import { describe, expect, it } from 'vitest';
import { BUDGETS, HOST_CONCURRENCY, budgetById, defaultBudgetFor, tightenBudgets } from '../../src/service/net/budgets';
import { checkUrl } from '../../src/service/net/policy';

const MIN = 60_000;
const HOUR = 60 * MIN;

const spec = (id: string) => {
  const b = budgetById(id);
  expect(b, `budget ${id}`).toBeDefined();
  return b!;
};

describe('BUDGETS', () => {
  it('has unique ids and sane values', () => {
    const ids = BUDGETS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BUDGETS) {
      expect(b.minIntervalMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(b.concurrency) && b.concurrency >= 1).toBe(true);
      expect(b.description.length).toBeGreaterThan(10);
      expect(b.host).toBe(b.host.toLowerCase());
    }
  });

  it('covers every connector budget named in the brief', () => {
    for (const id of [
      'bptf-snapshot',
      'bptf-prices',
      'bptf-currencies',
      'bptf-users',
      'pricedb',
      'sku',
      'steam-webapi',
      'scm',
      'mannco',
      'mptf',
      'stn',
    ]) {
      spec(id);
    }
  });

  it('matches the §2.0 "Our budget" column', () => {
    expect(spec('bptf-snapshot')).toMatchObject({ host: 'api.backpack.tf', minIntervalMs: 10_000, maxPerHour: 300, concurrency: 1 });
    // IGetPrices: never more often than every 15 minutes.
    expect(spec('bptf-prices').minIntervalMs).toBeGreaterThanOrEqual(15 * MIN);
    expect(spec('bptf-currencies').maxPerHour).toBeLessThanOrEqual(3);
    expect(spec('bptf-users').minIntervalMs).toBeGreaterThanOrEqual(10_000);
    expect(spec('pricedb')).toMatchObject({ host: 'pricedb.io', maxPerMinute: 60, concurrency: 2, minRemaining: 36 });
    expect(spec('sku')).toMatchObject({ host: 'sku.pricedb.io', maxPerMinute: 30 });
    expect(spec('steam-webapi')).toMatchObject({ minIntervalMs: 1_000, maxPerDay: 5_000 });
    // 0.9 (#14): the Steam Market gets a daily cap.
    expect(spec('scm')).toMatchObject({ host: 'steamcommunity.com', minIntervalMs: 5_000, on429PauseMs: 6 * HOUR, maxPerDay: 300 });
    expect(spec('mannco').minIntervalMs).toBeGreaterThanOrEqual(MIN);
    expect(spec('mannco-prices').minIntervalMs).toBeGreaterThanOrEqual(HOUR);
    expect(spec('mptf').minIntervalMs).toBeGreaterThanOrEqual(5_000);
    expect(spec('stn').minIntervalMs).toBeGreaterThanOrEqual(5_000);
  });

  it('stays below every published limit', () => {
    // pricedb.io publishes 360/min, sku.pricedb.io 360/min, Steam 100,000/day.
    expect(spec('pricedb').maxPerMinute!).toBeLessThan(360);
    expect(spec('sku').maxPerMinute!).toBeLessThan(360);
    expect(spec('steam-webapi').maxPerDay!).toBeLessThan(100_000);
    // mannco /item/prices: 1 per 5 minutes published.
    expect(spec('mannco-prices').minIntervalMs).toBeGreaterThan(5 * MIN);
    // 0.9 (#14): Steam Market priceoverview, community-measured at about 1,000 a day (RESEARCH §4.6).
    expect(spec('scm').maxPerDay!).toBeLessThan(1_000);
  });

  it('allows 2 concurrent requests to pricedb.io and 1 elsewhere', () => {
    expect(HOST_CONCURRENCY['pricedb.io']).toBe(2);
    for (const b of BUDGETS) if (b.host !== 'pricedb.io') expect(b.concurrency).toBe(1);
  });
});

describe('defaultBudgetFor', () => {
  it.each([
    ['https://api.backpack.tf/api/classifieds/listings/snapshot?sku=Strange%20Pain%20Train&appid=440', 'bptf-snapshot'],
    ['https://backpack.tf/api/classifieds/listings/snapshot?sku=x', 'bptf-snapshot'],
    ['https://api.backpack.tf/api/IGetPrices/v4?raw=1', 'bptf-prices'],
    ['https://api.backpack.tf/api/IGetCurrencies/v1?raw=1', 'bptf-currencies'],
    ['https://api.backpack.tf/api/users/info/v1?steamids=1', 'bptf-users'],
    ['https://api.backpack.tf/api/IGetUsers/v3?steamids=1', 'bptf-users'],
    ['https://api.backpack.tf/api/notifications', 'bptf-misc'],
    ['https://pricedb.io/api/item/5021;6', 'pricedb'],
    ['https://pricedb.io/api/items-bulk', 'pricedb'],
    ['https://ws.pricedb.io/socket.io/?EIO=4', 'pricedb'],
    ['https://sku.pricedb.io/api/schema', 'sku'],
    ['https://api.steampowered.com/IEconItems_440/GetSchemaItems/v0001/', 'steam-webapi'],
    ['https://steamcommunity.com/market/priceoverview/?appid=440', 'scm'],
    ['https://api.mannco.store/user/login', 'mannco-login'],
    ['https://api.mannco.store/item/prices?game=440', 'mannco-prices'],
    ['https://api.mannco.store/item/pricing/bulk?items=1', 'mannco'],
    ['https://marketplace.tf/api/Meta/GetEndpoints/v1', 'mptf'],
    ['https://api.stntrading.eu/GetKeyPrices/v1', 'stn'],
    ['https://API.BACKPACK.TF./api/IGetPrices/v4', 'bptf-prices'],
  ])('%s -> %s', (url, id) => {
    expect(defaultBudgetFor(url)).toBe(id);
    expect(budgetById(id)).toBeDefined();
  });

  it('returns null for hosts without a budget', () => {
    expect(defaultBudgetFor('https://scrap.tf/')).toBeNull();
    expect(defaultBudgetFor('https://example.com/')).toBeNull();
    expect(defaultBudgetFor('not a url')).toBeNull();
  });

  it('every allowed sample URL maps to a configured budget', () => {
    const samples = [
      'https://api.backpack.tf/api/IGetPrices/v4',
      'https://backpack.tf/api/IGetCurrencies/v1',
      'https://pricedb.io/api/autob/items',
      'https://ws.pricedb.io/socket.io/',
      'https://sku.pricedb.io/api/effect/list',
      'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/',
      'https://steamcommunity.com/market/priceoverview/',
      'https://marketplace.tf/api/Bans/GetUserBan/v2',
      'https://api.mannco.store/item/pricing/bulk',
      'https://api.stntrading.eu/GetApiCosts/v1',
    ];
    for (const url of samples) {
      expect(checkUrl(url).allowed, url).toBe(true);
      const id = defaultBudgetFor(url);
      expect(id, url).not.toBeNull();
      expect(budgetById(id!), url).toBeDefined();
    }
  });
});

describe('tightenBudgets', () => {
  it('accepts stricter overrides and ignores looser ones', () => {
    const out = tightenBudgets([
      { id: 'bptf-snapshot', minIntervalMs: 30_000, maxPerHour: 1_000, concurrency: 5 },
      { id: 'pricedb', maxPerMinute: 20, minIntervalMs: 0, concurrency: 1 },
      { id: 'sku', maxPerMinute: -1 },
      { id: 'unknown-budget', minIntervalMs: 1 },
    ]);
    const get = (id: string) => out.find((b) => b.id === id)!;
    expect(get('bptf-snapshot')).toMatchObject({ minIntervalMs: 30_000, maxPerHour: 300, concurrency: 1 });
    expect(get('pricedb')).toMatchObject({ minIntervalMs: 500, maxPerMinute: 20, concurrency: 1, minRemaining: 36 });
    expect(get('sku').maxPerMinute).toBe(30);
    expect(out).toHaveLength(BUDGETS.length);
    // The defaults are not mutated.
    expect(spec('bptf-snapshot').minIntervalMs).toBe(10_000);
  });
});
