// 0.9 (#13): a bank page whose own text says its bank is not trading, through the real importSavedPage and an in-memory
// repo. Such a look stores the prices it shows but no bank stock save, so nothing on it reads as sold (no 'gone' event,
// no price retired); its batch records the notice (V16 import_batches.bank_notice), and a window read of such a page
// records its batch even with no items, so the Banks card can date it. A card's price-drop wording rides on its bank
// stock row (V16 bank_stock.markdown), on-sale rows only. Synthetic pages; nothing is fetched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { clearImportReports } from '../../src/service/import/reports';
import { importSavedPage, WINDOW_NOTHING_TO_IMPORT, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { BANK_UNAVAILABLE_WARNING } from '../../src/shared/importCodes';
import type { BankStockStored, KeyPriceState, ScraptfBank } from '../../src/shared/types';
import { createStubSchema } from '../import/schemaStub';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
/** Ten hats the stub schema knows (quality 6). */
const HATS = [378, 126, 940, 31031, 31459, 31193, 31434, 31540, 31559, 935];
const ALERT = '<div class="alert alert-danger"><strong>Hat Banking</strong> is temporarily disabled.</div>';

const repos: Repo[] = [];
beforeEach(() => clearImportReports());
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  clearImportReports();
});

function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    import: { enabled: true, acknowledgedAt: NOW - 30 * HOUR },
    scraptfWindow: { enabled: true, acknowledgedAt: NOW - 30 * HOUR },
  });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  // The real scrap.tf history, so a stored save records its 'gone' events (F20) as in the app.
  const history = createScraptfHistory({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY });
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: { onImport: (batchId: number) => history.onImport(batchId) },
    bankStockChanged: quiet,
  } as unknown as HandlerContext;
  const stock = createBankStock({ clock: { now: () => NOW }, log, repo, market: { entryFor: () => null }, keyPrice: () => KEY, settings: () => settings, categoryOf: () => 'hats' });
  return { ctx, repo, stock };
}

function card(defindex: number, scrap: number, over: Record<string, string> = {}): string {
  const a: Record<string, string> = { 'data-id': `91000${defindex}`, 'data-appid': '440', class: 'item hoverable quality6 app440', 'data-defindex': String(defindex), 'data-title': `Hat ${defindex}`, 'data-item-value': String(scrap), ...over };
  return `<div ${Object.entries(a)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
    .join(' ')}>\n<div class="item-value-indicator">${scrap} scrap</div>\n</div>`;
}

function page(body: string, saved = true): string {
  return `<!DOCTYPE html>
${saved ? '<!-- saved from url=(0025)https://scrap.tf/buy/hats -->\n' : ''}<html><head><title>Hat Trading - TF2 - Scrap.TF</title></head>
<body id="pid-buy-hats">${body}</body></html>`;
}

const cards = (defs: readonly number[], price: (d: number) => number = () => 20): string => `<div id="buy-container">${defs.map((d) => card(d, price(d))).join('')}</div>`;

function importFile(h: ReturnType<typeof setup>, html: string, at: number) {
  return importSavedPage(h.ctx, { html, fileName: 'hats.html', mtimeMs: at });
}

const gone = (repo: Repo, bank: ScraptfBank = 'hats') => repo.scraptfEvents({ bank, kinds: ['gone'], limit: 100 });

