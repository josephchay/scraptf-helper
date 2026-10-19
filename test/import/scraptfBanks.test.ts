// F15: every scrap.tf bank page parses, and the parser tells which page a saved file came from.
// Offline (R1, R10): the pages are synthetic fixtures in test/fixtures/import or built here; nothing
// is fetched. Fixture card markup follows DESIGN_BRIEF §3.3, name handling NetroScript's userscript.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { isImportableItem, pageKindFromUrl, parseScrapTfHtml, warningCode } from '../../src/service/import';
import { fromString } from '../../src/shared/sku';
import type { ImportPageKind, ParsedScrapItem, ScraptfBank } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';
import { createStubSchema } from './schemaStub';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)), 'utf8');

const codes = (i: ParsedScrapItem): string[] => i.warnings.map(warningCode);
const byAsset = (items: ParsedScrapItem[], id: string): ParsedScrapItem => {
  const hit = items.find((i) => i.assetId === id);
  if (!hit) throw new Error(`no item with asset id ${id}`);
  return hit;
};

/** One card the way scrap.tf renders it (attribute values are raw HTML-escaped strings). */
function card(attrs: Record<string, string>, inner = ''): string {
  const a = Object.entries({ 'data-appid': '440', class: 'item hoverable quality6 rarity app440', ...attrs })
    .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
    .join(' ');
  return `<div ${a}>${inner}</div>`;
}

function page(body: string, opts: { url?: string | null; title?: string; bodyId?: string } = {}): string {
  const url = opts.url === undefined ? 'https://scrap.tf/buy/items' : opts.url;
  const saved = url ? `<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n` : '';
  const id = opts.bodyId ? ` id="${opts.bodyId}"` : '';
  return `<!DOCTYPE html>\n${saved}<html><head><title>${opts.title ?? 'Test'}</title></head><body${id}>${body}</body></html>`;
}

function one(attrs: Record<string, string>, inner = '', schema: SchemaService = createStubSchema()): ParsedScrapItem {
  const r = parseScrapTfHtml(page(card(attrs, inner)), schema);
  expect(r.items).toHaveLength(1);
  return r.items[0]!;
}

/** [asset id, SKU (null: skipped), name, keys, scrap, stock, warning codes] */
type CardRow = [string, string | null, string, number, number, number, string[]];

/** Exact expectations for every card of a fixture, in page order. */
function expectCards(file: string, rows: CardRow[]): void {
  const items = parseScrapTfHtml(fixture(file), createStubSchema()).items;

  it('has exactly these cards, in page order', () => {
    expect(items.map((i) => i.assetId)).toEqual(rows.map((r) => r[0]));
  });

  it.each(rows)('card %s -> %s', (id, sku, name, keys, scrap, stock, warnings) => {
    const it = byAsset(items, id);
    expect(it.sku).toBe(sku);
    expect(it.skuObject).toEqual(sku === null ? null : fromString(sku));
    expect(it.name).toBe(name);
    expect([it.costKeys, it.costScrap]).toEqual([keys, scrap]);
    expect(it.stock).toBe(stock);
    expect(codes(it)).toEqual(warnings);
  });

  it('never puts a paint, sheen or killstreaker into a SKU, and imports only identified, priced cards', () => {
    for (const it of items) {
      expect(it.sku ?? '').not.toMatch(/;p\d/);
      expect(it.skuObject?.paint ?? null).toBeNull();
    }
    expect(items.filter(isImportableItem).map((i) => i.assetId)).toEqual(rows.filter((r) => r[1] !== null).map((r) => r[0]));
  });
}

// ---------------------------------------------------------------------------
// The five new bank pages
// ---------------------------------------------------------------------------

describe('saved /buy/weapons page', () => {
  const r = parseScrapTfHtml(fixture('buy_weapons.html'), createStubSchema());

  it('is the weapons bank (saved-from comment) and drops the selected copy', () => {
    expect([r.pageKind, r.bank]).toEqual(['buy', 'weapons']);
    expect(r.warnings).toEqual(['duplicate-cards: ignored 1 selected-item copies']);
  });

  expectCards('buy_weapons.html', [
    ['9300000001', '127;6', 'Direct Hit', 0, 1, 12, []],
    ['9300000002', '228;6', 'Black Box', 0, 2, 1, []],
    ['9300000003', '355;6', "Fan O'War", 0, 1, 1, []],
    ['9300000004', '41;3', 'Vintage Natascha', 0, 27, 1, []],
    ['9300000005', '638;1', 'Genuine Sharp Dresser', 0, 40, 1, []],
    ['9300000006', '228;14', "Collector's Black Box", 0, 99, 1, []],
    ['9300000007', '202;11;australium', 'Strange Australium Minigun', 21, 90, 1, []],
    ['9300000008', '211;11;australium', 'Strange Australium Medi Gun', 17, 0, 1, []],
    ['9300000009', '205;11;australium;festive', 'Strange Festivized Australium Rocket Launcher', 30, 0, 1, []],
    ['9300000010', '200;6;festive', 'Festivized Scattergun', 0, 18, 1, []],
    ['9300000011', '133;6;uncraftable', 'Non-Craftable Gunboats', 0, 2, 1, []],
    ['9300000012', '793;11', 'Strange Silver Botkiller Minigun Mk.I', 3, 108, 1, []],
    ['9300000013', '654;6', 'Festive Minigun', 0, 45, 1, []],
    ['9300000014', '199;6;uncraftable', 'Non-Craftable Shotgun', 0, 1, 1, []],
  ]);

  it('reads "Festive" in a weapon name as the name, not the Festivized modifier', () => {
    expect(byAsset(r.items, '9300000013').skuObject?.festive).toBe(false);
    expect(byAsset(r.items, '9300000010').skuObject?.festive).toBe(true);
  });
});

