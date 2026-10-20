// 0.7.3 (audit): saved pages are untrusted, and the parse runs synchronously in the service process. parse5's
// tree builder takes time quadratic in nesting depth, and so did reading header cells nested in each other,
// so a deeply nested page or card tooltip froze every RPC and the live feed for minutes to days. Markup
// nested deeper than any scrap.tf page is now refused at once (the page, or the one card), and a header
// cell's text is read from a bounded part of it. Synthetic pages; nothing is fetched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { ImportTooDeepError, htmlAttrLines, parseScrapTfHtml, warningCode } from '../../src/service/import';
import { clearImportReports, importReports } from '../../src/service/import/reports';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { createStubSchema } from './schemaStub';

const BUY = '<link rel="canonical" href="https://scrap.tf/buy/hats">';
const ITEMS = '<link rel="canonical" href="https://scrap.tf/items">';
const page = (body: string, head = BUY) => `<!DOCTYPE html><html><head><title>x</title>${head}</head><body>${body}</body></html>`;
const card = (title: string) =>
  `<div class="item hoverable quality6 rarity app440" data-appid="440" data-defindex="126" data-quality="6" data-title="${title}" data-content="Level 1" data-item-value="9"></div>`;
const HAT = card('Bill&#39;s Hat');
/** 64 KB of "<div>" once the attribute is decoded. */
const DEEP_TITLE = '&lt;div&gt;'.repeat(13_000);

function timed<T>(fn: () => T): { ms: number; value: T } {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
}
const parsePage = (html: string) => parseScrapTfHtml(html, createStubSchema());

/** The error `fn` throws and how long it took to. */
function timedThrow(fn: () => unknown): { ms: number; err: unknown } {
  const t = performance.now();
  try {
    fn();
  } catch (err) {
    return { ms: performance.now() - t, err };
  }
  throw new Error('expected a throw');
}

describe('deeply nested markup is refused fast instead of freezing the service', () => {
  it.each([
    ['50 000 nested <div> (took ~53 s)', '<div>'.repeat(50_000)],
    ['16 000 nested <table><tr><th> (took ~40 s)', '<table><tr><th>'.repeat(16_000)],
    ['20 000 nested <template>', '<template>'.repeat(20_000)],
  ])('%s', (_, body) => {
    const { ms, err } = timedThrow(() => parsePage(page(body)));
    expect(err).toBeInstanceOf(ImportTooDeepError);
    expect((err as Error).message).toMatch(/^The saved page is nested more than 512 levels deep/);
    // Not the size refusal: the Import page would add the wrong advice (save it as "HTML only").
    expect((err as Error).message).not.toMatch(/too large/i);
    expect(ms).toBeLessThan(500);
  });

  it('reads header cells nested in each other in bounded time (was quadratic: 120 levels over 2 MB took seconds)', () => {
    const body = `${'<table><tr><th>'.repeat(120)}${'a '.repeat(1_000_000)}`;
    const { ms, value } = timed(() => parsePage(page(body, ITEMS)));
    expect(value.items).toEqual([]);
    expect(ms).toBeLessThan(2_000);
  });

  it('refuses one card whose tooltip is nested too deep, and still reads the others', () => {
    const { ms, value } = timed(() => parsePage(page(card(DEEP_TITLE) + HAT)));
    expect(ms).toBeLessThan(500);
    const [deep, hat] = value.items;
    expect(deep!.sku).toBeNull();
    expect(deep!.warnings.map(warningCode)).toEqual(['parse-error']);
    expect(deep!.warnings[0]).toMatch(/nested more than 64 levels deep/);
    expect(deep!.title.length).toBeLessThanOrEqual(256);
    expect(hat!.sku).toBe('126;6');

    const ten = timed(() => parsePage(page(card(DEEP_TITLE).repeat(10) + HAT)));
    expect(ten.ms).toBeLessThan(1_500);
    expect(ten.value.items.filter((i) => i.sku === '126;6')).toHaveLength(1);
  });

  it('keeps a card nested as deep as a real page could be, and refuses past the limit', () => {
    const nested = (n: number) => page(`${'<div>'.repeat(n)}${HAT}${'</div>'.repeat(n)}`);
    expect(parsePage(nested(400)).items.map((i) => i.sku)).toEqual(['126;6']);
    expect(() => parsePage(nested(600))).toThrow(ImportTooDeepError);
  });

  it('htmlAttrLines refuses a deep snippet at once and reads a real tooltip as before', () => {
    const { ms, err } = timedThrow(() => htmlAttrLines('<div>'.repeat(13_000)));
    expect(err).toBeInstanceOf(ImportTooDeepError);
    expect(ms).toBeLessThan(100);
    expect(htmlAttrLines("Level 5<br/><span style='color:#8650AC'>Halloween: <b>Spooky</b></span><div>Sheen: Team Shine</div>")).toEqual([
      'Level 5',
      'Halloween: Spooky',
      'Sheen: Team Shine',
    ]);
  });

  it('still finds a "Price to buy" header split over elements and whitespace', () => {
    const table =
      '<table><thead><tr><th>Icon</th><th>Item</th><th><span>Price</span>\n   to   buy <i class="fa"></i></th><th>Price we pay</th><th>Item Limits</th></tr></thead>' +
      '<tbody><tr data-quality="6" data-defindex="126"><td></td><td>Bill&#39;s Hat</td><td>3 keys, 53 ref</td><td>1 key</td><td><div title="1/5"></div></td></tr></tbody></table>';
    const r = parsePage(page(table, ITEMS));
    expect(r.warnings.map(warningCode)).not.toContain('no-price-column');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ sku: '126;6', costKeys: 3, costScrap: 53 * 9, stock: 1 });
  });

  it('inserts thousands of elements before a table in linear time (foster parenting)', () => {
    const { ms, value } = timed(() => parsePage(page(`<table>${'<i></i>'.repeat(300_000)}</table>${HAT}`)));
    expect(value.items.map((i) => i.sku)).toEqual(['126;6']);
    expect(ms).toBeLessThan(2_000);
  });
});

describe('importing a too-deep page', () => {
  const NOW = 1_800_000_000_000;
  const repos: Repo[] = [];
  beforeEach(() => clearImportReports());
  afterEach(() => {
    while (repos.length) repos.pop()!.close();
    clearImportReports();
  });

  it('throws, and records only the parse-error code', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
    const quiet = () => undefined;
    const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
    const ctx = {
      clock: { now: () => NOW },
      log,
      repo,
      schema: createStubSchema(),
      engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
      settings: () => settings,
      push: quiet,
      pricesChanged: quiet,
      scraptfListChanged: quiet,
      scraptfHistory: { onImport: () => 0 },
      bankStockChanged: quiet,
    } as unknown as HandlerContext;
    const html = page(`${'<div>'.repeat(50_000)}${HAT}`);
    expect(() => importSavedPage(ctx, { html, fileName: 'deep.html', mtimeMs: NOW - 60_000 })).toThrow(ImportTooDeepError);
    const [rep] = importReports();
    expect(rep!.warningCodes).toEqual({ 'parse-error': 1 });
    expect(repo.scrapPricesForSku('126;6')).toEqual([]);
  });
});
