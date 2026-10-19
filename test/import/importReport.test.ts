// 0.7.1 (P4): every parse leaves a sanitized parser report in memory ('import.report'), for the user to
// copy into a bug report. Whitelisted data only: counts, header texts, warning codes and the card fields the
// parser read for refused cards and cards read by a guess. Never the nav, scripts, avatars, SteamIDs, asset
// ids, custom names or gift and receipt text, and nothing is stored or sent. Synthetic pages; nothing is
// fetched.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { clearImportReports, importReports } from '../../src/service/import/reports';
import { createRpcHandlers, importSavedPage, recordSkippedImport, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { IMPORT_REPORT_MAX_ITEMS, IMPORT_REPORT_RING, IMPORT_SCHEMA_LOADING_MESSAGE } from '../../src/shared/importCodes';
import type { ImportReport } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const STEAMID = '76561198012345678';
const ASSET = '9100000777';
const SECRETS = [STEAMID, ASSET, 'avatar', 'My Secret Name', 'Gifted', 'SomeGifter', 'Date Received', 'my secret words', 'webSocketInfo', 'steamcommunity'];

const repos: Repo[] = [];
beforeEach(() => clearImportReports());
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  clearImportReports();
});

function setup(schema: SchemaService = createStubSchema()) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - 3_600_000 },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - 3_600_000 },
  });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: quiet,
  } as unknown as HandlerContext;
  return { ctx, repo, rpc: createRpcHandlers(ctx) };
}

/** A bank page with a signed-in nav (avatar, profile link, SteamID in a script) and three revealing cards. */
function revealingPage(): string {
  const cardAttrs = (attrs: Record<string, string>) =>
    Object.entries(attrs)
      .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
      .join(' ');
  return `<!DOCTYPE html>
<!-- saved from url=(0025)https://scrap.tf/buy/hats -->
<html><head><title>Hat Trading - TF2 - Scrap.TF</title>
<script>var me = { steamid: "${STEAMID}" }; const webSocketInfo = {};</script></head>
<body id="pid-buy-hats">
<nav><a href="https://steamcommunity.com/profiles/${STEAMID}"><img class="avatar" src="https://avatars.steamstatic.com/${STEAMID}_full.jpg" data-title="me" data-defindex="1"></a><span data-steamid="${STEAMID}">Me</span></nav>
<div id="buy-container">
<div ${cardAttrs({ 'data-id': ASSET, 'data-appid': '440', class: 'item hoverable quality6 app440 myclass', 'data-defindex': '378', 'data-title': "''My Secret Name'' Team Captain", 'data-content': `Level 1<br/>Gifted by: SomeGifter<br/>Date Received: 2026-01-01<br/>"my secret words"<br/>Steam ${STEAMID}` })}></div>
<div ${cardAttrs({ 'data-id': '9100000778', 'data-appid': '440', class: 'item hoverable quality5 app440', 'data-defindex': '31540', 'data-title': 'Unusual Le Sapeur', 'data-item-value': '900' })}><div class="item-value-indicator">5 keys</div></div>
<div ${cardAttrs({ 'data-id': '9100000779', 'data-appid': '440', class: 'item hoverable quality6 app440', 'data-defindex': '126', 'data-title': "Bill's Hat", 'data-item-value': '15' })}><div class="item-value-indicator">1.66 ref</div></div>
</div></body></html>`;
}

