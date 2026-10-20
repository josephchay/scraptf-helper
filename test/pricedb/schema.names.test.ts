import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService, parseItemUrl } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { canonical } from '../../src/shared/sku';
import { T0, fixture, makeDeps, schemaRoute, type TestDeps } from './helpers';

/** Names returned live by sku.pricedb.io /api/sku/{sku} on 2026-10-14 (golden-names.json, sku-lookups.json). */
function liveGolden(): [string, string][] {
  const out = new Map<string, string>();
  for (const [sku, v] of Object.entries(fixture<Record<string, { name: string }>>('golden-names.json'))) out.set(sku, v.name);
  for (const v of Object.values(fixture<Record<string, { data: { sku: string; name: string } }>>('sku-lookups.json'))) {
    out.set(v.data.sku, v.data.name);
  }
  return [...out];
}

/** Further cases derived from the getName rules (and PriceDB names where they agree). */
const DERIVED: [string, string][] = [
  ['1071;11', 'Strange Golden Frying Pan'],
  ['1000;11;kt-2', 'Strange Specialized Killstreak Festive Axtinguisher'],
  ['190;0', 'Normal Bat'],
  ['5021;6', 'Mann Co. Supply Crate Key'],
  ['5002;6', 'Refined Metal'],
  ['15000;15;u701;w1;pk14;strange', 'Strange Hot Night Owl Sniper Rifle (Factory New)'],
  ['1015;5;u3010', 'Mega Strike Taunt: The Shred Alert'],
  ['378;6;strange', 'Strange Unique Team Captain'],
  ['378;5', 'Unusual Team Captain'],
  ['378;6;untradable', 'Non-Tradable Team Captain'],
  ['378;5;u13;uncraftable', 'Non-Craftable Burning Flames Team Captain'],
  ['6523;6;uncraftable;kt-2;td-1013', 'Non-Craftable Specialized Killstreak Ham Shank Kit'],
  ['20002;6;kt-2;td-1013;od-6523;oq-6', 'Specialized Killstreak Ham Shank Kit Fabricator'],
  ['5734;6;c82', 'Mann Co. Supply Munition #82'],
  ['5068;6;c30', 'Salvaged Mann Co. Supply Crate #30'],
  ['1178;15;w1;pk390;kt-3;festive', "Festivized Professional Killstreak Dragon Slayer Dragon's Fury (Factory New)"],
  ['1151;11;w3;pk417;kt-2;festive', 'Strange Festivized Specialized Killstreak Team Serviced Iron Bomber (Field-Tested)'],
  ['15002;15;w1;pk11;kt-2;festive', 'Festivized Specialized Killstreak Night Terror Scattergun (Factory New)'],
  ['161;6', 'The Big Kill'],
  ['655;11', 'Strange Spirit of Giving'],
];

/** SKUs whose name intentionally does not resolve back to the same SKU. */
const NOT_ROUND_TRIP: Record<string, string> = {
  // RED/BLU twins resolve to the lower (canonical) id.
  '378;5;u361': '378;5;u360',
  // "Strange Night Owl ..." is also the 11-primary form; PriceDB prefers that one.
  '15000;15;w1;pk14;strange': '15000;11;w1;pk14',
  // A War Paint without its paintkit cannot be told apart from the generic War Paint.
  '16105;15;w3': '9536;15;w3',
};

let deps: TestDeps;
let svc: SchemaService;

beforeAll(async () => {
  deps = makeDeps(schemaRoute());
  svc = createSchemaService(deps);
  await svc.init();
});

