// 0.7.4 (audit F31, F37, F56, F62): ghost scrap.tf bank prices. A whole save of a one-page bank, the newest of
// its page, retires every imported price of that bank from before it of a copy it does not show on sale, however
// the price got there: a look that stored no save before the page's first save (F37; a first save that looks cut
// short against that look retires nothing), a 'gone' event a 0.7.0 build recorded and never acted on (the user's
// The Classified Coif, F62), an older page arriving late (F31, F56: it no longer writes a copy the newer whole
// save lacks). Typed prices, list-tagged prices, other banks', /unusuals and prices newer than the save stay.
// reconcileBankPrices clears what older builds left, once, at core start. Real repo, parser and scrap.tf history
// over the real saved-page fixture and synthetic pages, with the real item schema (schema-subset.json); offline.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Engine, Logger, Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { importSavedPage, reconcileBankPrices, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { BENIGN_SKIP_REASONS, SKIP_NEWER_SAVE, SKIP_NOT_ON_SALE_NEWER } from '../../src/shared/importCodes';
import type { ImportResult, KeyPriceState, ScrapPrice, ScraptfBank } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
const HATS_URL = 'https://scrap.tf/buy/hats';
const HATS = readFileSync(path.join(fileURLToPath(new URL('../fixtures/', import.meta.url)), 'import/buy_hats.html'), 'utf8');
const UNUSUALS = readFileSync(path.join(fileURLToPath(new URL('../fixtures/', import.meta.url)), 'import/unusuals.html'), 'utf8');

const BASE_JUMPER = '1101;6;uncraftable';
const CAPTAIN = '378;6';
const COIF = '30388;6';
const LE_SAPEUR_U380 = '31540;5;u380';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

/** One card of a fixture, from its `<!-- Cnn` (or Unn) comment up to the next card's comment. */
function card(html: string, id: string): string {
  const start = html.indexOf(`<!-- ${id}`);
  const next = html.slice(start + 4).search(/<!-- [CU]\d/);
  if (start < 0 || next < 0) throw new Error(`no card ${id} in the fixture`);
  return html.slice(start, start + 4 + next);
}

function without(html: string, ...ids: string[]): string {
  let out = html;
  for (const id of ids) {
    const c = card(html, id);
    expect(out.includes(c), id).toBe(true);
    out = out.replace(c, '');
  }
  return out;
}

function only(html: string, ...ids: string[]): string {
  const open = /<div id="buy-container"[^>]*>/.exec(html)!;
  return `${html.slice(0, open.index + open[0].length)}\n${ids.map((id) => card(html, id)).join('\n')}\n</div></div></body></html>`;
}

let cardId = 9_740_000_000;
/** A /buy/hats card priced in scrap; `line` is an extra tooltip line (a paint). */
function hat(defindex: number, title: string, scrap: number, line = ''): string {
  const ref = `${Math.floor(scrap / 9)}.${String((scrap % 9) * 11).padStart(2, '0')}`;
  return `<div data-id="${cardId++}" data-slot="head" data-content="Level 10<br/>${line}" data-appid="440" data-item-value="${scrap}" class="item hoverable quality6 app440" data-title="${title}" data-defindex="${defindex}"><div class="item-value-indicator">${ref} ref</div></div>`;
}

function hatsPage(cards: readonly string[]): string {
  return [
    '<!DOCTYPE html>',
    '<!-- saved from url=(0025)https://scrap.tf/buy/hats -->',
    '<html lang="en"><head><meta charset="utf-8" /><title>Hat Trading - TF2 - Scrap.TF</title></head>',
    '<body id="pid-buy-hats"><div id="buy-container" class="items-container">',
    ...cards,
    '</div></body></html>',
  ].join('\n');
}

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - 48 * HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - 48 * HOUR },
  });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  const dirty: string[] = [];
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema,
    engine: { keyPrice: () => KEY, markDirty: (skus: Iterable<string>) => dirty.push(...skus) } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: history,
    bankStockChanged: () => history.refresh(),
  } as unknown as HandlerContext;
  const file = (html: string, mtimeMs: number, fileName = 'Hat Trading - TF2 - Scrap.TF.html'): ImportResult => importSavedPage(ctx, { html, fileName, mtimeMs });
  const window = (html: string, mtimeMs: number, settled = true): ImportResult =>
    importSavedPage(ctx, { html, fileName: 'scrap.tf window /buy/hats', mtimeMs, address: HATS_URL, origin: 'window', settled });
  const imported = (sku: string): ScrapPrice[] => repo.scrapPricesForSku(sku).filter((p) => p.source === 'import');
  /** A price an older build left: imported under a batch of `bank` with no bank stock save. */
  const leftover = (sku: string, bank: ScraptfBank, at: number, costScrap = 47): ScrapPrice => {
    const batch = repo.createImportBatch({ fileName: 'scrap.tf window /buy/hats', pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: 1, bank, origin: 'window' });
    return repo.upsertScrapPrice({ sku, name: sku, costKeys: 0, costScrap, source: 'import', observedAt: at, note: null, importBatch: batch, special: null, assetId: null, stock: 1 });
  };
  return { repo, file, window, imported, leftover, dirty };
}

