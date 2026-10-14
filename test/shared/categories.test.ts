import { describe, expect, it } from 'vitest';
import { categorize, categoryOfSkuOnly, isWarPaintDefindex } from '../../src/shared/categories';
import type { CategoryItemInfo } from '../../src/shared/categories';
import { fromString } from '../../src/shared/sku';
import type { Category } from '../../src/shared/types';

// Schema facts as sku.pricedb.io / GetSchemaItems report them.
const HAT: CategoryItemInfo = { itemClass: 'tf_wearable', slot: 'misc', craftClass: 'hat', itemName: 'Team Captain' };
const MISC_NO_CRAFT: CategoryItemInfo = { itemClass: 'tf_wearable', slot: 'misc', craftClass: '', itemName: "Hephaistos' Handcraft" };
const ROCKET: CategoryItemInfo = { itemClass: 'tf_weapon_rocketlauncher', slot: 'primary', craftClass: '', itemName: 'Rocket Launcher' };
const SNIPER: CategoryItemInfo = { itemClass: 'tf_weapon_sniperrifle', slot: 'primary', craftClass: '', itemName: 'Sniper Rifle' };
const SHIELD: CategoryItemInfo = { itemClass: 'tf_wearable_demoshield', slot: 'secondary', craftClass: 'weapon', itemName: "Chargin' Targe" };
const WATCH: CategoryItemInfo = { itemClass: 'tf_weapon_invis', slot: 'pda2', craftClass: 'weapon', itemName: 'Invis Watch' };
const SAPPER: CategoryItemInfo = { itemClass: 'tf_weapon_sapper', slot: 'building', craftClass: 'weapon', itemName: 'Sapper' };
const PDA: CategoryItemInfo = { itemClass: 'tf_weapon_pda_engineer_build', slot: 'pda', craftClass: '', itemName: 'Construction PDA' };
const TAUNT: CategoryItemInfo = { itemClass: 'no_entity', slot: 'taunt', craftClass: null, itemName: 'Taunt: Panzer Pants' };
const KEY: CategoryItemInfo = { itemClass: 'tool', slot: null, craftClass: 'tool', itemName: 'Mann Co. Supply Crate Key' };
const KIT: CategoryItemInfo = { itemClass: 'tool', slot: null, craftClass: null, itemName: 'Kit' };
const FABRICATOR: CategoryItemInfo = { itemClass: 'tool', slot: null, craftClass: 'tool', itemName: 'Fabricator' };
const WAR_PAINT: CategoryItemInfo = { itemClass: 'tool', slot: null, craftClass: null, itemName: 'War Paint' };
const CRATE: CategoryItemInfo = { itemClass: 'supply_crate', slot: null, craftClass: 'supply_crate', itemName: 'Mann Co. Supply Crate' };
const NOISE_MAKER: CategoryItemInfo = { itemClass: 'tf_wearable', slot: 'action', craftClass: '', itemName: 'Noise Maker - Gremlin' };
const STRANGIFIER: CategoryItemInfo = { itemClass: 'tool', slot: null, craftClass: null, itemName: 'Strangifier' };
const METAL: CategoryItemInfo = { itemClass: 'craft_item', slot: null, craftClass: 'craft_bar', itemName: 'Refined Metal' };

