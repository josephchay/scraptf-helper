// F20 end to end in the real core, over the real saved-page fixture. Three saves of scrap.tf/buy/hats go
// through 'import.html' (importSavedPage, as the folder watch calls it):
//   1. buy_hats.html, 100 days ago;
//   2. 95 days ago: B.A.S.E. Jumper gone, Earbuds new, Genuine Bill's Hat cheaper (5 -> 4 ref),
//      Non-Craftable Bill's Hat pricier (1 -> 1.33 ref);
//   3. 30 minutes ago: B.A.S.E. Jumper back (restocked: the first save listed it), Earbuds gone,
//      Non-Craftable Bill's Hat cheaper (1.33 -> 1.11 ref), one Team Captain fewer in stock.
// Each step of the chain is checked where it lands: the scraptf_events rows on disk -> the
// 'scraptf.changed' push -> 'scraptf.changes' with the live revenue and Pay up to of the Live market ->
// 'scraptf.itemHistory' (points with their gap, listedSince, the 1 h / 24 h / 7 d / since-listed changes)
// -> the bank stock rows' time listed and the F20 filters -> the Live market's scraptfListedSince. Both
// older saves are past the 90-day limit, so the thinning after the third import deletes the first and keeps
// the second only because the newest save is compared with it. Then an opt-in re-save reminder: its
// minute timer is held and played by the test (fake timers), it fires once for the stale bank, and main
// opens exactly that bank's static page on a click, and nothing else.
//
// Offline (R1, R10): the pages are local files the "user" saved; only the schema host answers at start, and
// nothing at all is requested after it. No scrap.tf address is ever fetched.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { handleNotificationClick, notificationContent, droppedOpenUrl } from '../../src/main/notify';
import { resetBptfSocketGuard, type SocketTimers } from '../../src/service/connectors/bptfSocket';
import type { Repo } from '../../src/service/contracts';
import { DB_FILE_NAME, createServiceCore, serviceTimers, type ServiceCore } from '../../src/service/core';
import { openRepo } from '../../src/service/db';
import { RESAVE_TICK_MS } from '../../src/service/domain/resaveReminders';
import { createLogger } from '../../src/service/logger';
import { bankStockKey } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { PushContract, PushEvent } from '../../src/shared/rpc';
import { SCRAPTF_CHANGES_CSV_COLUMNS } from '../../src/shared/scraptfHistory';
import type { BankStockResult, ImportResult, Listing, MarketListResult, MarketRow, OppListResult, ScraptfChangeEvent, ScraptfItemHistory, Settings } from '../../src/shared/types';
import { FakeSocket } from '../bptf/helpers';
import { makeListing } from '../domain/helpers';

