import { describe, expect, it } from 'vitest';
import {
  SCRAP_PER_REF,
  formatKeysMetal,
  formatRef,
  formatScrap,
  parsePrice,
  refToScrap,
  scrapToRef,
  splitKeys,
  valueScrap,
} from '../../src/shared/currency';

const KEY = 540; // 60 ref

describe('refToScrap / scrapToRef', () => {
  it('uses 9 scrap per refined', () => {
    expect(SCRAP_PER_REF).toBe(9);
  });

  it.each([
    [0, 0],
    [1, 0.11],
    [2, 0.22],
    [3, 0.33],
    [4, 0.44],
    [5, 0.55],
    [6, 0.66],
    [7, 0.77],
    [8, 0.88],
    [9, 1],
    [12, 1.33],
    [15, 1.66],
    [17, 1.88],
    [46, 5.11],
    [567, 63],
    [574, 63.77],
    [579, 64.33],
    [267, 29.66],
  ])('%i scrap <-> %d ref', (scrap, ref) => {
    expect(scrapToRef(scrap)).toBe(ref);
    expect(refToScrap(ref)).toBe(scrap);
  });

  it('round-trips every remainder 0..8 across a range of whole refined values', () => {
    for (const whole of [0, 1, 2, 9, 10, 63, 64, 99, 1000, 123456]) {
      for (let rest = 0; rest <= 8; rest++) {
        const s = whole * 9 + rest;
        const ref = scrapToRef(s);
        expect(ref).toBe(Number((whole + rest * 0.11).toFixed(2)));
        expect(refToScrap(ref)).toBe(s);
        expect(refToScrap(-ref)).toBe(-s);
        expect(scrapToRef(-s)).toBe(s === 0 ? 0 : -ref);
      }
    }
  });

  it('round-trips every scrap value from -2000 to 2000', () => {
    for (let s = -2000; s <= 2000; s++) expect(refToScrap(scrapToRef(s))).toBe(s);
  });

  it('rounds non-integer scrap before converting', () => {
    expect(scrapToRef(11.6)).toBe(1.33);
    expect(scrapToRef(11.4)).toBe(1.22);
  });

  it('rounds refined to the nearest scrap (pricedb truncates to 2 decimals)', () => {
    expect(refToScrap(1.33)).toBe(12);
    expect(refToScrap(64.33)).toBe(579);
    expect(refToScrap(0.11)).toBe(1);
    expect(refToScrap(1.1)).toBe(10);
    expect(refToScrap(1.5)).toBe(14);
  });

  it('returns 0 for non-finite refined', () => {
    expect(refToScrap(Number.NaN)).toBe(0);
    expect(refToScrap(Number.POSITIVE_INFINITY)).toBe(0);
    expect(refToScrap(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('formatRef', () => {
  it.each([
    [0, '0.00 ref'],
    [1, '0.11 ref'],
    [9, '1.00 ref'],
    [12, '1.33 ref'],
    [46, '5.11 ref'],
    [-12, '-1.33 ref'],
  ])('%i -> %s', (scrap, text) => {
    expect(formatRef(scrap)).toBe(text);
  });
});

describe('valueScrap / splitKeys', () => {
  it('values keys with the given key price', () => {
    expect(valueScrap(2, 46, KEY)).toBe(1126);
    expect(valueScrap(1.5, 0, KEY)).toBe(810);
    expect(valueScrap(0, 46, KEY)).toBe(46);
    expect(valueScrap(0.333, 0, 100)).toBe(33);
  });

  it('treats missing parts as zero', () => {
    expect(valueScrap(Number.NaN, 5, KEY)).toBe(5);
    expect(valueScrap(1, Number.NaN, KEY)).toBe(KEY);
  });

  it.each([
    [0, { keys: 0, scrap: 0 }],
    [539, { keys: 0, scrap: 539 }],
    [540, { keys: 1, scrap: 0 }],
    [1126, { keys: 2, scrap: 46 }],
    [-552, { keys: -1, scrap: -12 }],
    [-12, { keys: 0, scrap: -12 }],
  ])('splits %i', (total, expected) => {
    expect(splitKeys(total, KEY)).toEqual(expected);
  });

  it('does not split with a missing or invalid key price', () => {
    expect(splitKeys(1126, 0)).toEqual({ keys: 0, scrap: 1126 });
    expect(splitKeys(1126, -5)).toEqual({ keys: 0, scrap: 1126 });
  });
});

describe('formatScrap', () => {
  it.each([
    [46, null, '5.11 ref'],
    [46, KEY, '5.11 ref'],
    [539, KEY, '59.88 ref'],
    [540, KEY, '1 key'],
    [1080, KEY, '2 keys'],
    [1126, KEY, '2 keys 5.11 ref'],
    [552, KEY, '1 key 1.33 ref'],
    [-552, KEY, '-1 key 1.33 ref'],
    [-1126, KEY, '-2 keys 5.11 ref'],
    [-1080, KEY, '-2 keys'],
    [-12, KEY, '-1.33 ref'],
    [-12, null, '-1.33 ref'],
    [0, KEY, '0.00 ref'],
    [5000, 0, '555.55 ref'],
    [1126, -5, '125.11 ref'],
  ] as [number, number | null, string][])('formatScrap(%i, %s) = %s', (total, key, text) => {
    expect(formatScrap(total, key)).toBe(text);
  });

  it('shows a dash for missing values', () => {
    expect(formatScrap(null, KEY)).toBe('—');
    expect(formatScrap(undefined)).toBe('—');
    expect(formatScrap(Number.NaN, KEY)).toBe('—');
    expect(formatScrap(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatKeysMetal', () => {
  it.each([
    [0, 0, '0.00 ref'],
    [0, 46, '5.11 ref'],
    [1, 0, '1 key'],
    [2, 0, '2 keys'],
    [1.5, 0, '1.5 keys'],
    [2, 46, '2 keys 5.11 ref'],
    [0.333333, 9, '0.33 keys 1.00 ref'],
  ])('formatKeysMetal(%d, %i) = %s', (keys, metal, text) => {
    expect(formatKeysMetal(keys, metal)).toBe(text);
  });
});

describe('parsePrice', () => {
  type Row = [string, number, number, boolean];
  const table: Row[] = [
    // text, keys, scrap, ambiguous
    ['12', 0, 108, true],
    ['0', 0, 0, true],
    ['1.33', 0, 12, false],
    ['1.33 ref', 0, 12, false],
    ['1.33ref', 0, 12, false],
    ['1.33 refined', 0, 12, false],
    ['1.33r', 0, 12, false],
    ['10 REF', 0, 90, false],
    ['0.11', 0, 1, false],
    ['14 scrap', 0, 14, false],
    ['14s', 0, 14, false],
    ['5 s', 0, 5, false],
    ['3 rec', 0, 9, false],
    ['3 reclaimed', 0, 9, false],
    ['2 keys', 2, 0, false],
    ['2 key', 2, 0, false],
    ['2keys', 2, 0, false],
    ['2k', 2, 0, false],
    ['1 K', 1, 0, false],
    ['1.5 keys', 1.5, 0, false],
    ['2 keys 5.11', 2, 46, false],
    ['2k 5.11 ref', 2, 46, false],
    ['1 key, 2.33ref', 1, 21, false],
    ['1.33 ref 2 keys', 2, 12, false],
    ['2 keys 3 rec 2 scrap', 2, 11, false],
    ['12 scrap 1 ref', 0, 21, false],
    ['2 keys 1', 2, 9, false],
    ['  2   keys    5.11  ', 2, 46, false],
  ];

  it.each(table)('parses %j', (text, keys, scrap, ambiguous) => {
    const p = parsePrice(text);
    expect(p).not.toBeNull();
    expect(p!.keys).toBe(keys);
    expect(p!.scrap).toBe(scrap);
    expect(p!.ambiguous).toBe(ambiguous);
    expect(p!.display).toBe(formatKeysMetal(keys, scrap));
  });

  it('uses the bare unit for a lone number', () => {
    expect(parsePrice('12', 'scrap')).toEqual({ keys: 0, scrap: 12, display: '1.33 ref', ambiguous: true });
    expect(parsePrice('1.5', 'keys')).toEqual({ keys: 1.5, scrap: 0, display: '1.5 keys', ambiguous: true });
    expect(parsePrice('1.33', 'scrap')).toEqual({ keys: 0, scrap: 1, display: '0.11 ref', ambiguous: true });
    // A number after an explicit unit is always refined, whatever the bare unit.
    expect(parsePrice('2 keys 5.11', 'scrap')).toMatchObject({ keys: 2, scrap: 46, ambiguous: false });
  });

  it('formats the display text', () => {
    expect(parsePrice('2k 5.11')?.display).toBe('2 keys 5.11 ref');
    expect(parsePrice('1 key')?.display).toBe('1 key');
    expect(parsePrice('14s')?.display).toBe('1.55 ref');
  });

  it.each([
    '',
    '   ',
    ',',
    'abc',
    'ref',
    'keys',
    '1.33.5',
    '1e3',
    '5 ref 5 ref',
    '2 keys 2 keys',
    '2 keys and 5 ref',
    '3 refs',
    '2 keys5.11',
    '1 kit',
    '-5',
  ])('rejects %j', (text) => {
    expect(parsePrice(text)).toBeNull();
  });

  it('tolerates non-string input at runtime', () => {
    expect(parsePrice(undefined as unknown as string)).toBeNull();
    expect(parsePrice(null as unknown as string)).toBeNull();
  });

  // BUG (reported): the unit regexes only capture \d+(\.\d+)?, so a leading
  // "." or "-" is left behind as punctuation and the remainder is accepted.
  // ".5 keys" becomes 5 keys (10x), "-5 ref" becomes +5 ref, and the
  // `keys < 0 || scrap < 0` guard can never trigger.
  it('".5 keys" parses as half a key', () => {
    const p = parsePrice('.5 keys');
    expect(p === null || p.keys === 0.5).toBe(true);
  });

  it('"-5 ref" is rejected', () => {
    expect(parsePrice('-5 ref')).toBeNull();
  });

  // A decimal comma ("1,5 keys", common outside the US) must not become
  // 5 keys + 1 ref.
  it('"1,5 keys" is a decimal comma', () => {
    const p = parsePrice('1,5 keys');
    expect(p === null || p.keys === 1.5).toBe(true);
    expect(parsePrice('1,5 keys')).toMatchObject({ keys: 1.5, scrap: 0 });
  });

  // A thousands separator must not split one number in two: "2,000 keys" was
  // read as 0 keys + 2 ref, "1,200 keys" as 200 keys + 1 ref.
  it.each<[string, number, number]>([
    ['2,000 keys', 2000, 0],
    ['1,200 keys', 1200, 0],
    ['4,583.41 ref', 0, 41251],
    ['1,278.85 ref', 0, 11510],
    ['1,000,000 ref', 0, 9_000_000],
    ['1,200 keys, 5 ref', 1200, 45],
    ['12 keys, 5.11 ref', 12, 46],
    ['48 keys, 10 ref', 48, 90],
  ])('reads thousands separators in %j', (text, keys, scrap) => {
    expect(parsePrice(text)).toMatchObject({ keys, scrap });
  });

  it.each(['2 000 keys', '1, 5 keys', '1,2345 ref', '2 5.11'])('rejects two numbers with no unit between them: %j', (text) => {
    expect(parsePrice(text)).toBeNull();
  });
});