describe('saved /buy/stranges page', () => {
  const r = parseScrapTfHtml(fixture('buy_stranges.html'), createStubSchema());

  it('is the stranges bank (canonical link and og:url, no saved-from comment)', () => {
    expect([r.pageKind, r.bank]).toEqual(['buy', 'stranges']);
    expect(r.warnings).toEqual([]);
  });

  expectCards('buy_stranges.html', [
    ['9400000001', '200;11', 'Strange Scattergun', 0, 45, 1, []],
    ['9400000002', '378;11', 'Strange Team Captain', 2, 0, 1, []],
    ['9400000003', '638;1;strange', 'Strange Genuine Sharp Dresser', 1, 45, 1, []],
    ['9400000004', '41;3;strange', 'Strange Vintage Natascha', 3, 0, 1, []],
    ['9400000005', '940;13;strange', 'Strange Haunted Ghostly Gibus', 0, 72, 1, []],
    ['9400000006', '201;11;festive', 'Strange Festivized Sniper Rifle', 0, 54, 1, []],
    ['9400000007', '208;11;kt-1', 'Strange Killstreak Flame Thrower', 0, 63, 1, []],
    ['9400000008', '205;11', 'Strange Rocket Launcher', 0, 90, 1, []],
    ['9400000009', '199;11;uncraftable', 'Non-Craftable Strange Shotgun', 0, 36, 1, []],
    ['9400000010', '35;11', 'Strange Kritzkrieg', 0, 27, 1, []],
    ['9400000011', '202;11;kt-2;festive', 'Strange Festivized Specialized Killstreak Minigun', 0, 140, 1, []],
    ['9400000012', '200;11', 'Strange Scattergun', 0, 81, 1, []],
    ['9400000013', '378;11', 'Strange Team Captain', 2, 54, 1, []],
  ]);

  it('records strange parts as extras without changing the SKU; a base counter is not a part', () => {
    const parts = byAsset(r.items, '9400000008');
    expect(parts.special.parts).toEqual(['Robots Destroyed', 'Kills While Explosive Jumping']);
    expect(parts.sku).toBe('205;11');
    // "(Kill Assists: N)" is a medi gun's own second counter.
    expect(byAsset(r.items, '9400000010').special.parts).toEqual([]);
    expect(r.items.filter((i) => i.special.parts.length > 0).map((i) => i.assetId)).toEqual(['9400000008']);
  });

  it('records spells and paint as extras too, with the same SKU as the clean copy', () => {
    const spelled = byAsset(r.items, '9400000012');
    expect([spelled.sku, spelled.special.spells, spelled.special.paint]).toEqual(['200;11', ['Exorcism'], null]);
    expect(byAsset(r.items, '9400000001').special.spells).toEqual([]);
    const painted = byAsset(r.items, '9400000013');
    expect([painted.sku, painted.special.paint, painted.special.spells]).toEqual(['378;11', 16738740, []]);
    expect(byAsset(r.items, '9400000002').special.paint).toBeNull();
  });

  it('elevates only a non-strange quality, whether the Strange is a class or a title word', () => {
    expect(byAsset(r.items, '9400000003').skuObject).toMatchObject({ quality: 1, quality2: 11 }); // two classes
    expect(byAsset(r.items, '9400000004').skuObject).toMatchObject({ quality: 3, quality2: 11 }); // title only
    expect(byAsset(r.items, '9400000001').skuObject).toMatchObject({ quality: 11, quality2: null });
  });

  it('reads the sheen of a strange festivized killstreak', () => {
    expect(byAsset(r.items, '9400000011').special).toMatchObject({ sheen: 4, killstreaker: null });
  });
});

describe('saved /buy/killstreaks page', () => {
  const r = parseScrapTfHtml(fixture('buy_killstreaks.html'), createStubSchema());

  it('is the killstreaks bank (og:url only)', () => {
    expect([r.pageKind, r.bank]).toEqual(['buy', 'killstreaks']);
    expect(r.warnings).toEqual([]);
  });

  expectCards('buy_killstreaks.html', [
    ['9500000001', '205;6;kt-1', 'Killstreak Rocket Launcher', 0, 14, 1, []],
    ['9500000002', '200;6;kt-2', 'Specialized Killstreak Scattergun', 0, 27, 1, []],
    ['9500000003', '202;6;kt-3', 'Professional Killstreak Minigun', 1, 90, 1, []],
    ['9500000004', '208;11;kt-3', 'Strange Professional Killstreak Flame Thrower', 2, 0, 1, []],
    ['9500000005', '207;11;australium;kt-1', 'Strange Killstreak Australium Stickybomb Launcher', 25, 0, 1, []],
    ['9500000006', '199;6;kt-2', 'Specialized Killstreak Shotgun', 0, 22, 1, []],
    ['9500000007', '211;6;kt-3', 'Professional Killstreak Medi Gun', 1, 75, 1, []],
    ['9500000008', '197;6;uncraftable;kt-1', 'Non-Craftable Killstreak Wrench', 0, 9, 1, []],
    ['9500000009', '202;11;kt-3;festive', 'Strange Festivized Professional Killstreak Minigun', 3, 54, 1, []],
    ['9500000010', '793;11;kt-3', 'Strange Professional Killstreak Silver Botkiller Minigun Mk.I', 5, 0, 1, []],
  ]);

  it.each([
    // [card, fx sheen id, fx killstreaker id] stored raw as SpecialAttrs, never in the SKU
    ['9500000001', null, null],
    ['9500000002', 3, null],
    ['9500000003', 1, 2002],
    ['9500000004', 7, 2007],
    ['9500000005', null, null],
    ['9500000006', 2, null], // tooltip only
    ['9500000007', 6, 2004], // no killstreak class: the tier comes from the title
    ['9500000008', null, null],
    ['9500000009', 4, 2006],
    ['9500000010', 5, 2003],
  ])('card %s: sheen %s, killstreaker %s', (id, sheen, killstreaker) => {
    const it = byAsset(r.items, id);
    expect([it.special.sheen, it.special.killstreaker]).toEqual([sheen, killstreaker]);
    expect(it.sku).not.toMatch(/sheen|fx|u20\d\d/);
  });
});

