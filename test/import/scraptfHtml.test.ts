import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImportTooLargeError,
  MAX_IMPORT_BYTES,
  cssColorToHex,
  htmlAttrLines,
  isImportableItem,
  pageKindFromUrl,
  parseScrapTfHtml,
  sellsPriceOf,
  warningCode,
} from '../../src/service/import';
import { fromString } from '../../src/shared/sku';
import type { ParsedScrapItem } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

const codes = (i: ParsedScrapItem): string[] => i.warnings.map(warningCode);
const byAsset = (items: ParsedScrapItem[], id: string): ParsedScrapItem => {
  const hit = items.find((i) => i.assetId === id);
  if (!hit) throw new Error(`no item with asset id ${id}`);
  return hit;
};

/** Builds one card the way scrap.tf renders it (attribute values are raw HTML-escaped strings). */
function card(attrs: Record<string, string>, inner = ''): string {
  const a = Object.entries({ 'data-appid': '440', class: 'item hoverable quality6 rarity app440', ...attrs })
    .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
    .join(' ');
  return `<div ${a}>${inner}</div>`;
}

function page(body: string, opts: { url?: string | null; title?: string; head?: string } = {}): string {
  const url = opts.url === undefined ? 'https://scrap.tf/buy/hats' : opts.url;
  const saved = url ? `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n` : '';
  return `<!DOCTYPE html>\n${saved}<html><head><title>${opts.title ?? 'Test'}</title>${opts.head ?? ''}</head><body>${body}</body></html>`;
}