describe('0.9 (#13): a look saying the bank is not trading', () => {
  it('a file of the notice page with no cards: one batch with its notice and no items, and no bank stock save', () => {
    const h = setup();
    const r = importFile(h, page(ALERT), NOW - MIN);
    expect(r.batchId).toBeGreaterThan(0);
    expect(r.stockSave).toBe('none');
    expect(r.warnings).toContain(BANK_UNAVAILABLE_WARNING);
    expect(r.warnings.some((w) => w.startsWith('no-cards-saved'))).toBe(false);
    const batches = h.repo.listImportBatches(10);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ id: r.batchId, itemCount: 0, bank: 'hats', bankNotice: 'unavailable' });
    expect(h.repo.bankStockSaves('hats', 10)).toEqual([]);
  });

  it('a notice page showing 3 of 10 copies (one cheaper) stores its prices but no save, and reads nothing as gone', () => {
    const h = setup();
    const whole = importFile(h, page(cards(HATS)), NOW - 10 * HOUR);
    expect(whole.stockSave).toBe('written');
    expect(h.repo.bankStockSaves('hats', 10)).toHaveLength(1);
    // Seven hours later (past DM-2's partial-read window), the page says the bank is not trading and shows three.
    const shown = HATS.slice(0, 3);
    const r = importFile(h, page(`${ALERT}${cards(shown, (d) => (d === 126 ? 15 : 20))}`), NOW - 3 * HOUR);
    expect(r.stockSave).toBe('partial');
    expect(r.warnings).toContain(BANK_UNAVAILABLE_WARNING);
    expect(h.repo.bankStockSaves('hats', 10)).toHaveLength(1);
    expect(gone(h.repo)).toEqual([]);
    // The seven copies it did not show keep their prices; the cheaper one is written.
    for (const d of HATS.slice(3)) expect(h.repo.scrapPricesForSku(`${d};6`).map((p) => p.costScrap), String(d)).toEqual([20]);
    expect(h.repo.scrapPricesForSku('126;6').map((p) => p.costScrap)).toEqual([15]);
    expect(h.repo.listImportBatches(1)[0]).toMatchObject({ id: r.batchId, bankNotice: 'unavailable', itemCount: 3 });

    // The control: the same look without the notice is a whole save, and reads the seven as gone (their prices go).
    const c = setup();
    importFile(c, page(cards(HATS)), NOW - 10 * HOUR);
    const plain = importFile(c, page(cards(shown, (d) => (d === 126 ? 15 : 20))), NOW - 3 * HOUR);
    expect(plain.stockSave).toBe('written');
    expect(c.repo.bankStockSaves('hats', 10)).toHaveLength(2);
    expect(gone(c.repo)).toHaveLength(7);
    for (const d of HATS.slice(3)) expect(c.repo.scrapPricesForSku(`${d};6`), String(d)).toEqual([]);
    expect(c.repo.listImportBatches(1)[0]).not.toHaveProperty('bankNotice');
  });

  it('a bare "banking" notice after an ordinary lead word stores no bank stock save either (recheck)', () => {
    for (const notice of ['Unfortunately banking is temporarily disabled.', '<strong>Notice</strong> Banking is temporarily disabled.']) {
      const h = setup();
      expect(importFile(h, page(cards(HATS)), NOW - 10 * HOUR).stockSave, notice).toBe('written');
      const r = importFile(h, page(`<div class="alert alert-danger">${notice}</div>${cards(HATS.slice(0, 3))}`), NOW - 3 * HOUR);
      expect(r.stockSave, notice).toBe('partial');
      expect(r.warnings, notice).toContain(BANK_UNAVAILABLE_WARNING);
      expect(h.repo.bankStockSaves('hats', 10), notice).toHaveLength(1);
      // The seven copies it does not show never read as sold.
      expect(gone(h.repo), notice).toEqual([]);
      expect(h.repo.listImportBatches(1)[0], notice).toMatchObject({ id: r.batchId, bankNotice: 'unavailable', itemCount: 3 });
    }
  });

  it('a window read of the notice page with no items records its batch; without the notice it records nothing, as before', () => {
    const h = setup();
    const read = (html: string) =>
      importSavedPage(h.ctx, { html, fileName: 'scrap.tf window /buy/hats', mtimeMs: NOW - MIN, address: 'https://scrap.tf/buy/hats', origin: 'window' });
    const r = read(page(ALERT, false));
    expect(r.batchId).toBeGreaterThan(0);
    expect(r.warnings).toEqual([BANK_UNAVAILABLE_WARNING]);
    expect(r.stockSave).toBe('none');
    expect(h.repo.listImportBatches(10)[0]).toMatchObject({ id: r.batchId, origin: 'window', itemCount: 0, bankNotice: 'unavailable' });

    const nothing = read(page('<div id="buy-container"></div>', false));
    expect(nothing.batchId).toBe(0);
    expect(nothing.warnings[0]).toBe(WINDOW_NOTHING_TO_IMPORT);
    expect(h.repo.listImportBatches(10)).toHaveLength(1);
  });
});

describe('0.9 (#13): a card\'s price-drop wording on its bank stock row', () => {
  const SOON = { 'data-content': 'This item will decrease in price shortly.' };

  it('rides on the stored row and the bank stock list row while on sale; never on the gone row', () => {
    const h = setup();
    const first = importFile(h, page(`<div id="buy-container">${card(378, 20, SOON)}${card(126, 20)}</div>`), NOW - 10 * HOUR);
    expect(first.stockSave).toBe('written');
    const stored = h.repo.bankStockRows(first.batchId);
    expect(stored.find((r) => r.sku === '378;6')!.markdown).toEqual(['soon']);
    expect(stored.find((r) => r.sku === '126;6')).not.toHaveProperty('markdown');
    h.stock.refresh();
    const listed = h.stock.list({ bank: 'hats' }, NOW).rows;
    expect(listed.find((r) => r.sku === '378;6')!.markdown).toEqual(['soon']);
    expect(listed.find((r) => r.sku === '126;6')).not.toHaveProperty('markdown');

    // A later whole save where it is gone: its gone row carries none.
    importFile(h, page(`<div id="buy-container">${card(126, 20)}</div>`), NOW - 3 * HOUR);
    h.stock.refresh();
    const goneRows = h.stock.list({ bank: 'hats', filter: 'gone' }, NOW).rows;
    expect(goneRows.map((r) => r.sku)).toEqual(['378;6']);
    expect(goneRows[0]).not.toHaveProperty('markdown');
  });

  it('an /items row never stores one', () => {
    const h = setup();
    const id = h.repo.createImportBatch({ fileName: 'items.html', pageKind: 'items-list', fileMtime: NOW - HOUR, importedAt: NOW - HOUR, itemCount: 1, bank: 'list' });
    const row: BankStockStored = { sku: '378;6', specialKey: '', name: 'Team Captain', costKeys: 0, costScrap: 20, stock: 1, assetId: null, markdown: ['soon'] };
    h.repo.insertBankStock(id, 'list', [row], '/items');
    expect(h.repo.bankStockRows(id)[0]).not.toHaveProperty('markdown');
  });
});