describe('saved /buy/skins page', () => {
  const r = parseScrapTfHtml(fixture('buy_skins.html'), createStubSchema());

  it('is the skins bank (an address nested in a web.archive.org copy)', () => {
    expect([r.pageKind, r.bank]).toEqual(['buy', 'skins']);
    expect(r.warnings).toEqual(['no-sku: 3 of 19 items could not be identified']);
  });

  expectCards('buy_skins.html', [
    ['9600000001', '15000;15;w3;pk14', 'Night Owl Sniper Rifle (Field-Tested)', 0, 36, 1, []],
    ['9600000002', '205;15;w3;pk14', 'Night Owl Rocket Launcher (Field-Tested)', 0, 40, 1, []],
    ['9600000003', '208;15;w5;pk300', 'Frozen Aurora Flame Thrower (Battle Scarred)', 0, 18, 1, []],
    ['9600000004', '208;11;w2;pk300', 'Strange Frozen Aurora Flame Thrower (Minimal Wear)', 0, 99, 1, []],
    ['9600000005', '15000;15;w1;pk14;kt-3', 'Professional Killstreak Night Owl Sniper Rifle (Factory New)', 1, 0, 1, []],
    ['9600000006', '15063;11;w2;pk70;kt-2', 'Strange Specialized Killstreak Haunted Ghosts Revolver (Minimal Wear)', 0, 72, 1, []],
    ['9600000007', '208;15;u702;w3;pk300', 'Isotope Frozen Aurora Flame Thrower (Field-Tested)', 4, 0, 1, []],
    ['9600000008', '15000;15;u704;w1;pk14', 'Energy Orb Night Owl Sniper Rifle (Factory New)', 12, 0, 1, []],
    ['9600000009', '15000;15;u703;w2;pk1014', 'Cool Night Owl Mk.II Sniper Rifle (Minimal Wear)', 6, 0, 1, []],
    ['9600000010', '15000;15;u701;w4;pk14;strange', 'Strange Hot Night Owl Sniper Rifle (Well-Worn)', 9, 0, 1, []],
    ['9600000011', '16104;15;w5;pk104', 'Masked Mender War Paint (Battle Scarred)', 0, 9, 1, []],
    ['9600000012', '16070;15;w1;pk70', 'Haunted Ghosts War Paint (Factory New)', 0, 27, 1, []],
    ['9600000013', '16105;15;w2;pk105', 'Masked Mender Mk.II War Paint (Minimal Wear)', 0, 22, 1, []],
    ['9600000014', '16105;11;w3;pk105', 'Strange Masked Mender Mk.II War Paint (Field-Tested)', 0, 45, 1, []],
    ['9600000015', '15000;15;w2;pk14', 'Night Owl Sniper Rifle (Minimal Wear)', 0, 40, 1, []],
    ['9600000016', '205;15;w2;pk14;festive', 'Festivized Night Owl Rocket Launcher (Minimal Wear)', 0, 50, 1, []],
    ['9600000017', null, 'Mystery Swirl Flame Thrower (Field-Tested)', 0, 31, 1, ['unparsed-name', 'paintkit-unresolved']],
    ['9600000018', null, '★Unusual Frozen Aurora Flame Thrower (Factory New)', 7, 0, 1, ['unusual-without-effect']],
    ['9600000019', null, 'Unusual Night Owl Sniper Rifle (Field-Tested)', 8, 0, 1, ['unusual-without-effect']],
  ]);

  it('keys unusual skins as Decorated plus the effect, whatever quality class scrap.tf gives them', () => {
    for (const id of ['9600000007', '9600000008', '9600000009', '9600000010']) {
      expect(byAsset(r.items, id).skuObject?.quality).toBe(15);
    }
    // Without an effect neither the Unusual class nor an "Unusual" title is turned into a guess.
    for (const id of ['9600000018', '9600000019']) {
      expect(byAsset(r.items, id).warnings).toEqual(['unusual-without-effect: unusual quality but no effect found']);
    }
  });

  it('never takes "Haunted Ghosts" for the Haunted quality', () => {
    for (const id of ['9600000006', '9600000012']) expect(byAsset(r.items, id).skuObject).toMatchObject({ paintkit: 70 });
    expect(r.items.some((i) => i.skuObject?.quality === 13)).toBe(false);
  });

  it('skips a skin whose paintkit it cannot name, with the reason', () => {
    expect(byAsset(r.items, '9600000017').warnings).toEqual([
      'unparsed-name: "Mystery Swirl" in "Mystery Swirl Flame Thrower (Field-Tested)"',
      'paintkit-unresolved: "Mystery Swirl Flame Thrower (Field-Tested)" has a wear but no known paintkit',
    ]);
  });
});

