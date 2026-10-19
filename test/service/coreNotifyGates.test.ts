// 0.7.1 (Package C), wired in the real core: what keeps the engine's toasts to news.
// ACT-7: a price the user typed or saved from the check popup minutes ago (dated then, or new to the engine
// then, as a saved-list price the popup dates at the list's save time) is told already (no "Profit:").
// ACT-3: a scrap.tf buy recorded in the journal after a price was seen holds its toast back, and an Undo
// lets it through again. ACT-8: a rule candidate on a bank page seen whole (a bank stock save) within
// inputStaleMs gets no "Candidate:" toast; a stale, empty or partial look does not hold it back. Real core
// and repo in a temp folder; only the schema host answers, and nothing here makes another request
// (scrap.tf never, R1).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBptfSocketGuard } from '../../src/service/connectors/bptfSocket';
import type { Clock, Repo } from '../../src/service/contracts';
import { DB_FILE_NAME, USER_PRICE_TOLD_MS, createServiceCore, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { createLogger } from '../../src/service/logger';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract, PushEvent } from '../../src/shared/rpc';
import type { JournalEntry, Listing, OppListResult, ScrapPrice } from '../../src/shared/types';
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

/** A clock the test moves forward while real timers keep running. */
function offsetClock(): Clock & { offset: number } {
  const c = { offset: 0, now: () => Date.now() + c.offset };
  return c;
}