function one(attrs: Record<string, string>, inner = '', schema = createStubSchema()): ParsedScrapItem {
  const r = parseScrapTfHtml(page(card(attrs, inner)), schema);
  expect(r.items).toHaveLength(1);
  return r.items[0]!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseScrapTfHtml: saved /buy/hats page', () => {
  const schema = createStubSchema();
  const result = parseScrapTfHtml(fixture('buy_hats.html'), schema);
  const items = result.items;

  it('detects the page kind from the saved-from comment and drops duplicate cards', () => {
    expect(result.pageKind).toBe('buy');
    expect(result.bank).toBe('hats');
    expect(items).toHaveLength(38);
    expect(result.warnings.map(warningCode)).toEqual(['duplicate-cards', 'duplicate-cards', 'no-sku']);
    expect(result.warnings).toContain('no-sku: 3 of 38 items could not be identified');
    // The non-TF2 card (app730) is ignored.
    expect(items.some((i) => i.title === 'Other Game Item')).toBe(false);
  });

  it.each([
    ['9100000001', '378;6', 0, 12, 3],
    ['9100000002', '126;6', 0, 15, 1],
    ['9100000003', '31031;6', 0, 16, 1],
    ['9100000004', '31459;6', 0, 13, 1],
    ['9100000005', '31193;6', 0, 14, 1],
    ['9100000006', '940;6', 0, 12, 1],
    ['9100000007', '31540;5;u380', 9, 0, 1],
    ['9100000008', '31434;5;u360', 12, 46, 1],
    ['9100000009', '31559;5;u9999', 20, 0, 1],
    ['9100000010', '31193;11', 0, 30, 1],
    ['9100000011', '378;5;u13;strange', 150, 0, 1],
    ['9100000012', '31434;5;u312;strange', 35, 0, 1],
    ['9100000013', '1101;6;uncraftable', 0, 5, 1],
    ['9100000014', '126;6;uncraftable', 0, 9, 1],
    ['9100000015', '208;6;kt-1;festive', 0, 27, 1],
    ['9100000016', '1153;6;festive', 0, 22, 1],
    ['9100000017', '205;11;australium;kt-3', 48, 90, 1],
    ['9100000018', '16105;15;w3;pk105', 0, 25, 1],
    ['9100000019', '208;15;w1;pk300', 0, 40, 1],
    // 0.7.1 (P2): a strange skin without an effect is Strange (11), as backpack.tf keys it, whatever its class.
    ['9100000020', '15000;11;w2;pk14', 0, 120, 1],
    ['9100000021', '15063;15;w4;pk70', 0, 33, 1],
    ['9100000022', '15000;15;u701;w1;pk1014', 3, 0, 1],
    ['9100000023', '940;6', 0, 20, 1],
    ['9100000024', '412;11;kt-2', 0, 40, 1],
    ['9100000025', '935;6', 0, 13, 1],
    ['9100000026', '202;11', 0, 24, 1],
    ['9100000027', '811;6', 0, 20, 1],
    ['9100000031', '20002;6;kt-2;td-1013;od-6523;oq-6', 0, 18, 1],
    ['9100000033', '378;6', 0, 12, 1],
    ['9100000034', '5036;6', 0, 60, 1],
    ['9100000035', '30920;5;u3010', 40, 0, 1],
    ['9100000036', '126;1', 0, 45, 1],
    ['9100000037', '940;13', 0, 31, 1],
    ['9100000038', '31031;6', 0, 12, 5],
  ])('card %s -> %s (%d keys + %d scrap, stock %d)', (id, sku, keys, scrap, stock) => {
    const it = byAsset(items, id);
    expect(it.sku).toBe(sku);
    expect(it.skuObject).toEqual(fromString(sku));
    expect(it.costKeys).toBe(keys);
    expect(it.costScrap).toBe(scrap);
    expect(it.stock).toBe(stock);
  });

  it('never puts the paint into the SKU', () => {
    for (const it of items) {
      expect(it.sku ?? '').not.toMatch(/;p\d/);
      expect(it.skuObject?.paint ?? null).toBeNull();
    }
  });

  it('reads paints from .paintcolor (hex and rgb, RED and BLU) and skips paint cans', () => {
    expect(byAsset(items, '9100000003').special.paint).toBe(6901050);
    expect(byAsset(items, '9100000004').special.paint).toBe(8400928); // BLU #256D8D -> The Value of Teamwork
    expect(byAsset(items, '9100000034').special.paint).toBeNull();
    expect(byAsset(items, '9100000001').special.paint).toBeNull();
  });

  it('flags #5885A2 and uses the tooltip to tell Team Spirit from Legacy Paint', () => {
    const resolved = byAsset(items, '9100000005');
    expect(resolved.special.paint).toBe(12073019);
    expect(resolved.warnings).toEqual(['ambiguous-paint: #5885A2 resolved as Team Spirit from the tooltip']);
    const unresolved = byAsset(items, '9100000006');
    expect(codes(unresolved)).toEqual(['ambiguous-paint']);
    expect(unresolved.special.paint).toBe(5801378);
  });

  it('canonicalises a BLU effect id to the lower id of its pair', () => {
    expect(byAsset(items, '9100000008').skuObject?.effect).toBe(360);
  });

  it('keeps unknown effect ids but warns', () => {
    const it = byAsset(items, '9100000009');
    expect(codes(it)).toEqual(['unknown-effect']);
    expect(it.warnings[0]).toContain('9999');
  });

  it('reads sheen and killstreaker from fx classes and tooltip lines', () => {
    const aussie = byAsset(items, '9100000017');
    expect(aussie.special.sheen).toBe(5);
    expect(aussie.special.killstreaker).toBe(2008);
    expect(aussie.warnings).toEqual([]);
    expect(byAsset(items, '9100000024').special.sheen).toBe(6);
  });

  it('detects custom names and descriptions and names the item from the schema', () => {
    const named = byAsset(items, '9100000023');
    expect(named.title).toBe("''Spooky Lid''");
    expect(named.name).toBe('Ghostly Gibus');
    expect(named.special.customName).toBe(true);
    expect(named.special.customDesc).toBe(true);
    expect(named.warnings).toEqual([]);
    const weapon = byAsset(items, '9100000024');
    expect(weapon.title).toBe("Strange ''The Angriffsmaschine''");
    expect(weapon.special.customName).toBe(true);
    expect(weapon.name).toBe('Strange Specialized Killstreak Overdose');
  });

  it('recognises spells and strange parts', () => {
    expect(byAsset(items, '9100000025').special.spells).toEqual(['Exorcism', 'Team Spirit Footprints']);
    expect(byAsset(items, '9100000026').special.parts).toEqual(['Robots Destroyed', 'Headshot Kills']);
    expect(byAsset(items, '9100000026').warnings).toEqual([]);
  });

  it('reports unparsed tooltip lines and price mismatches but keeps data-item-value', () => {
    const it = byAsset(items, '9100000027');
    expect(codes(it)).toEqual(['unparsed-modifier', 'price-mismatch']);
    expect(it.warnings[0]).toContain('Mysterious glowing line');
    expect(it.costScrap).toBe(20);
  });

  it('returns unidentifiable cards with sku null and a reason', () => {
    expect(codes(byAsset(items, '9100000028'))).toEqual(['no-price']);
    const noDef = byAsset(items, '9100000029');
    expect(noDef.sku).toBeNull();
    expect(codes(noDef)).toEqual(['no-defindex']);
    const noEffect = byAsset(items, '9100000030');
    expect(noEffect.sku).toBeNull();
    expect(codes(noEffect)).toEqual(['unusual-without-effect']);
    const kit = byAsset(items, '9100000032');
    expect(kit.sku).toBeNull();
    expect(codes(kit)).toEqual(['needs-target']);
  });

  it('flags reserved items', () => {
    expect(codes(byAsset(items, '9100000033'))).toEqual(['reserved']);
  });

  it('uses schema names and decodes entities in titles', () => {
    expect(byAsset(items, '9100000002').title).toBe("Bill's Hat");
    expect(byAsset(items, '9100000007').title).toBe('Le Sapeur');
    expect(byAsset(items, '9100000007').name).toBe('Piercing Headache Le Sapeur');
    expect(byAsset(items, '9100000014').name).toBe("Non-Craftable Bill's Hat");
  });

  it('isImportableItem keeps only items with a SKU and a price', () => {
    const importable = items.filter(isImportableItem);
    expect(importable).toHaveLength(34);
    expect(importable.some((i) => i.assetId === '9100000028')).toBe(false);
    expect(importable.some((i) => i.sku === null)).toBe(false);
  });

  it('only consults the schema (no network)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    parseScrapTfHtml(fixture('buy_hats.html'), createStubSchema());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('parseScrapTfHtml: saved /unusuals page', () => {
  const result = parseScrapTfHtml(fixture('unusuals.html'), createStubSchema());

  it('detects the page kind from the canonical link', () => {
    expect(result.pageKind).toBe('unusuals');
    expect(result.bank).toBe('unusuals');
    expect(result.warnings).toEqual([]);
    expect(result.items).toHaveLength(7);
  });

  it.each([
    ['9200000001', '31540;5;u380', 15, 0],
    ['9200000002', '378;5;u365', 8, 201],
    ['9200000003', '31559;5;u392', 1, 0],
    ['9200000004', '31434;5;u13', 25, 0],
    ['9200000005', '1108;5;u3190', 4, 90],
    ['9200000006', '940;5;u8;strange', 60, 0],
    ['9200000007', '31540;5;u13', 0, 2940],
  ])('card %s -> %s (%d keys + %d scrap)', (id, sku, keys, scrap) => {
    const it = byAsset(result.items, id);
    expect(it.sku).toBe(sku);
    expect(it.costKeys).toBe(keys);
    expect(it.costScrap).toBe(scrap);
  });

  it('takes the effect from the tooltip when there is no particle image', () => {
    expect(byAsset(result.items, '9200000003').warnings).toEqual([]);
  });

  it('prefers the particle image over a disagreeing tooltip and warns', () => {
    expect(codes(byAsset(result.items, '9200000004'))).toEqual(['effect-mismatch']);
  });

  it('keeps data-item-value as integer scrap when there is no price text', () => {
    const it = byAsset(result.items, '9200000007');
    expect(it.costScrap).toBe(2940);
    expect(it.costKeys).toBe(0);
  });
});

