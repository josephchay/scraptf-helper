// Small in-memory SchemaService for import tests.

import { fromString } from '../../src/shared/sku';
import type { ConnectorHealth, ItemSuggestion, ResolvedItem } from '../../src/shared/types';
import { KILLSTREAK_NAMES, QUALITY_NAMES, WEAR_NAMES } from '../../src/shared/types';
import type { EffectRow, PaintRow, PaintkitRow, SchemaItemRow, SchemaService } from '../../src/service/contracts';

function item(defindex: number, itemName: string, itemClass: string, slot: string | null, name = itemName): SchemaItemRow {
  return {
    defindex,
    name,
    itemName,
    properName: name.startsWith('The '),
    itemClass,
    slot,
    craftClass: null,
    usedByClasses: [],
    imageUrl: null,
  };
}

export const STUB_ITEMS: SchemaItemRow[] = [
  item(5021, 'Mann Co. Supply Crate Key', 'tool', null),
  item(378, 'Team Captain', 'tf_wearable', 'head', 'The Team Captain'),
  item(126, "Bill's Hat", 'tf_wearable', 'head'),
  item(940, 'Ghostly Gibus', 'tf_wearable', 'head'),
  item(31031, 'Wise Whiskers', 'tf_wearable', 'misc'),
  item(31459, 'Commonwealth Commando', 'tf_wearable', 'head'),
  item(31193, 'Crocodile Dandy', 'tf_wearable', 'misc'),
  item(31434, 'Balkans Brute', 'tf_wearable', 'head'),
  item(31540, 'Le Sapeur', 'tf_wearable', 'head'),
  item(31559, 'Feathered Foe', 'tf_wearable', 'head'),
  item(30920, 'Taunt: The Bunnyhopper', 'tf_wearable', 'taunt'),
  item(1108, 'Taunt: Buy a Life', 'tf_wearable', 'taunt'),
  item(1015, 'Taunt: The Shred Alert', 'tf_wearable', 'taunt'),
  item(30621, 'Taunt: Burstchester', 'tf_wearable', 'taunt'),
  item(935, 'Voodoo JuJu (Slight Return)', 'tf_wearable', 'head'),
  item(143, 'Earbuds', 'tf_wearable', 'head'),
  item(1101, 'B.A.S.E. Jumper', 'tf_weapon_parachute', 'secondary'),
  item(1153, 'Panic Attack', 'tf_weapon_shotgun', 'primary'),
  item(208, 'Flame Thrower', 'tf_weapon_flamethrower', 'primary'),
  item(205, 'Rocket Launcher', 'tf_weapon_rocketlauncher', 'primary'),
  item(202, 'Minigun', 'tf_weapon_minigun', 'primary'),
  item(412, 'Overdose', 'tf_weapon_syringegun_medic', 'primary'),
  item(811, 'Huo-Long Heater', 'tf_weapon_minigun', 'primary'),
  item(15000, 'Sniper Rifle', 'tf_weapon_sniperrifle', 'primary'),
  item(15063, 'Revolver', 'tf_weapon_revolver', 'secondary'),
  item(16105, 'War Paint', 'tool', null),
  item(20002, 'Specialized Killstreak Kit Fabricator', 'tool', null),
  item(20003, 'Professional Killstreak Kit Fabricator', 'tool', null),
  item(5036, 'Ye Olde Rustic Colour', 'tool', null),
  item(6012, 'Strange Part: Airborne Enemies Killed', 'tool', null),
  item(725, 'Tour of Duty Ticket', 'tool', null),
  item(5832, 'Warbird Weapons Case', 'supply_crate', null),
  item(5020, 'Name Tag', 'tool', null),
  // F15 bank fixtures (buy_weapons/stranges/killstreaks/skins/items.html): TF2 schema defindexes.
  item(35, 'Kritzkrieg', 'tf_weapon_medigun', 'secondary', 'The Kritzkrieg'),
  item(41, 'Natascha', 'tf_weapon_minigun', 'primary'),
  item(127, 'Direct Hit', 'tf_weapon_rocketlauncher_directhit', 'primary', 'The Direct Hit'),
  item(133, 'Gunboats', 'tf_wearable', 'secondary', 'The Gunboats'),
  item(197, 'Wrench', 'tf_weapon_wrench', 'melee'),
  item(199, 'Shotgun', 'tf_weapon_shotgun', 'secondary'),
  item(200, 'Scattergun', 'tf_weapon_scattergun', 'primary'),
  item(201, 'Sniper Rifle', 'tf_weapon_sniperrifle', 'primary'),
  item(206, 'Grenade Launcher', 'tf_weapon_grenadelauncher', 'primary'),
  item(207, 'Stickybomb Launcher', 'tf_weapon_pipebomblauncher', 'secondary'),
  item(211, 'Medi Gun', 'tf_weapon_medigun', 'secondary'),
  item(228, 'Black Box', 'tf_weapon_rocketlauncher', 'primary', 'The Black Box'),
  item(355, "Fan O'War", 'tf_weapon_bat', 'melee', "The Fan O'War"),
  item(638, 'Sharp Dresser', 'tf_weapon_knife', 'melee', 'The Sharp Dresser'),
  item(654, 'Festive Minigun', 'tf_weapon_minigun', 'primary'),
  item(793, 'Silver Botkiller Minigun Mk.I', 'tf_weapon_minigun', 'primary'),
  item(1013, 'Ham Shank', 'saxxy', 'melee', 'The Ham Shank'),
  item(1118, 'Taunt: Conga', 'tf_wearable', 'taunt'),
  item(1157, 'Taunt: Kazotsky Kick', 'tf_wearable', 'taunt'),
  item(1162, 'Taunt: Mannrobics', 'tf_wearable', 'taunt'),
  item(5037, 'Australium Gold', 'tool', null),
  item(5044, 'Description Tag', 'tool', null),
  item(5046, 'Team Spirit', 'tool', null),
  item(5051, 'Pink as Hell', 'tool', null),
  item(5734, 'Mann Co. Supply Munition', 'supply_crate', null),
  item(6526, 'Professional Killstreak Kit', 'tool', null),
  item(16070, 'War Paint', 'tool', null),
  item(16104, 'War Paint', 'tool', null),
  // Crates whose card shows no series (a single-series case, a multi-series crate) and an item that
  // exists only as Unusual, without an effect.
  item(5078, 'Scorched Crate', 'supply_crate', null),
  item(5022, 'Mann Co. Supply Crate', 'supply_crate', null),
  item(267, 'Haunted Metal Scrap', 'craft_item', null),
];

