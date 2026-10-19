// F20 wiring in the real core: saves of scrap.tf/buy/hats imported through 'import.html' (as the folder
// watch does) write the change feed in the import's transaction, push 'scraptf.changed' after the bank
// stock refresh, and reach every reader: 'scraptf.changes' (joined to the Live market's revenue and Pay
// up to), its CSV, 'scraptf.itemHistory', the bank stock rows' time listed and filters, and the Live
// market's scraptfListedSince and "Listed > 24 h" filter. Temp repo with buy orders stored before start;
// the pages are synthetic saves (R10), only the schema host answers at start, and nothing is requested
// after it (R1).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import { DB_FILE_NAME, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushEvent } from '../../src/shared/rpc';
import { SCRAPTF_CHANGES_CSV_COLUMNS } from '../../src/shared/scraptfHistory';
import type { BankStockResult, ImportResult, Listing, MarketListResult, ScraptfChangeEvent, ScraptfItemHistory } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const requested: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  requested.push(u.hostname + u.pathname);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/schema') return json(schemaSubset);
  if (u.hostname === 'sku.pricedb.io' && u.pathname === '/api/paint/list') return json(paintList);
  if (u.hostname === 'sku.pricedb.io') return json({ success: false }, 404);
  throw new TypeError(`fetch failed: the test refuses ${u.hostname}`);
}) as typeof fetch;

const temps: string[] = [];
const cores: ServiceCore[] = [];
afterEach(async () => {
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(100);
  }
}