describe('parseScrapTfHtml: saved /items price list', () => {
  const result = parseScrapTfHtml(fixture('items_list.html'), createStubSchema());
  const row = (title: string): ParsedScrapItem => {
    const hit = result.items.find((i) => i.title === title);
    if (!hit) throw new Error(`no row ${title}`);
    return hit;
  };

  it('detects the page kind from og:url and reads every row', () => {
    expect(result.pageKind).toBe('items-list');
    expect(result.bank).toBe('list');
    expect(result.items).toHaveLength(13);
    expect(result.warnings).toEqual([]);
    expect(result.items.every((i) => i.assetId === null)).toBe(true);
  });

  it.each([
    ['Tough Break Key', '5833;6', 1, 54, 49],
    ['Warbird Weapons Case #100', '5832;6;c100', 7, 90, 3],
    ['Earbuds', '143;6', 10, 450, 0],
    ['Bills Hat', '126;6', 3, 477, 2],
    ['Non-Craftable Tour of Duty Ticket', '725;6;uncraftable', 0, 273, 44],
    ['Name Tag', '5020;6', 0, 156, 483],
    ['Strange Taunt: Burstchester', '30621;11', 66, 0, 1],
    ['Genuine Taunt: The Shred Alert', '1015;1', 3, 359, 0],
    ['Strange Part: Airborne Enemies Killed', '6012;6', 4, 90, 5],
    ['Strange Count Transfer Tool', '5818;6', 0, 2, 12],
    ['Strange Australium Rocket Launcher', '205;11;australium', 44, 396, 1],
    ['Vintage Bills Hat', '126;3', 45, 0, 1],
  ])('%s -> %s (%d keys + %d scrap, stock %d)', (title, sku, keys, scrap, stock) => {
    const it = row(title);
    expect(it.sku).toBe(sku);
    expect(it.costKeys).toBe(keys);
    expect(it.costScrap).toBe(scrap);
    expect(it.stock).toBe(stock);
  });

  it('matches schema names that differ only by apostrophes', () => {
    expect(row('Bills Hat').name).toBe("Bill's Hat");
    expect(row('Bills Hat').warnings).toEqual([]);
  });

  it('warns about items missing from the schema without guessing an elevated strange', () => {
    expect(codes(row('Tough Break Key'))).toEqual(['unknown-item']);
    expect(row('Strange Count Transfer Tool').skuObject?.quality2).toBeNull();
  });

  it('flags prices it cannot read', () => {
    const it = row('Crocodile Dandy');
    expect(codes(it)).toEqual(['unparsed-price']);
    expect(isImportableItem(it)).toBe(false);
  });
});

