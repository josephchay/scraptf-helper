// Port of @tf2autobot/tf2-sku 3.1.0 (MIT, Copyright (c) 2020 IdiNium/Nicklas Marc Pedersen).
// https://github.com/TF2Autobot/node-tf2-sku
//
// fromString is order-agnostic; fromObject emits either the v3 order (default,
// used by marketplace.tf links and as our canonical DB key) or the legacy order
// (used by PriceDB exact-match lookups).

import type { SkuObject } from './types';

export const SKU_TEMPLATE: Readonly<SkuObject> = Object.freeze({
  defindex: 0,
  quality: 0,
  craftable: true,
  tradable: true,
  killstreak: 0,
  australium: false,
  effect: null,
  festive: false,
  paintkit: null,
  wear: null,
  quality2: null,
  craftnumber: null,
  crateseries: null,
  target: null,
  output: null,
  outputQuality: null,
  paint: null,
});

function isNum(test: string): boolean {
  return /^-{0,1}\d+$/.test(test);
}

/** Fills missing fields from the template and drops unknown keys. */
export function normalizeSkuObject(item: Partial<SkuObject>): SkuObject {
  const out = { ...SKU_TEMPLATE } as SkuObject;
  for (const k of Object.keys(SKU_TEMPLATE) as (keyof SkuObject)[]) {
    const v = item[k];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function fromString(sku: string): SkuObject {
  const attributes: Partial<SkuObject> = {};
  const parts = sku.split(';');

  if (parts.length > 0) {
    if (isNum(parts[0]!)) attributes.defindex = parseInt(parts[0]!, 10);
    parts.shift();
  }
  if (parts.length > 0) {
    if (isNum(parts[0]!)) attributes.quality = parseInt(parts[0]!, 10);
    parts.shift();
  }

  for (const part of parts) {
    // Upstream removes only the first '-' ("kt-3" -> "kt3", "td-205" -> "td205").
    const attribute = part.replace('-', '');

    if (attribute === 'uncraftable') {
      attributes.craftable = false;
    } else if (attribute === 'untradeable' || attribute === 'untradable') {
      attributes.tradable = false;
    } else if (attribute === 'australium') {
      attributes.australium = true;
    } else if (attribute === 'festive') {
      attributes.festive = true;
    } else if (attribute === 'strange') {
      attributes.quality2 = 11;
    } else if (attribute.startsWith('kt') && isNum(attribute.substring(2))) {
      attributes.killstreak = parseInt(attribute.substring(2), 10);
    } else if (attribute.startsWith('u') && isNum(attribute.substring(1))) {
      attributes.effect = parseInt(attribute.substring(1), 10);
    } else if (attribute.startsWith('pk') && isNum(attribute.substring(2))) {
      attributes.paintkit = parseInt(attribute.substring(2), 10);
    } else if (attribute.startsWith('w') && isNum(attribute.substring(1))) {
      attributes.wear = parseInt(attribute.substring(1), 10);
    } else if (attribute.startsWith('td') && isNum(attribute.substring(2))) {
      attributes.target = parseInt(attribute.substring(2), 10);
    } else if (attribute.startsWith('n') && isNum(attribute.substring(1))) {
      attributes.craftnumber = parseInt(attribute.substring(1), 10);
    } else if (attribute.startsWith('c') && isNum(attribute.substring(1))) {
      attributes.crateseries = parseInt(attribute.substring(1), 10);
    } else if (attribute.startsWith('od') && isNum(attribute.substring(2))) {
      attributes.output = parseInt(attribute.substring(2), 10);
    } else if (attribute.startsWith('oq') && isNum(attribute.substring(2))) {
      attributes.outputQuality = parseInt(attribute.substring(2), 10);
    } else if (attribute.startsWith('p') && isNum(attribute.substring(1))) {
      attributes.paint = parseInt(attribute.substring(1), 10);
    }
  }

  return normalizeSkuObject(attributes);
}

export function fromObject(input: Partial<SkuObject>, legacy = false): string {
  const item = normalizeSkuObject(input);
  let sku = `${item.defindex};${item.quality}`;

  if (item.effect) sku += `;u${item.effect}`;
  if (item.australium === true) sku += ';australium';
  if (!legacy) {
    if (item.craftnumber) sku += `;n${item.craftnumber}`;
    if (item.crateseries) sku += `;c${item.crateseries}`;
  }
  if (item.craftable === false) sku += ';uncraftable';
  if (item.tradable === false) sku += ';untradable';
  if (item.wear) sku += `;w${item.wear}`;
  if (typeof item.paintkit === 'number') sku += `;pk${item.paintkit}`;
  // Upstream uses loose equality here; quality2 is always a number or null for us.
  if (item.quality2 === 11) sku += ';strange';
  if (typeof item.killstreak === 'number' && item.killstreak !== 0) sku += `;kt-${item.killstreak}`;
  if (legacy) {
    if (item.target) sku += `;td-${item.target}`;
  }
  if (item.festive === true) sku += ';festive';
  if (legacy) {
    if (item.craftnumber) sku += `;n${item.craftnumber}`;
    if (item.crateseries) sku += `;c${item.crateseries}`;
  }
  if (!legacy) {
    if (item.target) sku += `;td-${item.target}`;
  }
  if (item.output) sku += `;od-${item.output}`;
  if (item.outputQuality) sku += `;oq-${item.outputQuality}`;
  if (item.paint) sku += `;p${item.paint}`;

  return sku;
}

/** Canonical v3 form of any SKU string (re-orders tokens, drops unknown ones). */
export function canonical(sku: string): string {
  return fromObject(fromString(sku));
}

/** Legacy-order form, used for PriceDB exact-match lookups. */
export function toLegacy(sku: string): string {
  return fromObject(fromString(sku), true);
}

/** The SKU with the paint token removed: the key used to match buy orders. */
export function baseSku(sku: string | SkuObject): string {
  const obj = typeof sku === 'string' ? fromString(sku) : sku;
  return fromObject({ ...obj, paint: null });
}

/**
 * 0.7.4 (F08/F43/F69): an unusual skin (a paintkit and an effect) as backpack.tf's buyers key it:
 * Unusual (5) plus the effect, strange as quality2 11 ("199;5;u702;w1;pk232", "203;5;u703;w3;pk58;strange").
 * The live feed sent 1469 of its 1477 unusual-skin orders so; the rest came as Strange (11) plus the effect
 * (market_name "Strange X"), the same item, and before 0.7.4 this app keyed them Decorated (15) plus the
 * effect, a form no order uses. Those forms become this one; every other object is returned as it is.
 */
export function canonicalUnusualSkin(obj: SkuObject): SkuObject {
  if (obj.paintkit === null || obj.effect === null) return obj;
  if (obj.quality !== 5 && obj.quality !== 11 && obj.quality !== 15) return obj;
  const strange = obj.quality === 11 || obj.quality2 === 11;
  if (obj.quality === 5 && obj.quality2 === (strange ? 11 : null)) return obj;
  return { ...obj, quality: 5, quality2: strange ? 11 : null };
}

/** Rough syntactic check: "<int>;<int>" followed by known-looking tokens. */
export function looksLikeSku(text: string): boolean {
  return /^\d+;\d+(;[a-z0-9-]+)*$/i.test(text.trim());
}

/** A token as fromString reads it: the first '-' is dropped ("kt-3" = "kt3") and "untradeable" is "untradable". */
function tokenKey(part: string): string {
  const t = part.replace('-', '');
  return t === 'untradeable' ? 'untradable' : t;
}

/**
 * Strict check for SKUs a user typed: lower case, and every token after the
 * defindex and quality is one fromString reads, once, and canonical() keeps
 * (in any order, with or without the hyphen). fromString silently ignores
 * anything else ("KT-3", "UNCRAFTABLE", "uncratable", a second effect), which
 * would turn the text into a different item. Callers lower-case user input first.
 */
export function isValidSku(text: string): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!/^\d+;\d+(;[a-z0-9-]+)*$/.test(t)) return false;
  const canon = canonical(t);
  // Fast path for stored SKUs (always canonical; the engine checks every price on every
  // run): only a negative value ("kt--3") is left to refuse.
  if (canon === t) return !t.includes('--');
  const typed = t.split(';');
  const kept = canon.split(';');
  if (typed.length !== kept.length || typed[0] !== kept[0] || typed[1] !== kept[1]) return false;
  const a = typed.slice(2).map(tokenKey).sort();
  const b = kept.slice(2).map(tokenKey).sort();
  // A '-' left after the first one is a negative value ("kt--3"), never a real item.
  return a.every((k, i) => k === b[i] && !k.includes('-'));
}
