// 0.7.4: a card's or /items row's quality checked against the item and its title (F05, F76), strange parts on a
// copy nothing marks Strange (F75), and a cosmetic's "Kills" strange part (F11).
// - F05: scrap.tf/items listed the Horseless Headless Horsemann's Headtaker with data-quality 0, keyed 266;0, a SKU
//   no order or price uses (the item exists only as Unusual, schema item_quality 5): keyed 266;5, noted
//   quality-inferred. A row's title quality words are checked like a card's class (quality-mismatch).
// - F76: the Strange quality alone (class quality11, data-quality 11) beside another quality word or an unusual
//   effect is an elevated copy the page does not say how to key: refused with quality-conflict, never guessed.
// - F75: strange parts on a copy keyed neither Strange nor elevated strange: refused with strange-conflict.
// - F11: on a cosmetic the counter is Points Scored, so "(Kills: N)" is a part (TF2.GG's "Damage Dealt,
//   Dominations, Kills" orders are all on cosmetics); a weapon's Kills stays its own counter.
// Real schema (test/fixtures/pricedb/schema-subset.json); synthetic cards and rows; nothing is fetched.

import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { classifyOrder, matchContext } from '../../src/service/domain/matcher';
import { isImportableItem, parseScrapTfHtml, warningCode } from '../../src/service/import/scraptfHtml';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { IMPORT_REFUSAL_CODES } from '../../src/shared/importCodes';
import type { ParsedScrapItem } from '../../src/shared/types';
import { makeListing, special, T0 } from '../domain/helpers';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const codes = (it: ParsedScrapItem): string[] => it.warnings.map(warningCode);

function rows(...list: [quality: string, defindex: number, title: string][]): ParsedScrapItem[] {
  const html =
    '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head><body id="pid-items"><table>' +
    '<thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead><tbody>' +
    list.map(([q, d, t]) => `<tr data-quality="${q}" data-defindex="${d}"><td></td><td>${t}</td><td>19 keys</td><td>18 keys</td><td><div title="1/3"></div></td></tr>`).join('') +
    '</tbody></table></body></html>';
  return parseScrapTfHtml(html, schema).items;
}