describe('parseScrapTfHtml: what scrap.tf pays and its stock limit (F14)', () => {
  const result = parseScrapTfHtml(fixture('items_list.html'), createStubSchema());
  const row = (title: string): ParsedScrapItem => {
    const hit = result.items.find((i) => i.title === title);
    if (!hit) throw new Error(`no row ${title}`);
    return hit;
  };

  it.each([
    ['Tough Break Key', 1, 9, 49, 50],
    ['Warbird Weapons Case #100', 6, 0, 3, 5],
    ['Earbuds', 8, 90, 0, 5],
    ['Bills Hat', 3, 378, 2, 5],
    ['Non-Craftable Tour of Duty Ticket', 0, 238, 44, 400],
    ['Name Tag', 0, 144, 483, 500],
    ['Strange Taunt: Burstchester', 60, 0, 1, 2],
    ['Genuine Taunt: The Shred Alert', 3, 180, 0, 3],
    ['Strange Part: Airborne Enemies Killed', 3, 360, 5, 10],
    ['Strange Count Transfer Tool', 0, 1, 12, 20],
    ['Strange Australium Rocket Launcher', 40, 0, 1, 3],
    ['Vintage Bills Hat', 40, 0, 1, 2],
    ['Crocodile Dandy', 0, 12, 0, 5],
  ])('%s: pays %d keys + %d scrap, stock %d of %d', (title, keys, scrap, stock, limit) => {
    const it = row(title);
    expect(it.pays).toEqual({ keys, scrap });
    expect(it.stock).toBe(stock);
    expect(it.stockLimit).toBe(limit);
    expect(codes(it).filter((c) => c.includes('pays'))).toEqual([]);
  });

  it('reads every row of the fixture without a page warning', () => {
    expect(result.items).toHaveLength(13);
    expect(result.warnings).toEqual([]);
    expect(result.items.every((i) => i.pays !== null && i.stockLimit !== null)).toBe(true);
  });

  it('keeps out-of-stock rows with what scrap.tf pays for them', () => {
    const out = result.items.filter((i) => i.stock === 0).map((i) => [i.title, i.pays]);
    expect(out).toEqual([
      ['Earbuds', { keys: 8, scrap: 90 }],
      ['Genuine Taunt: The Shred Alert', { keys: 3, scrap: 180 }],
      ['Crocodile Dandy', { keys: 0, scrap: 12 }],
    ]);
  });

  it('gives a "Sold out" row no price to buy, but still what scrap.tf pays', () => {
    const dandy = row('Crocodile Dandy');
    expect(sellsPriceOf(dandy)).toBeNull();
    expect(dandy.pays).toEqual({ keys: 0, scrap: 12 });
    expect(sellsPriceOf(row('Bills Hat'))).toEqual({ keys: 3, scrap: 477 });
    expect(sellsPriceOf(row('Earbuds'))).toEqual({ keys: 10, scrap: 450 });
  });

  it('leaves the fields off bank-page cards, which have no such column', () => {
    const cards = parseScrapTfHtml(fixture('buy_hats.html'), createStubSchema()).items;
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect('pays' in c).toBe(false);
      expect('stockLimit' in c).toBe(false);
    }
  });
});

