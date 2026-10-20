// Audit importflow-1 / rpc-1: a look known to be missing cards (a window snapshot cut before its settle read,
// ACT-4, or a look with far fewer cards than a recent save, DM-2) stores the prices it shows but reads no
// copy as gone (F18 deviation 11): the other painted, spelled or kit copies of the items it shows keep their
// imported prices until a whole look. A whole look still replaces every copy of the items it lists.
// Offline (R10): the pages are built here or read from test/fixtures/import.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { importWarningCode } from '../../src/shared/importCodes';
import type { ImportResult, ScrapPrice, ScraptfBank } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const PINK = 16738740;
const KIT = '6526;6;uncraftable;kt-3;td-205';

const KITS = readFileSync(fileURLToPath(new URL('../fixtures/import/buy_killstreaks.html', import.meta.url)), 'utf8');

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - HOUR },
  });
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
  const file = (html: string, mtimeMs: number, fileName = 'page.html'): ImportResult => importSavedPage(ctx, { html, fileName, mtimeMs });
  const window = (html: string, path: string, mtimeMs: number, extra: { settled?: boolean } = {}): ImportResult =>
    importSavedPage(ctx, { html, fileName: `scrap.tf window ${path}`, mtimeMs, address: `https://scrap.tf${path}`, origin: 'window', ...extra });
  const imported = (sku: string): ScrapPrice[] => repo.scrapPricesForSku(sku).filter((p) => p.source === 'import');
  /** The copies (sku|special key) the newest stored bank stock save of the bank lists. */
  const newestSave = (bank: ScraptfBank): string[] => {
    const sv = repo.bankStockSaves(bank, 10)[0]!;
    return repo.bankStockRows(sv.batchId).map((r) => `${r.sku}|${r.specialKey}`);
  };
  return { repo, file, window, imported, newestSave };
}

/** A /buy/hats page with the given cards. */
function bankPage(cards: Record<string, string>[]): string {
  const html = cards
    .map((attrs) => {
      const a = Object.entries({ 'data-appid': '440', class: 'item hoverable quality6 rarity app440', ...attrs })
        .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
        .join(' ');
      return `<div ${a}></div>`;
    })
    .join('\n');
  return `<!DOCTYPE html>\n<!-- saved from url=(0024)https://scrap.tf/buy/hats -->\n<html><head><title>Hats</title></head><body>${html}</body></html>`;
}

