// F18 S4: parity with the reference helper (VeBeshka's tf2-scraptf-profit-helper, a userscript kept
// read-only under reference/). It reads each `.item.hoverable.app440` card of the live scrap.tf tab;
// Flip Desk reads the same cards from a page the user saved (R10) and never runs in the tab, never
// watches it and never scrapes backpack.tf (R1-R3). One describe per rule of the reference's card
// reading, each proving the saved-page parser (src/service/import/scraptfHtml.ts) handles it, and
// where Flip Desk deliberately reads more strictly, that it does. Synthetic cards only; nothing is fetched.

import { describe, expect, it } from 'vitest';
import { isImportableItem, pageKindFromUrl, parseScrapTfHtml, sellsPriceOf, warningCode } from '../../src/service/import';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import type { Engine, Logger } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { ParsedScrapItem } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

/** One card as scrap.tf renders it (attribute values raw, HTML-escaped). */
function card(attrs: Record<string, string>, inner = ''): string {
  const a = Object.entries({ 'data-appid': '440', class: 'item hoverable quality6 rarity app440', ...attrs })
    .map(([k, v]) => `${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join(' ');
  return `<div ${a}>${inner}</div>`;
}

function page(body: string, url: string | null = 'https://scrap.tf/buy/hats'): string {
  const saved = url ? `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n` : '';
  return `<!DOCTYPE html>\n${saved}<html><head><title>Hat Trading - TF2 - Scrap.TF</title></head><body>${body}</body></html>`;
}

const schema = createStubSchema();
const parse = (body: string, url?: string | null) => parseScrapTfHtml(page(body, url), schema);
function one(attrs: Record<string, string>, inner = ''): ParsedScrapItem {
  const r = parse(card(attrs, inner));
  expect(r.items).toHaveLength(1);
  return r.items[0]!;
}
const codes = (i: ParsedScrapItem): string[] => i.warnings.map(warningCode);
const indicator = (text: string) => `<div class="item-value-indicator">${text}</div>`;

describe('price: data-item-value (scrap), else the .item-value-indicator text ("X refined", "X key(s)")', () => {
  it('reads data-item-value as scrap (the reference divides it by 9 for refined)', () => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '21' }, indicator('2.33 ref'));
    expect([it.costKeys, it.costScrap]).toEqual([0, 21]);
    expect(it.warnings).toEqual([]);
  });

  it.each<[string, number, number]>([
    ['2.33 refined', 0, 21],
    ['2.33 ref', 0, 21],
    ['1 key', 1, 0],
    ['3 keys', 3, 0],
    ['1.5 keys', 1.5, 0],
    ['2 keys 5.11 ref', 2, 46],
  ])('falls back to the indicator text "%s" without data-item-value', (text, keys, scrap) => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain' }, indicator(text));
    expect([it.costKeys, it.costScrap]).toEqual([keys, scrap]);
    expect(isImportableItem(it)).toBe(true);
  });

  it('treats data-item-value 0 as no value and reads the indicator, as the reference does (gap fixed in F18)', () => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '0' }, indicator('1.33 refined'));
    expect([it.costKeys, it.costScrap]).toEqual([0, 12]);
    expect(it.warnings).toEqual([]);
    const none = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '0' });
    expect(codes(none)).toEqual(['no-price']);
    expect(sellsPriceOf(none)).toBeNull();
  });

  it('keeps a key price in keys (converted at the live key price later), where the reference converts at a fixed rate', () => {
    // data-item-value of a key-priced card is scrap at scrap.tf's own key rate; the indicator's keys win.
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '4410' }, indicator('9 keys'));
    expect([it.costKeys, it.costScrap]).toEqual([9, 0]);
  });
});

describe('quality from the quality{N} class', () => {
  it.each<[string, string]>([
    ['quality1', '378;1'],
    ['quality3', '378;3'],
    ['quality6', '378;6'],
    ['quality11', '378;11'],
    ['quality13', '378;13'],
    ['quality14', '378;14'],
  ])('%s -> %s', (cls, sku) => {
    const it = one({ class: `item hoverable ${cls} app440`, 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' });
    expect(it.sku).toBe(sku);
    expect(it.warnings).toEqual([]);
  });

  it('assumes Unique without a class, as the reference does, and says so', () => {
    const it = one({ class: 'item hoverable app440', 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' });
    expect(it.sku).toBe('378;6');
    expect(codes(it)).toEqual(['unknown-quality']);
  });

  it('reads a strange unusual (two quality classes) as Unusual with the strange elevation, beyond the reference', () => {
    const it = one(
      { class: 'item hoverable quality11 quality5 app440', 'data-defindex': '378', 'data-title': 'Team Captain', 'data-content': 'Effect: Burning Flames', 'data-item-value': '900' },
    );
    expect(it.sku).toBe('378;5;u13;strange');
  });
});

describe('festivized from the data-content or data-title text', () => {
  it.each<[string, Record<string, string>]>([
    ['the title', { 'data-title': 'Festivized Rocket Launcher' }],
    ['the tooltip', { 'data-title': 'Rocket Launcher', 'data-content': "Level 1<br/><span style='color:#FFD700;'>Festivized</span>" }],
    ['both', { 'data-title': 'Strange Festivized Rocket Launcher', 'data-content': 'Festivized', class: 'item hoverable quality11 app440' }],
  ])('from %s', (_where, attrs) => {
    const it = one({ 'data-defindex': '205', 'data-item-value': '30', ...attrs });
    expect(it.skuObject?.festive).toBe(true);
    expect(it.warnings).toEqual([]);
  });

  it('not from an item whose name says Festive (the reference matches "festivized" only, too)', () => {
    const it = one({ 'data-defindex': '654', 'data-title': 'Festive Minigun', 'data-item-value': '45' });
    expect(it.sku).toBe('654;6');
  });
});

describe('unusual effect from the title prefix, else from the data-content text', () => {
  const unusual = (attrs: Record<string, string>, inner = '') => one({ class: 'item hoverable quality5 app440', 'data-defindex': '378', 'data-item-value': '900', ...attrs }, inner);

  it('reads an effect the title names before the item', () => {
    expect(unusual({ 'data-title': 'Burning Flames Team Captain' }).sku).toBe('378;5;u13');
    expect(unusual({ 'data-title': 'Unusual Burning Flames Team Captain' }).sku).toBe('378;5;u13');
  });

  it("reads the tooltip's effect line when the title names none", () => {
    expect(unusual({ 'data-title': 'Unusual Team Captain', 'data-content': '★ Unusual Effect: Scorching Flames' }).sku).toBe('378;5;u14');
    expect(unusual({ 'data-title': 'Team Captain', 'data-content': "Level 10<br/><span style='color:#8650AC'>Effect: Burning Flames</span>" }).sku).toBe('378;5;u13');
  });

  it('agrees when both name it, and prefers scrap.tf\'s particle image when the card shows one', () => {
    const both = unusual({ 'data-title': 'Burning Flames Team Captain', 'data-content': 'Effect: Burning Flames' });
    expect(both.sku).toBe('378;5;u13');
    expect(both.warnings).toEqual([]);
    const image = unusual({ 'data-title': 'Team Captain', style: "background-image:url('/img/particles_440/14_380x380.png')" });
    expect(image.sku).toBe('378;5;u14');
  });

  it('refuses an unusual whose effect cannot be read instead of guessing (the reference would check the effect-less item)', () => {
    const it = unusual({ 'data-title': 'Team Captain' });
    expect(it.sku).toBeNull();
    expect(codes(it)).toContain('unusual-without-effect');
  });
});

describe('quality and effect prefixes stripped from the base name', () => {
  it.each<[string, string, string]>([
    ['quality1', 'Genuine Team Captain', '378;1'],
    ['quality3', 'Vintage Team Captain', '378;3'],
    ['quality13', 'Haunted Team Captain', '378;13'],
    ['quality14', "Collector's Team Captain", '378;14'],
    ['quality6', 'Unique Team Captain', '378;6'],
    ['quality6', 'The Team Captain', '378;6'],
    ['quality11', 'Strange Team Captain', '378;11'],
    ['quality5', 'Unusual Burning Flames Team Captain', '378;5;u13'],
    ['quality6', 'Festivized Rocket Launcher', '205;6;festive'],
  ])('%s "%s" -> %s, with the schema name', (cls, title, sku) => {
    const defindex = sku.split(';')[0]!;
    const it = one({ class: `item hoverable ${cls} app440`, 'data-defindex': defindex, 'data-title': title, 'data-item-value': '9' });
    expect(it.sku).toBe(sku);
    // No leftover text: every prefix was read as a modifier, the rest is the item.
    expect(codes(it).filter((c) => c === 'unparsed-name' || c === 'name-unmatched')).toEqual([]);
    expect(it.name).toBe(schema.nameForSku(sku));
  });
});

describe('painted detection', () => {
  it('reads the paint swatch and the tooltip line into extras, the SKU staying the clean item', () => {
    const it = one(
      { 'data-defindex': '378', 'data-title': 'Team Captain', 'data-content': 'Level 10<br/>Painted Pink as Hell', 'data-item-value': '30' },
      '<div class="paintcolor" style="background:#FF69B4;"></div>',
    );
    expect(it.sku).toBe('378;6');
    expect(it.special.paint).toBe(16738740);
    expect(it.warnings).toEqual([]);
  });

  it('reads a paint named only in the tooltip, and never a paint can as painted', () => {
    expect(one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-content': 'Painted Pink as Hell', 'data-item-value': '30' }).special.paint).toBe(16738740);
    const can = one({ 'data-defindex': '5051', 'data-title': 'Pink as Hell', 'data-content': 'Painted Pink as Hell', 'data-item-value': '60' }, '<div class="paintcolor" style="background:#FF69B4;"></div>');
    expect(can.special.paint).toBeNull();
  });
});

describe('/unusuals/<sub-page> URLs', () => {
  it.each(['https://scrap.tf/unusuals/378', 'https://scrap.tf/unusuals/30001/', 'https://scrap.tf/unusuals'])('%s is the unusuals bank', (url) => {
    expect(pageKindFromUrl(url)).toMatchObject({ kind: 'unusuals', bank: 'unusuals', scrapTf: true });
  });

  it('imports a saved sub-page as its own page of the unusuals bank', () => {
    const r = parse(card({ class: 'item hoverable quality5 app440', 'data-id': '1', 'data-defindex': '378', 'data-title': 'Burning Flames Team Captain', 'data-item-value': '900' }), 'https://scrap.tf/unusuals/378');
    expect([r.pageKind, r.bank, r.page]).toEqual(['unusuals', 'unusuals', '/unusuals/378']);
    expect(r.items.map((i) => i.sku)).toEqual(['378;5;u13']);
  });
});

describe('a card shown in two containers is counted once', () => {
  const captain = { 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '12', 'data-num-available': '3' };

  it('by its asset id: a "new items" strip above the main grid', () => {
    const body = `<div class="new-items">${card({ ...captain, 'data-id': '42' })}</div><div id="buy-container" class="items-container">${card({ ...captain, 'data-id': '42' })}${card({ 'data-id': '43', 'data-defindex': '126', 'data-title': "Bill's Hat", 'data-item-value': '15' })}</div>`;
    const r = parse(body);
    expect(r.items.map((i) => [i.assetId, i.sku, i.stock])).toEqual([
      ['42', '378;6', 3],
      ['43', '126;6', 1],
    ]);
    expect(r.warnings).toEqual(['duplicate-cards: ignored 1 cards with an asset id already seen']);
  });

  it('without an asset id: an identical second card is the same card (gap fixed in F18); a different one is not', () => {
    const body = `<div class="new-items">${card(captain)}</div><div id="buy-container">${card(captain)}${card({ ...captain, 'data-item-value': '13' })}${card({ ...captain, 'data-content': 'This item has been reserved' })}</div>`;
    const r = parse(body);
    expect(r.items.map((i) => [i.sku, i.costScrap, i.stock, codes(i)])).toEqual([
      ['378;6', 12, 3, []],
      ['378;6', 13, 3, []],
      ['378;6', 12, 3, ['reserved']],
    ]);
    expect(r.warnings).toEqual(['duplicate-cards: ignored 1 cards without an asset id shown twice']);
  });

  it('so the import neither doubles its stock nor its bank stock', () => {
    const repo = openRepo(':memory:');
    try {
      const quiet = () => undefined;
      const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
      const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: 1 } });
      const ctx = {
        clock: { now: () => 1_800_000_000_000 },
        log,
        repo,
        schema,
        engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
        settings: () => settings,
        push: quiet,
        pricesChanged: quiet,
        scraptfListChanged: quiet,
        // F20: the change feed's import hook (writes no event in these tests).
        scraptfHistory: { onImport: () => 0 },
        bankStockChanged: quiet,
      } as unknown as HandlerContext;
      const html = page(`<div class="new-items">${card(captain)}</div><div id="buy-container">${card(captain)}</div>`);
      const r = importSavedPage(ctx, { html, fileName: 'hats.html', mtimeMs: 1_799_999_000_000 });
      expect(r).toMatchObject({ parsed: 1, stored: 1 });
      expect(repo.bankStockRows(r.batchId).map((x) => [x.sku, x.stock])).toEqual([['378;6', 3]]);
    } finally {
      repo.close();
    }
  });

  it('reads TF2 cards only (.item with app440), as the reference selects .item.hoverable.app440', () => {
    const r = parse(`${card({ 'data-id': '1', 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' })}${card({ class: 'item hoverable quality4 app730', 'data-id': '2', 'data-defindex': '1', 'data-title': 'Other Game Item', 'data-item-value': '99' })}`);
    expect(r.items.map((i) => i.assetId)).toEqual(['1']);
  });
});