describe('parseScrapTfHtml: the "Price we pay" column on edited lists', () => {
  const HEAD = '<title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" />';
  /** A saved /items table with these header cells and rows (each row: its <td> contents). */
  function listPage(headers: string[], rows: string[][]): string {
    const thead = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
    const body = rows.map((cells) => `<tr data-quality="6" data-defindex="126">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<!DOCTYPE html><html><head>${HEAD}</head><body id="pid-items"><table>${thead}<tbody>${body}</tbody></table></body></html>`;
  }
  const STD = ['Icon', 'Item', 'Price to buy', 'Price we pay', 'Item Limits'];
  const limits = (t: string) => `<div rel="tooltip" title="${t}"><div>${t.split('/')[0]}</div></div>`;
  const one = (pays: string): ParsedScrapItem => parseScrapTfHtml(listPage(STD, [['', "Bill's Hat", '3 keys, 53 refined', pays, limits('2/5')]]), createStubSchema()).items[0]!;

  it.each([
    ['', 'no-pays-price'],
    ['   ', 'no-pays-price'],
    ['—', 'no-pays-price'],
    ['–', 'no-pays-price'],
    ['-', 'no-pays-price'],
    ['- —', 'no-pays-price'],
    ['0 refined', 'no-pays-price'],
    ['Not buying', 'unparsed-pays-price'],
    ['twenty', 'unparsed-pays-price'],
    ['n/a', 'unparsed-pays-price'],
    ['49 50', 'unparsed-pays-price'],
  ])('an empty or unreadable "we pay" (%j) gives null and a %s warning', (cell, code) => {
    const it = one(cell);
    expect(it.pays).toBeNull();
    expect(codes(it)).toEqual([code]);
    // The price to buy is still imported as before.
    expect(isImportableItem(it)).toBe(true);
    expect([it.costKeys, it.costScrap, it.stock, it.stockLimit]).toEqual([3, 477, 2, 5]);
  });

  it('does not run a price parse over an absurdly long cell', () => {
    const it = one(`1${'0'.repeat(100_000)} refined`);
    expect(it.pays).toBeNull();
    expect(codes(it)).toEqual(['unparsed-pays-price']);
  });

  it('finds the column by its header, wherever it is', () => {
    const html = listPage(['Item', 'Price we pay', 'Item Limits', 'Icon', 'Price to buy'], [["Bill's Hat", '3 keys, 42 refined', limits('4/5'), '', '3 keys, 53 refined']]);
    const it = parseScrapTfHtml(html, createStubSchema()).items[0]!;
    expect(it.pays).toEqual({ keys: 3, scrap: 378 });
    expect([it.costKeys, it.costScrap]).toEqual([3, 477]);
    // "Item Limits" before the price column is still read (its header says where): full, out of stock and
    // the price path's sold-out rule depend on it.
    expect([it.stock, it.stockLimit]).toEqual([4, 5]);
    expect(it.warnings).toEqual([]);
  });

  it('reads stock from the "Item Limits" column by header, not from another cell that happens to carry n/m', () => {
    const html = listPage(['Icon', 'Item', 'Price to buy', 'Price we pay', 'Notes', 'Item Limits'], [['', "Bill's Hat", '3 keys, 53 refined', '3 keys, 42 refined', limits('9/9'), limits('1/5')]]);
    const it = parseScrapTfHtml(html, createStubSchema()).items[0]!;
    expect([it.stock, it.stockLimit]).toEqual([1, 5]);
  });

  it('falls back to the first n/m cell after the price when the page has no "Item Limits" header', () => {
    const html = listPage(['Icon', 'Item', 'Price to buy', 'Price we pay', 'Stock'], [['', "Bill's Hat", '3 keys, 53 refined', '3 keys, 42 refined', limits('5/5')]]);
    const it = parseScrapTfHtml(html, createStubSchema()).items[0]!;
    expect([it.stock, it.stockLimit]).toEqual([5, 5]);
  });

  it('never guesses the column by position: without the header no row has a pays price, and the page says so once', () => {
    const r = parseScrapTfHtml(
      listPage(['Icon', 'Item', 'Price to buy', 'Paid', 'Item Limits'], [['', "Bill's Hat", '3 keys, 53 refined', '3 keys, 42 refined', limits('2/5')]]),
      createStubSchema(),
    );
    expect(r.items[0]!.pays).toBeNull();
    expect(r.items[0]!.warnings).toEqual([]);
    expect(r.items[0]!.stockLimit).toBe(5);
    expect(r.warnings.map(warningCode)).toEqual(['no-pays-column']);
  });

  it('warns about a row that is missing the cell', () => {
    const it = parseScrapTfHtml(listPage(STD, [['', "Bill's Hat", '3 keys, 53 refined']]), createStubSchema()).items[0]!;
    expect(it.pays).toBeNull();
    expect(it.stock).toBeNull();
    expect(it.stockLimit).toBeNull();
    // 0.7.1 (P1): the list has an Item Limits column, so a row without one cannot say it is in stock.
    expect(codes(it)).toEqual(['no-pays-price', 'no-stock-limit']);
    expect(isImportableItem(it)).toBe(false);
  });

  it('reads a full item (stock at its limit)', () => {
    const it = one('3 keys');
    expect([it.stock, it.stockLimit]).toEqual([2, 5]);
    const full = parseScrapTfHtml(listPage(STD, [['', "Bill's Hat", '3 keys, 53 refined', '3 keys', limits('5/5')]]), createStubSchema()).items[0]!;
    expect([full.stock, full.stockLimit]).toEqual([5, 5]);
  });
});

describe('page kind detection', () => {
  it.each([
    ['https://scrap.tf/buy/hats', 'buy', true],
    ['https://scrap.tf/buy/stranges?sort=price#top', 'buy', true],
    ['https://scrap.tf/buy/items/', 'buy', true],
    ['https://scrap.tf/unusuals', 'unusuals', true],
    ['https://scrap.tf/unusuals/12', 'unusuals', true],
    ['https://scrap.tf/buy/unusuals', 'unusuals', true],
    ['https://scrap.tf/items', 'items-list', true],
    ['https://scrap.tf/items/13', 'items-list', true],
    ['https://www.scrap.tf/buy/killstreaks', 'buy', true],
    ['https://scrap.tf/sell/hats', 'unknown', true],
    ['https://scrap.tf/raffles', 'unknown', true],
    ['http://web.archive.org/web/20261014041145/https://scrap.tf/items', 'items-list', true],
    ['https://web.archive.org/web/20261014041145id_/scrap.tf/buy/hats', 'buy', true],
    ['https://backpack.tf/classifieds', 'unknown', false],
    ['https://notscrap.tf/buy/hats', 'unknown', false],
  ])('%s -> %s', (url, kind, scrapTf) => {
    const hint = pageKindFromUrl(url);
    expect(hint?.kind).toBe(kind);
    expect(hint?.scrapTf).toBe(scrapTf);
  });

  it('rejects non-http and malformed URLs', () => {
    expect(pageKindFromUrl('file:///C:/Users/x/scrap.html')).toBeNull();
    expect(pageKindFromUrl('javascript:alert(1)')).toBeNull();
    expect(pageKindFromUrl('not a url')).toBeNull();
  });

  it('imports nothing from scrap.tf pages that are not buy pages', () => {
    const r = parseScrapTfHtml(page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '10' }), { url: 'https://scrap.tf/sell/hats' }), createStubSchema());
    expect(r.pageKind).toBe('unknown');
    expect(r.bank).toBeNull();
    expect(r.items).toEqual([]);
    expect(r.warnings.map(warningCode)).toEqual(['page-not-importable']);
  });

  it('warns but still parses pages saved from another site', () => {
    const r = parseScrapTfHtml(page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '10' }), { url: 'https://example.com/page' }), createStubSchema());
    expect(r.pageKind).toBe('unknown');
    expect(r.bank).toBeNull();
    expect(r.warnings.map(warningCode)).toEqual(['not-scraptf']);
    expect(r.items[0]?.sku).toBe('378;6');
  });

  it('prefers a scrap.tf hint over other hosts', () => {
    const html = page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '10' }), {
      url: 'https://example.com/mirror',
      head: '<link rel="canonical" href="https://scrap.tf/buy/hats">',
    });
    expect(parseScrapTfHtml(html, createStubSchema()).pageKind).toBe('buy');
  });

  it('guesses from the title when no address was saved', () => {
    const body = card({ 'data-defindex': '31540', class: 'item hoverable quality5 app440', 'data-title': 'Le Sapeur', style: "background-image:url('/img/particles_440/13_380x380.png')", 'data-item-value': '490' });
    const r = parseScrapTfHtml(page(body, { url: null, title: 'Unusual Trading - TF2 - Scrap.TF' }), createStubSchema());
    expect(r.pageKind).toBe('unusuals');
    expect(r.bank).toBe('unusuals');
    expect(r.warnings.map(warningCode)).toEqual(['page-kind-guessed']);
    const r2 = parseScrapTfHtml(page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' }), { url: null, title: 'Hat Trading - TF2 - Scrap.TF' }), createStubSchema());
    expect(r2.pageKind).toBe('buy');
    // The title tells a buy page, never which bank (F15): coverage falls back to the categories.
    expect(r2.bank).toBeNull();
  });

  it('guesses items-list from the table layout alone', () => {
    const html = fixture('items_list.html').replace(/<meta property="og:url"[^>]*>/, '').replace(/<title>[^<]*<\/title>/, '<title>x</title>');
    const r = parseScrapTfHtml(html, createStubSchema());
    expect(r.pageKind).toBe('items-list');
    expect(r.bank).toBe('list');
    expect(r.warnings.map(warningCode)).toEqual(['page-kind-guessed']);
  });

  it('reports unknown pages and empty pages', () => {
    const r = parseScrapTfHtml(page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' }), { url: null, title: 'Untitled' }), createStubSchema());
    expect(r.pageKind).toBe('unknown');
    expect(r.warnings.map(warningCode)).toEqual(['page-kind-unknown']);
    expect(r.items).toHaveLength(1);
    // A bank page with no card was saved before scrap.tf added them (F18 S3): 'no-cards-saved', not 'no-items'.
    const empty = parseScrapTfHtml(page('<p>Sign in through Steam</p>'), createStubSchema());
    expect(empty.pageKind).toBe('buy');
    expect(empty.items).toEqual([]);
    expect(empty.warnings.map(warningCode)).toEqual(['no-cards-saved']);
    expect(parseScrapTfHtml('', createStubSchema()).warnings.map(warningCode)).toEqual(['page-kind-unknown', 'no-items']);
  });
});

