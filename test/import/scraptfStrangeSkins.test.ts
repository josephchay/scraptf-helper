// 0.7.1 (P2): skins keyed the way backpack.tf buyers key them, whatever quality class scrap.tf gives the
// card. A strange skin without an effect is Strange (11) with no second quality ("15000;11;w2;pk14"); an
// unusual skin is Unusual (5) plus its effect, and strange too when it is ("...;5;u701;w1;pk14;strange"; 0.7.4,
// F08: 0.7.3 keyed it Decorated plus the effect, a form no backpack.tf order uses); killstreak and festive stay.
// The old "15;...;strange" form for a plain strange skin matched no order.
// Synthetic cards and rows; nothing is fetched.

import { describe, expect, it } from 'vitest';
import { parseScrapTfHtml, warningCode } from '../../src/service/import';
import { fromString } from '../../src/shared/sku';
import type { ParsedScrapItem } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const schema = createStubSchema();

function card(attrs: Record<string, string>): string {
  const a = Object.entries({ 'data-appid': '440', 'data-defindex': '15000', 'data-item-value': '120', ...attrs })
    .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
    .join(' ');
  return `<div ${a}><div class="item-value-indicator">13.33 ref</div></div>`;
}

function page(body: string, url = 'https://scrap.tf/buy/skins'): string {
  return `<!DOCTYPE html>\n<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n<html><head><title>Skins</title></head><body>${body}</body></html>`;
}

function one(attrs: Record<string, string>): ParsedScrapItem {
  const r = parseScrapTfHtml(page(card(attrs)), schema);
  expect(r.items).toHaveLength(1);
  return r.items[0]!;
}

const HOT = "opacity:1;background-image:url('/img/particles_440/701_380x380.png');";

describe('strange and unusual skins on cards, every quality class (P2)', () => {
  it.each(['quality15', 'quality15 quality11', 'quality11 quality15', 'quality11'])('class "%s"', (q) => {
    const plain = one({ class: `item hoverable ${q} app440`, 'data-title': 'Strange Night Owl Sniper Rifle (Minimal Wear)' });
    expect(plain.sku).toBe('15000;11;w2;pk14');
    expect(plain.skuObject).toEqual(fromString('15000;11;w2;pk14'));
    expect(plain.skuObject?.quality2).toBeNull();
    const unusual = one({ class: `item hoverable ${q} app440`, style: HOT, 'data-title': 'Strange Hot Night Owl Sniper Rifle (Factory New)' });
    expect(unusual.sku).toBe('15000;5;u701;w1;pk14;strange');
    expect(unusual.skuObject).toMatchObject({ quality: 5, quality2: 11, effect: 701 });
  });

  it('an Unusual class with the effect is Unusual plus the effect, strange when the class or title says so', () => {
    expect(one({ class: 'item quality5 app440', style: HOT, 'data-title': 'Hot Night Owl Sniper Rifle (Factory New)' }).sku).toBe('15000;5;u701;w1;pk14');
    expect(one({ class: 'item quality5 quality11 app440', style: HOT, 'data-title': 'Hot Night Owl Sniper Rifle (Factory New)' }).sku).toBe('15000;5;u701;w1;pk14;strange');
  });

  it('a skin that is not strange is Decorated, whatever its class', () => {
    expect(one({ class: 'item quality15 app440', 'data-title': 'Night Owl Sniper Rifle (Minimal Wear)' }).sku).toBe('15000;15;w2;pk14');
    expect(one({ class: 'item quality6 app440', 'data-title': 'Night Owl Sniper Rifle (Minimal Wear)' }).sku).toBe('15000;15;w2;pk14');
  });

  it('keeps killstreak and festive on a strange skin', () => {
    const it = one({ class: 'item quality15 killstreak2 app440', 'data-title': 'Strange Festivized Specialized Killstreak Night Owl Sniper Rifle (Minimal Wear)' });
    expect(it.skuObject).toMatchObject({ quality: 11, quality2: null, killstreak: 2, festive: true, paintkit: 14, wear: 2 });
  });

  it('an Unusual card that shows no effect is still refused, never keyed as the plain or strange skin', () => {
    for (const q of ['quality5', 'quality5 quality11']) {
      const it = one({ class: `item ${q} app440`, 'data-title': 'Strange Night Owl Sniper Rifle (Minimal Wear)' });
      expect(it.sku, q).toBeNull();
      expect(it.warnings.map(warningCode), q).toContain('unusual-without-effect');
    }
  });

  it('leaves weapons that are not skins as they were', () => {
    const it = one({ 'data-defindex': '208', class: 'item quality11 app440', 'data-title': 'Strange Flame Thrower' });
    expect(it.sku).toBe('208;11');
    const elevated = one({ 'data-defindex': '208', class: 'item quality6 quality11 app440', 'data-title': 'Strange Unique Flame Thrower' });
    expect(elevated.sku).toBe('208;6;strange');
  });
});

describe('strange skins on the /items list (P2)', () => {
  const list = (quality: string, title: string) =>
    page(
      `<table><thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead><tbody>` +
        `<tr data-quality="${quality}" data-defindex="15000"><td></td><td>${title}</td><td>13.33 refined</td><td>12 refined</td><td><div title="1/3"></div></td></tr>` +
        `</tbody></table>`,
      'https://scrap.tf/items',
    );

  it.each(['11', '15'])('data-quality %s', (q) => {
    const r = parseScrapTfHtml(list(q, 'Strange Night Owl Sniper Rifle (Minimal Wear)'), schema);
    expect(r.items.map((i) => i.sku)).toEqual(['15000;11;w2;pk14']);
  });

  it('a plain skin row is Decorated', () => {
    expect(parseScrapTfHtml(list('15', 'Night Owl Sniper Rifle (Minimal Wear)'), schema).items[0]!.sku).toBe('15000;15;w2;pk14');
  });
});