describe('the parser report (P4)', () => {
  it('holds the counts, codes and the refused cards as read, and nothing that names or tracks anyone', async () => {
    const h = setup();
    const r = importSavedPage(h.ctx, { html: revealingPage(), fileName: 'C:\\Users\\me\\Hat Trading - TF2 - Scrap.TF.html', mtimeMs: NOW - MIN });
    expect(r.stored).toBe(1);
    const reports = (await h.rpc('import.report', {})) as ImportReport[];
    expect(reports).toHaveLength(1);
    const rep = reports[0]!;
    expect(rep).toMatchObject({ origin: 'file', name: 'Hat Trading - TF2 - Scrap.TF.html', pageKind: 'buy', bank: 'hats', page: '/buy/hats', format: 'html', batchId: r.batchId, at: NOW });
    expect(rep.counts).toMatchObject({ cards: 3, rows: 0, selectedSkipped: 0, duplicates: 0 });
    expect(rep.counts.dataDefindex).toBe(4);
    expect(rep.warningCodes).toMatchObject({ 'no-price': 1, 'unusual-without-effect': 1, 'no-sku': 1 });
    // The two refused cards; the stored one with nothing guessed is left out.
    expect(rep.items.map((i) => i.defindex)).toEqual([378, 31540]);
    const named = rep.items[0]!;
    expect(named.title).toBeNull();
    expect(named.contentLines).toEqual(['Level 1', 'Steam #']);
    expect(named.classTokens).toEqual(['item', 'hoverable', 'quality6', 'app440']);
    expect(named.sku).toBe('378;6');
    const sapeur = rep.items[1]!;
    expect(sapeur).toMatchObject({ title: 'Unusual Le Sapeur', indicator: '5 keys', itemValue: '900', sku: null, particleId: null });
    const text = JSON.stringify(reports);
    for (const s of SECRETS) expect(text, s).not.toContain(s);
  });

  it('never holds a line naming a person in another wording, as a tooltip line or inside a warning', async () => {
    const h = setup();
    const html = revealingPage().replace(
      'Gifted by: SomeGifter<br/>',
      'Gift from: SomeGifter<br/>Crafted by SomeCrafter<br/>Signed by AnotherPerson<br/>',
    );
    importSavedPage(h.ctx, { html, fileName: 'hats.html', mtimeMs: NOW - MIN });
    const [rep] = importReports();
    const named = rep!.items.find((i) => i.defindex === 378)!;
    expect(named.contentLines).toEqual(['Level 1', 'Steam #']);
    const text = JSON.stringify(rep);
    for (const s of ['SomeGifter', 'SomeCrafter', 'AnotherPerson', 'Gift from', 'Crafted by']) expect(text, s).not.toContain(s);
  });

  it('a window read of a page that records nothing keeps counts and codes only, never its address', async () => {
    const h = setup();
    const profile = `<html><head><title>Profile</title></head><body><div id="inventory"><div data-defindex="378" data-title="Team Captain" class="item app-440"></div></div></body></html>`;
    const r = (await h.rpc('import.html', { html: profile, fileName: `scrap.tf window /profile/${STEAMID}`, mtimeMs: NOW - MIN, address: `https://scrap.tf/profile/${STEAMID}`, origin: 'window' })) as { batchId: number };
    expect(r.batchId).toBe(0);
    const [rep] = importReports();
    expect(rep).toMatchObject({ origin: 'window', format: 'window', batchId: 0, page: '', items: [], pageKind: 'unknown' });
    expect(rep!.counts.lookalikes).toBe(1);
    expect(JSON.stringify(rep)).not.toContain(STEAMID);
  });

  it('records a refused read (item data still loading) and a passed-over file with their codes only', async () => {
    const h = setup(createStubSchema({ loaded: false }));
    expect(() => importSavedPage(h.ctx, { html: fixture('buy_hats.html'), fileName: 'hats.html', mtimeMs: NOW - MIN })).toThrow(IMPORT_SCHEMA_LOADING_MESSAGE);
    recordSkippedImport(h.ctx, { fileName: 'D:\\watch\\big.mhtml', mtimeMs: NOW - MIN, warning: 'too-large: 30 MB' });
    const [skippedRep, refused] = importReports();
    expect(refused).toMatchObject({ batchId: 0, items: [], warningCodes: { 'schema-loading': 1 }, format: 'html' });
    expect(skippedRep).toMatchObject({ format: 'mhtml', items: [], warningCodes: { 'too-large': 1 } });
    expect(skippedRep!.batchId).toBeGreaterThan(0);
  });

  it('reads an /items row: its cells, the limit attributes, and the header', async () => {
    const h = setup();
    // The Earbuds bar (the first 0/5) with nothing left to read its stock from.
    const list = fixture('items_list_bs3.html').replace(/<div rel="tooltip" title="" data-original-title="0\/5"[^\n]*/, '<div rel="tooltip"><span>?</span></div>');
    importSavedPage(h.ctx, { html: list, fileName: 'items.html', mtimeMs: NOW - MIN });
    const [rep] = importReports();
    expect(rep!.headerColumns).toEqual(['Icon', 'Item', 'Price to buy', 'Price we pay', 'Item Limits']);
    const bar = rep!.items.find((i) => i.warnings.some((w) => w.startsWith('no-stock-limit')))!;
    expect(bar.cells?.slice(1, 4)).toEqual(['Earbuds', '10 keys, 50 refined', '8 keys, 10 refined']);
    expect(bar.limitAttrs).toEqual({ title: null, dataOriginalTitle: null, dataBsOriginalTitle: null, ariaLabel: null });
    expect(rep!.warningCodes['no-stock-limit']).toBeGreaterThanOrEqual(1);
  });

  it('keeps at most IMPORT_REPORT_MAX_ITEMS items, and the ring keeps the newest IMPORT_REPORT_RING reports', async () => {
    const h = setup();
    const many = Array.from({ length: IMPORT_REPORT_MAX_ITEMS + 50 }, (_, i) => `<div data-id="${8000 + i}" data-appid="440" class="item app440 quality6" data-defindex="378" data-title="Team Captain"></div>`).join('');
    importSavedPage(h.ctx, { html: `<!-- saved from url=(0025)https://scrap.tf/buy/hats -->\n<html><body><div id="buy-container">${many}</div></body></html>`, fileName: 'many.html', mtimeMs: NOW - MIN });
    expect(importReports()[0]!.items).toHaveLength(IMPORT_REPORT_MAX_ITEMS);
    for (let i = 0; i < IMPORT_REPORT_RING + 5; i++) importSavedPage(h.ctx, { html: fixture('buy_hats.html'), fileName: `hats-${i}.html`, mtimeMs: NOW - (100 - i) * MIN });
    const all = importReports();
    expect(all).toHaveLength(IMPORT_REPORT_RING);
    expect(all[0]!.name).toBe(`hats-${IMPORT_REPORT_RING + 4}.html`);
    expect(all.map((r) => r.id)).toEqual([...all.map((r) => r.id)].sort((a, b) => b - a));
    expect(((await h.rpc('import.report', { limit: 3 })) as ImportReport[]).map((r) => r.id)).toEqual(all.slice(0, 3).map((r) => r.id));
    // A copy: changing what was returned changes nothing kept.
    all[0]!.items.length = 0;
    expect(importReports()[0]!.items.length).toBeGreaterThan(0);
  });
});
