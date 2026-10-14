// Category classifier for the dashboard filters and price-sheet rules.
//
// Precedence, first match wins:
//   unusuals > skins > taunts > killstreaks > stranges > hats > weapons > other
// so a Strange Unusual is an unusual, a killstreak skin is a skin and an
// unusual taunt is an unusual. Unusual quality without an effect (the generic
// any-effect base, 378;5) is an unusual too.

import type { Category, SkuObject } from './types';

/** The schema facts the classifier needs (a subset of SchemaItemRow). */
export interface CategoryItemInfo {
  itemClass: string;
  slot: string | null;
  craftClass: string | null;
  itemName?: string;
}

const QUALITY_UNUSUAL = 5;
const QUALITY_STRANGE = 11;
const QUALITY_DECORATED = 15;

const COSMETIC_SLOTS: ReadonlySet<string> = new Set(['misc', 'head', 'hat']);
const WEAPON_SLOTS: ReadonlySet<string> = new Set(['primary', 'secondary', 'melee', 'pda', 'pda2', 'building']);

/** The generic "Paintkit" War Paint item. */
const WAR_PAINT_BASE_DEFINDEX = 9536;

/**
 * War Paint tools are defindex 16000 + paintkit. The 2026 schema has them in
 * both 16xxx and 17xxx (31 and 132 items), and nothing else in that range.
 */
export function isWarPaintDefindex(defindex: number): boolean {
  return defindex === WAR_PAINT_BASE_DEFINDEX || (defindex >= 16000 && defindex <= 17999);
}

function lower(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return t === '' ? null : t;
}

function hasEffect(obj: SkuObject): boolean {
  return typeof obj.effect === 'number' && Number.isFinite(obj.effect) && obj.effect > 0;
}

/**
 * A generic "Unusual <item>" with no particle (378;5): the base that any-effect
 * buy orders map to. Unusualifiers (9258;5;td-N) are quality-5 tools that carry
 * a target; they are not unusuals.
 */
function isGenericUnusual(obj: SkuObject): boolean {
  return obj.quality === QUALITY_UNUSUAL && typeof obj.target !== 'number';
}

function isSkinSku(obj: SkuObject): boolean {
  return (
    (typeof obj.paintkit === 'number' && obj.paintkit >= 0) ||
    (typeof obj.wear === 'number' && obj.wear > 0) ||
    obj.quality === QUALITY_DECORATED ||
    isWarPaintDefindex(obj.defindex)
  );
}

function isKillstreak(obj: SkuObject): boolean {
  return typeof obj.killstreak === 'number' && obj.killstreak > 0;
}

function isStrange(obj: SkuObject): boolean {
  return obj.quality === QUALITY_STRANGE || obj.quality2 === QUALITY_STRANGE;
}

function isWarPaintItem(item: CategoryItemInfo): boolean {
  return lower(item.itemClass) === 'tool' && lower(item.itemName) === 'war paint';
}

function isTaunt(item: CategoryItemInfo): boolean {
  const slot = lower(item.slot);
  if (slot === 'taunt') return true;
  // Some schema sources leave item_slot empty on taunts; their names always start with "Taunt:".
  return slot === null && (lower(item.itemName)?.startsWith('taunt:') ?? false);
}

/** Category from the SKU alone, for items whose schema entry is unknown. */
export function categoryOfSkuOnly(obj: SkuObject): Category {
  if (hasEffect(obj) || isGenericUnusual(obj)) return 'unusuals';
  if (isSkinSku(obj)) return 'skins';
  if (isKillstreak(obj)) return 'killstreaks';
  if (isStrange(obj)) return 'stranges';
  return 'other';
}

export function categorize(obj: SkuObject, item: CategoryItemInfo | null): Category {
  if (!item) return categoryOfSkuOnly(obj);

  if (hasEffect(obj) || (isGenericUnusual(obj) && lower(item.itemClass) !== 'tool')) return 'unusuals';
  if (isSkinSku(obj) || isWarPaintItem(item)) return 'skins';
  if (isTaunt(item)) return 'taunts';
  if (isKillstreak(obj)) return 'killstreaks';
  if (isStrange(obj)) return 'stranges';

  const slot = lower(item.slot);
  const craftClass = lower(item.craftClass);
  if ((slot !== null && COSMETIC_SLOTS.has(slot)) || craftClass === 'hat') return 'hats';
  if ((slot !== null && WEAPON_SLOTS.has(slot)) || craftClass === 'weapon') return 'weapons';
  return 'other';
}