describe('categorize', () => {
  const cases: [string, string, CategoryItemInfo | null, Category][] = [
    // unusuals beat everything
    ['unusual hat', '378;5;u13', HAT, 'unusuals'],
    ['strange unusual hat', '378;5;u13;strange', HAT, 'unusuals'],
    ['unusual taunt', '1196;5;u3043', TAUNT, 'unusuals'],
    ['unusual killstreak weapon', '205;5;u703;kt-3', ROCKET, 'unusuals'],
    ['unusual skin', '15000;15;u701;w1;pk14', SNIPER, 'unusuals'],
    ['strange unusual war paint', '16309;5;u703;w2;pk309;strange', WAR_PAINT, 'unusuals'],
    // generic any-effect unusual bases (quality 5, no particle) are unusuals, not hats or taunts
    ['generic unusual hat', '378;5', HAT, 'unusuals'],
    ['generic strange unusual hat', '378;5;strange', HAT, 'unusuals'],
    ['generic uncraftable unusual hat', '378;5;uncraftable', HAT, 'unusuals'],
    ['generic unusual taunt', '1196;5', TAUNT, 'unusuals'],
    ['generic unusual weapon', '205;5;kt-3', ROCKET, 'unusuals'],
    ['unusualifier (quality-5 tool with a target)', '9258;5;uncraftable;td-1196', { itemClass: 'tool', slot: null, craftClass: null, itemName: 'Unusualifier' }, 'other'],
    ['quality-5 tool without a target', '9258;5', { itemClass: 'tool', slot: null, craftClass: null, itemName: 'Unusualifier' }, 'other'],
    // skins
    ['decorated skin', '15000;15;w1;pk14', SNIPER, 'skins'],
    ['strange skin (11 form)', '15000;11;w2;pk14', SNIPER, 'skins'],
    ['strange killstreak skin', '15013;15;kt-3;w2;pk102;strange', ROCKET, 'skins'],
    ['wear only', '15000;6;w3', SNIPER, 'skins'],
    ['quality 15 without paintkit', '15000;15', SNIPER, 'skins'],
    ['war paint by defindex 16xxx', '16102;15;w1;pk102', WAR_PAINT, 'skins'],
    ['war paint by defindex 17xxx', '17442;15', WAR_PAINT, 'skins'],
    ['war paint by class and name', '9536;6', WAR_PAINT, 'skins'],
    ['war paint name under another defindex', '12345;6', WAR_PAINT, 'skins'],
    // taunts
    ['taunt', '1196;6', TAUNT, 'taunts'],
    ['strange taunt', '1196;11', TAUNT, 'taunts'],
    ['taunt with no slot', '1157;6', { itemClass: 'no_entity', slot: null, craftClass: null, itemName: 'Taunt: Kazotsky Kick' }, 'taunts'],
    ['taunt slot in capitals', '1157;6', { itemClass: 'no_entity', slot: 'TAUNT', craftClass: null }, 'taunts'],
    // killstreaks
    ['killstreak weapon', '205;6;kt-1', ROCKET, 'killstreaks'],
    ['strange pro ks australium', '205;11;australium;kt-3', ROCKET, 'killstreaks'],
    ['killstreak kit', '6526;6;uncraftable;kt-3;td-205', KIT, 'killstreaks'],
    ['fabricator', '20003;6;kt-3;td-205;od-6526;oq-6', FABRICATOR, 'killstreaks'],
    // stranges
    ['strange weapon', '205;11', ROCKET, 'stranges'],
    ['strange australium', '205;11;australium', ROCKET, 'stranges'],
    ['strange cosmetic', '378;11', HAT, 'stranges'],
    ['strange genuine (elevated)', '30177;1;strange', HAT, 'stranges'],
    ['strange festivized', '205;11;festive', ROCKET, 'stranges'],
    // hats
    ['unique hat', '378;6', HAT, 'hats'],
    ['vintage hat', '378;3', HAT, 'hats'],
    ['genuine hat', '30177;1', HAT, 'hats'],
    ['misc slot without craft class', '31000;6', MISC_NO_CRAFT, 'hats'],
    ['craft class hat without slot', '1;6', { itemClass: 'tf_wearable', slot: null, craftClass: 'hat' }, 'hats'],
    ['head slot', '1;6', { itemClass: 'tf_wearable', slot: 'head', craftClass: null }, 'hats'],
    ['painted hat', '378;6;p16738740', HAT, 'hats'],
    ['uncraftable hat', '378;6;uncraftable', HAT, 'hats'],
    // weapons
    ['unique weapon', '205;6', ROCKET, 'weapons'],
    ['festivized weapon', '205;6;festive', ROCKET, 'weapons'],
    ['wearable shield', '131;6', SHIELD, 'weapons'],
    ['watch', '30;6', WATCH, 'weapons'],
    ['sapper', '735;6', SAPPER, 'weapons'],
    ['pda', '25;6', PDA, 'weapons'],
    ['craft class weapon without slot', '1;6', { itemClass: 'saxxy', slot: null, craftClass: 'weapon' }, 'weapons'],
    // other
    ['key', '5021;6', KEY, 'other'],
    ['refined', '5002;6', METAL, 'other'],
    ['crate', '5041;6;c11', CRATE, 'other'],
    ['strangifier', '6522;6;td-205', STRANGIFIER, 'other'],
    ['noise maker (action slot)', '536;6', NOISE_MAKER, 'other'],
    ['no slot, no craft class', '1;6', { itemClass: 'tool', slot: null, craftClass: null }, 'other'],
  ];

  it.each(cases)('%s (%s)', (_label, sku, item, expected) => {
    expect(categorize(fromString(sku), item)).toBe(expected);
  });

  it('is case-insensitive and trims schema strings', () => {
    expect(categorize(fromString('378;6'), { itemClass: 'TF_WEARABLE', slot: ' Misc ', craftClass: null })).toBe('hats');
    expect(categorize(fromString('205;6'), { itemClass: 'x', slot: 'PRIMARY', craftClass: null })).toBe('weapons');
    expect(categorize(fromString('1;6'), { itemClass: 'x', slot: null, craftClass: 'HAT' })).toBe('hats');
    expect(categorize(fromString('1;6'), { itemClass: 'TOOL', slot: null, craftClass: null, itemName: ' war paint ' })).toBe('skins');
  });

  it('tolerates a schema row with unexpected types at runtime', () => {
    const weird = { itemClass: 5, slot: 7, craftClass: {} } as unknown as CategoryItemInfo;
    expect(categorize(fromString('378;6'), weird)).toBe('other');
    expect(categorize(fromString('378;11'), weird)).toBe('stranges');
  });

  it('falls back to the SKU-only classifier when the schema item is unknown', () => {
    for (const sku of ['378;5;u13', '15000;15;w1;pk14', '205;6;kt-1', '205;11', '378;6', '1196;6']) {
      expect(categorize(fromString(sku), null)).toBe(categoryOfSkuOnly(fromString(sku)));
    }
  });
});