describe('nameForSku (port of node-tf2-schema getName)', () => {
  const golden = liveGolden();

  it('has a large live golden set', () => {
    expect(golden.length).toBeGreaterThanOrEqual(40);
  });

  it.each(golden)('%s -> %s (live sku.pricedb.io)', (sku, name) => {
    expect(svc.nameForSku(sku)).toBe(name);
  });

  it.each(DERIVED)('%s -> %s', (sku, name) => {
    expect(svc.nameForSku(sku)).toBe(name);
  });

  it('accepts out-of-order SKUs', () => {
    expect(svc.nameForSku('205;11;kt-3;australium')).toBe('Strange Professional Killstreak Australium Rocket Launcher');
    expect(svc.nameForSku(' 15000;15;pk14;w1 ')).toBe('Night Owl Sniper Rifle (Factory New)');
  });

  it('prefers names learned from the backpack.tf feed', () => {
    deps.repo.upsertBptfNames([{ sku: '378;6', name: 'Team Captain', marketName: 'The Team Captain', lastSeen: T0 }]);
    expect(svc.nameForSku('378;6')).toBe('Team Captain');
    deps.repo.upsertBptfNames([{ sku: '378;6', name: 'The Team Captain', marketName: 'The Team Captain', lastSeen: T0 + 1 }]);
  });

  it('uses the learned name of the base SKU for a painted copy (bp.tf names are keyed without paint)', () => {
    deps.repo.upsertBptfNames([{ sku: '378;6', name: 'Team Captain', marketName: null, lastSeen: T0 + 10 }]);
    const pink = 16738740;
    const painted = svc.nameForSku(`378;6;p${pink}`);
    expect(painted.startsWith('Team Captain (Paint: ')).toBe(true);
    expect(painted).not.toContain(String(pink));
  });

  it('falls back to the PriceDB name, then the SKU, for unknown items', () => {
    expect(svc.nameForSku('999999;6')).toBe('999999;6');
    deps.repo.upsertPricedb([{ sku: '999998;6', name: 'Brand New Hat', buyKeys: 0, buyScrap: 9, sellKeys: 0, sellScrap: 12, time: 1, fetchedAt: T0 }]);
    expect(svc.nameForSku('999998;6')).toBe('Brand New Hat');
    expect(svc.nameForSku('not a sku')).toBe('not a sku');
  });

  it('returns the SKU while the schema is not loaded', () => {
    const cold = createSchemaService(makeDeps(schemaRoute()));
    expect(cold.nameForSku('378;6')).toBe('378;6');
    expect(cold.resolve('Team Captain')).toBeNull();
    expect(cold.search('team', 5)).toEqual([]);
  });
});

describe('baseNameForSku and marketHashName', () => {
  it('gives the plain item name', () => {
    expect(svc.baseNameForSku('205;11;australium;kt-3')).toBe('Rocket Launcher');
    expect(svc.baseNameForSku('378;5;u13')).toBe('Team Captain');
    expect(svc.baseNameForSku('15000;15;u701;w1;pk14')).toBe('Sniper Rifle');
    expect(svc.baseNameForSku('5049;6')).toBe('Festive Winter Crate Key');
    expect(svc.baseNameForSku('999999;6')).toBe('999999;6');
  });

  it.each([
    ['30177;6', 'Hong Kong Cone'],
    ['30177;5;u13', 'Unusual Hong Kong Cone'],
    ['30177;5;u13;strange', 'Strange Unusual Hong Kong Cone'],
    ['205;11;australium;kt-3', 'Strange Professional Killstreak Australium Rocket Launcher'],
    ['15000;15;w1;pk14', 'Night Owl Sniper Rifle (Factory New)'],
    ['15000;15;u701;w1;pk14', 'Unusual Night Owl Sniper Rifle (Factory New)'],
    ['5022;6;c1', 'Mann Co. Supply Crate Series #1'],
    ['20000;6;td-103;od-6522;oq-6', 'Camera Beard Strangifier Chemistry Set Series #1'],
    ['1015;5;u3010', 'Unusual Taunt: The Shred Alert'],
  ])('SCM name of %s is %s', (sku, name) => {
    expect(svc.marketHashName(sku)).toBe(name);
  });

  it('is null for non-craftable, non-tradable and unknown items', () => {
    expect(svc.marketHashName('200;6;uncraftable')).toBeNull();
    expect(svc.marketHashName('378;6;untradable')).toBeNull();
    expect(svc.marketHashName('999999;6')).toBeNull();
  });

  it('prefers the learned backpack.tf market name', () => {
    deps.repo.upsertBptfNames([{ sku: '30177;5;u14', name: 'Scorching Flames Hong Kong Cone', marketName: 'Unusual Hong Kong Cone', lastSeen: T0 }]);
    expect(svc.marketHashName('30177;5;u14')).toBe('Unusual Hong Kong Cone');
  });
});