describe("a page's first whole save after a look that stored no save (F37)", () => {
  it('retires a card that look caught and the save does not show', () => {
    const h = setup();
    expect(h.window(HATS, NOW - 4 * HOUR, false).stockSave).toBe('unsettled');
    expect(h.imported(BASE_JUMPER).map((p) => p.observedAt)).toEqual([NOW - 4 * HOUR]);
    const first = h.file(without(HATS, 'C13'), NOW - 3 * HOUR);
    expect(first.stockSave).toBe('written');
    expect(h.repo.scraptfEvents({ kinds: ['gone'] })).toEqual([]);
    expect(h.imported(BASE_JUMPER)).toEqual([]);
    expect(h.dirty).toContain(BASE_JUMPER);
    // The cards the save shows keep theirs, from it.
    expect(h.imported(CAPTAIN).map((p) => p.observedAt)).toEqual([NOW - 3 * HOUR]);
  });

  it('retires nothing when the first save caught far fewer cards than that look (cut short)', () => {
    const h = setup();
    const look = h.window(HATS, NOW - 4 * HOUR, false);
    expect(look.stored).toBeGreaterThan(16);
    expect(h.file(only(HATS, 'C01', 'C02'), NOW - 3 * HOUR).stockSave).toBe('written');
    expect(h.imported(BASE_JUMPER).map((p) => p.observedAt)).toEqual([NOW - 4 * HOUR]);
    // The next whole save is compared with that first one (DM-2) and decides.
    expect(h.file(without(HATS, 'C13'), NOW - 2 * HOUR).stockSave).toBe('written');
    expect(h.imported(BASE_JUMPER)).toEqual([]);
  });
});

describe('an older page arriving late (F31, F56)', () => {
  it('does not write a card the newer whole save of its bank lacks', () => {
    const h = setup();
    h.file(without(HATS, 'C13'), NOW - HOUR);
    const late = h.file(HATS, NOW - 2 * HOUR, 'older.html');
    expect(late.stored).toBe(0);
    // 0.7.4 (R05): no newer page priced it, it is not on sale there; a copy the newer page did price says so.
    expect(late.skipped).toContainEqual({ reason: SKIP_NOT_ON_SALE_NEWER, title: expect.stringContaining('B.A.S.E. Jumper') });
    expect(late.skipped).toContainEqual({ reason: SKIP_NEWER_SAVE, title: expect.stringContaining('Team Captain') });
    expect(late.skipped).not.toContainEqual({ reason: SKIP_NEWER_SAVE, title: expect.stringContaining('B.A.S.E. Jumper') });
    expect(BENIGN_SKIP_REASONS).toContain(SKIP_NOT_ON_SALE_NEWER);
    expect(late.skippedCounts?.[SKIP_NOT_ON_SALE_NEWER]).toBeGreaterThanOrEqual(1);
    expect(h.imported(BASE_JUMPER)).toEqual([]);
    expect(h.imported(CAPTAIN).map((p) => p.observedAt)).toEqual([NOW - HOUR]);
    // The newer save stays the bank's newest; nothing reads as gone or new.
    expect(h.repo.bankStockSaves('hats', 1)[0]!.savedAt).toBe(NOW - HOUR);
  });

  it('still keeps a price a later look set when the older page lists the card too', () => {
    const h = setup();
    h.file(without(HATS, 'C13'), NOW - 3 * HOUR);
    h.window(HATS, NOW - HOUR, false);
    expect(h.file(without(HATS, 'C13'), NOW - 2 * HOUR, 'older.html').stockSave).toBe('written');
    expect(h.imported(BASE_JUMPER).map((p) => p.observedAt)).toEqual([NOW - HOUR]);
  });

  it('judges each copy: a painted copy the newer save shows keeps its price, one it does not show is not written', () => {
    const h = setup();
    const pinkBills = (scrap: number) => hat(126, "Bill's Hat", scrap, 'Painted Pink as Hell<br/>');
    h.file(hatsPage([hat(378, 'Team Captain', 14), pinkBills(30)]), NOW - HOUR);
    const pink = h.imported('126;6');
    expect(pink).toHaveLength(1);
    expect(pink[0]!.special?.paint).not.toBeNull();
    h.file(hatsPage([hat(378, 'Team Captain', 12), pinkBills(25), hat(126, "Bill's Hat", 20), hat(940, 'Ghostly Gibus', 10)]), NOW - 2 * HOUR, 'older.html');
    // The pink copy keeps the newer save's price; the plain Bill's Hat and the Gibus are not written.
    expect(h.imported('126;6').map((p) => [p.special?.paint ?? null, p.costScrap, p.observedAt])).toEqual([[pink[0]!.special!.paint, 30, NOW - HOUR]]);
    expect(h.imported('940;6')).toEqual([]);
  });
});