describe('saved /buy/items page', () => {
  const r = parseScrapTfHtml(fixture('buy_items.html'), createStubSchema());

  it('is the items bank', () => {
    expect([r.pageKind, r.bank]).toEqual(['buy', 'items']);
    expect(r.warnings).toEqual(['no-sku: 4 of 27 items could not be identified']);
  });

  expectCards('buy_items.html', [
    ['9700000001', '5021;6', 'Mann Co. Supply Crate Key', 0, 564, 40, []],
    ['9700000002', '5021;6;uncraftable', 'Non-Craftable Mann Co. Supply Crate Key', 0, 495, 1, []],
    ['9700000003', '5020;6', 'Name Tag', 0, 156, 8, []],
    ['9700000004', '5044;6', 'Description Tag', 0, 86, 1, []],
    ['9700000005', '5051;6', 'Pink as Hell', 0, 90, 1, []],
    ['9700000006', '5046;6', 'Team Spirit', 0, 23, 1, []],
    ['9700000007', '5037;6', 'Australium Gold', 0, 81, 1, []],
    ['9700000008', '1157;6', 'Taunt: Kazotsky Kick', 0, 45, 1, []],
    ['9700000009', '1118;11', 'Strange Taunt: Conga', 2, 45, 1, []],
    ['9700000010', '1157;5;u3001', 'Showstopper Taunt: Kazotsky Kick', 18, 0, 1, []],
    ['9700000011', '1162;5;u3004', "'72 Taunt: Mannrobics", 9, 0, 1, []],
    ['9700000012', '1015;1', 'Genuine Taunt: The Shred Alert', 3, 359, 1, []],
    ['9700000013', '5734;6;c82', 'Mann Co. Supply Munition #82', 0, 3, 1, []],
    ['9700000014', '5832;6;c100', 'Warbird Weapons Case #100', 0, 20, 1, []],
    ['9700000015', '5735;6;c83', 'Mann Co. Supply Munition Series #83', 0, 3, 1, ['unknown-item']],
    ['9700000016', '6012;6', 'Strange Part: Airborne Enemies Killed', 4, 90, 1, []],
    ['9700000017', '6526;6;kt-3;td-205', 'Professional Killstreak Rocket Launcher Kit', 2, 0, 1, []],
    ['9700000018', '20003;6;kt-3;td-205;od-6526;oq-6', 'Professional Killstreak Rocket Launcher Kit Fabricator', 1, 180, 1, []],
    ['9700000019', null, 'Specialized Killstreak Bread Bite Kit Fabricator', 0, 9, 1, ['needs-target']],
    ['9700000020', '725;6', 'Tour of Duty Ticket', 0, 75, 1, []],
    ['9700000021', '725;6;uncraftable', 'Non-Craftable Tour of Duty Ticket', 0, 63, 1, []],
    ['9700000022', '206;11;australium', 'Strange Australium Grenade Launcher', 20, 0, 1, []],
    ['9700000023', null, 'Team Captain Strangifier', 0, 22, 1, ['needs-target']],
    ['9700000024', null, 'Unusual Taunt: Conga Unusualifier', 6, 0, 1, ['needs-target']],
    // Crates are priced per series: one with a single series takes it from the schema, any other is skipped.
    ['9700000025', '5078;6;c46', 'Scorched Crate #46', 0, 3, 1, ['series-inferred']],
    ['9700000026', null, 'Mann Co. Supply Crate', 0, 1, 1, ['series-unresolved']],
    // Exists only as Unusual, with no effect: the SKU is complete.
    ['9700000027', '267;5', 'Unusual Haunted Metal Scrap', 1, 90, 1, []],
  ]);

  it('treats paint cans as items, never as painted (team paints and Australium Gold included)', () => {
    for (const id of ['9700000005', '9700000006', '9700000007']) {
      const it = byAsset(r.items, id);
      expect(it.special.paint).toBeNull();
      expect(it.skuObject).toMatchObject({ quality: 6, australium: false });
    }
  });

  it('keeps the non-craftable key apart from the currency key', () => {
    expect(r.items.filter((i) => i.sku === '5021;6').map((i) => i.assetId)).toEqual(['9700000001']);
  });

  it('canonicalises a BLU taunt effect and reads an effect name with an apostrophe', () => {
    expect(byAsset(r.items, '9700000010').skuObject?.effect).toBe(3001);
    expect(byAsset(r.items, '9700000011').skuObject?.effect).toBe(3004);
  });

  it('keeps the strange part an item and resolves kits and fabricators only by exact name', () => {
    expect(byAsset(r.items, '9700000016').skuObject?.quality2).toBeNull();
    expect(byAsset(r.items, '9700000019').warnings).toEqual([
      'needs-target: "Specialized Killstreak Bread Bite Kit Fabricator" needs a target item that the page does not show',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Bank recognition (S1)
// ---------------------------------------------------------------------------

describe('bank from the page address', () => {
  it.each<[string, ImportPageKind, ScraptfBank | null]>([
    ['https://scrap.tf/buy/hats', 'buy', 'hats'],
    ['https://scrap.tf/buy/weapons', 'buy', 'weapons'],
    ['https://scrap.tf/buy/stranges?sort=price#top', 'buy', 'stranges'],
    ['https://scrap.tf/buy/killstreaks/', 'buy', 'killstreaks'],
    ['https://www.scrap.tf/buy/killstreaks', 'buy', 'killstreaks'],
    ['https://scrap.tf/buy/skins', 'buy', 'skins'],
    ['https://scrap.tf/Buy/Items', 'buy', 'items'],
    ['https://scrap.tf/buy/items/2', 'buy', 'items'],
    ['https://scrap.tf/unusuals', 'unusuals', 'unusuals'],
    ['https://scrap.tf/unusuals/12', 'unusuals', 'unusuals'],
    ['https://scrap.tf/buy/unusuals', 'unusuals', 'unusuals'],
    ['https://scrap.tf/items', 'items-list', 'list'],
    ['https://scrap.tf/items/13', 'items-list', 'list'],
    ['https://web.archive.org/web/20261014041145/https://scrap.tf/buy/skins', 'buy', 'skins'],
    ['https://web.archive.org/web/20261014041145id_/scrap.tf/buy/weapons', 'buy', 'weapons'],
    ['http://web.archive.org/web/20261014041145/https://scrap.tf/items/2', 'items-list', 'list'],
    ['https://web.archive.org/web/20261014041145/https://scrap.tf/buy/hats/', 'buy', 'hats'],
    ['https://scrap.tf/buy/unusuals/', 'unusuals', 'unusuals'],
    ['https://scrap.tf/items/', 'items-list', 'list'],
    ['HTTPS://SCRAP.TF/BUY/WEAPONS', 'buy', 'weapons'],
    ['https://scrap.tf/buy', 'unknown', null],
    ['https://web.archive.org/web/20261014041145/https://backpack.tf/buy/hats', 'unknown', null],
    // Not a bank this app knows, or not a bank page at all.
    ['https://scrap.tf/buy/crates', 'buy', null],
    ['https://scrap.tf/buy/list', 'buy', null],
    ['https://scrap.tf/items/hats', 'unknown', null],
    ['https://scrap.tf/sell/hats', 'unknown', null],
    ['https://scrap.tf/raffles', 'unknown', null],
    ['https://backpack.tf/classifieds', 'unknown', null],
    ['https://notscrap.tf/buy/hats', 'unknown', null],
  ])('%s -> %s / %s', (url, kind, bank) => {
    expect(pageKindFromUrl(url)).toMatchObject({ kind, bank });
  });

  it('records the bank of the three pages that already had fixtures', () => {
    expect(parseScrapTfHtml(fixture('buy_hats.html'), createStubSchema()).bank).toBe('hats'); // saved-from comment
    expect(parseScrapTfHtml(fixture('unusuals.html'), createStubSchema()).bank).toBe('unusuals'); // canonical link
    expect(parseScrapTfHtml(fixture('items_list.html'), createStubSchema()).bank).toBe('list'); // og:url
  });

  it('imports an unknown /buy/<slug> with no bank and says so', () => {
    const r = parseScrapTfHtml(page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '10' }), { url: 'https://scrap.tf/buy/crates' }), createStubSchema());
    expect([r.pageKind, r.bank]).toEqual(['buy', null]);
    expect(r.warnings).toEqual(['unknown-bank: crates is not a scrap.tf bank page this app knows; coverage uses the item categories']);
    expect(r.items.map((i) => i.sku)).toEqual(['378;6']);
  });

  it('clips a long unknown slug in the warning', () => {
    const r = parseScrapTfHtml(page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '10' }), { url: `https://scrap.tf/buy/${'x'.repeat(300)}` }), createStubSchema());
    expect(r.bank).toBeNull();
    expect(r.warnings).toEqual([`unknown-bank: ${'x'.repeat(39)}… is not a scrap.tf bank page this app knows; coverage uses the item categories`]);
  });

  it('has no bank for pages it does not import or that were saved from another site', () => {
    const c = card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '10' });
    const sell = parseScrapTfHtml(page(c, { url: 'https://scrap.tf/sell/hats', bodyId: 'pid-buy-hats' }), createStubSchema());
    expect([sell.pageKind, sell.bank, sell.items]).toEqual(['unknown', null, []]);
    // The body id does not overrule an address from another site.
    const mirror = parseScrapTfHtml(page(c, { url: 'https://example.com/mirror', bodyId: 'pid-buy-hats' }), createStubSchema());
    expect([mirror.pageKind, mirror.bank]).toEqual(['unknown', null]);
    expect(mirror.warnings.map(warningCode)).toEqual(['not-scraptf']);
  });

  it('trusts the address over the body id', () => {
    const r = parseScrapTfHtml(page(card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '10' }), { url: 'https://scrap.tf/buy/hats', bodyId: 'pid-buy-weapons' }), createStubSchema());
    expect(r.bank).toBe('hats');
  });
});

