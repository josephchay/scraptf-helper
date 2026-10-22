// 0.9 (#22): a scrap.tf card's tooltip effect read for the card's kind of item. Valve renamed the hat effect Northern
// Nights to Polar Prism (408); "Northern Nights" is now a taunt effect's name (3221). A hat card that still says
// "Northern Nights" is 408, and agrees with its 408 particle image; a taunt card with the same words stays 3221.
// Real schema (test/fixtures/pricedb/schema-subset.json); synthetic cards; nothing is fetched.

import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { parseScrapTfHtml, warningCode } from '../../src/service/import/scraptfHtml';
import type { ParsedScrapItem } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const TOOLTIP = '★ Unusual Effect: Northern Nights';

function cardItem(attrs: { defindex: number; title: string; style?: string }): ParsedScrapItem {
  const html =
    '<!DOCTYPE html>\n<!-- saved from url=(0025)https://scrap.tf/buy/hats -->\n<html><head><title>Hats</title></head><body id="pid-buy-hats">' +
    `<div data-appid="440" data-defindex="${attrs.defindex}" data-item-value="900" class="item hoverable quality5 app440" style="${attrs.style ?? 'opacity:1;'}" data-title="${attrs.title}" data-content="${TOOLTIP}"><div class="item-value-indicator">10 keys</div></div>` +
    '</body></html>';
  const items = parseScrapTfHtml(html, schema).items;
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe('0.9 (#22): "Northern Nights" in a card tooltip', () => {
  it('on a hat with no particle image: 408 (Polar Prism)', () => {
    const it = cardItem({ defindex: 378, title: 'Unusual Team Captain' });
    expect(it.sku).toBe('378;5;u408');
  });

  it("on a hat with the 408 particle image: 408, and the image and the tooltip agree (no effect-mismatch)", () => {
    const it = cardItem({ defindex: 378, title: 'Unusual Team Captain', style: "opacity:1;background-image:url('/img/particles_440/408_380x380.png');" });
    expect(it.sku).toBe('378;5;u408');
    expect(it.warnings.map(warningCode)).not.toContain('effect-mismatch');
  });

  it('on a taunt: 3221, the taunt effect of that name', () => {
    const it = cardItem({ defindex: 1015, title: 'Unusual Taunt: The Shred Alert' });
    expect(it.sku).toBe('1015;5;u3221');
  });
});

/** A card with no tooltip effect line and no particle image: the effect comes from its title alone (parseName). */
function titleItem(attrs: { defindex: number; title: string; cls?: string; bank?: string }): ParsedScrapItem {
  const bank = attrs.bank ?? 'hats';
  const html =
    `<!DOCTYPE html>\n<!-- saved from url=(0025)https://scrap.tf/buy/${bank} -->\n<html><head><title>Bank</title></head><body id="pid-buy-${bank}">` +
    `<div data-appid="440" data-defindex="${attrs.defindex}" data-item-value="900" class="item hoverable ${attrs.cls ?? 'quality5'} app440" style="opacity:1;" data-title="${attrs.title}"><div class="item-value-indicator">10 keys</div></div>` +
    '</body></html>';
  const items = parseScrapTfHtml(html, schema).items;
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe("0.9 (#22): the effect in a card's title (scraptfHtml's parseName reads it for the item's kind)", () => {
  it('"Northern Nights Team Captain" is 408 (Polar Prism), as "Polar Prism Team Captain" is', () => {
    expect(titleItem({ defindex: 378, title: 'Northern Nights Team Captain' }).sku).toBe('378;5;u408');
    expect(titleItem({ defindex: 378, title: 'Polar Prism Team Captain' }).sku).toBe('378;5;u408');
  });

  it('"Northern Nights Taunt: The Shred Alert" stays 3221, the taunt effect of that name', () => {
    expect(titleItem({ defindex: 1015, title: 'Northern Nights Taunt: The Shred Alert' }).sku).toBe('1015;5;u3221');
  });

  it('a hat effect no other kind uses reads as before (Burning Flames is 13)', () => {
    expect(titleItem({ defindex: 378, title: 'Burning Flames Team Captain' }).sku).toBe('378;5;u13');
  });

  it("a skin's own weapon effect before its paintkit still reads as that weapon effect (Hot is 701)", () => {
    const it = titleItem({ defindex: 15000, title: 'Hot Night Owl Sniper Rifle (Factory New)', cls: 'quality15', bank: 'skins' });
    expect(it.sku).toBe('15000;5;u701;w1;pk14');
  });
});