describe('resolve', () => {
  const all = [...liveGolden(), ...DERIVED];

  it.each(all)('round-trips %s through its name', (sku) => {
    const name = svc.nameForSku(sku);
    const r = svc.resolve(name);
    expect(r, name).not.toBeNull();
    expect(r!.sku).toBe(NOT_ROUND_TRIP[sku] ?? canonical(sku));
    expect(r!.match).toBe('exact');
  });

  it('resolves the real backpack.tf-style names in the PriceDB list', () => {
    const rows = fixture<{ items: { sku: string; name: string }[] }>('autob-items.json').items;
    const misses: string[] = [];
    for (const row of rows) {
      if (row.sku.includes(';255')) continue; // invalid quality rows
      const r = svc.resolve(row.name);
      const want = canonical(row.sku);
      // The stale 15+strange skin form shares its name with the 11-primary form (§4.2).
      const alt = /;15;.*;strange/.test(row.sku) ? canonical(row.sku.replace(';15;', ';11;').replace(';strange', '')) : null;
      if (r?.sku !== want && r?.sku !== alt) misses.push(`${row.sku} "${row.name}" -> ${r?.sku}`);
    }
    expect(misses).toEqual([]);
  });

  it('accepts SKUs and canonicalises them', () => {
    const r = svc.resolve('205;11;kt-3;australium')!;
    expect(r).toMatchObject({
      sku: '205;11;australium;kt-3',
      name: 'Strange Professional Killstreak Australium Rocket Launcher',
      match: 'sku',
      category: 'killstreaks',
      warnings: [],
    });
    expect(r.skuObject).toMatchObject({ defindex: 205, quality: 11, australium: true, killstreak: 3 });
  });

  it('maps a BLU effect id to its RED twin with a warning', () => {
    const r = svc.resolve('378;5;u361')!;
    expect(r.sku).toBe('378;5;u360');
    expect(r.warnings.join(' ')).toContain('BLU twin');
  });

  it('warns about unknown items and effects in SKUs', () => {
    expect(svc.resolve('999999;6')!.warnings[0]).toContain('not in the item schema');
    expect(svc.resolve('378;5;u99999')!.warnings.join(' ')).toContain('Unknown unusual effect');
    expect(svc.resolve('378;5')!.warnings.join(' ')).toContain('Unusual without an effect');
  });

  it.each([
    ['https://marketplace.tf/items/tf2/30177;5;u13', '30177;5;u13'],
    ['https://marketplace.tf/items/tf2/205%3B11%3Bkt-3%3Baustralium', '205;11;australium;kt-3'],
    ['https://pricedb.io/api/graph/5021;6', '5021;6'],
    ['https://backpack.tf/stats/Unusual/Team%20Captain/Tradable/Craftable/13', '378;5;u13'],
    ['https://backpack.tf/stats/Strange/Australium%20Rocket%20Launcher/Tradable/Craftable', '205;11;australium'],
    ['https://backpack.tf/stats/Unique/Scattergun/Tradable/Non-Craftable', '200;6;uncraftable'],
    ['https://backpack.tf/stats/Strange%20Unusual/Team%20Captain/Tradable/Craftable/13', '378;5;u13;strange'],
    ['https://backpack.tf/stats/Unique/Mann%20Co.%20Supply%20Crate/Tradable/Craftable/11', '5041;6;c11'],
    ['https://backpack.tf/stats/Unique/Strangifier/Tradable/Craftable/378', '6522;6;td-378'],
    ['https://backpack.tf/stats/Unique/Killstreak%20Kit/Tradable/Non-Craftable/3-205', '6526;6;uncraftable;kt-3;td-205'],
    ['https://backpack.tf/stats/Decorated%20Weapon/Night%20Owl%20%7C%20Sniper%20Rifle%20(Factory%20New)/Tradable/Craftable/701', '15000;15;u701;w1;pk14'],
    [
      'https://next.backpack.tf/stats?item=Rocket%20Launcher&quality=Strange&australium=1&killstreakTier=3&sheen=-1&killstreaker=-1',
      '205;11;australium;kt-3',
    ],
    ['https://next.backpack.tf/stats?item=Team%20Captain&quality=Unusual&priceindex=13&craftable=0', '378;5;u13;uncraftable'],
    ['https://next.backpack.tf/stats?item=Sniper%20Rifle&quality=Decorated%20Weapon&wearTier=Factory%20New&texture=Night%20Owl', '15000;15;w1;pk14'],
  ])('resolves %s', (url, sku) => {
    const r = svc.resolve(url);
    expect(r?.sku).toBe(sku);
    expect(r?.warnings).toEqual([]);
  });

  it('ignores other URLs', () => {
    expect(parseItemUrl('https://example.com/items/tf2/5021;6')).toBeNull();
    expect(parseItemUrl('https://marketplace.tf/items/tf2/not-a-sku')).toBeNull();
    expect(svc.resolve('https://backpack.tf/premium/search')).toBeNull();
  });

  it('uses learned backpack.tf names first', () => {
    deps.repo.upsertBptfNames([{ sku: '30177;5;u3001', name: 'Odd Feed Name', marketName: null, lastSeen: T0 }]);
    expect(svc.resolve('odd feed name')).toMatchObject({ sku: '30177;5;u3001', match: 'exact' });
  });

  it.each([
    ['The Team Captain', '378;6'],
    ['team captain', '378;6'],
    ['Unique Team Captain', '378;6'],
    ['Uncraftable Team Captain', '378;6;uncraftable'],
    ['Killstreak Non-Craftable Ham Shank', '1013;6;uncraftable;kt-1'],
    ['Strange(e) Night Owl Sniper Rifle (Factory New)', '15000;15;w1;pk14;strange'],
    ['Strange Unusual Burning Flames Team Captain', '378;5;u13;strange'],
    ['Searing Stove Team Captain', '378;5;u360'],
    ['Mann Co. Supply Crate Series #11', '5041;6;c11'],
    ['Select Reserve Mann Co. Supply Crate', '5660;6;c60'],
    ['Scorched Crate', '5078;6;c46'],
    ['Professional Killstreak Kit', '6526;6;kt-3'],
    ['Team Captain (Paint: Pink as Hell)', '378;6;p16738740'],
    ['Rocket Launcher', '205;6'],
    ['Shotgun', '199;6'],
    ['Name Tag', '5020;6'],
    ['Genuine Red-Tape Recorder', '831;1'],
    ['Team Cäptain', '378;6'],
    ['Strange   Rocket\tLauncher', '205;11'],
  ])('parses "%s" as %s', (text, sku) => {
    expect(svc.resolve(text)?.sku).toBe(sku);
  });

  it('matches approximate names as fuzzy with a warning', () => {
    const r = svc.resolve('Strange Rocket Launcer')!;
    expect(r.sku).toBe('205;11');
    expect(r.match).toBe('fuzzy');
    expect(r.warnings[0]).toContain('closest match');
  });

  it('returns null for nonsense and empty input', () => {
    expect(svc.resolve('')).toBeNull();
    expect(svc.resolve('   ')).toBeNull();
    expect(svc.resolve('qwertyuiop asdfghjkl')).toBeNull();
    expect(svc.resolve('x'.repeat(500))).toBeNull();
  });

  it('warns about unknown paints and missing crate series', () => {
    expect(svc.resolve('Team Captain (Paint: Hot Pink)')!.warnings.join(' ')).toContain('Unknown paint');
    expect(svc.resolve('Mann Co. Supply Crate')!.warnings.join(' ')).toContain('series number missing');
  });
});