describe('bank from inside a page saved without its address', () => {
  /** Removes every address hint (saved-from comment, canonical link, og:url). */
  const withoutAddress = (html: string): string =>
    html
      .replace(/<!--\s*saved from url=[^>]*-->/i, '')
      .replace(/<link rel="canonical"[^>]*>/i, '')
      .replace(/<meta property="og:url"[^>]*>/i, '');
  const withoutTitle = (html: string): string => html.replace(/<title>[^<]*<\/title>/, '<title>Saved page</title>');
  const withoutBodyId = (html: string): string => html.replace(/(<body[^>]*?) id="[^"]*"/, '$1');

  it.each<[string, ImportPageKind, ScraptfBank]>([
    ['buy_hats.html', 'buy', 'hats'],
    ['buy_weapons.html', 'buy', 'weapons'],
    ['buy_stranges.html', 'buy', 'stranges'],
    ['buy_killstreaks.html', 'buy', 'killstreaks'],
    ['buy_skins.html', 'buy', 'skins'],
    ['buy_items.html', 'buy', 'items'],
    ['unusuals.html', 'unusuals', 'unusuals'],
    ['items_list.html', 'items-list', 'list'],
  ])('%s: the body id names the page (%s, %s)', (file, kind, bank) => {
    const r = parseScrapTfHtml(withoutTitle(withoutAddress(fixture(file))), createStubSchema());
    expect([r.pageKind, r.bank]).toEqual([kind, bank]);
    expect(r.warnings[0]).toBe(`page-kind-guessed: treated as ${kind} from the page title/layout`);
    expect(r.warnings.map(warningCode)).not.toContain('unknown-bank');
    // Same cards as with the address.
    expect(r.items.map((i) => i.sku)).toEqual(parseScrapTfHtml(fixture(file), createStubSchema()).items.map((i) => i.sku));
  });

  it.each<[string, ImportPageKind, ScraptfBank | null]>([
    ['buy_weapons.html', 'buy', null],
    ['buy_items.html', 'buy', null], // "Item Trading" is also the /items list's title
    ['unusuals.html', 'unusuals', 'unusuals'],
    ['items_list.html', 'items-list', 'list'], // the table layout
  ])('%s without a body id: the title or layout tells the kind but never a bank page', (file, kind, bank) => {
    const r = parseScrapTfHtml(withoutBodyId(withoutAddress(fixture(file))), createStubSchema());
    expect([r.pageKind, r.bank]).toEqual([kind, bank]);
    expect(r.warnings[0]).toBe(`page-kind-guessed: treated as ${kind} from the page title/layout`);
  });

  it('with nothing to go on there is no bank (coverage falls back to the categories)', () => {
    const r = parseScrapTfHtml(withoutTitle(withoutBodyId(withoutAddress(fixture('buy_weapons.html')))), createStubSchema());
    expect([r.pageKind, r.bank]).toEqual(['unknown', null]);
    expect(r.warnings.map(warningCode)).toEqual(['page-kind-unknown', 'duplicate-cards']);
  });

  it('warns about a pid-buy-<slug> it does not know and reads pid-buy-unusuals as the unusuals page', () => {
    const c = card({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-item-value': '10' });
    const unknown = parseScrapTfHtml(page(c, { url: null, bodyId: 'pid-buy-crates' }), createStubSchema());
    expect([unknown.pageKind, unknown.bank]).toEqual(['buy', null]);
    expect(unknown.warnings).toEqual([
      'page-kind-guessed: treated as buy from the page title/layout',
      'unknown-bank: crates is not a scrap.tf bank page this app knows; coverage uses the item categories',
    ]);
    const unusual = parseScrapTfHtml(page(c, { url: null, bodyId: 'pid-buy-unusuals' }), createStubSchema());
    expect([unusual.pageKind, unusual.bank]).toEqual(['unusuals', 'unusuals']);
  });

  it('needs cards (or list rows) before a body id counts', () => {
    const r = parseScrapTfHtml(page('<p>Sign in through Steam</p>', { url: null, bodyId: 'pid-buy-hats' }), createStubSchema());
    expect([r.pageKind, r.bank]).toEqual(['unknown', null]);
    // F18 S3: but a body id naming a bank page with no card says it was saved without its items.
    expect(r.warnings.map(warningCode)).toEqual(['page-kind-unknown', 'no-cards-saved']);
    const list = parseScrapTfHtml(page('<p>Sign in through Steam</p>', { url: null, bodyId: 'pid-items' }), createStubSchema());
    expect(list.warnings.map(warningCode)).toEqual(['page-kind-unknown', 'no-items']);
  });
});

// ---------------------------------------------------------------------------
// Parser fixes the fixtures exposed
// ---------------------------------------------------------------------------

describe('crate series', () => {
  it('keeps the title series when the tooltip disagrees, and says so', () => {
    const it = one({ 'data-defindex': '5734', 'data-title': 'Mann Co. Supply Munition Series #82', 'data-content': 'Crate Series #83', 'data-item-value': '3' });
    expect(it.sku).toBe('5734;6;c82');
    expect(it.warnings).toEqual(['series-mismatch: title says #82, tooltip says #83 (using the title)']);
  });

  it('a crate the schema does not know takes a bare "#N" as its series when the tooltip confirms it', () => {
    const it = one({ 'data-defindex': '5999', 'data-title': 'Mystery Case #7', 'data-content': 'Crate Series #7', 'data-item-value': '3' });
    expect(it.sku).toBe('5999;6;c7');
    expect(codes(it)).toEqual(['unknown-item']);
  });

  it('refuses a bare "#N" on an item the schema does not know: a crate series or a craft number', () => {
    const it = one({ 'data-defindex': '5999', 'data-title': 'Mystery Case #7', 'data-item-value': '3' });
    expect(it.sku).toBeNull();
    expect(it.warnings).toEqual([
      'unknown-item: defindex 5999 is not in the item schema',
      'series-unresolved: "#7" in "Mystery Case #7" is a crate series or a craft number; the item schema does not say which',
    ]);
  });

  it('without a loaded schema, "Series #N" still reads and a bare "#N" is refused', () => {
    const r = parseScrapTfHtml(fixture('buy_items.html'), createStubSchema({ loaded: false }));
    expect(byAsset(r.items, '9700000013').sku).toBe('5734;6;c82');
    expect(byAsset(r.items, '9700000014').sku).toBe('5832;6;c100'); // tooltip line
    const bare = one({ 'data-defindex': '5832', 'data-title': 'Warbird Weapons Case #100', 'data-item-value': '20' }, '', createStubSchema({ loaded: false }));
    expect(bare.sku).toBeNull();
    expect(codes(bare)).toEqual(['series-unresolved']);
  });

  it('never prices a known crate without its series: a single-series case takes the schema\'s, any other is refused', () => {
    // A bare "5832;6" is a SKU no backpack.tf order or PriceDB price uses: the item would never be a flip.
    const single = one({ 'data-defindex': '5078', 'data-title': 'Scorched Crate', 'data-content': 'Level 1', 'data-item-value': '3' });
    expect(single.sku).toBe('5078;6;c46');
    expect(single.warnings).toEqual(['series-inferred: crate series #46 taken from the item schema']);
    for (const [defindex, title] of [
      ['5022', 'Mann Co. Supply Crate'], // the resolver gives no series: one of many
      ['5734', 'Mann Co. Supply Munition'],
      ['5832', 'Warbird Weapons Case'], // the stub's resolver does not know it
    ]) {
      const it = one({ 'data-defindex': defindex!, 'data-title': title!, 'data-content': 'Level 1', 'data-item-value': '3' });
      expect(it.sku, title).toBeNull();
      expect(it.warnings, title).toEqual([`series-unresolved: "${title}" shows no crate series`]);
      expect(isImportableItem(it)).toBe(false);
    }
  });

  it('refuses an /items list row of a crate without its series the same way', () => {
    const rows = [
      ['5078', 'supply_crate', 'Scorched Crate'],
      ['5022', 'supply_crate', 'Mann Co. Supply Crate'],
      ['5999', 'supply_crate', 'Mystery Case'], // the page says crate, the schema does not know it
    ]
      .map(([d, type, name]) => `<tr data-quality="6" data-defindex="${d}" data-type="${type}"><td></td><td>${name}</td><td>1 ref</td><td>0.88 ref</td><td><div title="1/5"></div></td></tr>`)
      .join('');
    const html = `<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head><body id="pid-items"><table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const r = parseScrapTfHtml(html, createStubSchema());
    expect(r.pageKind).toBe('items-list');
    expect(r.items.map((i) => [i.sku, i.warnings.map(warningCode)])).toEqual([
      ['5078;6;c46', ['series-inferred']],
      [null, ['series-unresolved']],
      [null, ['unknown-item', 'series-unresolved']],
    ]);
  });

  it('reports a "Crate Series" line on an item that is not a crate instead of using it', () => {
    const it = one({ 'data-defindex': '378', 'data-title': 'Team Captain', 'data-content': 'Level 1<br/>Crate Series #5', 'data-item-value': '9' });
    expect(it.sku).toBe('378;6');
    expect(it.warnings).toEqual(['unparsed-modifier: "Crate Series #5"']);
  });
});

describe('unusual skins and War Paint names', () => {
  const sniper = (cls: string, title: string, effect: number | null) =>
    one({
      'data-defindex': '15000',
      class: `item hoverable ${cls} app440`,
      style: effect === null ? 'opacity:1;' : `opacity:1;background-image:url('/img/particles_440/${effect}_380x380.png');`,
      'data-title': title,
      'data-item-value': '900',
    });

  it('"Unusual" in a skin title agrees with a quality15 class; on a hat it still disagrees', () => {
    const skin = sniper('quality15', 'Unusual Night Owl Sniper Rifle (Factory New)', 701);
    expect(skin.sku).toBe('15000;15;u701;w1;pk14');
    expect(skin.warnings).toEqual([]);
    const hat = one({ 'data-defindex': '378', class: 'item quality6 app440', 'data-title': 'Unusual Team Captain', 'data-item-value': '9' });
    expect(codes(hat)).toEqual(['quality-mismatch']);
  });

  it('reads "★Unusual" on a hat as the Unusual quality too', () => {
    const it = one({
      'data-defindex': '378',
      class: 'item quality5 app440',
      style: "background-image:url('/img/particles_440/13_380x380.png')",
      'data-title': '★Unusual Team Captain',
      'data-item-value': '900',
    });
    expect(it.sku).toBe('378;5;u13');
    expect(it.warnings).toEqual([]);
  });

  it('keeps the Unusual class on a skin whose effect it cannot find, and refuses it', () => {
    const it = sniper('quality5', 'Unusual Night Owl Sniper Rifle (Factory New)', null);
    expect(it.sku).toBeNull();
    expect(codes(it)).toEqual(['unusual-without-effect']);
  });

  it('refuses a Decorated skin that is called Unusual but shows no effect, instead of keying the plain skin', () => {
    expect(sniper('quality15', 'Unusual Night Owl Sniper Rifle (Factory New)', null).sku).toBeNull();
    expect(sniper('quality15 quality5', 'Night Owl Sniper Rifle (Factory New)', null).sku).toBeNull();
    const unknown = one({
      'data-defindex': '15000',
      class: 'item quality15 app440',
      'data-content': 'Effect: Spectral Shimmer',
      'data-title': 'Night Owl Sniper Rifle (Factory New)',
      'data-item-value': '900',
    });
    expect(unknown.sku).toBeNull();
    expect(codes(unknown)).toEqual(['unknown-effect', 'unusual-without-effect']);
    // A plain Decorated skin is not affected.
    expect(sniper('quality15', 'Night Owl Sniper Rifle (Factory New)', null).sku).toBe('15000;15;w1;pk14');
  });

  it('takes an unusual skin effect named only in the tooltip, and finds the paintkit after it in the title', () => {
    const it = one({
      'data-defindex': '208',
      class: 'item quality15 app440',
      'data-content': 'Effect: Isotope',
      'data-title': 'Isotope Frozen Aurora Flame Thrower (Field-Tested)',
      'data-item-value': '900',
    });
    expect(it.sku).toBe('208;15;u702;w3;pk300');
    expect(it.warnings).toEqual([]);
  });

  it('refuses a War Paint whose name and defindex name different paintkits, in either title form', () => {
    // 16104 is pk104: "16104;15;w3;pk105" cannot exist, and which signal is wrong cannot be told.
    for (const title of ['War Paint: Masked Mender Mk.II (Field-Tested)', 'Masked Mender Mk.II War Paint (Field-Tested)']) {
      const it = one({ 'data-defindex': '16104', class: 'item quality15 app440', 'data-title': title, 'data-item-value': '20' });
      expect(it.sku, title).toBeNull();
      expect(it.skuObject).toBeNull();
      expect(it.warnings, title).toEqual(['paintkit-mismatch: name gives pk105, defindex 16104 implies pk104']);
      expect(isImportableItem(it)).toBe(false);
    }
    // Name and defindex agreeing still import.
    expect(one({ 'data-defindex': '16105', class: 'item quality15 app440', 'data-title': 'War Paint: Masked Mender Mk.II (Field-Tested)', 'data-item-value': '20' }).sku).toBe('16105;15;w3;pk105');
  });
});

describe('items that exist only as Unusual', () => {
  it('keys a no-effect Unusual card when the schema says the item is only ever Unusual', () => {
    const scrap = one({ 'data-defindex': '267', class: 'item hoverable quality5 app440', 'data-title': 'Unusual Haunted Metal Scrap', 'data-item-value': '654' });
    expect(scrap.sku).toBe('267;5');
    expect(scrap.warnings).toEqual([]);
    // Any other item without its effect is still refused, whatever the schema's other answers.
    const hat = one({ 'data-defindex': '378', class: 'item hoverable quality5 app440', 'data-title': 'Unusual Team Captain', 'data-item-value': '900' });
    expect([hat.sku, codes(hat)]).toEqual([null, ['unusual-without-effect']]);
    // A schema that cannot answer refuses too.
    const unknown = one({ 'data-defindex': '267', class: 'item hoverable quality5 app440', 'data-title': 'Unusual Haunted Metal Scrap', 'data-item-value': '654' }, '', createStubSchema({ throwing: true }));
    expect(unknown.sku).toBeNull();
  });
});

describe('crates and always-Unusual items with the real item schema (fixture, fake HTTP)', () => {
  let schema: SchemaService;
  beforeAll(async () => {
    schema = createSchemaService(makeDeps(schemaRoute()));
    await schema.init();
  });
  const real = (attrs: Record<string, string>) => one({ 'data-content': 'Level 1', 'data-item-value': '20', ...attrs }, '', schema);

  it.each<[string, string, string | null, string[]]>([
    // One series: the same SKU the app's resolver and backpack.tf use.
    ['5832', 'Warbird Weapons Case', '5832;6;c100', ['series-inferred']],
    ['5078', 'Scorched Crate', '5078;6;c46', ['series-inferred']],
    // Many series: never guessed.
    ['5022', 'Mann Co. Supply Crate', null, ['series-unresolved']],
    ['5734', 'Mann Co. Supply Munition', null, ['series-unresolved']],
    ['5068', 'Salvaged Mann Co. Supply Crate', null, ['series-unresolved']],
    // A crate that has no series at all.
    ['5739', 'Mann Co. Audition Reel', '5739;6', []],
  ])('crate %s "%s" -> %s', (defindex, title, sku, warnings) => {
    const it = real({ 'data-defindex': defindex, 'data-title': title });
    expect(it.sku).toBe(sku);
    expect(codes(it)).toEqual(warnings);
    if (sku !== null) expect(sku).toBe(schema.resolve(title)!.sku);
  });

  it.each<[string, string]>([
    ['266', "Unusual Horseless Headless Horsemann's Headtaker"],
    ['267', 'Unusual Haunted Metal Scrap'],
  ])('always-Unusual %s "%s" imports as the schema resolves it', (defindex, title) => {
    const it = real({ 'data-defindex': defindex, class: 'item hoverable quality5 app440', 'data-title': title });
    expect(it.sku).toBe(`${defindex};5`);
    expect(it.sku).toBe(schema.resolve(title)!.sku);
    expect(it.warnings).toEqual([]);
  });
});
