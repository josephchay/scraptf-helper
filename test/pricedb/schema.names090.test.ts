// 0.9 (#22): name parsing. Regression pins of names that read today (verified 2026-10-22 on the schema subset), and the
// type-aware effect alias: Valve renamed the hat effect Northern Nights to Polar Prism (408), and "Northern Nights" is
// now a taunt effect's name (3221), so the old name on a hat is 408 while on a taunt it stays 3221. Effects that share a
// name are twins only within one kind. Fixture schemas served by a fake HTTP route; nothing touches the network.

import { describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import { EFFECT_NAME_ALIASES, effectTypeForItem } from '../../src/service/connectors/schemaNames';
import type { SchemaItemRow, SchemaService } from '../../src/service/contracts';
import { PAINT_URL, SCHEMA_URL, fixture, makeDeps, res, schemaRoute, type Route } from './helpers';

async function service(route: Route = schemaRoute()): Promise<SchemaService> {
  const svc = createSchemaService(makeDeps(route));
  await svc.init();
  return svc;
}

type Particle = { id: number; name: string; [k: string]: unknown };
type Subset = { raw: { schema: { attribute_controlled_attached_particles: Particle[] } } };

/** The schema subset with its particle list changed by `fn` (a deep copy; the cached fixture is never touched). */
function mutated(fn: (particles: Particle[]) => Particle[]): Route {
  const copy = JSON.parse(JSON.stringify(fixture('schema-subset.json'))) as Subset;
  copy.raw.schema.attribute_controlled_attached_particles = fn(copy.raw.schema.attribute_controlled_attached_particles);
  return (url, opts) => {
    if (url === SCHEMA_URL) return res(copy, { etag: 'W/"mutated"' });
    if (url === PAINT_URL) return res(fixture('paint-list.json'));
    return schemaRoute()(url, opts);
  };
}

const sku = (svc: SchemaService, text: string): string | null => svc.resolve(text)?.sku ?? null;

describe('0.9 (#22): regression pins (resolve(text).sku, verified 2026-10-22)', () => {
  const PINS: [string, string][] = [
    ['Sizzling Aroma Team Captain', '378;5;u387'],
    ['Sizzling Team Captain', '378;5;u364'],
    ['Haunted Mist Taunt: The Shred Alert', '1015;5;u3205'],
    ['Haunted Team Captain', '378;13'],
    ['Haunted Ghosts Team Captain', '378;5;u8'],
    ['Haunted Ghosts Sniper Rifle (Factory New)', '201;15;w1;pk236'],
    ['Frostbite Team Captain', '378;5;u87'],
    ['Strange Unusual Frostbite Team Captain', '378;5;u87;strange'],
    ['Strange Part', '5999;6'],
    ['Strange Part: Heavies Killed', '6000;6'],
    ['Taunt: The Shred Alert Unusualifier', '9258;5;td-1015'],
    ['Unusual Taunt: The Shred Alert Unusualifier', '9258;5;td-1015'],
    ['Non-Tradable Non-Craftable Team Captain', '378;6;uncraftable;untradable'],
    ['Non-Craftable Non-Tradable Team Captain', '378;6;uncraftable;untradable'],
    ['Non-Craftable Non-Tradable Unusual Burning Flames Team Captain', '378;5;u13;uncraftable;untradable'],
    ['Strange(e) Hot Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14;strange'],
    ['Strange Unusual Hot Night Owl Sniper Rifle (Factory New)', '15000;5;u701;w1;pk14;strange'],
    ['Strange Decorated Night Owl Sniper Rifle (Factory New)', '15000;15;w1;pk14;strange'],
  ];

  it.each(PINS)('%s -> %s', async (text, expected) => {
    expect(sku(await service(), text)).toBe(expected);
  });

  it('a bare Unusualifier is the plain tool, with a warning about its missing target', async () => {
    const r = (await service()).resolve('Unusualifier');
    expect(r?.sku).toBe('9258;6');
    expect(r?.warnings.some((w) => /target/i.test(w))).toBe(true);
  });
});

describe('0.9 (#22): the type-aware effect alias on today\'s schema (408 "Polar Prism", 3221 "Northern Nights")', () => {
  it('reads "Northern Nights" on a hat as 408 (it was u3221) and on a taunt as 3221', async () => {
    const svc = await service();
    expect(EFFECT_NAME_ALIASES).toEqual([{ id: 408, names: ['Polar Prism', 'Northern Nights'] }]);
    expect(sku(svc, 'Northern Nights Team Captain')).toBe('378;5;u408');
    expect(sku(svc, 'Polar Prism Team Captain')).toBe('378;5;u408');
    expect(sku(svc, 'Northern Nights Taunt: The Shred Alert')).toBe('1015;5;u3221');
  });

  it('effectIdByName: typeless as before, typed per kind', async () => {
    const svc = await service();
    expect(svc.effectIdByName('Northern Nights')).toBe(3221);
    expect(svc.effectIdByName('northern nights', 'cosmetic')).toBe(408);
    expect(svc.effectIdByName('Northern Nights', 'taunt')).toBe(3221);
    expect(svc.effectIdByName('Polar Prism')).toBe(408);
    expect(svc.effectIdByName('Polar Prism', 'taunt')).toBe(408);
    expect(svc.effectIdByName('Burning Flames', 'cosmetic')).toBe(13);
    expect(svc.effectIdByName('No Such Effect', 'cosmetic')).toBeNull();
    expect(svc.nameForSku('378;5;u408')).toBe('Polar Prism Team Captain');
  });
});

describe('0.9 (#22): a pre-rename schema (particle 408 still named "Northern Nights")', () => {
  const preRename = mutated((ps) => ps.map((p) => (p.id === 408 ? { ...p, name: 'Northern Nights' } : p)));

  it('keeps the two kinds apart (type-scoped twins) and still reads both names', async () => {
    const svc = await service(preRename);
    expect(svc.canonicalEffectId(3221)).toBe(3221);
    expect(svc.canonicalEffectId(408)).toBe(408);
    expect(sku(svc, 'Polar Prism Team Captain')).toBe('378;5;u408');
    expect(sku(svc, 'Northern Nights Team Captain')).toBe('378;5;u408');
    expect(sku(svc, 'Northern Nights Taunt: The Shred Alert')).toBe('1015;5;u3221');
    expect(svc.effectIdByName('Polar Prism')).toBe(408);
    expect(svc.effectIdByName('Northern Nights', 'taunt')).toBe(3221);
  });
});

describe('0.9 (#22): a schema without 408', () => {
  it('has no alias: Polar Prism is unknown and Northern Nights on a hat stays 3221 (the documented limit)', async () => {
    const svc = await service(mutated((ps) => ps.filter((p) => p.id !== 408)));
    expect(svc.effectIdByName('Polar Prism')).toBeNull();
    expect(svc.effectIdByName('Polar Prism', 'cosmetic')).toBeNull();
    expect(sku(svc, 'Northern Nights Team Captain')).toBe('378;5;u3221');
  });
});

describe('0.9 (#22): effectTypeForItem', () => {
  const item = (itemClass: string, slot: string | null): Pick<SchemaItemRow, 'itemClass' | 'slot'> => ({ itemClass, slot });

  it('names the kind of effect an item carries', () => {
    // A skin, whatever its class.
    expect(effectTypeForItem(item('tf_weapon_sniperrifle', 'primary'), true)).toBe('weapon');
    expect(effectTypeForItem(null, true)).toBe('weapon');
    // The taunt slot (a tf_wearable).
    expect(effectTypeForItem(item('tf_wearable', 'taunt'), false)).toBe('taunt');
    // A cosmetic.
    expect(effectTypeForItem(item('tf_wearable', 'head'), false)).toBe('cosmetic');
    // A weapon class without a skin, or nothing known: any kind.
    expect(effectTypeForItem(item('tf_weapon_minigun', 'primary'), false)).toBeNull();
    expect(effectTypeForItem(null, false)).toBeNull();
    expect(effectTypeForItem(undefined, false)).toBeNull();
  });
});