/** item_quality where the schema gives one other than Unique (6). */
export const STUB_ITEM_QUALITY: Record<number, number> = { 267: 5, 16070: 15, 16104: 15, 16105: 15 };

export const STUB_EFFECTS: EffectRow[] = [
  { id: 8, name: 'Haunted Ghosts', canonicalId: 8, type: 'cosmetic' },
  { id: 13, name: 'Burning Flames', canonicalId: 13, type: 'cosmetic' },
  { id: 14, name: 'Scorching Flames', canonicalId: 14, type: 'cosmetic' },
  { id: 312, name: 'Radiant Rivalry', canonicalId: 312, type: 'cosmetic' },
  { id: 380, name: 'Piercing Headache', canonicalId: 380, type: 'cosmetic' },
  { id: 392, name: 'Sandy', canonicalId: 392, type: 'cosmetic' },
  // RED/BLU pairs share a name and map to the lower id.
  { id: 360, name: 'Searing Stove', canonicalId: 360, type: 'cosmetic' },
  { id: 361, name: 'Searing Stove', canonicalId: 360, type: 'cosmetic' },
  { id: 365, name: 'Crystal Crown', canonicalId: 365, type: 'cosmetic' },
  { id: 366, name: 'Crystal Crown', canonicalId: 365, type: 'cosmetic' },
  { id: 701, name: 'Hot', canonicalId: 701, type: 'weapon' },
  { id: 702, name: 'Isotope', canonicalId: 702, type: 'weapon' },
  { id: 703, name: 'Cool', canonicalId: 703, type: 'weapon' },
  { id: 704, name: 'Energy Orb', canonicalId: 704, type: 'weapon' },
  // Taunt effects: Showstopper is a RED/BLU pair; '72 carries an apostrophe.
  { id: 3001, name: 'Showstopper', canonicalId: 3001, type: 'taunt' },
  { id: 3002, name: 'Showstopper', canonicalId: 3001, type: 'taunt' },
  { id: 3004, name: "'72", canonicalId: 3004, type: 'taunt' },
  { id: 3010, name: 'Mega Strike', canonicalId: 3010, type: 'taunt' },
  { id: 3190, name: 'Award Winning', canonicalId: 3190, type: 'taunt' },
];