describe('prices older builds left, retired by the next whole save (F31, F62)', () => {
  it("removes a leftover of the bank the save does not show, and nothing it must keep", () => {
    const h = setup();
    // The user's real case: The Classified Coif, imported by a hats read on Oct 19 and never removed.
    const coif = h.leftover(COIF, 'hats', NOW - 30 * HOUR);
    // What must stay: a typed price, a list-tagged price, another bank's price, a price newer than the save.
    const typed = h.repo.upsertScrapPrice({ sku: COIF, name: 'The Classified Coif', costKeys: 0, costScrap: 40, source: 'user', observedAt: NOW - 30 * HOUR, note: null });
    const listed = h.leftover('5040;6', 'list', NOW - 30 * HOUR);
    const unusual = h.leftover(LE_SAPEUR_U380, 'unusuals', NOW - 30 * HOUR);
    const newer = h.leftover('940;6', 'hats', NOW - 2 * HOUR);
    expect(h.file(without(HATS, 'C13'), NOW - 3 * HOUR).stockSave).toBe('written');
    expect(h.file(without(HATS, 'C13'), NOW - HOUR + MIN).stockSave).toBe('written');
    const ids = new Set(h.repo.listScrapPrices().map((p) => p.id));
    expect(ids.has(coif.id)).toBe(false);
    expect([typed.id, listed.id, unusual.id].every((id) => ids.has(id))).toBe(true);
    expect(h.dirty).toContain(COIF);
    // The newer leftover predates the second save: that save does not show it, so it goes then.
    expect(ids.has(newer.id)).toBe(false);
  });

  it('keeps a leftover the save shows on sale (as another copy of nothing: the same copy)', () => {
    const h = setup();
    const kept = h.leftover(CAPTAIN, 'hats', NOW - 30 * HOUR);
    h.file(HATS, NOW - 3 * HOUR);
    // The page's own Team Captain took over the row (same copy), dated by the save.
    expect(h.imported(CAPTAIN).map((p) => [p.id, p.observedAt])).toEqual([[kept.id, NOW - 3 * HOUR]]);
  });

  it('leaves /unusuals alone: a page per effect', () => {
    const h = setup();
    const unusuals = (html: string, at: number) => h.file(html, at, 'Unusual Hat Trading - TF2 - Scrap.TF.html');
    const sapeur = h.leftover(LE_SAPEUR_U380, 'unusuals', NOW - 30 * HOUR);
    expect(unusuals(without(UNUSUALS, 'U1'), NOW - 3 * HOUR).stockSave).toBe('written');
    expect(unusuals(without(UNUSUALS, 'U1'), NOW - HOUR).stockSave).toBe('written');
    expect(h.repo.listScrapPrices().some((p) => p.id === sapeur.id)).toBe(true);
  });
});

describe('reconcileBankPrices: the one-time pass over what older builds left (F31, F62)', () => {
  it('deletes exactly the leftovers a bank\'s newest whole save does not show, once', () => {
    const h = setup();
    h.file(without(HATS, 'C13'), NOW - 3 * HOUR);
    h.file(without(HATS, 'C13'), NOW - HOUR);
    // As a pre-0.7.1 build left it: a price of a sold card, older than both saves.
    const coif = h.leftover(COIF, 'hats', NOW - 30 * HOUR);
    const typed = h.repo.upsertScrapPrice({ sku: COIF, name: 'The Classified Coif', costKeys: 0, costScrap: 40, source: 'user', observedAt: NOW - 30 * HOUR, note: null });
    const listed = h.leftover('5040;6', 'list', NOW - 30 * HOUR);
    const unusual = h.leftover(LE_SAPEUR_U380, 'unusuals', NOW - 30 * HOUR);
    const afterSave = h.leftover('940;6', 'hats', NOW - 30 * MIN);
    const before = h.repo.listScrapPrices().length;

    expect(reconcileBankPrices(h.repo)).toEqual([COIF]);
    const ids = new Set(h.repo.listScrapPrices().map((p) => p.id));
    expect(ids.has(coif.id)).toBe(false);
    expect([typed.id, listed.id, unusual.id, afterSave.id].every((id) => ids.has(id))).toBe(true);
    expect(ids.size).toBe(before - 1);
    // Idempotent.
    expect(reconcileBankPrices(h.repo)).toEqual([]);
    expect(h.repo.listScrapPrices()).toHaveLength(before - 1);
  });

  it("leaves a bank whose newest save is its page's first (no whole save the import could have retired by)", () => {
    const h = setup();
    h.file(without(HATS, 'C13'), NOW - HOUR);
    const coif = h.leftover(COIF, 'hats', NOW - 30 * HOUR);
    expect(reconcileBankPrices(h.repo)).toEqual([]);
    expect(h.repo.listScrapPrices().some((p) => p.id === coif.id)).toBe(true);
  });
});