let seq = 0;
function buyers(sku: string, scrap: number, n = 3): Listing[] {
  return Array.from({ length: n }, () => {
    seq++;
    return makeListing({ id: `sh${seq}`, sku, baseSku: sku, steamid: `7656119800077${String(seq).padStart(4, '0')}`, metalScrap: scrap, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

let cardId = 9_500_000_000;
/** A hat card as saved with Ctrl+S (the markup of test/fixtures/import/buy_hats.html; made-up ids and prices). */
function card(defindex: number, title: string, scrap: number): string {
  const ref = `${Math.floor(scrap / 9)}.${String((scrap % 9) * 11).padStart(2, '0')}`;
  return `<div data-id="${cardId++}" data-slot="head" data-classes="multi" data-content="Level 10<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-value="${scrap}" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="${title}" data-defindex="${defindex}"><div class="item-value-indicator">${ref} ref</div></div>`;
}

function hatsPage(cards: readonly string[]): string {
  return [
    '<!DOCTYPE html>',
    '<!-- saved from url=(0025)https://scrap.tf/buy/hats -->',
    '<html lang="en"><head><meta charset="utf-8" /><title>Hat Trading - TF2 - Scrap.TF</title>',
    '<meta property="og:url" content="https://scrap.tf/buy/hats" /></head>',
    '<body class="page-theme-light" id="pid-buy-hats"><div class="container"><div id="buy-container" class="items-container rev-items-container">',
    ...cards,
    '</div></div></body></html>',
  ].join('\n');
}

async function setup(seed: (repo: Repo) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-history-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  seed(repo);
  repo.close();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
  });
  const core = createServiceCore({ dataDir, version: '0.6.0', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const importPage = (cards: readonly string[], mtimeMs: number) => call<ImportResult>('import.html', { html: hatsPage(cards), fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs });
  return { core, call, pushes, importPage };
}

describe('scrap.tf history in the core (F20)', () => {
  it('turns saves of a bank into the change feed, item history and time listed, everywhere', async () => {
    const h = await setup((repo) => repo.upsertListings([...buyers('378;6', 300), ...buyers('126;6', 40)]));
    await waitFor('the Live market build', async () => {
      const m = await h.call<MarketListResult>('market.list', {});
      return !m.stats.building && m.rows.some((r) => r.sku === '378;6' && r.buyerCount > 0);
    });

    // First save two days ago: no change to tell, no push.
    await h.importPage([card(378, 'Team Captain', 14), card(126, "Bill's Hat", 20)], NOW - 2 * DAY);
    expect(h.pushes.some((p) => p.event === 'scraptf.changed')).toBe(false);
    expect(await h.call<ScraptfChangeEvent[]>('scraptf.changes', {})).toEqual([]);

    // Ten minutes ago: Team Captain cheaper, Bill's Hat gone.
    h.pushes.length = 0;
    await h.importPage([card(378, 'Team Captain', 12)], NOW - 10 * MIN);
    const changed = h.pushes.filter((p) => p.event === 'scraptf.changed');
    expect(changed.map((p) => p.payload)).toEqual([{ at: NOW - 10 * MIN, count: 2 }]);
    // After the bank stock refresh (its rows read the new save), before the price push and import.done.
    const order = h.pushes.map((p) => p.event).filter((e) => e === 'scraptf.changed' || e === 'prices.changed' || e === 'import.done');
    expect(order).toEqual(['scraptf.changed', 'prices.changed', 'import.done']);

    const feed = await h.call<ScraptfChangeEvent[]>('scraptf.changes', {});
    // One save's events share its time; newest written first (a save's gone rows are written last).
    expect(feed.map((e) => [e.sku, e.kind, e.at])).toEqual([
      ['126;6', 'gone', NOW - 10 * MIN],
      ['378;6', 'cheaper', NOW - 10 * MIN],
    ]);
    const market = await h.call<MarketListResult>('market.list', {});
    const tc = market.rows.find((r) => r.sku === '378;6')!;
    expect(feed[1]).toMatchObject({ fromValueScrap: 14, toValueScrap: 12, deltaScrap: -2, revenueScrap: tc.revenueScrap, maxCostScrap: tc.maxCostScrap, flip: true });
    expect(feed[0]).toMatchObject({ toValueScrap: null, flip: false });
    expect((await h.call<ScraptfChangeEvent[]>('scraptf.changes', { kinds: ['gone'] })).map((e) => e.sku)).toEqual(['126;6']);

    const csv = await h.call<{ csv: string; suggestedName: string }>('opps.exportCsv', { kind: 'scraptfChanges', scraptfChanges: { bank: 'hats' } });
    expect(csv.suggestedName).toMatch(/^flipdesk-scraptf-changes-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = csv.csv.trim().split(/\r?\n/);
    expect(lines[0]).toContain(SCRAPTF_CHANGES_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);

    const item = await h.call<ScraptfItemHistory>('scraptf.itemHistory', { sku: '378;6' });
    expect(item).toMatchObject({ sku: '378;6', bank: 'hats', firstSeenAt: NOW - 2 * DAY, listedSince: NOW - 2 * DAY, lastSeenAt: NOW - 10 * MIN, current: { costScrap: 12, bank: 'hats' } });
    expect(item.points.map((p) => [p.at, p.costScrap, p.listed])).toEqual([
      [NOW - 2 * DAY, 14, true],
      [NOW - 10 * MIN, 12, true],
    ]);
    expect(item.change.listed).toMatchObject({ fromScrap: 14, toScrap: 12, deltaScrap: -2 });
    expect(item.events.map((e) => e.kind)).toEqual(['cheaper']);

    // The bank stock page's time listed and its F20 chips.
    const stock = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'long-listed' });
    expect(stock.rows.map((r) => [r.sku, r.listedSince])).toEqual([['378;6', NOW - 2 * DAY]]);
    expect(stock.counts).toMatchObject({ longListed: 1, dropped: 1 });
    expect((await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'dropped' })).rows[0]!.changeSinceListed).toMatchObject({ deltaScrap: -2 });

    // The Live market's time listed and "Listed > 24 h".
    expect(tc.scraptfListedSince).toBe(NOW - 2 * DAY);
    expect(market.rows.find((r) => r.sku === '126;6')!.scraptfListedSince).toBeNull();
    const listed = await h.call<MarketListResult>('market.list', { listedOnScraptf: true });
    expect(listed.rows.map((r) => r.sku)).toEqual(['378;6']);

    expect(requested).toEqual([]);
  }, 30_000);
});