describe('limits and untrusted input', () => {
  it('rejects pages over 20 MB, counting UTF-8 bytes', () => {
    expect(() => parseScrapTfHtml('a'.repeat(MAX_IMPORT_BYTES + 1), createStubSchema())).toThrow(ImportTooLargeError);
    // Two bytes per character: under the limit in characters, over it in bytes.
    expect(() => parseScrapTfHtml('é'.repeat(MAX_IMPORT_BYTES / 2 + 1), createStubSchema())).toThrow(ImportTooLargeError);
  });

  it('accepts a page of exactly 20 MB', () => {
    const html = `<!--${'a'.repeat(MAX_IMPORT_BYTES - 7)}-->`;
    expect(Buffer.byteLength(html)).toBe(MAX_IMPORT_BYTES);
    expect(() => parseScrapTfHtml(html, createStubSchema())).not.toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => parseScrapTfHtml(null as unknown as string, createStubSchema())).toThrow(TypeError);
  });

  it('ignores a byte order mark', () => {
    const r = parseScrapTfHtml(`\uFEFF${page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' }))}`, createStubSchema());
    expect(r.pageKind).toBe('buy');
    expect(r.items[0]?.sku).toBe('378;6');
  });

  it('never executes scripts or event handlers in the page', () => {
    const g = globalThis as Record<string, unknown>;
    delete g.__flipdeskPwned;
    const body = `<script>globalThis.__flipdeskPwned = 1</script><img src=x onerror="globalThis.__flipdeskPwned = 2">${card({
      'data-defindex': '378',
      'data-title': '<img src=x onerror="globalThis.__flipdeskPwned=3">Team Captain<script>globalThis.__flipdeskPwned=4</script>',
      'data-content': '<script>globalThis.__flipdeskPwned=5</script>Level 1',
      'data-item-value': '9',
    })}`;
    const r = parseScrapTfHtml(page(body), createStubSchema());
    expect(g.__flipdeskPwned).toBeUndefined();
    expect(r.items[0]?.title).toBe('Team Captain');
    expect(r.items[0]?.warnings).toEqual([]);
  });

  it('survives a schema module that throws on every call', () => {
    const r = parseScrapTfHtml(fixture('buy_hats.html'), createStubSchema({ throwing: true }));
    expect(r.items).toHaveLength(38);
    expect(r.warnings.map(warningCode)).toContain('schema-not-loaded');
    expect(byAsset(r.items, '9100000001').sku).toBe('378;6');
  });

  it('works without a loaded schema, refusing to guess skins', () => {
    const r = parseScrapTfHtml(fixture('buy_hats.html'), createStubSchema({ loaded: false }));
    expect(r.warnings.map(warningCode)).toContain('schema-not-loaded');
    expect(byAsset(r.items, '9100000001').sku).toBe('378;6');
    expect(byAsset(r.items, '9100000017').sku).toBe('205;11;australium;kt-3');
    expect(byAsset(r.items, '9100000019').sku).toBe('208;15;w1;pk300'); // from the warpaint image
    expect(byAsset(r.items, '9100000020').sku).toBeNull();
    expect(codes(byAsset(r.items, '9100000020'))).toContain('paintkit-unresolved');
    expect(byAsset(r.items, '9100000018').sku).toBe('16105;15;w3;pk105'); // defindex 16000 + pk
  });

  it('drops invalid attributes with a warning', () => {
    const it = one({ 'data-defindex': '12abc', 'data-id': 'x1', 'data-title': 'Team Captain', 'data-item-value': '-4' });
    expect(it.sku).toBeNull();
    expect(it.assetId).toBeNull();
    expect(codes(it)).toEqual(['invalid-attribute', 'invalid-attribute', 'invalid-attribute', 'no-price', 'no-defindex']);
  });

  // 0.7.3: parse5 takes time quadratic in depth (20,000 nested elements took seconds), so a page nested
  // deeper than any real one is refused (test/import/audit-parser-depth.test.ts); up to that it is read.
  it('handles very deep nesting without recursion limits', () => {
    const html = (depth: number) => page('<div>'.repeat(depth) + card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' }) + '</div>'.repeat(depth));
    expect(parseScrapTfHtml(html(500), createStubSchema()).items.map((i) => i.sku)).toEqual(['378;6']);
    expect(() => parseScrapTfHtml(html(20000), createStubSchema())).toThrow(/nested more than 512 levels deep/);
  });
});

