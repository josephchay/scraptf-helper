// 0.7.2: "Open on scrap.tf" copies a killstreak kit's search name as "<weapon> Kit". scrap.tf titles a kit card
// "Professional Rocket Launcher Kit" (no "Killstreak"), so Steam's "Non-Craftable Professional Killstreak
// Rocket Launcher Kit", the row's name, is not part of it and the search found nothing. Every other item's
// search name is unchanged. The names come from TF2's own schema rows (test/fixtures/pricedb/schema-subset.json)
// as the Live market and the drawer show them. The copy is clipboard text only: nothing contacts scrap.tf.

import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { checkArmFor } from '../../src/renderer/checkModel';
import { flattenSections, itemMenuSections, scraptfSearchName } from '../../src/renderer/itemMenuModel';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const search = (sku: string, name = schema.nameForSku(sku)): string => scraptfSearchName({ sku, name });

describe('scraptfSearchName for killstreak kits (0.7.2)', () => {
  it('copies "<weapon> Kit" for a kit with a weapon, every tier, craftable or not', () => {
    const cases: [string, string, string][] = [
      ['6526;6;uncraftable;kt-3;td-205', 'Non-Craftable Professional Killstreak Rocket Launcher Kit', 'Rocket Launcher Kit'],
      ['6523;6;uncraftable;kt-2;td-211', 'Non-Craftable Specialized Killstreak Medi Gun Kit', 'Medi Gun Kit'],
      ['6527;6;uncraftable;kt-1;td-200', 'Non-Craftable Killstreak Scattergun Kit', 'Scattergun Kit'],
      // backpack.tf's Craftable kit and a weapon with a proper name.
      ['6526;6;kt-3;td-199', 'Professional Killstreak Shotgun Kit', 'Shotgun Kit'],
      ['6526;6;uncraftable;kt-3;td-228', 'Non-Craftable Professional Killstreak Black Box Kit', 'Black Box Kit'],
    ];
    for (const [sku, name, want] of cases) {
      expect(schema.nameForSku(sku), sku).toBe(name);
      expect(search(sku), sku).toBe(want);
    }
  });

  it('is part of every form of the title: scrap.tf\'s card, Steam\'s and backpack.tf\'s', () => {
    const want = search('6526;6;uncraftable;kt-3;td-205');
    for (const title of [
      'Professional Rocket Launcher Kit',
      'Non-Craftable Professional Rocket Launcher Kit',
      'Professional Killstreak Rocket Launcher Kit',
      'Non-Craftable Professional Killstreak Rocket Launcher Kit',
    ]) {
      expect(title).toContain(want);
    }
    for (const title of ['Specialized Medi Gun Kit', 'Specialized Killstreak Medi Gun Kit']) expect(title).toContain(search('6523;6;uncraftable;kt-2;td-211'));
    for (const title of ['Killstreak Scattergun Kit', 'Basic Scattergun Kit', 'Basic Killstreak Scattergun Kit']) expect(title).toContain(search('6527;6;uncraftable;kt-1;td-200'));
  });

  it("reads a learned backpack.tf name, a non-tradable kit's and stray spacing the same way", () => {
    expect(search('6526;6;kt-3;td-205', 'Professional Killstreak Rocket Launcher Kit')).toBe('Rocket Launcher Kit');
    expect(search('6526;6;uncraftable;kt-3;td-205', '  Non-Craftable  Professional Killstreak   Rocket Launcher Kit ')).toBe('Rocket Launcher Kit');
    expect(search('6526;6;untradable;uncraftable;kt-3;td-205', 'Non-Tradable Non-Craftable Professional Killstreak Rocket Launcher Kit')).toBe('Rocket Launcher Kit');
  });

  it('leaves every other name as before', () => {
    // A kit with no weapon names none to search for.
    expect(search('6526;6')).toBe(schema.nameForSku('6526;6').trim());
    expect(search('6526;6', 'Professional Killstreak Kit')).toBe('Professional Killstreak Kit');
    // A fabricator is not a kit: its name stays whole.
    const fab = '20003;6;kt-3;td-205;od-6526;oq-6';
    expect(search(fab)).toBe(schema.nameForSku(fab).trim());
    expect(search(fab, 'Professional Killstreak Rocket Launcher Kit Fabricator')).toBe('Professional Killstreak Rocket Launcher Kit Fabricator');
    // A killstreak weapon, not a kit.
    expect(search('205;11;kt-3', 'Strange Professional Killstreak Rocket Launcher')).toBe('Strange Professional Killstreak Rocket Launcher');
    // A kit name the schema could not build (the SKU) or of another shape keeps the usual name.
    expect(search('6526;6;uncraftable;kt-3;td-205', '6526;6;uncraftable;kt-3;td-205')).toBe('6526;6;uncraftable;kt-3;td-205');
    expect(search('6526;6;uncraftable;kt-3;td-205', 'Strange Professional Killstreak Rocket Launcher Kit')).toBe('Strange Professional Killstreak Rocket Launcher Kit');
    expect(search('6526;6;uncraftable;kt-3;td-205', '')).toBe('6526;6;uncraftable;kt-3;td-205');
    // As before 0.7.2.
    expect(scraptfSearchName({ sku: '378;6', name: ' Team Captain ' })).toBe('Team Captain');
    expect(scraptfSearchName({ sku: '378;6', name: '' })).toBe('378;6');
    expect(scraptfSearchName({ sku: '378;6;p15185211', name: 'Team Captain (Paint: Australium Gold)' })).toBe('Team Captain');
  });

  it('is what the item menu copies and arms the Live check with', () => {
    const target = { sku: '6526;6;uncraftable;kt-3;td-205', name: schema.nameForSku('6526;6;uncraftable;kt-3;td-205'), category: 'killstreaks' as const };
    const item = flattenSections(itemMenuSections(target, { status: 'loading' })).find((i) => i.id === 'scraptf-open')!;
    expect(item.action).toEqual({ kind: 'scraptf', url: 'https://scrap.tf/buy/killstreaks', name: 'Rocket Launcher Kit' });
    expect(item.title).toContain('"Rocket Launcher Kit"');
    expect(checkArmFor(target.sku, 'Rocket Launcher Kit')).toEqual({ sku: target.sku, name: 'Rocket Launcher Kit' });
  });
});
