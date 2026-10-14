// Tests for the @tf2autobot/tf2-sku 3.1.0 port (src/shared/sku.ts).
//
// Neither TF2Autobot/node-tf2-sku nor the original Nicklason/node-tf2-sku
// ships test files, so these cases are derived from upstream index.js
// (checked token by token), its README example, the SKU vectors in
// peleicht/tf2-item-parser's tests, and every example in DESIGN_BRIEF §4.1.

import { describe, expect, it } from 'vitest';
import {
  SKU_TEMPLATE,
  baseSku,
  canonical,
  fromObject,
  fromString,
  isValidSku,
  looksLikeSku,
  normalizeSkuObject,
  toLegacy,
} from '../../src/shared/sku';
import type { SkuObject } from '../../src/shared/types';

const sku = (fields: Partial<SkuObject>): SkuObject => ({ ...SKU_TEMPLATE, ...fields });

describe('SKU_TEMPLATE', () => {
  it('matches the upstream template', () => {
    expect(SKU_TEMPLATE).toEqual({
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
    expect(Object.isFrozen(SKU_TEMPLATE)).toBe(true);
  });
});

describe('design brief §4.1 examples', () => {
  const examples: [string, Partial<SkuObject>][] = [
    ['5021;6', { defindex: 5021, quality: 6 }],
    ['378;5;u13', { defindex: 378, quality: 5, effect: 13 }],
    ['378;5;u13;strange', { defindex: 378, quality: 5, effect: 13, quality2: 11 }],
    ['205;11;australium;kt-3', { defindex: 205, quality: 11, australium: true, killstreak: 3 }],
    ['205;11;uncraftable;kt-3;festive', { defindex: 205, quality: 11, craftable: false, killstreak: 3, festive: true }],
    ['1104;15;w1;pk114', { defindex: 1104, quality: 15, wear: 1, paintkit: 114 }],
    ['15000;15;u701;w1;pk14', { defindex: 15000, quality: 15, effect: 701, wear: 1, paintkit: 14 }],
    [
      '20003;6;kt-3;td-205;od-6526;oq-6',
      { defindex: 20003, quality: 6, killstreak: 3, target: 205, output: 6526, outputQuality: 6 },
    ],
    ['378;6;p16738740', { defindex: 378, quality: 6, paint: 16738740 }],
    ['160;3;n4', { defindex: 160, quality: 3, craftnumber: 4 }],
    ['5041;6;c11', { defindex: 5041, quality: 6, crateseries: 11 }],
  ];

  it.each(examples)('parses %s', (text, fields) => {
    expect(fromString(text)).toEqual(sku(fields));
  });

  it.each(examples)('round-trips %s in v3 order', (text, fields) => {
    expect(fromObject(sku(fields))).toBe(text);
    expect(fromObject(fromString(text))).toBe(text);
    expect(canonical(text)).toBe(text);
  });

  it.each(examples)('legacy order of %s parses back to the same object', (text) => {
    const legacy = toLegacy(text);
    expect(fromString(legacy)).toEqual(fromString(text));
  });

  it('none of the brief examples differ between v3 and legacy order', () => {
    // They contain no n/c token next to uncraftable/untradable/w/pk/strange/kt and no td with festive.
    for (const [text] of examples) expect(toLegacy(text)).toBe(text);
  });

  it('crate series 11 is defindex 5041, not 5022 (both parse; identity is the caller’s concern)', () => {
    expect(fromString('5041;6;c11').defindex).toBe(5041);
    expect(fromString('5022;6;c11').defindex).toBe(5022);
  });
});

describe('external vectors', () => {
  it('matches the upstream README example', () => {
    const item = fromString('5021;6');
    expect(item).toMatchObject({
      defindex: 5021,
      quality: 6,
      craftable: true,
      killstreak: 0,
      australium: false,
      festive: false,
      effect: null,
      paintkit: null,
      wear: null,
      quality2: null,
      target: null,
      craftnumber: null,
    });
    expect(fromObject(item)).toBe('5021;6');
  });

  // SKUs from peleicht/tf2-item-parser's test/sku_tests.js, which emits the legacy token order.
  const legacyVectors: [string, Partial<SkuObject>][] = [
    ['13;15;w4;pk72;strange;kt-2;festive', { defindex: 13, quality: 15, wear: 4, paintkit: 72, quality2: 11, killstreak: 2, festive: true }],
    ['18002;6;c113', { defindex: 18002, quality: 6, crateseries: 113 }],
    ['20000;6;td-878;n2;od-5661;oq-6', { defindex: 20000, quality: 6, target: 878, craftnumber: 2, output: 5661, outputQuality: 6 }],
    ['20002;6;kt-2;td-444;od-5726;oq-6', { defindex: 20002, quality: 6, killstreak: 2, target: 444, output: 5726, outputQuality: 6 }],
    ['30919;5;u3007', { defindex: 30919, quality: 5, effect: 3007 }],
    ['38;11;australium;kt-2', { defindex: 38, quality: 11, australium: true, killstreak: 2 }],
    ['5661;6;td-593', { defindex: 5661, quality: 6, target: 593 }],
    ['5726;6;uncraftable;kt-1;td-460', { defindex: 5726, quality: 6, craftable: false, killstreak: 1, target: 460 }],
    ['5790;6;c89', { defindex: 5790, quality: 6, crateseries: 89 }],
    ['9258;5;uncraftable;td-1182', { defindex: 9258, quality: 5, craftable: false, target: 1182 }],
    ['9536;15;w1;pk114', { defindex: 9536, quality: 15, wear: 1, paintkit: 114 }],
  ];

  it.each(legacyVectors)('parses %s and reproduces it in legacy order', (text, fields) => {
    expect(fromString(text)).toEqual(sku(fields));
    expect(toLegacy(text)).toBe(text);
  });

  it('moves n before td in v3 order', () => {
    expect(canonical('20000;6;td-878;n2;od-5661;oq-6')).toBe('20000;6;n2;td-878;od-5661;oq-6');
  });
});

describe('fromObject token order', () => {
  const everything = sku({
    defindex: 100,
    quality: 5,
    effect: 13,
    australium: true,
    craftnumber: 7,
    crateseries: 8,
    craftable: false,
    tradable: false,
    wear: 2,
    paintkit: 14,
    quality2: 11,
    killstreak: 3,
    festive: true,
    target: 205,
    output: 6526,
    outputQuality: 6,
    paint: 3100495,
  });

  it('emits the v3 order', () => {
    expect(fromObject(everything)).toBe(
      '100;5;u13;australium;n7;c8;uncraftable;untradable;w2;pk14;strange;kt-3;festive;td-205;od-6526;oq-6;p3100495',
    );
  });

  it('emits the legacy order', () => {
    expect(fromObject(everything, true)).toBe(
      '100;5;u13;australium;uncraftable;untradable;w2;pk14;strange;kt-3;td-205;festive;n7;c8;od-6526;oq-6;p3100495',
    );
  });

  it('round-trips the full object through both orders', () => {
    expect(fromString(fromObject(everything))).toEqual(everything);
    expect(fromString(fromObject(everything, true))).toEqual(everything);
  });

  it.each([
    [{ defindex: 200, quality: 6, craftable: false, craftnumber: 100 }, '200;6;n100;uncraftable', '200;6;uncraftable;n100'],
    [{ defindex: 5022, quality: 6, craftable: false, crateseries: 1 }, '5022;6;c1;uncraftable', '5022;6;uncraftable;c1'],
    [
      { defindex: 6526, quality: 6, killstreak: 3, target: 205, festive: true },
      '6526;6;kt-3;festive;td-205',
      '6526;6;kt-3;td-205;festive',
    ],
    [{ defindex: 15000, quality: 15, wear: 3, paintkit: 14, crateseries: 82 }, '15000;15;c82;w3;pk14', '15000;15;w3;pk14;c82'],
  ] as [Partial<SkuObject>, string, string][])('v3 and legacy differ for %j', (fields, v3, legacy) => {
    expect(fromObject(fields)).toBe(v3);
    expect(fromObject(fields, true)).toBe(legacy);
    expect(canonical(legacy)).toBe(v3);
    expect(toLegacy(v3)).toBe(legacy);
  });

  it('fills missing fields from the template', () => {
    expect(fromObject({ defindex: 5021, quality: 6 })).toBe('5021;6');
    expect(fromObject({})).toBe('0;0');
  });

  it('omits falsy numeric tokens like upstream, except pk0 (typeof check)', () => {
    expect(fromObject(sku({ defindex: 1, quality: 6, effect: 0, wear: 0, paint: 0, target: 0 }))).toBe('1;6');
    expect(fromObject(sku({ defindex: 1, quality: 6, paintkit: 0 }))).toBe('1;6;pk0');
    expect(fromObject(sku({ defindex: 1, quality: 6, killstreak: 0 }))).toBe('1;6');
  });

  it('emits strange whenever quality2 is 11, even on quality 11 (upstream behaviour)', () => {
    expect(fromObject(sku({ defindex: 205, quality: 11, quality2: 11 }))).toBe('205;11;strange');
  });

  it('does not mutate its input (upstream mutates via `defaults`; the port must not)', () => {
    const input: Partial<SkuObject> = { defindex: 5021, quality: 6 };
    fromObject(input);
    expect(input).toEqual({ defindex: 5021, quality: 6 });
  });
});

describe('fromString', () => {
  it('is order-agnostic', () => {
    const a = fromString('378;5;u13;strange;kt-3;festive');
    expect(fromString('378;5;festive;kt-3;strange;u13')).toEqual(a);
    expect(fromString('378;5;strange;u13;festive;kt-3')).toEqual(a);
  });

  it('always reads defindex and quality from the first two positions', () => {
    expect(fromString('5;378;u13')).toEqual(sku({ defindex: 5, quality: 378, effect: 13 }));
  });

  it('ignores unknown and malformed tokens', () => {
    expect(fromString('5021;6;foo;bar;x-1;kt;u;pk;w;c;n;td-;od-x;oq-;p')).toEqual(sku({ defindex: 5021, quality: 6 }));
    expect(canonical('5021;6;foo;bar')).toBe('5021;6');
    expect(fromString('5021;6;u13x')).toEqual(sku({ defindex: 5021, quality: 6 }));
  });

  it('accepts both untradable spellings', () => {
    expect(fromString('5021;6;untradable').tradable).toBe(false);
    expect(fromString('5021;6;untradeable').tradable).toBe(false);
    expect(canonical('5021;6;untradeable')).toBe('5021;6;untradable');
  });

  it('removes only the first dash of a token, as upstream does', () => {
    expect(fromString('1;6;kt3').killstreak).toBe(3);
    expect(fromString('1;6;td205').target).toBe(205);
    expect(fromString('1;6;u-13').effect).toBe(13);
    // "kt--3" -> "kt-3" -> isNum("-3") -> -3: an upstream quirk the port keeps.
    expect(fromString('1;6;kt--3').killstreak).toBe(-3);
  });

  it('tests pk before p and uncraftable before u', () => {
    expect(fromString('1;15;pk14')).toEqual(sku({ defindex: 1, quality: 15, paintkit: 14 }));
    expect(fromString('1;6;p14')).toEqual(sku({ defindex: 1, quality: 6, paint: 14 }));
    expect(fromString('1;6;uncraftable')).toEqual(sku({ defindex: 1, quality: 6, craftable: false }));
    expect(fromString('1;6;u1')).toEqual(sku({ defindex: 1, quality: 6, effect: 1 }));
  });

  it('distinguishes od/oq from other prefixes', () => {
    const o = fromString('20005;6;td-205;od-6522;oq-6');
    expect(o.target).toBe(205);
    expect(o.output).toBe(6522);
    expect(o.outputQuality).toBe(6);
  });

  it('handles short and non-numeric heads like upstream', () => {
    expect(fromString('5021')).toEqual(sku({ defindex: 5021 }));
    expect(fromString('')).toEqual(sku({}));
    expect(fromString('abc;6')).toEqual(sku({ quality: 6 }));
    expect(fromString('5021;abc;u13')).toEqual(sku({ defindex: 5021, effect: 13 }));
    expect(fromString('5021;6;')).toEqual(sku({ defindex: 5021, quality: 6 }));
    // No trimming upstream: a leading space makes the defindex non-numeric.
    expect(fromString(' 5021;6').defindex).toBe(0);
  });

  it('round-trips a deterministic sample of random objects', () => {
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const maybe = (n: number): number | null => (rand(2) ? rand(n) + 1 : null);
    for (let i = 0; i < 500; i++) {
      const o = sku({
        defindex: rand(40000),
        quality: rand(16),
        craftable: rand(4) !== 0,
        tradable: rand(8) !== 0,
        killstreak: rand(4),
        australium: rand(6) === 0,
        effect: maybe(3300),
        festive: rand(6) === 0,
        paintkit: rand(2) ? rand(400) : null,
        wear: maybe(5),
        quality2: rand(5) === 0 ? 11 : null,
        craftnumber: maybe(1000),
        crateseries: maybe(120),
        target: maybe(30000),
        output: maybe(7000),
        outputQuality: maybe(15),
        paint: maybe(16777215),
      });
      const v3 = fromObject(o);
      const legacy = fromObject(o, true);
      expect(fromString(v3)).toEqual(o);
      expect(fromString(legacy)).toEqual(o);
      expect(canonical(legacy)).toBe(v3);
      expect(looksLikeSku(v3)).toBe(true);
      expect(isValidSku(v3), v3).toBe(true);
      expect(isValidSku(legacy), legacy).toBe(true);
    }
  });
});

describe('helpers', () => {
  it('normalizeSkuObject fills defaults and drops unknown keys without mutating', () => {
    const input = { defindex: 5021, quality: 6, bogus: 1 } as unknown as Partial<SkuObject>;
    const out = normalizeSkuObject(input);
    expect(out).toEqual(sku({ defindex: 5021, quality: 6 }));
    expect('bogus' in out).toBe(false);
    expect(input).toEqual({ defindex: 5021, quality: 6, bogus: 1 });
  });

  it('normalizeSkuObject keeps explicit nulls and treats undefined as missing', () => {
    const out = normalizeSkuObject({ defindex: 1, quality: 6, effect: undefined, craftable: undefined });
    expect(out.effect).toBeNull();
    expect(out.craftable).toBe(true);
  });

  it('baseSku removes only the paint token', () => {
    expect(baseSku('378;6;p16738740')).toBe('378;6');
    expect(baseSku('378;5;u13;strange;p16738740')).toBe('378;5;u13;strange');
    expect(baseSku('5021;6')).toBe('5021;6');
    expect(baseSku(fromString('378;6;uncraftable;p3100495'))).toBe('378;6;uncraftable');
    // Re-orders as a side effect.
    expect(baseSku('378;5;strange;u13')).toBe('378;5;u13;strange');
  });

  it('canonical re-orders and toLegacy converts', () => {
    expect(canonical('378;5;strange;u13')).toBe('378;5;u13;strange');
    expect(canonical('205;11;kt-3;australium')).toBe('205;11;australium;kt-3');
    expect(canonical('15000;15;pk14;w1;u701')).toBe('15000;15;u701;w1;pk14');
    expect(toLegacy('200;6;n100;uncraftable')).toBe('200;6;uncraftable;n100');
  });

  it.each([
    ['5021;6', true],
    ['  5021;6  ', true],
    ['378;5;u13;strange', true],
    ['20003;6;kt-3;td-205;od-6526;oq-6', true],
    ['378;5;UNCRAFTABLE', true],
    ['5021', false],
    ['5021;', false],
    ['5021;6;', false],
    ['Team Captain', false],
    ['378;5;u 13', false],
    ['378;5;u13;p#ff0000', false],
    ['', false],
  ])('looksLikeSku(%j) is %s', (text, expected) => {
    expect(looksLikeSku(text)).toBe(expected);
  });
});

describe('isValidSku (strict check for typed SKUs)', () => {
  it.each([
    '5021;6',
    '  5021;6  ',
    '378;5;u13;strange',
    '378;5;strange;u13',
    '205;11;kt-3;australium',
    '205;11;kt3;australium',
    '378;6;uncraftable',
    '378;6;untradeable',
    '378;6;untradable;p16738740',
    '20003;6;kt-3;td-205;od-6526;oq-6',
    '20003;6;kt3;td205;od6526;oq6',
    '15000;15;u701;w1;pk14',
    '15000;15;pk0',
    '5734;6;c82',
    '200;6;n100;uncraftable',
    '1178;15;w1;pk390;kt-3;festive',
  ])('accepts %j', (text) => {
    expect(isValidSku(text)).toBe(true);
  });

  it.each([
    // fromString matches tokens case-sensitively and would drop these.
    ['378;6;UNCRAFTABLE', '378;6'],
    ['205;11;KT-3', '205;11'],
    ['378;5;U13', '378;5'],
    ['15000;15;W1;PK14', '15000;15'],
    // Unknown or misspelt tokens.
    ['378;6;uncratable', '378;6'],
    ['378;6;foo', '378;6'],
    // Repeated fields: the last one wins upstream.
    ['378;5;u13;u14', '378;5;u14'],
    // Values canonical() drops or rewrites.
    ['378;5;u0', '378;5'],
    ['205;11;kt-0', '205;11'],
    ['378;5;u013', '378;5;u13'],
    ['0378;6', '378;6'],
    ['205;11;kt--3', '205;11;kt--3'],
    ['20003;6;td--205', '20003;6;td--205'],
  ])('rejects %j (fromString reads it as %j)', (text, readAs) => {
    expect(canonical(text)).toBe(readAs);
    expect(looksLikeSku(text)).toBe(true);
    expect(isValidSku(text)).toBe(false);
  });

  it.each(['5021', '5021;6;', 'Team Captain', '378;5;u 13', '', '378;5;u13;p#ff0000'])('rejects non-SKU text %j', (text) => {
    expect(isValidSku(text)).toBe(false);
  });

  it('accepts the lower-cased form of an upper-case SKU', () => {
    expect(isValidSku('378;6;UNCRAFTABLE'.toLowerCase())).toBe(true);
    expect(canonical('205;11;KT-3'.toLowerCase())).toBe('205;11;kt-3');
  });

  it('leaves fromString a faithful port: unknown and upper-case tokens are still ignored', () => {
    expect(fromString('378;6;UNCRAFTABLE')).toEqual(sku({ defindex: 378, quality: 6 }));
    expect(fromString('378;6;uncratable')).toEqual(sku({ defindex: 378, quality: 6 }));
  });
});