const FIX = fileURLToPath(new URL('../fixtures/', import.meta.url));
const schemaSubset = JSON.parse(readFileSync(path.join(FIX, 'pricedb/schema-subset.json'), 'utf8')) as unknown;
const paintList = JSON.parse(readFileSync(path.join(FIX, 'pricedb/paint-list.json'), 'utf8')) as unknown;
const HATS = readFileSync(path.join(FIX, 'import/buy_hats.html'), 'utf8');
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
const repos: Repo[] = [];
afterEach(async () => {
  while (repos.length) repos.pop()!.close();
  while (cores.length) await cores.pop()!.stop();
  resetBptfSocketGuard();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
  requested.length = 0;
});

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const S1 = NOW - 100 * DAY;
const S2 = NOW - 95 * DAY;
const S3 = NOW - 30 * MIN;
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
/** Three fresh buyers of one SKU at about `scrap` each (eligible orders, so no suspect margin). */
function buyers(sku: string, scrap: number): Listing[] {
  return Array.from({ length: 3 }, (_, i) => {
    seq++;
    return makeListing({ id: `hist${seq}`, sku, baseSku: sku, steamid: `7656119800088${String(seq).padStart(4, '0')}`, metalScrap: scrap - i, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

/** One card of buy_hats.html, from its `<!-- Cnn` comment up to the next card's comment. */
function card(html: string, id: string): string {
  const start = html.indexOf(`<!-- ${id}:`);
  const end = html.indexOf('<!-- C', start + 4);
  if (start < 0 || end < 0) throw new Error(`no card ${id} in the fixture`);
  return html.slice(start, end);
}

/** Earbuds (defindex 143), a hat the first save did not have; the markup of the fixture's C02. */
const EARBUDS = [
  '<!-- C99: new since the first save -->',
  `<div data-id="9100000099" data-slot="head" data-classes="multi" data-content="Level 1<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-value="18" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="Earbuds" data-defindex="143">`,
  '\t<div class="item-value-indicator">2 ref</div>',
  '</div>',
  '',
  '',
].join('\n');

/** Replaces `from` by `to` once, failing loudly if the fixture changed (so this test cannot silently weaken). */
function swap(html: string, from: string, to: string): string {
  expect(html.includes(from), from.slice(0, 60)).toBe(true);
  return html.replace(from, to);
}

/** Save 2: C13 gone, Earbuds added, C36 down to 4 ref, C14 up to 1.33 ref. */
function secondSave(html: string): string {
  const nonCraft = card(html, 'C14');
  const genuine = card(html, 'C36');
  let out = swap(html, card(html, 'C13'), EARBUDS);
  out = swap(out, nonCraft, nonCraft.replace('data-item-value="9"', 'data-item-value="12"').replace('>1 ref<', '>1.33 ref<'));
  return swap(out, genuine, genuine.replace('data-item-value="45"', 'data-item-value="36"').replace('>5 ref<', '>4 ref<'));
}

/** Save 3, from save 2: C13 back where Earbuds was, C14 down to 1.11 ref, C01 (Team Captain) 3 -> 2 in stock. */
function thirdSave(second: string): string {
  const nonCraft = card(second, 'C14');
  const captain = card(second, 'C01');
  let out = swap(second, EARBUDS, card(HATS, 'C13'));
  out = swap(out, nonCraft, nonCraft.replace('data-item-value="12"', 'data-item-value="10"').replace('>1.33 ref<', '>1.11 ref<'));
  return swap(out, captain, captain.replace('data-num-available="3"', 'data-num-available="2"').replace('>3x<', '>2x<'));
}

const CAPTAIN = '378;6';
const GENUINE = '126;1';
const NON_CRAFT = '126;6;uncraftable';
const BASE_JUMPER = '1101;6;uncraftable';
const EARBUDS_SKU = '143;6';
const HATS_URL = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;

/**
 * The core's timers: real, except the re-save reminder's minute timer, which is held for the test to play
 * (fake timers for that one timer; the engine's sweep also waits a minute, so the reminder's is told by
 * its call site). Every other timer runs as in the app.
 */
function reminderClock() {
  const held: { fn: () => void }[] = [];
  const timers: SocketTimers = {
    ...serviceTimers,
    setTimeout(fn, ms) {
      if (ms === RESAVE_TICK_MS && /resaveReminders/.test(new Error().stack ?? '')) {
        const h = { fn };
        held.push(h);
        return h;
      }
      return serviceTimers.setTimeout(fn, ms);
    },
    clearTimeout(h) {
      const i = held.indexOf(h as { fn: () => void });
      if (i >= 0) held.splice(i, 1);
      else serviceTimers.clearTimeout(h);
    },
  };
  /** A minute passes for the reminder: its tick runs (and arms the next one). */
  const tick = () => {
    expect(held).toHaveLength(1);
    held.shift()!.fn();
  };
  return { timers, held, tick };
}

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-history-wire-'));
  temps.push(root);
  const dataDir = path.join(root, 'data');
  const dbPath = path.join(dataDir, DB_FILE_NAME);
  const seedRepo = openRepo(dbPath);
  seedRepo.upsertListings([...buyers(CAPTAIN, 300), ...buyers(EARBUDS_SKU, 250), ...buyers(GENUINE, 400), ...buyers(NON_CRAFT, 100), ...buyers(BASE_JUMPER, 60)]);
  seedRepo.close();
  const settings: Settings = mergeSettings(DEFAULT_SETTINGS, {
    contactUrl: 'https://github.com/flipdesk-test',
    liveFeed: { enabled: false },
    connectors: { pricedb: false, pricedbSocket: false, bptfApi: false, scm: false },
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
  });
  const clock = reminderClock();
  const core = createServiceCore({ dataDir, version: '0.6.0', settings, secrets: {}, log: createLogger({ dataDir }), fetchImpl, timers: clock.timers, wsFactory: (url, headers) => new FakeSocket(url, headers) });
  cores.push(core);
  const pushes: { event: PushEvent; payload: unknown }[] = [];
  core.onPush((event, payload) => pushes.push({ event, payload }));
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const importPage = (html: string, mtimeMs: number) => call<ImportResult>('import.html', { html, fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs });
  const notes = () => pushes.filter((p) => p.event === 'notify').map((p) => p.payload as PushContract['notify']);
  /** A second connection to the core's database file (WAL), to see the rows exactly as stored. */
  const disk = () => {
    const r = openRepo(dbPath);
    repos.push(r);
    return r;
  };
  return { core, call, pushes, importPage, notes, disk, settings, clock };
}

describe('scrap.tf history, wired end to end (F20)', () => {
  it('takes three saves of buy_hats.html from the import to the feed, item history, time listed, thinning and a re-save reminder', async () => {
    const h = await setup();
    await waitFor('the Live market build', async () => {
      const m = await h.call<MarketListResult>('market.list', {});
      return !m.stats.building && m.stats.lastFullAt !== null && [CAPTAIN, EARBUDS_SKU, GENUINE, NON_CRAFT, BASE_JUMPER].every((sku) => m.rows.some((r) => r.sku === sku && r.buyerCount === 3));
    });
    // The reminder's timer is armed at start and held; it is off by default, so a minute passing says nothing.
    h.clock.tick();
    expect(h.notes()).toEqual([]);

    // ---- Save 1: a first save of the page writes no change and pushes none. ----
    const second = secondSave(HATS);
    const third = thirdSave(second);
    const first = await h.importPage(HATS, S1);
    expect(first).toMatchObject({ bank: 'hats' });
    expect(h.disk().scraptfEvents({ limit: 5000 })).toEqual([]);
    expect(h.pushes.some((p) => p.event === 'scraptf.changed')).toBe(false);

    // ---- Save 2: four changes against save 1, in the import's transaction. ----
    h.pushes.length = 0;
    const save2 = await h.importPage(second, S2);
    const rows2 = h.disk().scraptfEvents({ limit: 5000 });
    expect(rows2.map((e) => [e.sku, e.kind, e.at, e.batchId, e.page]).sort()).toEqual(
      [
        [BASE_JUMPER, 'gone', S2, save2.batchId, '/buy/hats'],
        [EARBUDS_SKU, 'new', S2, save2.batchId, '/buy/hats'],
        [GENUINE, 'cheaper', S2, save2.batchId, '/buy/hats'],
        [NON_CRAFT, 'pricier', S2, save2.batchId, '/buy/hats'],
      ].sort(),
    );
    expect(rows2.find((e) => e.sku === GENUINE)).toMatchObject({ fromKeys: 0, fromScrap: 45, toKeys: 0, toScrap: 36 });
    expect(h.pushes.filter((p) => p.event === 'scraptf.changed').map((p) => p.payload)).toEqual([{ at: S2, count: 4 }]);
    // The push follows the bank stock refresh and comes before the price push and import.done.
    const order = h.pushes.map((p) => p.event).filter((e) => e === 'scraptf.changed' || e === 'prices.changed' || e === 'import.done');
    expect(order).toEqual(['scraptf.changed', 'prices.changed', 'import.done']);
    // Both saves kept, though older than 90 days: the newest and the one it is compared with.
    expect(h.disk().bankStockSaves('hats').map((s) => s.batchId)).toEqual([save2.batchId, first.batchId]);

    // ---- Save 3: restocked, gone, cheaper and a stock move against save 2. ----
    h.pushes.length = 0;
    const save3 = await h.importPage(third, S3);
    const disk3 = h.disk();
    const rows3 = disk3.scraptfEvents({ limit: 5000 }).filter((e) => e.batchId === save3.batchId);
    expect(rows3.map((e) => [e.sku, e.kind, e.at]).sort()).toEqual(
      [
        [BASE_JUMPER, 'restocked', S3],
        [EARBUDS_SKU, 'gone', S3],
        [NON_CRAFT, 'cheaper', S3],
        [CAPTAIN, 'stock', S3],
      ].sort(),
    );
    const stockMove = rows3.find((e) => e.kind === 'stock')!;
    expect(stockMove).toMatchObject({ fromScrap: 12, toScrap: 12 });
    expect(stockMove.toStock).toBe(stockMove.fromStock! - 1);
    expect(rows3.find((e) => e.kind === 'restocked')).toMatchObject({ fromScrap: null, toScrap: 5, toStock: 1 });
    expect(h.pushes.filter((p) => p.event === 'scraptf.changed').map((p) => p.payload)).toEqual([{ at: S3, count: 4 }]);

    // Thinning after the import: save 1 (past 90 days) is gone; save 2 is past 90 days too but stays,
    // because the newest save is compared with it; the stock page still reads that pair.
    expect(disk3.bankStockSaves('hats').map((s) => s.batchId)).toEqual([save3.batchId, save2.batchId]);
    expect(disk3.bankStockRows(first.batchId)).toEqual([]);
    expect(disk3.bankStockLatestPair('hats')).toMatchObject({ newest: { batchId: save3.batchId }, previous: { batchId: save2.batchId } });
    // The feed keeps every change, the thinned save's included.
    expect(disk3.scraptfEvents({ limit: 5000 })).toHaveLength(8);

    // ---- 'scraptf.changes': newest first, valued now, joined to the Live market's buy side. ----
    const market = await h.call<MarketListResult>('market.list', { limit: 2000 });
    const row = (sku: string): MarketRow => market.rows.find((r) => r.sku === sku)!;
    const feed = await h.call<ScraptfChangeEvent[]>('scraptf.changes', {});
    expect(feed).toHaveLength(8);
    expect(feed.map((e) => e.id)).toEqual([...feed.map((e) => e.id)].sort((a, b) => b - a));
    expect(feed.slice(0, 4).every((e) => e.at === S3)).toBe(true);
    expect(feed.slice(4).every((e) => e.at === S2)).toBe(true);
    for (const e of feed) {
      expect(e.revenueScrap, `${e.sku} ${e.kind}`).toBe(row(e.sku).revenueScrap);
      expect(e.revenueScrap, e.sku).not.toBeNull();
      expect(e.maxCostScrap, e.sku).toBe(row(e.sku).maxCostScrap);
      expect(e.key).toBe(bankStockKey(e.sku, e.specialKey));
    }
    const cheaper = feed.find((e) => e.sku === NON_CRAFT && e.kind === 'cheaper')!;
    expect(cheaper).toMatchObject({ fromValueScrap: 12, toValueScrap: 10, deltaScrap: -2, flip: true, hasExtras: false });
    expect(cheaper.pct).toBeCloseTo(-2 / 12, 6);
    expect(feed.find((e) => e.kind === 'restocked')).toMatchObject({ sku: BASE_JUMPER, fromValueScrap: null, toValueScrap: 5, flip: true });
    expect(feed.find((e) => e.sku === EARBUDS_SKU && e.kind === 'gone')).toMatchObject({ fromValueScrap: 18, toValueScrap: null, flip: false });
    // Filters and paging, as the Live log tab reads them.
    expect((await h.call<ScraptfChangeEvent[]>('scraptf.changes', { kinds: ['restocked', 'stock'] })).map((e) => e.sku).sort()).toEqual([BASE_JUMPER, CAPTAIN].sort());
    expect((await h.call<ScraptfChangeEvent[]>('scraptf.changes', { bank: 'hats', sku: NON_CRAFT })).map((e) => e.kind)).toEqual(['cheaper', 'pricier']);
    expect(await h.call<ScraptfChangeEvent[]>('scraptf.changes', { bank: 'stranges' })).toEqual([]);
    const page1 = await h.call<ScraptfChangeEvent[]>('scraptf.changes', { limit: 3 });
    const page2 = await h.call<ScraptfChangeEvent[]>('scraptf.changes', { beforeId: page1.at(-1)!.id, limit: 100 });
    expect([...page1, ...page2].map((e) => e.id)).toEqual(feed.map((e) => e.id));
    const csv = await h.call<{ csv: string; suggestedName: string }>('opps.exportCsv', { kind: 'scraptfChanges', scraptfChanges: { bank: 'hats' } });
    const lines = csv.csv.trim().split(/\r?\n/);
    expect(lines[0]).toContain(SCRAPTF_CHANGES_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(9);

    // ---- 'scraptf.itemHistory': one point per retained save of the item's page, with its gaps. ----
    const nonCraft = await h.call<ScraptfItemHistory>('scraptf.itemHistory', { sku: NON_CRAFT });
    expect(nonCraft).toMatchObject({ sku: NON_CRAFT, bank: 'hats', firstSeenAt: S2, listedSince: S2, lastSeenAt: S3, current: { costScrap: 10, bank: 'hats' } });
    expect(nonCraft.points.map((p) => [p.at, p.costScrap, p.listed])).toEqual([
      [S2, 12, true],
      [S3, 10, true],
    ]);
    // Save 3 is within the hour, so 1 h, 24 h and 7 d all compare with save 2, as "since listed" does.
    for (const c of [nonCraft.change.h1, nonCraft.change.h24, nonCraft.change.d7, nonCraft.change.listed]) {
      expect(c).toMatchObject({ fromScrap: 12, toScrap: 10, deltaScrap: -2, since: S2 });
    }
    expect(nonCraft.events.map((e) => e.kind)).toEqual(['cheaper', 'pricier']);
    // Earbuds: listed in save 2, not in save 3 (a point with no price), so not listed now.
    const earbuds = await h.call<ScraptfItemHistory>('scraptf.itemHistory', { sku: EARBUDS_SKU });
    expect(earbuds).toMatchObject({ bank: 'hats', listedSince: null, lastSeenAt: S2, current: null, change: { h1: null, h24: null, d7: null, listed: null } });
    expect(earbuds.points.map((p) => [p.at, p.costScrap, p.listed])).toEqual([
      [S2, 18, true],
      [S3, 0, false],
    ]);
    expect(earbuds.events.map((e) => e.kind)).toEqual(['gone', 'new']);
    // B.A.S.E. Jumper: back since save 3. The save that listed it first was thinned, so its history starts
    // at save 3; the feed still has its gone and restocked events.
    const jumper = await h.call<ScraptfItemHistory>('scraptf.itemHistory', { sku: BASE_JUMPER });
    expect(jumper).toMatchObject({ bank: 'hats', firstSeenAt: S3, listedSince: S3, current: { costScrap: 5 } });
    expect(jumper.points.map((p) => [p.at, p.listed])).toEqual([[S3, true]]);
    expect(jumper.events.map((e) => e.kind)).toEqual(['restocked', 'gone']);
    // An item no save listed: an empty history, named by the schema.
    expect(await h.call<ScraptfItemHistory>('scraptf.itemHistory', { sku: '5021;6' })).toMatchObject({ bank: null, points: [], listedSince: null, events: [] });

    // ---- Bank stock: time listed per row and the F20 filters. ----
    const stock = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats' });
    const stockRow = (sku: string) => stock.rows.find((r) => r.sku === sku && !r.hasExtras)!;
    expect(stockRow(NON_CRAFT)).toMatchObject({ change: 'cheaper', previousCostScrap: 12, listedSince: S2, firstSeenAt: S2, changeSinceListed: { deltaScrap: -2, since: S2 } });
    expect(stockRow(BASE_JUMPER)).toMatchObject({ listedSince: S3, firstSeenAt: S3 });
    expect(stockRow(CAPTAIN)).toMatchObject({ listedSince: S2, changeSinceListed: { deltaScrap: 0 } });
    expect(stock.counts.dropped).toBe(1);
    expect(stock.counts.longListed).toBe(stock.rows.filter((r) => r.listedSince !== null && r.listedSince <= NOW - DAY).length);
    expect(stock.counts.longListed).toBeGreaterThan(3);
    const dropped = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'dropped' });
    expect(dropped.rows.map((r) => r.sku)).toEqual([NON_CRAFT]);
    const long = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'long-listed', limit: 2000 });
    expect(long.rows.some((r) => r.sku === BASE_JUMPER)).toBe(false);
    expect(long.rows.some((r) => r.sku === NON_CRAFT)).toBe(true);
    expect(long.total).toBe(stock.counts.longListed);
    // "Listed" sorts the longest-listed first: the item back since 30 minutes comes last.
    const byListed = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', sort: 'listed', limit: 2000 });
    expect(byListed.rows.at(-1)!.sku).toBe(BASE_JUMPER);

    // ---- The Live market: time listed on scrap.tf and "Listed > 24 h". ----
    expect(row(NON_CRAFT).scraptfListedSince).toBe(S2);
    expect(row(BASE_JUMPER).scraptfListedSince).toBe(S3);
    expect(row(EARBUDS_SKU).scraptfListedSince).toBeNull();
    const listed = await h.call<MarketListResult>('market.list', { listedOnScraptf: true, limit: 2000 });
    const listedSkus = new Set(listed.rows.map((r) => r.sku));
    expect([CAPTAIN, GENUINE, NON_CRAFT].every((s) => listedSkus.has(s))).toBe(true);
    expect(listedSkus.has(BASE_JUMPER) || listedSkus.has(EARBUDS_SKU)).toBe(false);

    // ---- Re-save reminders (opt-in): one notification for the stale bank, its static page only. ----
    h.core.updateSettings(mergeSettings(h.settings, { import: { resaveReminderMin: 15 } }));
    h.clock.tick();
    const reminders = h.notes().filter((n) => n.title.startsWith('Re-save'));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toEqual({
      title: 'Re-save scrap.tf/buy/hats',
      body: expect.stringMatching(/^Last saved 3\d m ago\. Save it again \(Ctrl\+S, 'Webpage, Complete'\) to refresh prices and see what changed$/) as unknown as string,
      sku: null,
      openUrl: HATS_URL,
    });
    // Once per N minutes: the next minute says nothing more, and no bank never saved is reminded of.
    h.clock.tick();
    expect(h.notes().filter((n) => n.title.startsWith('Re-save'))).toHaveLength(1);

    // Main shows it with its link, and a click opens exactly that bank page in the user's browser.
    const pushed = h.pushes.find((p) => p.event === 'notify' && (p.payload as PushContract['notify']).title.startsWith('Re-save'))!.payload;
    const toast = notificationContent(pushed)!;
    expect(toast).toEqual(reminders[0]);
    expect(droppedOpenUrl(pushed, toast)).toBe(false);
    const opened: string[] = [];
    const elsewhere: string[] = [];
    const warnings: string[] = [];
    const deps = {
      openExternal: (url: string) => void opened.push(url),
      openItem: (sku: string) => void elsewhere.push(`item:${sku}`),
      showDashboard: () => void elsewhere.push('dashboard'),
      log: { warn: (msg: string) => void warnings.push(msg) },
    };
    expect(await handleNotificationClick(toast, deps)).toBe('url');
    expect(opened).toEqual([HATS_URL]);
    expect(elsewhere).toEqual([]);
    // A link that is not exactly a static bank page is refused, at receipt and again at click time.
    for (const url of [`${HATS_URL}?q=Bill's Hat`, `${HATS_URL}/${NON_CRAFT}`, `${HATS_URL}/`, 'https://example.com/']) {
      expect(notificationContent({ ...reminders[0], openUrl: url })).not.toHaveProperty('openUrl');
      expect(await handleNotificationClick({ ...toast, openUrl: url }, deps)).toBe('dashboard');
    }
    expect(opened).toEqual([HATS_URL]);
    // Refusals are logged without the URL (it may carry item data).
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).not.toMatch(/https?:|\/buy\/|example|Bill|126;/);

    // Nothing left this process after start: no scrap.tf, no anything (R1).
    expect(requested).toEqual([]);
  }, 60_000);

  // 0.8 (T3-T7, LC-4, LC-5): buy_hats.html and two later saves of it (Non-Craftable Bill's Hat repriced down twice
  // with its stock unchanged, B.A.S.E. Jumper and then Genuine Bill's Hat gone): the verdict and the cycles reach the
  // drawer, the bank stock rows (Dropping), the Live market and Health, from the saves in memory; nothing is requested.
  it('carries the buy timing and the cycles from three saves to every surface, offline', async () => {
    const h = await setup();
    await waitFor('the Live market build', async () => {
      const m = await h.call<MarketListResult>('market.list', {});
      return !m.stats.building && m.stats.lastFullAt !== null && m.rows.some((r) => r.sku === NON_CRAFT && r.buyerCount === 3);
    });
    const reprice = (html: string, from: [string, string], to: [string, string]): string => {
      const c = card(html, 'C14');
      return swap(html, c, c.replace(`data-item-value="${from[0]}"`, `data-item-value="${to[0]}"`).replace(`>${from[1]}<`, `>${to[1]}<`));
    };
    const second = swap(reprice(HATS, ['9', '1 ref'], ['8', '0.89 ref']), card(HATS, 'C13'), '');
    const third = swap(reprice(second, ['8', '0.89 ref'], ['7', '0.78 ref']), card(second, 'C36'), '');
    await h.importPage(HATS, NOW - 5 * HOUR);
    await h.importPage(second, NOW - 3 * HOUR);
    await h.importPage(third, NOW - HOUR);

    // The drawer: the copy's run with its two drops, and a verdict (whatever it is, with its why).
    const item = await h.call<ScraptfItemHistory>('scraptf.itemHistory', { sku: NON_CRAFT });
    expect(item.cycles).toMatchObject({ runsTotal: 1, returns: 0, dropAts: [NOW - 3 * HOUR, NOW - HOUR] });
    expect(item.timing).toMatchObject({ bank: 'hats', key: bankStockKey(NON_CRAFT, ''), dropsThisRun: 2, lastSeenAt: NOW - HOUR });
    expect(item.timing!.why).toEqual(expect.any(String));
    expect(item.timing!.steps.map((s) => [s.fromScrap, s.toScrap])).toEqual([
      [9, 8],
      [8, 7],
    ]);

    // Bank stock: the same verdict on the row, the Dropping chip, and the bank's turnover.
    const stock = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', limit: 2000 });
    const row = stock.rows.find((r) => r.key === bankStockKey(NON_CRAFT, ''))!;
    expect(row.timing).toMatchObject({ verdict: item.timing!.verdict, why: item.timing!.why, dropsThisRun: 2 });
    expect(stock.counts.dropping).toBe(1);
    const dropping = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'dropping' });
    expect(dropping.rows.map((r) => r.sku)).toEqual([NON_CRAFT]);
    expect(stock.turnover).toMatchObject({ bank: 'hats', reason: 'not-enough-data' });
    const gone = await h.call<BankStockResult>('scraptf.bankStock', { bank: 'hats', filter: 'gone' });
    expect(gone.rows.map((r) => r.sku)).toEqual([GENUINE]);
    expect(gone.rows[0]).not.toHaveProperty('timing');

    // The Live market's page: the listed copy's verdict, as the bank stock row has it.
    const market = await h.call<MarketListResult>('market.list', { limit: 2000 });
    expect(market.rows.find((r) => r.sku === NON_CRAFT)!.scraptfTiming).toEqual(row.timing);

    // Opportunities: the imported price's row carries its copy's verdict (judged against the row's own Sells for).
    const opp = await waitFor('the imported price as an opportunity', async () => {
      const list = await h.call<OppListResult>('opps.list', { limit: 500 });
      return list.rows.find((o) => o.sku === NON_CRAFT && o.inputKind === 'import' && o.costScrap === 7);
    });
    expect(opp.timing).toMatchObject({ bank: 'hats', key: bankStockKey(NON_CRAFT, ''), dropsThisRun: 2 });

    // Health: the hats bank's asset-id stability. Every single card keeps its data-id across the three saves (two
    // looks apart each), over 50 pairs: stable, so the drawer may say 'the same item came back'.
    const health = await h.call<{ scraptfAssetIds?: { bank: string; pairs: number; same: number; stable: boolean }[] }>('health.get');
    expect(health.scraptfAssetIds).toEqual([expect.objectContaining({ bank: 'hats', stable: true })]);
    expect(health.scraptfAssetIds![0]!.pairs).toBeGreaterThanOrEqual(50);
    expect(health.scraptfAssetIds![0]!.same).toBe(health.scraptfAssetIds![0]!.pairs);
    expect(item.cycles!.assetIdsStable).toBe(true);

    expect(requested).toEqual([]);
  }, 60_000);
});