const plainCaptain = (value: number) => ({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': String(value) });
const pinkCaptain = (value: number) => ({ ...plainCaptain(value), 'data-content': 'Painted Pink as Hell' });

/** One card of the kits fixture, from its `<!-- Knn` comment up to the next card's. */
function card(html: string, id: string): string {
  const start = html.indexOf(`<!-- ${id}`);
  const next = html.slice(start + 4).search(/<!-- K\d/);
  if (start < 0 || next < 0) throw new Error(`no card ${id} in the fixture`);
  return html.slice(start, start + 4 + next);
}
function without(html: string, id: string): string {
  const c = card(html, id);
  expect(html.includes(c)).toBe(true);
  return html.replace(c, '');
}
function only(html: string, ...ids: string[]): string {
  const open = /<div id="buy-container"[^>]*>/.exec(html)!;
  return `${html.slice(0, open.index + open[0].length)}\n${ids.map((id) => card(html, id)).join('\n')}\n</div></div></body></html>`;
}

const kitCopies = (prices: ScrapPrice[]) =>
  prices.map((p) => [p.costKeys, p.costScrap, p.special?.sheen ?? null, p.special?.killstreaker ?? null]).sort((a, b) => a[0]! - b[0]!);

describe('a partial or unsettled look keeps the prices of the copies it did not show (audit importflow-1, rpc-1)', () => {
  it('an unsettled window read of the plain Team Captain keeps the Pink one, row untouched', () => {
    const h = setup();
    expect(h.file(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 2 * HOUR, 'hats.html').stockSave).toBe('written');
    const pink = h.imported('378;6').find((p) => p.special?.paint === PINK)!;
    expect(pink).toBeDefined();

    const r = h.window(bankPage([plainCaptain(95)]), '/buy/hats', NOW - HOUR, { settled: false });
    expect(r.stockSave).toBe('unsettled');
    const after = h.imported('378;6');
    expect(after.map((p) => [p.special?.paint ?? null, p.costScrap]).sort()).toEqual([
      [null, 95],
      [PINK, 140],
    ]);
    expect(after.find((p) => p.special?.paint === PINK)).toEqual(pink);
    // The newest stored save is still the whole one, and it lists both copies.
    expect(h.newestSave('hats')).toHaveLength(2);
  });

  it('a partial look (DM-2) keeps them too', () => {
    const h = setup();
    // Enough cards that one is far fewer (DM-2 needs at least 8 on sale in the save before).
    const others: [number, string][] = [
      [126, "Bill's Hat"],
      [940, 'Ghostly Gibus'],
      [143, 'Earbuds'],
      [31031, 'Wise Whiskers'],
      [31459, 'Commonwealth Commando'],
      [31434, 'Balkans Brute'],
      [31559, 'Feathered Foe'],
      [935, 'Voodoo JuJu (Slight Return)'],
    ];
    const cards = others.map(([d, title], i) => ({ 'data-defindex': String(d), 'data-title': title, 'data-item-value': String(10 + i) }));
    expect(h.file(bankPage([plainCaptain(100), pinkCaptain(140), ...cards]), NOW - 2 * HOUR, 'hats.html').stockSave).toBe('written');
    const r = h.window(bankPage([plainCaptain(95)]), '/buy/hats', NOW - HOUR);
    expect(r.stockSave).toBe('partial');
    expect(h.imported('378;6').map((p) => [p.special?.paint ?? null, p.costScrap]).sort()).toEqual([
      [null, 95],
      [PINK, 140],
    ]);
  });

  it('still removes an older duplicate of a copy the look shows', () => {
    const h = setup();
    h.file(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 2 * HOUR, 'hats.html');
    // Imported before extras were recorded: a second plain row of the same copy.
    h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 50, source: 'import', observedAt: NOW - 3 * HOUR, special: null });
    expect(h.imported('378;6')).toHaveLength(3);
    expect(h.window(bankPage([plainCaptain(95)]), '/buy/hats', NOW - HOUR, { settled: false }).stockSave).toBe('unsettled');
    expect(h.imported('378;6').map((p) => [p.special?.paint ?? null, p.costScrap]).sort()).toEqual([
      [null, 95],
      [PINK, 140],
    ]);
  });

  it('a whole look still replaces every copy of the items it lists', () => {
    const h = setup();
    h.file(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 2 * HOUR, 'hats.html');
    expect(h.window(bankPage([plainCaptain(95)]), '/buy/hats', NOW - HOUR).stockSave).toBe('written');
    expect(h.imported('378;6').map((p) => [p.special?.paint ?? null, p.costScrap])).toEqual([[null, 95]]);
  });

  it('keeps every killstreak kit copy of a weapon and tier (sheen, killstreaker) a cut look missed (0.7.2 kits)', () => {
    const h = setup();
    expect(h.file(KITS, NOW - 2 * HOUR, 'killstreaks.html').stockSave).toBe('written');
    expect(kitCopies(h.imported(KIT))).toEqual([
      [35, 0, 4, 2003],
      [37, 360, 1, 2008],
    ]);

    // K11 (37 keys) had not arrived when the snapshot was cut.
    expect(h.window(without(KITS, 'K11'), '/buy/killstreaks', NOW - HOUR, { settled: false }).stockSave).toBe('unsettled');
    expect(kitCopies(h.imported(KIT))).toEqual([
      [35, 0, 4, 2003],
      [37, 360, 1, 2008],
    ]);

    const partial = h.window(only(KITS, 'K12', 'K01'), '/buy/killstreaks', NOW - 30 * MIN);
    expect(partial.stockSave).toBe('partial');
    expect(partial.warnings.map(importWarningCode)).toContain('partial-read');
    expect(kitCopies(h.imported(KIT))).toEqual([
      [35, 0, 4, 2003],
      [37, 360, 1, 2008],
    ]);

    // A whole save without K11: it sold.
    expect(h.file(without(KITS, 'K11'), NOW - 15 * MIN, 'killstreaks (1).html').stockSave).toBe('written');
    expect(kitCopies(h.imported(KIT))).toEqual([[35, 0, 4, 2003]]);
  });

  it('a cut look still removes a copy it shows sold out', () => {
    const h = setup();
    h.file(bankPage([plainCaptain(100), pinkCaptain(140)]), NOW - 2 * HOUR, 'hats.html');
    const pinkGone = { ...pinkCaptain(140), 'data-num-available': '0' };
    const r = h.window(bankPage([plainCaptain(95), pinkGone]), '/buy/hats', NOW - HOUR, { settled: false });
    expect(r.stockSave).toBe('unsettled');
    expect(h.imported('378;6').map((p) => [p.special?.paint ?? null, p.costScrap])).toEqual([[null, 95]]);
  });
});