describe('categoryForSku and lookups', () => {
  it.each([
    ['378;6', 'hats'],
    ['378;5;u13', 'unusuals'],
    ['205;11', 'stranges'],
    ['205;6;kt-1', 'killstreaks'],
    ['15000;15;w1;pk14', 'skins'],
    ['16105;15;w1;pk105', 'skins'],
    ['30920;6', 'taunts'],
    ['205;6', 'weapons'],
    ['5021;6', 'other'],
    ['999999;6', 'other'],
    ['not a sku', 'other'],
  ] as const)('%s is %s', (sku, cat) => {
    expect(svc.categoryForSku(sku)).toBe(cat);
  });

  it('looks up effects, paints and paintkits', () => {
    expect(svc.effectIdByName('searing stove')).toBe(360);
    expect(svc.effectIdByName('Nope')).toBeNull();
    expect(svc.canonicalEffectId(361)).toBe(360);
    expect(svc.canonicalEffectId(12345)).toBe(12345);
    expect(svc.effectName(2001)).toBeNull();
    expect(svc.paintByDecimal(12073019)?.name).toBe('Team Spirit');
    expect(svc.paintDecimalByHex('#B8383B')).toBe(12073019);
    expect(svc.paintDecimalByHex('b8383b')).toBe(12073019);
    // BLU hex of a team paint maps to its RED decimal.
    expect(svc.paintDecimalByHex('#384248')).toBe(4732984);
    expect(svc.paintDecimalByHex('28394D')).toBe(6637376);
    // #5885A2 is both Legacy Paint (RED) and Team Spirit (BLU): the exact paint wins.
    expect(svc.paintDecimalByHex('#5885A2')).toBe(5801378);
    expect(svc.paintDecimalByHex('zzz')).toBeNull();
    expect(svc.paintkitName(14)).toBe('Night Owl');
    expect(svc.paintkitIdByName('night owl')).toBe(14);
    expect(svc.itemByDefindex(378)?.itemName).toBe('Team Captain');
    expect(svc.itemByDefindex(1)?.itemName).toBe('Bottle');
  });
});