function cardItem(attrs: { defindex: number; cls: string; title: string; content?: string; style?: string }): ParsedScrapItem {
  const content = (attrs.content ?? 'Level 10').replace(/"/g, '&quot;');
  const html =
    '<!DOCTYPE html>\n<!-- saved from url=(0025)https://scrap.tf/buy/hats -->\n<html><head><title>Hats</title></head><body id="pid-buy-hats">' +
    `<div data-appid="440" data-defindex="${attrs.defindex}" data-item-value="90" class="item hoverable ${attrs.cls} app440" style="${attrs.style ?? 'opacity:1;'}" data-title="${attrs.title}" data-content="${content}"><div class="item-value-indicator">10 ref</div></div>` +
    '</body></html>';
  const items = parseScrapTfHtml(html, schema).items;
  expect(items).toHaveLength(1);
  return items[0]!;
}

const BURNING = "background-image:url('/img/particles_440/13_380x380.png');";

describe('F05: an /items row keyed by its item and title, not only by data-quality', () => {
  it.each([
    ['0', "Horseless Headless Horsemann's Headtaker", '266;5', ['quality-inferred']],
    ['6', "Unusual Horseless Headless Horsemann's Headtaker", '266;5', ['quality-mismatch', 'quality-inferred']],
    ['5', "Horseless Headless Horsemann's Headtaker", '266;5', []],
    ['11', "Strange Unusual Horseless Headless Horsemann's Headtaker", '266;5;strange', ['quality-mismatch', 'quality-inferred']],
    ['1', 'Strange Genuine Huo-Long Heater', '811;1;strange', []],
    ['11', 'Strange Australium Rocket Launcher', '205;11;australium', []],
    ['6', "Bill's Hat", '126;6', []],
    ['6', 'Team Captain', '378;6', []],
  ])('data-quality %s, %j -> %s', (q, title, sku, warned) => {
    const defindex = /Headtaker/.test(title) ? 266 : /Huo-Long/.test(title) ? 811 : /Rocket/.test(title) ? 205 : /Bill/.test(title) ? 126 : 378;
    const [it] = rows([q, defindex, title]);
    expect(it!.sku).toBe(sku);
    expect(codes(it!).filter((c) => c !== 'craft-unverified')).toEqual(warned);
    if (sku === '266;5' || sku === '266;5;strange') expect(schema.resolve(title.replace(/^(?!Strange|Unusual)/, 'Unusual '))?.sku).toBe(sku);
  });

  it('refuses a Strange row whose title names another quality (F76), with a refusal code', () => {
    const [it] = rows(['11', 811, 'Strange Genuine Huo-Long Heater']);
    expect(it!.sku).toBeNull();
    expect(codes(it!)).toContain('quality-conflict');
    expect(IMPORT_REFUSAL_CODES).toContain('quality-conflict');
  });

  it('keys a quality0 card of an Unusual-only item as 5 too', () => {
    const it = cardItem({ defindex: 266, cls: 'quality0', title: "Horseless Headless Horsemann's Headtaker" });
    expect(it.sku).toBe('266;5');
    expect(codes(it)).toEqual(['quality-inferred']);
  });
});

describe('F76: the Strange class alone beside another quality or an effect is refused, never guessed', () => {
  it.each([
    ['quality11', 'Strange Genuine Team Captain', 'opacity:1;'],
    ['quality11', 'Strange Haunted Ghostly Gibus', 'opacity:1;'],
    ['quality11', 'Strange Unusual Team Captain', 'opacity:1;'],
    ['quality11', 'Team Captain', BURNING],
  ])('class %s, %j', (cls, title, style) => {
    const it = cardItem({ defindex: /Gibus/.test(title) ? 940 : 378, cls, title, style });
    expect(it.sku).toBeNull();
    expect(codes(it)).toContain('quality-conflict');
    expect(isImportableItem(it)).toBe(false);
  });

  it('keys the shapes the parser does know as before', () => {
    expect(cardItem({ defindex: 378, cls: 'quality1 quality11', title: 'Strange Genuine Team Captain' }).sku).toBe('378;1;strange');
    expect(cardItem({ defindex: 378, cls: 'quality5 quality11', title: 'Strange Unusual Burning Flames Team Captain', style: BURNING }).sku).toBe('378;5;u13;strange');
    expect(cardItem({ defindex: 378, cls: 'quality11', title: 'Strange Team Captain' }).sku).toBe('378;11');
  });

  it('keeps a class/title disagreement in the parser report (quality-mismatch is a guess code)', () => {
    const html =
      '<!DOCTYPE html>\n<!-- saved from url=(0025)https://scrap.tf/buy/hats -->\n<html><head><title>Hats</title></head><body id="pid-buy-hats">' +
      '<div data-appid="440" data-defindex="378" data-item-value="90" class="item hoverable quality6 app440" data-title="Unusual Team Captain" data-content="Level 10"><div class="item-value-indicator">10 ref</div></div></body></html>';
    const r = parseScrapTfHtml(html, schema, { diagnostics: true });
    expect(r.items[0]!.sku).toBe('378;6');
    expect(r.diagnostics!.items.map((i) => i.warnings.map(warningCode))).toEqual([['quality-mismatch']]);
  });
});

describe('F75: strange parts on a copy nothing marks Strange are refused', () => {
  it('refuses an Unusual hat whose tooltip lists a part but whose class and title say nothing of Strange', () => {
    const it = cardItem({ defindex: 378, cls: 'quality5', title: 'Burning Flames Team Captain', style: BURNING, content: 'Level 10<br/>(Damage Dealt: 5)' });
    expect(it.sku).toBeNull();
    expect(codes(it)).toContain('strange-conflict');
    expect(IMPORT_REFUSAL_CODES).toContain('strange-conflict');
  });

  it('keeps parts on an elevated Strange copy', () => {
    expect(cardItem({ defindex: 378, cls: 'quality5 quality11', title: 'Strange Burning Flames Team Captain', style: BURNING, content: 'Points Scored: 3<br/>(Damage Dealt: 5)' })).toMatchObject({
      sku: '378;5;u13;strange',
      special: { parts: ['Damage Dealt'] },
    });
  });
});

describe('F11: a cosmetic\'s "Kills" is a strange part', () => {
  const captain = (content: string) => cardItem({ defindex: 378, cls: 'quality11', title: 'Strange Team Captain', content });

  it('reads Damage Dealt, Dominations and Kills on a strange hat', () => {
    const it = captain('Points Scored: 12<br/>(Damage Dealt: 1)<br/>(Dominations: 0)<br/>(Kills: 5)');
    expect(it.sku).toBe('378;11');
    expect(it.special.parts).toEqual(['Damage Dealt', 'Dominations', 'Kills']);
    expect(captain('Points Scored: 12<br/>(Kills: 5)').special.parts).toEqual(['Kills']);
    // No counter line at all: a hat's counter is still Points Scored.
    expect(captain('(Kills: 5)').special.parts).toEqual(['Kills']);
  });

  it("keeps a weapon's Kills and a medi gun's Kill Assists as their own counters", () => {
    const rl = cardItem({ defindex: 205, cls: 'quality11', title: 'Strange Rocket Launcher', content: 'Kills: 3021<br/>(Damage Dealt: 1)' });
    expect(rl.special.parts).toEqual(['Damage Dealt']);
    const kritz = cardItem({ defindex: 35, cls: 'quality11', title: 'Strange Kritzkrieg', content: 'Ubers: 112<br/>(Kill Assists: 50)' });
    expect(kritz.special.parts).toEqual([]);
  });

  it("matches TF2.GG's Damage Dealt + Dominations + Kills order on such a hat", () => {
    const it = captain('Points Scored: 12<br/>(Damage Dealt: 1)<br/>(Dominations: 0)<br/>(Kills: 5)');
    const order = makeListing({ sku: '378;11', baseSku: '378;11', special: special({ parts: ['Damage Dealt', 'Dominations', 'Kills'] }), lastEventAt: T0 });
    const ctx = matchContext(DEFAULT_SETTINGS, T0);
    const c = classifyOrder(order, { baseSku: '378;11', special: it.special }, ctx);
    expect(c.eligible).toBe(true);
    expect(c.flags).not.toContain('attribute-specific');
    // A Kills-only copy is not clean: a generic order notes its extras.
    const generic = makeListing({ sku: '378;11', baseSku: '378;11', lastEventAt: T0 });
    expect(classifyOrder(generic, { baseSku: '378;11', special: captain('Points Scored: 12<br/>(Kills: 5)').special }, ctx).flags).toContain('has-extras');
  });
});