describe('card details', () => {
  it('parses paint colours', () => {
    expect(cssColorToHex('#ABC')).toBe('#aabbcc');
    expect(cssColorToHex('#7D4071')).toBe('#7d4071');
    expect(cssColorToHex('rgb(37, 109, 141)')).toBe('#256d8d');
    expect(cssColorToHex('rgba(37,109,141,0.5)')).toBe('#256d8d');
    expect(cssColorToHex('rgb(100%, 50%, 0%)')).toBe('#ff7f00');
    expect(cssColorToHex('transparent')).toBeNull();
  });

  it('splits tooltip HTML into text lines', () => {
    expect(htmlAttrLines("Level 5<br/><span class='x'>Painted Pink as Hell</span><br><small></small>")).toEqual(['Level 5', 'Painted Pink as Hell']);
    expect(htmlAttrLines('')).toEqual([]);
  });

  it('warns on unknown paint colours', () => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' }, '<div class="paintcolor" style="background:#123456;"></div>');
    expect(it.special.paint).toBeNull();
    expect(codes(it)).toEqual(['unknown-paint']);
  });

  it('prefers the tooltip paint when it disagrees with the colour', () => {
    const it = one(
      { 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9', 'data-content': 'Painted Team Spirit' },
      '<div class="paintcolor" style="background:#FF69B4;"></div>',
    );
    expect(it.special.paint).toBe(12073019);
    expect(codes(it)).toEqual(['paint-mismatch']);
  });

  it('takes the paint from the tooltip when there is no colour swatch', () => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9', 'data-content': 'Painted An Air of Debonair' });
    expect(it.special.paint).toBe(6637376);
    expect(it.warnings).toEqual([]);
  });

  it('accepts the effect name in the title', () => {
    const it = one({ 'data-defindex': '378', class: 'item quality5 app440', 'data-title': 'Burning Flames Team Captain', 'data-item-value': '900' });
    expect(it.sku).toBe('378;5;u13');
    expect(it.warnings).toEqual([]);
  });

  it('accepts an image effect whose name is repeated in the title', () => {
    const it = one({
      'data-defindex': '378',
      class: 'item quality5 app440',
      style: "background-image:url('/img/particles_440/8_380x380.png')",
      'data-title': 'Haunted Ghosts Team Captain',
      'data-item-value': '900',
    });
    expect(it.sku).toBe('378;5;u8');
    expect(it.warnings).toEqual([]);
  });

  it('takes the killstreak tier from the title when there is no class and warns on conflicts', () => {
    expect(one({ 'data-defindex': '205', 'data-title': 'Professional Killstreak Rocket Launcher', 'data-item-value': '90' }).sku).toBe('205;6;kt-3');
    const conflict = one({ 'data-defindex': '205', class: 'item quality6 killstreak3 app440', 'data-title': 'Killstreak Rocket Launcher', 'data-item-value': '90' });
    expect(conflict.sku).toBe('205;6;kt-3');
    expect(codes(conflict)).toEqual(['killstreak-mismatch']);
  });

  it('does not treat items named "Strange ..." as elevated strange', () => {
    const it = one({ 'data-defindex': '6012', 'data-title': 'Strange Part: Airborne Enemies Killed', 'data-item-value': '900' });
    expect(it.sku).toBe('6012;6');
  });

  it('treats "Strange Stat Clock" as elevated strange', () => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-content': 'Level 1<br/>Strange Stat Clock', 'data-item-value': '30' });
    expect(it.sku).toBe('378;6;strange');
  });

  it('cross-checks the warpaint image', () => {
    const it = one({
      'data-defindex': '208',
      class: 'item quality15 app440',
      style: "background-image:url('/img/items/warpaint/208_300_2_0.png')",
      'data-title': 'Frozen Aurora Flame Thrower (Factory New)',
      'data-item-value': '40',
    });
    expect(it.sku).toBe('208;15;w1;pk300');
    expect(codes(it)).toEqual(['wear-mismatch']);
  });

  it('infers a war paint paintkit from its defindex', () => {
    const it = one({ 'data-defindex': '16123', class: 'item quality15 app440', 'data-title': 'Unknownium War Paint (Factory New)', 'data-item-value': '40' });
    expect(it.sku).toBe('16123;15;w1;pk123');
    expect(codes(it)).toEqual(['paintkit-inferred', 'unknown-item']);
  });

  it('refuses skins whose paintkit is unknown', () => {
    const it = one({ 'data-defindex': '208', class: 'item quality15 app440', 'data-title': 'Mystery Swirl Flame Thrower (Field-Tested)', 'data-item-value': '40' });
    expect(it.sku).toBeNull();
    expect(codes(it)).toEqual(['unparsed-name', 'paintkit-unresolved']);
    expect(it.warnings[0]).toContain('Mystery Swirl');
  });

  it('reads untradable items', () => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-content': 'Level 1<br/>( Not Tradable )', 'data-item-value': '30' });
    expect(it.sku).toBe('378;6;untradable');
    expect(codes(it)).toEqual(['not-tradable']);
  });

  it('parses key prices from the indicator and checks them against data-item-value', () => {
    const ok = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '671' }, '<div class="item-value-indicator">1 key 20.11 ref</div>');
    expect([ok.costKeys, ok.costScrap]).toEqual([1, 181]);
    expect(ok.warnings).toEqual([]);
    const bad = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '100' }, '<div class="item-value-indicator">1 key 20.11 ref</div>');
    expect(codes(bad)).toEqual(['price-mismatch']);
  });

  it('reports unreadable prices', () => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain' }, '<div class="item-value-indicator">make offer</div>');
    expect(codes(it)).toEqual(['unparsed-price', 'no-price']);
    expect(isImportableItem(it)).toBe(false);
  });

  it('stock comes from data-num-available, the stack badge, or one per asset', () => {
    expect(one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9', 'data-num-available': '7' }).stock).toBe(7);
    expect(one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' }, '<div class="item-group-num-text">4x</div>').stock).toBe(4);
    expect(one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9', 'data-id': '123' }).stock).toBe(1);
    expect(one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9' }).stock).toBeNull();
  });

  it('finds particle images rewritten by a "Webpage, Complete" save', () => {
    const it = one({
      'data-defindex': '31540',
      class: 'item hoverable quality5 app440',
      style: 'opacity: 1; background-image: url("./Hats_files/96fx96f"), url("./Hats_files/380_380x380.png");',
      'data-title': 'Le Sapeur',
      'data-item-value': '900',
    });
    expect(it.sku).toBe('31540;5;u380');
  });

  it('does not double-count lines repeated in data-content2', () => {
    const content = 'Halloween: Exorcism (spell only active during event)<br/>(Kills While Explosive Jumping: 3)';
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '9', 'data-content': content, 'data-content2': content });
    expect(it.special.spells).toEqual(['Exorcism']);
    expect(it.special.parts).toEqual(['Kills While Explosive Jumping']);
  });

  it('accepts cards without the hoverable class', () => {
    const r = parseScrapTfHtml(page('<div class="item app440 quality6" data-defindex="378" data-title="Team Captain" data-item-value="9"></div>'), createStubSchema());
    expect(r.items.map((i) => i.sku)).toEqual(['378;6']);
  });
});

describe('warningCode / isImportableItem', () => {
  it('extracts the code', () => {
    expect(warningCode('no-price: x: y')).toBe('no-price');
    expect(warningCode('plain')).toBe('plain');
  });
});
