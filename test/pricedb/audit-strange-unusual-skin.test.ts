// Audit schema-3: a strange unusual skin is keyed with strange as quality2. 0.7.4 (F08/F43/F69): Unusual (5)
// plus its effect, the form backpack.tf's buy orders use (1469 of 1477 unusual-skin orders in the live feed,
// 0 in the Decorated 15 form 0.7.3 used), so typed names, links and the saved-page import meet the orders.

import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { makeDeps, schemaRoute } from './helpers';

let svc: SchemaService;

beforeAll(async () => {
  svc = createSchemaService(makeDeps(schemaRoute()));
  await svc.init();
});

const NEXT = 'https://next.backpack.tf/stats?item=Sniper%20Rifle&wearTier=Well-Worn&texture=Night%20Owl';
const CLASSIC = (q: string): string => `https://backpack.tf/stats/${q}/Night%20Owl%20%7C%20Sniper%20Rifle%20(Well-Worn)/Tradable/Craftable/701`;

describe('strange unusual skins resolve to the 5 + strange form', () => {
  it.each([
    ['Strange Hot Night Owl Sniper Rifle (Well-Worn)', '15000;5;u701;w4;pk14;strange'],
    ['Strange Unusual Hot Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14;strange'],
    ['Strange Hot Professional Killstreak Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14;strange;kt-3'],
    ['Strange Professional Killstreak Hot Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14;strange;kt-3'],
  ])('"%s" -> %s', (text, sku) => {
    const r = svc.resolve(text);
    expect(r?.sku).toBe(sku);
    expect(r?.match).toBe('exact');
  });

  it('round-trips the bp.tf / import SKU through its name', () => {
    const sku = '15000;5;u701;w1;pk14;strange';
    expect(svc.resolve(svc.nameForSku(sku))?.sku).toBe(sku);
    expect(svc.marketHashName(sku)).toBe('Strange Unusual Night Owl Sniper Rifle (Factory New)');
  });

  it('suggests the live SKU first in search', () => {
    expect(svc.search('Strange Hot Night Owl Sniper Rifle (Well-Worn)', 5)[0]?.sku).toBe('15000;5;u701;w4;pk14;strange');
  });

  it.each([
    [`${NEXT}&quality=Strange&priceindex=701`, '15000;5;u701;w4;pk14;strange'],
    [`${NEXT}&quality=Unusual&elevatedQuality=Strange&priceindex=701`, '15000;5;u701;w4;pk14;strange'],
    [CLASSIC('Strange%20Unusual'), '15000;5;u701;w4;pk14;strange'],
    [CLASSIC('Unusual'), '15000;5;u701;w4;pk14'],
    [CLASSIC('Decorated%20Weapon'), '15000;5;u701;w4;pk14'],
    [`${NEXT}&quality=Strange&priceindex=0`, '15000;11;w4;pk14'],
  ])('URL %s -> %s', (url, sku) => {
    expect(svc.resolve(url)?.sku).toBe(sku);
  });

  it.each([
    ['Hot Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14'],
    ['Unusual Hot Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14'],
    ['Decorated Weapon Hot Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14'],
    ['Strange Night Owl Sniper Rifle (Factory New)', '15000;11;w1;pk14'],
    ['Night Owl Sniper Rifle (Factory New)', '15000;15;w1;pk14'],
    ['Strange(e) Night Owl Sniper Rifle (Factory New)', '15000;15;w1;pk14;strange'],
    ['Strange(e) Hot Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14;strange'],
    [
      'https://backpack.tf/stats/Decorated%20Weapon/Night%20Owl%20%7C%20Sniper%20Rifle%20(Factory%20New)/Tradable/Craftable/701',
      '15000;5;u701;w1;pk14',
    ],
    ['https://backpack.tf/stats/Strange%20Unusual/Team%20Captain/Tradable/Craftable/13', '378;5;u13;strange'],
    ['Strange Unusual Burning Flames Team Captain', '378;5;u13;strange'],
  ])('leaves "%s" as %s', (text, sku) => {
    expect(svc.resolve(text)?.sku).toBe(sku);
  });
});
