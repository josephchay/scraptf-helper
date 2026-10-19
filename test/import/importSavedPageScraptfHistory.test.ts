// F20 S2 end to end through the real importSavedPage, parser and scrap.tf history: each save of a bank
// page writes its changes against the previous save of that page in the import's own transaction (none for
// a first save, an older save, the same file again or a page saved without its cards), 'scraptf.changed'
// follows the bank stock refresh and precedes the price push, a failed event write rolls the whole import
// back, and the thinning after an import leaves the runs. Synthetic saved pages only (R10); offline.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfHistory, type ScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { bankStockKey } from '../../src/shared/bankStock';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { KeyPriceState, ScraptfBank } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

let cardId = 9_400_000_000;
/** One hat card as scrap.tf's /buy/hats shows it (the markup of buy_hats.html), priced in scrap. */
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

const FIRST = [card(378, 'Team Captain', 14), card(126, "Bill's Hat", 20), card(940, 'Ghostly Gibus', 10)];
/** Bill's Hat gone, Earbuds new, Team Captain cheaper, Ghostly Gibus pricier. */
const LATER = [card(378, 'Team Captain', 12), card(940, 'Ghostly Gibus', 11), card(143, 'Earbuds', 22)];

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - DAY } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const calls: string[] = [];
  const history: ScraptfHistory = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: (event: string, payload: unknown) => calls.push(`push:${event}${event === 'scraptf.changed' ? `:${JSON.stringify(payload)}` : ''}`),
    pricesChanged: () => calls.push('pricesChanged'),
    scraptfListChanged: quiet,
    scraptfHistory: history,
    // Core's bankStockChanged refreshes the history's runs (and the bank stock cache).
    bankStockChanged: (imported?: { bank: ScraptfBank; batchId: number }) => {
      history.refresh();
      calls.push(imported ? `bankStockChanged:${imported.bank}` : 'bankStockChanged');
    },
  } as unknown as HandlerContext;
  const run = (cards: readonly string[], mtimeMs: number) => {
    calls.length = 0;
    return importSavedPage(ctx, { html: hatsPage(cards), fileName: 'hats.html', mtimeMs });
  };
  return { repo, history, run, calls };
}

describe('importSavedPage writes the change feed (F20 S2)', () => {
  it('nothing for the first save; the changes of the next, then the push between the bank stock and the prices', () => {
    const h = setup();
    h.run(FIRST, NOW - 3 * HOUR);
    expect(h.repo.scraptfEvents()).toEqual([]);
    expect(h.calls.some((c) => c.startsWith('push:scraptf.changed'))).toBe(false);
    const later = h.run(LATER, NOW - 10 * MIN);
    const events = h.repo.scraptfEvents();
    expect(events.map((e) => [e.sku, e.kind, e.fromScrap, e.toScrap]).sort()).toEqual([
      ['126;6', 'gone', 20, null],
      ['143;6', 'new', null, 22],
      ['378;6', 'cheaper', 14, 12],
      ['940;6', 'pricier', 10, 11],
    ]);
    expect(events.every((e) => e.batchId === later.batchId && e.at === NOW - 10 * MIN && e.bank === 'hats' && e.page === '/buy/hats')).toBe(true);
    expect(h.calls.slice(0, 3)).toEqual(['bankStockChanged:hats', `push:scraptf.changed:${JSON.stringify({ at: NOW - 10 * MIN, count: 4 })}`, 'pricesChanged']);
    // The runs already read the new save when the push goes out.
    expect(h.history.runsFor('hats').get(bankStockKey('143;6', ''))).toMatchObject({ listedSince: NOW - 10 * MIN });
    // Back again later: restocked, since an earlier save listed it.
    h.run([...LATER, card(126, "Bill's Hat", 20)], NOW - 5 * MIN);
    expect(h.repo.scraptfEvents()[0]).toMatchObject({ sku: '126;6', kind: 'restocked', toScrap: 20 });
  });

  it('nothing for an older save, the same file again or a page saved without its cards', () => {
    const h = setup();
    h.run(FIRST, NOW - 3 * HOUR);
    h.run(LATER, NOW - HOUR);
    const before = h.repo.scraptfEvents();
    h.run([card(378, 'Team Captain', 9)], NOW - 2 * HOUR);
    h.run(LATER, NOW - HOUR);
    h.run([], NOW - 10 * MIN);
    expect(h.repo.scraptfEvents()).toEqual(before);
    expect(h.calls.some((c) => c.startsWith('push:scraptf.changed'))).toBe(false);
  });

  it('shares the import’s transaction: a failed event write leaves no batch, price, stock row or push behind', () => {
    const h = setup();
    h.run(FIRST, NOW - 3 * HOUR);
    const batches = h.repo.listImportBatches(10);
    const prices = h.repo.listScrapPrices();
    vi.spyOn(h.repo, 'insertScraptfEvents').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    expect(() => h.run(LATER, NOW - HOUR)).toThrow(/disk I\/O error/);
    expect(h.repo.listImportBatches(10)).toEqual(batches);
    expect(h.repo.listScrapPrices()).toEqual(prices);
    expect(h.repo.bankStockSaveIndex()).toHaveLength(1);
    expect(h.calls).toEqual([]);
    // The runs never saw the rolled-back save.
    h.history.refresh();
    expect(h.history.runsFor('hats').has(bankStockKey('143;6', ''))).toBe(false);
  });

  it('the thinning after an import leaves the runs; the events compare with the protected previous save', () => {
    const h = setup();
    h.run(FIRST, NOW - 100 * DAY);
    h.run([card(378, 'Team Captain', 13), card(126, "Bill's Hat", 20)], NOW - 95 * DAY);
    h.run(LATER, NOW - HOUR);
    // The 100-day-old save is gone; the 95-day-old one is the page's previous save and stays.
    expect(h.repo.bankStockSaveIndex().map((s) => s.savedAt)).toEqual([NOW - 95 * DAY, NOW - HOUR]);
    // The thinning runs after the import's transaction: the 100-day-old save still counted as seen before.
    expect(h.repo.scraptfEvents({ sinceAt: NOW - HOUR }).map((e) => [e.sku, e.kind, e.fromScrap]).sort()).toEqual([
      ['126;6', 'gone', 20],
      ['143;6', 'new', null],
      ['378;6', 'cheaper', 13],
      ['940;6', 'restocked', null],
    ]);
    expect(h.history.runsFor('hats').get(bankStockKey('378;6', ''))).toMatchObject({ seenAt: NOW - 95 * DAY, firstSeenAt: NOW - 95 * DAY, listedSince: NOW - 95 * DAY });
  });
});