describe('categoryOfSkuOnly', () => {
  it.each([
    ['378;5;u13', 'unusuals'],
    ['378;5;u13;strange', 'unusuals'],
    ['1196;5;u3043', 'unusuals'],
    ['15000;15;u701;w1;pk14', 'unusuals'],
    ['15000;15;w1;pk14', 'skins'],
    ['15000;11;w2;pk14', 'skins'],
    ['1;6;pk0', 'skins'],
    ['16102;15', 'skins'],
    ['17000;6', 'skins'],
    ['9536;6', 'skins'],
    ['205;6;kt-1', 'killstreaks'],
    ['6526;6;uncraftable;kt-3;td-205', 'killstreaks'],
    ['205;11', 'stranges'],
    ['378;6;strange', 'stranges'],
    ['378;6', 'other'],
    ['205;6', 'other'],
    ['5021;6', 'other'],
    ['378;5', 'unusuals'],
    ['378;5;strange', 'unusuals'],
    ['9258;5;uncraftable;td-1196', 'other'],
  ] as [string, Category][])('%s -> %s', (sku, expected) => {
    expect(categoryOfSkuOnly(fromString(sku))).toBe(expected);
  });

  it('ignores a zero effect', () => {
    expect(categoryOfSkuOnly({ ...fromString('378;6'), effect: 0 })).toBe('other');
    // Quality 5 alone still makes it the generic unusual base.
    expect(categoryOfSkuOnly({ ...fromString('378;5'), effect: 0 })).toBe('unusuals');
  });
});

describe('isWarPaintDefindex', () => {
  it.each([
    [9536, true],
    [16000, true],
    [16102, true],
    [16999, true],
    [17000, true],
    [17442, true],
    [17999, true],
    [15999, false],
    [18000, false],
    [15000, false],
    [5021, false],
  ])('%i -> %s', (defindex, expected) => {
    expect(isWarPaintDefindex(defindex)).toBe(expected);
  });
});