let seq = 0;
/** Fresh buy orders from distinct buyers, stored before the core starts (the feed is off). */
function buyers(sku: string, scrap: number, n = 3): Listing[] {
  return Array.from({ length: n }, (_, i) => {
    seq++;
    return makeListing({ id: `gate${seq}`, sku, baseSku: sku, steamid: `7656119800088${String(seq).padStart(4, '0')}`, metalScrap: scrap - i, isBot: i === 0, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

async function setup(seed: (repo: Repo) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-notify-gates-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const repo = openRepo(path.join(dataDir, DB_FILE_NAME));
  seed(repo);
  repo.close();
  const clock = offsetClock();
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    notifications: { minConfidence: 0 },
  });
  const core = createServiceCore({ dataDir, version: '0.7.1', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, wsFactory: (url, headers) => new FakeSocket(url, headers), clock });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  // The engine's toasts only (a journal buy is a held item too, whose "Sell:" toasts are Holdings').
  const titles = () =>
    pushes
      .filter((p) => p.event === 'notify')
      .map((p) => (p.payload as PushContract['notify']).title)
      .filter((t) => /^(Profit|Candidate):/.test(t));
  /** The engine's run, then a moment for any debounced run the writes scheduled. */
  const run = async () => {
    await call('engine.runNow');
    await new Promise((r) => setTimeout(r, 1_300));
    await call('engine.runNow');
  };
  return { core, call, pushes, titles, run, clock };
}

describe('the engine toasts only news, as core wires it (0.7.1)', () => {
  it('ACT-7: a price the user just typed or saved gets no "Profit:" toast, then or later, whatever its date; an old price that comes to pay does', async () => {
    const h = await setup((repo) => repo.upsertListings([...buyers('378;6', 300), ...buyers('45;6', 300), ...buyers('126;6', 250)]));
    // Saved from the check popup just now (dated at the copy), and from the saved list: checkSaveInput dates
    // that one at the list's save time, here 30 min ago, but it is new to the engine all the same.
    await h.call('prices.upsert', { sku: '378;6', costScrap: 30, note: 'live check' });
    await h.call('prices.upsert', { sku: '45;6', costScrap: 30, observedAt: h.clock.now() - 30 * MIN, note: 'live check' });
    // A price typed an hour ago at a cost no buyer clears: stored, nothing to tell yet.
    const old = await h.call<ScrapPrice>('prices.upsert', { sku: '126;6', costScrap: 400, observedAt: h.clock.now() - HOUR });
    await h.run();
    expect(h.titles()).toEqual([]);
    const opps = await h.call<OppListResult>('opps.list', {});
    expect(opps.rows.filter((o) => o.status === 'profitable').map((o) => [o.sku, o.inputKind]).sort()).toEqual([
      ['378;6', 'user'],
      ['45;6', 'user'],
    ]);
    // Recorded as told: past the dedupe window, unchanged, still nothing.
    h.clock.offset += 31 * MIN;
    await h.run();
    expect(h.titles()).toEqual([]);
    // Neither dated nor new minutes ago: the old price, corrected to a cost that pays, is news.
    expect(h.clock.now() - old.observedAt).toBeGreaterThan(USER_PRICE_TOLD_MS);
    await h.call('prices.upsert', { id: old.id, sku: '126;6', costScrap: 30, observedAt: old.observedAt });
    await h.run();
    expect(h.titles()).toEqual(["Profit: Bill's Hat"]);
  }, 30_000);

  it('ACT-3: a scrap.tf buy recorded after the price was seen holds its toast back, and its Undo lets it through', async () => {
    const h = await setup((repo) => repo.upsertListings([...buyers('378;6', 300), ...buyers('126;6', 250)]));
    const t = h.clock.now();
    const bought = await h.call<JournalEntry>('journal.add', { side: 'buy', venue: 'scrap.tf', sku: '378;6', scrap: 30, ts: t - 5 * MIN });
    // Bought before its price was seen, and on any-case "Scrap.TF": that one still toasts.
    await h.call('journal.add', { side: 'buy', venue: 'Scrap.TF', sku: '126;6', scrap: 30, ts: t - 30 * MIN });
    // Prices from a page saved 20 min ago (imports, so ACT-7's rule for the user's own prices stays out of it).
    await h.call('prices.upsert', { sku: '378;6', costScrap: 30, observedAt: t - 20 * MIN, source: 'import' });
    await h.call('prices.upsert', { sku: '126;6', costScrap: 30, observedAt: t - 20 * MIN, source: 'import' });
    await h.run();
    expect(h.titles()).toEqual(["Profit: Bill's Hat"]);
    // The buy was a mistake: Undo. The engine hears of it through journalChanged.
    await h.call('journal.delete', { id: bought.id });
    await h.run();
    expect(h.titles().sort()).toEqual(["Profit: Bill's Hat", 'Profit: The Team Captain']);
  }, 30_000);

  it('ACT-8: no "Candidate:" toast for a hat a 10-minute-old hats save does not list; a stale, empty or partial look holds nothing back', async () => {
    const h = await setup((repo) => {
      repo.upsertListings([...buyers('378;6', 300), ...buyers('45;6', 300)]);
      /** A whole look of a bank page: its batch plus its bank stock save (what importSavedPage writes). */
      const wholeLook = (bank: 'hats' | 'weapons', fileName: string, at: number, sku: string): void => {
        const id = repo.createImportBatch({ fileName, pageKind: 'buy', fileMtime: at, importedAt: at, itemCount: 1, categories: { [bank]: 1 }, bank });
        repo.insertBankStock(id, bank, [{ sku, specialKey: '', name: sku, costKeys: 0, costScrap: 20, stock: 1, assetId: null }]);
      };
      wholeLook('hats', 'Buy Hats.html', NOW - 10 * MIN, '940;6');
      wholeLook('weapons', 'Buy Weapons.html', NOW - 3 * HOUR, '13;6');
      // A newer weapons save that stored nothing (cards still loading) is no save of the page.
      repo.createImportBatch({ fileName: 'Buy Weapons (1).html', pageKind: 'buy', fileMtime: NOW - 2 * MIN, importedAt: NOW - 2 * MIN, itemCount: 0, categories: {}, bank: 'weapons' });
      // Nor is a look that stored prices but no bank stock save (a partial look, DM-2, or a window snapshot
      // cut before its settle read, ACT-4): the cards it missed may well be on the page.
      repo.createImportBatch({ fileName: 'scrap.tf window /buy/weapons', pageKind: 'buy', fileMtime: NOW - MIN, importedAt: NOW - MIN, itemCount: 4, categories: { weapons: 4 }, bank: 'weapons', origin: 'window' });
    });
    await h.call('rules.upsert', { name: 'Hats', filter: { defindexes: [378], hasEffect: false }, costScrap: 200 });
    await h.call('rules.upsert', { name: 'Weapons', filter: { defindexes: [45] }, costScrap: 200 });
    await h.run();
    expect(h.titles()).toEqual(['Candidate: The Force-a-Nature']);
    const opps = await h.call<OppListResult>('opps.list', { inputKinds: ['rule'] });
    expect(opps.rows.map((o) => [o.sku, o.status]).sort()).toEqual([
      ['378;6', 'profitable'],
      ['45;6', 'profitable'],
    ]);
    // Two hours on, that hats save is older than profit.inputStaleMs: the candidate is told.
    h.clock.offset += 2 * HOUR;
    await h.run();
    expect(h.titles()).toEqual(['Candidate: The Force-a-Nature', 'Candidate: The Team Captain']);
    expect(requested.every((r) => r.startsWith('sku.pricedb.io/'))).toBe(true);
  }, 30_000);
});