export const STUB_PAINTS: PaintRow[] = [
  { decimal: 12073019, hex: '#B8383B', name: 'Team Spirit', bluHex: '#5885A2' },
  { decimal: 5801378, hex: '#5885A2', name: 'Legacy Paint', bluHex: null },
  { decimal: 8400928, hex: '#803020', name: 'The Value of Teamwork', bluHex: '#256D8D' },
  { decimal: 6637376, hex: '#654740', name: 'An Air of Debonair', bluHex: '#28394D' },
  { decimal: 8208497, hex: '#7D4071', name: 'A Deep Commitment to Purple', bluHex: null },
  { decimal: 6901050, hex: '#694D3A', name: 'Radigan Conagher Brown', bluHex: null },
  { decimal: 15185211, hex: '#E7B53B', name: 'Australium Gold', bluHex: null },
  { decimal: 12955537, hex: '#C5AF91', name: 'Peculiarly Drab Tincture', bluHex: null },
  { decimal: 16738740, hex: '#FF69B4', name: 'Pink as Hell', bluHex: null },
  { decimal: 8154199, hex: '#7C6C57', name: 'Ye Olde Rustic Colour', bluHex: null },
];

export const STUB_PAINTKITS: PaintkitRow[] = [
  { id: 14, name: 'Night Owl' },
  { id: 1014, name: 'Night Owl Mk.II' },
  { id: 70, name: 'Haunted Ghosts' },
  { id: 104, name: 'Masked Mender' },
  { id: 105, name: 'Masked Mender Mk.II' },
  { id: 206, name: 'Pizza Polished' },
  { id: 300, name: 'Frozen Aurora' },
];

/** Exact-name resolutions (kits and fabricators carry target tokens). */
export const STUB_RESOLVE: Record<string, string> = {
  'specialized killstreak ham shank kit fabricator': '20002;6;kt-2;td-1013;od-6523;oq-6',
  'professional killstreak rocket launcher kit': '6526;6;kt-3;td-205',
  'professional killstreak rocket launcher kit fabricator': '20003;6;kt-3;td-205;od-6526;oq-6',
  // As the real resolver: a single-series case gets its series, a multi-series crate none.
  'scorched crate': '5078;6;c46',
  'mann co. supply crate': '5022;6',
  'mann co. supply munition': '5734;6',
};

