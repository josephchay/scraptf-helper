// Audit rbanks-2: a saved scrap.tf/items page that gave the price list no rows (saved before its rows loaded,
// a layout the parser does not know, rows without a SKU or a price) must not read "a newer save of
// scrap.tf/items is already stored" on the Import page: nothing newer may be stored at all. The result says
// how many list rows the page gave (listRowsRead), and an older copy of a list keeps today's wording.
// Offline (R10): the pages are built here.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { importListRowsText } from '../../src/renderer/scraptfListModel';
import { ImportResultView } from '../../src/renderer/pages/ImportPage';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { importWarningCode } from '../../src/shared/importCodes';
import type { ImportResult } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const NEWER_SAVE = 'No list rows changed: a newer save of scrap.tf/items is already stored.';
const NONE_READ = 'No list rows changed: this page gave no rows your price list can use.';

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup() {
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
  const run = (html: string, mtimeMs: number, fileName = 'Item Trading - TF2 - Scrap.TF.html'): ImportResult => importSavedPage(ctx, { html, fileName, mtimeMs });
  return { repo, run };
}

/** A saved /items list with the given rows ("n/limit" is the stock cell). */
function itemsPage(rows: { defindex: number; name: string; price: string; stock: string; pays: string }[]): string {
  const tr = rows
    .map((r) => `<tr data-quality="6" data-defindex="${r.defindex}"><td></td><td>${r.name}</td><td>${r.price}</td><td>${r.pays}</td><td><div rel="tooltip" title="${r.stock}"></div></td></tr>`)
    .join('\n');
  return (
    '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head>' +
    '<body id="pid-items"><table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead>' +
    `<tbody>${tr}</tbody></table></body></html>`
  );
}

const EMPTY =
  '<!-- saved from url=(0022)https://scrap.tf/items --><html><head><title>Item Trading - TF2 - Scrap.TF</title></head><body id="pid-items"><div class="loading">Loading...</div></body></html>';

/** The "Price list" line as the Import page renders it. */
const priceListLine = (r: ImportResult): string | null => {
  const html = renderToString(createElement(ImportResultView, { r })).replace(/<!-- -->/g, '');
  return /<dt>Price list<\/dt><dd>([^<]*)<\/dd>/.exec(html)?.[1] ?? null;
};

describe('an /items save that gave the price list no rows (audit rbanks-2)', () => {
  it('an empty save into an empty database does not claim a newer save', () => {
    const h = setup();
    const r = h.run(EMPTY, NOW - 60_000);
    expect(r).toMatchObject({ pageKind: 'items-list', parsed: 0, listRows: 0, listRowsRead: 0 });
    expect(r.warnings.map(importWarningCode)).toContain('no-items');
    expect(h.repo.scraptfList()).toEqual([]);
    expect(importListRowsText(r)).toBe(NONE_READ);
    const line = priceListLine(r);
    expect(line).toBe(NONE_READ.replace(/'/g, '&#x27;'));
    expect(line).not.toContain('newer save');
  });

  it('a save whose rows show neither price reads the same', () => {
    const h = setup();
    const r = h.run(itemsPage([{ defindex: 378, name: 'Team Captain', price: 'Sold out', stock: '0/5', pays: '—' }]), NOW - 60_000);
    expect(r.parsed).toBeGreaterThan(0);
    expect([r.listRows, r.listRowsRead]).toEqual([0, 0]);
    expect(importListRowsText(r)).toBe(NONE_READ);
  });

  it('an older copy of a stored list keeps the newer-save wording', () => {
    const h = setup();
    const captain = (price: string, stock: string) => ({ defindex: 378, name: 'Team Captain', price, stock, pays: '1 refined' });
    const p = h.run(itemsPage([captain('3 refined', '4/5')]), NOW - 30_000);
    expect([p.listRows, p.listRowsRead]).toEqual([1, 1]);
    const old = h.run(itemsPage([captain('1 refined', '1/5')]), NOW - 120_000, 'old.html');
    expect([old.listRows, old.listRowsRead]).toEqual([0, 1]);
    expect(importListRowsText(old)).toBe(NEWER_SAVE);
  });

  it('reads an older result without listRowsRead by its parsed count', () => {
    expect(importListRowsText({ pageKind: 'items-list', listRows: 0, parsed: 0 })).toBe(NONE_READ);
    expect(importListRowsText({ pageKind: 'items-list', listRows: 0, parsed: 5 })).toBe(NEWER_SAVE);
    expect(importListRowsText({ pageKind: 'items-list', listRows: 0, listRowsRead: 0, parsed: 5 })).toBe(NONE_READ);
    expect(importListRowsText({ pageKind: 'items-list', listRows: 0 })).toBe(NEWER_SAVE);
  });
});
