// F19 S1 in the real core: a scrap.tf bank page imported through 'import.html' (as the folder watch does)
// turns the Live market rows it listed into links to that page (MarketRow.scraptfLink, source 'seen',
// dated at the save) on the next 'market.list', agreeing with 'item.detail''s seenOn; rows no page listed
// keep their category's bank. The page is a synthetic save (R10); the link is only a static SCRAPTF_BANKS
// URL for links.open, and nothing here requests scrap.tf or anything else after start (R1).

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
import { isAllowedExternalUrl } from '../../src/shared/links';
import type { ImportResult, ItemDetail, Listing, MarketListResult, MarketRow } from '../../src/shared/types';
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
function buyers(sku: string, scrap: number, n = 2): Listing[] {
  return Array.from({ length: n }, () => {
    seq++;
    return makeListing({ id: `ml${seq}`, sku, baseSku: sku, steamid: `7656119800099${String(seq).padStart(4, '0')}`, metalScrap: scrap, lastEventAt: NOW - MIN, listedAt: Math.floor((NOW - HOUR) / 1000) });
  });
}

/** scrap.tf item cards as saved with Ctrl+S (the markup of test/fixtures/import/buy_hats.html; made-up ids and prices). */
const CARDS = {
  teamCaptain: `<div data-id="9300000001" data-slot="head" data-classes="multi" data-content="Level 10<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-group-hash="bb11" data-num-available="3" data-num-selected="0" data-item-value="12" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="Team Captain" data-defindex="378"><div class="item-value-indicator">1.33 ref</div><div class="item-group-num-text" id="group-num-available">3x</div></div>`,
  billsHat: `<div data-id="9300000002" data-slot="head" data-classes="multi" data-content="Level 5<br/><small style='color:#3498db;'></small>" data-appid="440" data-item-value="15" class="item hoverable quality6   rarity app440 " style="opacity:1;" data-title="Bill&apos;s Hat" data-defindex="126"><div class="item-value-indicator">1.66 refined</div></div>`,
};

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
  const root = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-marketlink-'));
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
  await core.start();
  requested.length = 0;
  const call = <T>(method: string, params?: unknown) => core.handle(method, params) as Promise<T>;
  const rows = async (): Promise<Map<string, MarketRow>> => new Map((await call<MarketListResult>('market.list', { limit: 2000 })).rows.map((r) => [r.sku, r]));
  return { call, rows };
}

describe('MarketRow.scraptfLink in the core (F19 S1)', () => {
  it('links the rows a saved bank page listed to that page, as item.detail says, and the rest to their category', async () => {
    const h = await setup((repo) => repo.upsertListings([...buyers('378;6', 300), ...buyers('126;6', 200), ...buyers('205;6', 100)]));
    await waitFor('the Live market build', async () => {
      const m = await h.call<MarketListResult>('market.list', {});
      return !m.stats.building && ['378;6', '126;6', '205;6'].every((sku) => m.rows.some((r) => r.sku === sku && r.buyerCount > 0));
    });
    const before = await h.rows();
    expect(before.get('378;6')!.scraptfLink).toEqual({ bank: 'hats', url: 'https://scrap.tf/buy/hats', seenAt: null, source: 'category' });
    expect(before.get('205;6')!.scraptfLink).toEqual({ bank: 'weapons', url: 'https://scrap.tf/buy/weapons', seenAt: null, source: 'category' });

    const savedAt = NOW - 30 * MIN;
    const imported = await h.call<ImportResult>('import.html', { html: hatsPage([CARDS.teamCaptain, CARDS.billsHat]), fileName: 'Hat Trading - TF2 - Scrap.TF.html', mtimeMs: savedAt });
    expect(imported).toMatchObject({ bank: 'hats', stored: 2 });

    const after = await h.rows();
    for (const sku of ['378;6', '126;6']) {
      const link = after.get(sku)!.scraptfLink;
      expect(link, sku).toEqual({ bank: 'hats', url: 'https://scrap.tf/buy/hats', seenAt: savedAt, source: 'seen' });
      // Parity with the drawer's "Seen on" (item.detail's seenOn).
      const detail = await h.call<ItemDetail>('item.detail', { sku, history: false });
      expect(detail.seenOn, sku).toEqual({ bank: link.bank, url: link.url, at: link.seenAt });
    }
    expect(after.get('205;6')!.scraptfLink).toMatchObject({ bank: 'weapons', source: 'category', seenAt: null });
    for (const r of after.values()) expect(isAllowedExternalUrl(r.scraptfLink.url), r.sku).toBe(true);
    expect(requested).toEqual([]);
  });
});