function normHex(hex: string): string {
  const h = hex.trim().replace(/^#/, '').toLowerCase();
  return h.length === 3 ? h.replace(/(.)/g, '$1$1') : h;
}

export interface StubOptions {
  loaded?: boolean;
  /** Throw from every lookup (simulates a broken schema module). */
  throwing?: boolean;
}

export function createStubSchema(opts: StubOptions = {}): SchemaService & { calls: string[] } {
  const loaded = opts.loaded ?? true;
  const items = loaded ? STUB_ITEMS : [];
  const effects = loaded ? STUB_EFFECTS : [];
  const paints = loaded ? STUB_PAINTS : [];
  const paintkits = loaded ? STUB_PAINTKITS : [];
  const calls: string[] = [];
  const guard = <T>(name: string, fn: () => T): T => {
    calls.push(name);
    if (opts.throwing) throw new Error(`stub ${name} failure`);
    return fn();
  };

  const itemByDefindex = (d: number) => items.find((i) => i.defindex === d) ?? null;
  const effectName = (id: number) => effects.find((e) => e.id === id)?.name ?? null;
  const paintkitName = (id: number) => paintkits.find((p) => p.id === id)?.name ?? null;

  const nameForSku = (sku: string): string => {
    const o = fromString(sku);
    const it = itemByDefindex(o.defindex);
    if (!it) return sku;
    // Kits and fabricators are named after their target ("Professional Killstreak Rocket Launcher Kit").
    const target = o.target !== null ? itemByDefindex(o.target) : null;
    if (target && / Kit(?: Fabricator)?$/.test(it.itemName)) {
      const tier = o.killstreak ? `${KILLSTREAK_NAMES[o.killstreak]} ` : '';
      return `${tier}${target.itemName} Kit${it.itemName.endsWith('Fabricator') ? ' Fabricator' : ''}`;
    }
    const parts: string[] = [];
    if (!o.craftable) parts.push('Non-Craftable');
    if (o.quality2 === 11) parts.push('Strange');
    if (o.quality === 5 && o.effect) parts.push(effectName(o.effect) ?? `Effect ${o.effect}`);
    else if (o.quality !== 6 && !(o.quality === 15 && o.paintkit !== null)) parts.push(QUALITY_NAMES[o.quality] ?? `Quality ${o.quality}`);
    else if (o.effect) parts.push(effectName(o.effect) ?? `Effect ${o.effect}`);
    // bp.tf's order: Festivized before the killstreak tier.
    if (o.festive) parts.push('Festivized');
    if (o.killstreak) parts.push(KILLSTREAK_NAMES[o.killstreak]!);
    if (o.australium) parts.push('Australium');
    if (o.paintkit !== null) parts.push(paintkitName(o.paintkit) ?? `Paintkit ${o.paintkit}`);
    parts.push(it.itemName);
    if (o.wear) parts.push(`(${WEAR_NAMES[o.wear]})`);
    if (o.crateseries) parts.push(`#${o.crateseries}`);
    return parts.join(' ');
  };

  const health: ConnectorHealth = {
    id: 'schema',
    label: 'Item schema',
    state: loaded ? 'idle' : 'off',
    detail: 'stub',
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    disabledReason: null,
  };

  return {
    calls,
    init: async () => undefined,
    refresh: async () => undefined,
    isLoaded: () => guard('isLoaded', () => loaded),
    health: () => health,
    itemByDefindex: (d) => guard('itemByDefindex', () => itemByDefindex(d)),
    itemQuality: (d) => guard('itemQuality', () => (itemByDefindex(d) ? (STUB_ITEM_QUALITY[d] ?? 6) : null)),
    nameForSku: (sku) => guard('nameForSku', () => nameForSku(sku)),
    baseNameForSku: (sku) => guard('baseNameForSku', () => itemByDefindex(fromString(sku).defindex)?.itemName ?? sku),
    marketHashName: () => null,
    resolve: (text): ResolvedItem | null =>
      guard('resolve', () => {
        const sku = STUB_RESOLVE[text.trim().toLowerCase()];
        if (!sku || !loaded) return null;
        return { sku, name: text, skuObject: fromString(sku), category: 'other', match: 'exact', warnings: [] };
      }),
    search: (): ItemSuggestion[] => [],
    categoryForSku: () => 'other',
    effectName: (id) => guard('effectName', () => effectName(id)),
    effectIdByName: (name) =>
      guard('effectIdByName', () => {
        const hits = effects.filter((e) => e.name.toLowerCase() === name.trim().toLowerCase()).map((e) => e.id);
        return hits.length ? Math.min(...hits) : null;
      }),
    canonicalEffectId: (id) => guard('canonicalEffectId', () => effects.find((e) => e.id === id)?.canonicalId ?? id),
    paintByDecimal: (d) => guard('paintByDecimal', () => paints.find((p) => p.decimal === d) ?? null),
    paintDecimalByHex: (hex) =>
      guard('paintDecimalByHex', () => {
        const h = normHex(hex);
        const red = paints.find((p) => normHex(p.hex) === h);
        if (red) return red.decimal;
        const blu = paints.find((p) => p.bluHex !== null && normHex(p.bluHex) === h);
        return blu ? blu.decimal : null;
      }),
    paintkitName: (id) => guard('paintkitName', () => paintkitName(id)),
    paintkitIdByName: (name) =>
      guard('paintkitIdByName', () => paintkits.find((p) => p.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null),
    paintkits: () => guard('paintkits', () => paintkits),
  };
}
