// F7 pure helpers: the bulk-paste grammar and its R10 refusal, the price-sheet
// CSV, and the rules backup round trip.

import { describe, expect, it } from 'vitest';
import {
  MAX_BULK_BYTES,
  MAX_BULK_LINES,
  MAX_IMPORT_RULES,
  MAX_SKIP_REASONS,
  PAGE_CONTENT_REFUSAL,
  RULES_BACKUP_FORMAT,
  looksLikePageContent,
  parseBulkPrices,
  pricesCsv,
  rulesFromJson,
  rulesToJson,
} from '../../src/service/priceSheetIo';
import { CSV_BOM } from '../../src/service/domain/csv';
import { fromString } from '../../src/shared/sku';
import type { Category, PriceRule, ResolvedItem, ScrapPrice } from '../../src/shared/types';

const BOM = String.fromCharCode(0xfeff);

function item(sku: string, name: string, over: Partial<ResolvedItem> = {}): ResolvedItem {
  return { sku, name, skuObject: fromString(sku), category: 'hats' as Category, match: 'exact', warnings: [], ...over };
}

const ITEMS: Record<string, ResolvedItem> = {
  'team captain': item('378;6', 'Team Captain'),
  '378;6': item('378;6', 'Team Captain', { match: 'sku' }),
  '378;6;p15185211': item('378;6;p15185211', 'Painted Team Captain', { match: 'sku' }),
  'rock, paper, scissors': item('1110;6', 'Taunt: Rock, Paper, Scissors', { category: 'taunts' }),
  'strange rocket launcher': item('18;11', 'Strange Rocket Launcher', { category: 'stranges' }),
  '18;11': item('18;11', 'Strange Rocket Launcher', { match: 'sku', category: 'stranges' }),
  'mann co. supply crate key': item('5021;6', 'Mann Co. Supply Crate Key', { category: 'other' }),
  '5021;6': item('5021;6', 'Mann Co. Supply Crate Key', { match: 'sku', category: 'other' }),
  'https://marketplace.tf/items/tf2/5021;6': item('5021;6', 'Mann Co. Supply Crate Key', { match: 'sku', category: 'other' }),
  'https://backpack.tf/stats/unique/team%20captain/tradable/craftable': item('378;6', 'Team Captain'),
  'team captian': item('378;6', 'Team Captain', { match: 'fuzzy', warnings: ['No exact item named "Team Captian"; using the closest match "Team Captain"'] }),
  'unusual team captain': item('378;5', 'Unusual Team Captain', { warnings: ['Unusual without an effect: the effect is unknown'] }),
  'blu team captain': item('378;5;u3002', 'Burning Team Captain', { warnings: ['Effect 3001 is the BLU twin of 3002; using 3002'] }),
};
const lookups: string[] = [];
const resolve = (t: string): ResolvedItem | null => {
  lookups.push(t);
  return ITEMS[t.trim().toLowerCase()] ?? null;
};

const parse = (text: string, unit: 'ref' | 'scrap' | 'keys' = 'ref') => parseBulkPrices(text, unit, resolve);
const one = (text: string, unit: 'ref' | 'scrap' | 'keys' = 'ref') => {
  const r = parse(text, unit);
  expect(r.refusal).toBeNull();
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!;
};

describe('parseBulkPrices grammar', () => {
  it('reads every separator: tab, comma, semicolon, equals, at and a spaced dash', () => {
    for (const sep of ['\t', ',', ';', '=', '@', ' - ', ' , ', '\t\t']) {
      expect(one(`Team Captain${sep}1 key 5 ref`)).toMatchObject({ sku: '378;6', name: 'Team Captain', costKeys: 1, costScrap: 45, error: null });
    }
  });

  it('uses the last price-looking words when there is no separator', () => {
    expect(one('Team Captain 2 keys 5.11')).toMatchObject({ sku: '378;6', costKeys: 2, costScrap: 46, error: null });
    expect(one('Strange Rocket Launcher 14s')).toMatchObject({ sku: '18;11', costKeys: 0, costScrap: 14 });
    expect(one('Mann Co. Supply Crate Key 50')).toMatchObject({ sku: '5021;6', costScrap: 450 });
  });

  it('keeps commas inside names and prices ("Rock, Paper, Scissors", "1 key, 2.33 ref")', () => {
    expect(one('Rock, Paper, Scissors, 1 key, 2.33 ref')).toMatchObject({ sku: '1110;6', costKeys: 1, costScrap: 21, error: null });
    expect(one('Team Captain, 1 key, 2.33 ref')).toMatchObject({ sku: '378;6', costKeys: 1, costScrap: 21 });
    expect(one('"Rock, Paper, Scissors","1 key, 5 ref"')).toMatchObject({ sku: '1110;6', costKeys: 1, costScrap: 45 });
  });

  it('reads SKUs and item links whose own ";" is not the separator', () => {
    expect(one('5021;6, 50 ref')).toMatchObject({ sku: '5021;6', costScrap: 450, error: null });
    expect(one('5021;6;50')).toMatchObject({ sku: '5021;6', costScrap: 450 });
    expect(one('378;6\t1.33')).toMatchObject({ sku: '378;6', costScrap: 12 });
    expect(one('https://marketplace.tf/items/tf2/5021;6 = 50 ref')).toMatchObject({ sku: '5021;6', costScrap: 450 });
    expect(one('https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable 1.33')).toMatchObject({ sku: '378;6', costScrap: 12 });
  });

  it('applies the bare unit only to bare numbers', () => {
    expect(one('Team Captain, 12', 'scrap')).toMatchObject({ costKeys: 0, costScrap: 12 });
    expect(one('Team Captain, 12', 'ref')).toMatchObject({ costKeys: 0, costScrap: 108 });
    expect(one('Team Captain, 1.5', 'keys')).toMatchObject({ costKeys: 1.5, costScrap: 0 });
    expect(one('Team Captain, 3 rec', 'keys')).toMatchObject({ costKeys: 0, costScrap: 9 });
  });

  it('skips blank and # lines, keeps 1-based line numbers and the raw text', () => {
    const r = parse('# my list\r\n\r\nTeam Captain, 1.33\n   \n\tStrange Rocket Launcher = 2 ref  \r# end');
    expect(r.refusal).toBeNull();
    expect(r.rows.map((x) => [x.line, x.raw, x.sku])).toEqual([
      [3, 'Team Captain, 1.33', '378;6'],
      [5, '\tStrange Rocket Launcher = 2 ref  ', '18;11'],
    ]);
    expect(r.rejected).toBe(0);
  });

  it('reads text copied out of a CSV export (byte-order mark)', () => {
    expect(one(BOM + 'Team Captain, 1.33')).toMatchObject({ line: 1, sku: '378;6', costScrap: 12 });
  });

  it('marks lines it cannot save, with the reason, and never gives them a SKU', () => {
    const r = parse(
      [
        'Team Captain', // no price
        'Banana Hat, 5 ref', // not an item
        'Team Captain, lots', // not a price
        'Team Captian, 5 ref', // only a guess
        'Unusual Team Captain, 40 keys', // incomplete SKU
        'Team Captain, 0', // zero
        'x'.repeat(700) + ', 5 ref', // too long
      ].join('\n'),
    );
    expect(r.rows.map((x) => x.error)).toEqual([
      'No price found (e.g. "Team Captain, 1 key 5 ref")',
      'Item not recognised: Banana Hat',
      'No price found (e.g. "Team Captain, 1 key 5 ref")',
      'Closest match only ("Team Captain"). Use the exact name, a SKU or an item link',
      'Unusual without an effect: the effect is unknown',
      'The price is 0',
      'Line is longer than 600 characters',
    ]);
    expect(r.rows.every((x) => x.sku === null)).toBe(true);
    expect(r.rejected).toBe(7);
    // The parsed price and the matched name are still shown in the preview.
    expect(r.rows[3]).toMatchObject({ name: 'Team Captain', costScrap: 45 });
    expect(r.rows[4]).toMatchObject({ name: 'Unusual Team Captain', costKeys: 40 });
  });

  it('accepts informational resolver notes (BLU effect twin)', () => {
    expect(one('BLU Team Captain, 40 keys')).toMatchObject({ sku: '378;5;u3002', error: null, costKeys: 40 });
  });

  it('keeps every line of an item pasted twice saveable (the dashboard uses the last one)', () => {
    const r = parse('Team Captain, 1.33\n378;6, 1.44\nTeam Captain, 1.55');
    expect(r.rows.map((x) => [x.line, x.sku, x.costScrap, x.error])).toEqual([
      [1, '378;6', 12, null],
      [2, '378;6', 13, null],
      [3, '378;6', 14, null],
    ]);
    expect(r.rejected).toBe(0);
  });

  it('prefers the split whose item resolves when several splits give a price', () => {
    // ";" first gives "5021" + "6, ..." (not a price); the comma split resolves.
    expect(one('5021;6, 2 keys')).toMatchObject({ sku: '5021;6', costKeys: 2 });
  });

  it('survives a resolver that throws', () => {
    const r = parseBulkPrices('Team Captain, 1.33', 'ref', () => {
      throw new Error('schema not loaded');
    });
    expect(r.rows[0]).toMatchObject({ sku: null, error: 'Item not recognised: Team Captain' });
  });

  it('bounds the work on a line full of separators', () => {
    lookups.length = 0;
    const r = parse(`${',1'.repeat(250)}`);
    expect(r.rows).toHaveLength(1);
    expect(lookups.length).toBeLessThanOrEqual(6);
  });

  it('bounds the item lookups of a whole paste of unknown items', () => {
    lookups.length = 0;
    const r = parse(Array.from({ length: MAX_BULK_LINES }, (_, i) => `Banana Hat ${i}, 1 key, 5 ref`).join('\n'));
    expect(r.rejected).toBe(MAX_BULK_LINES);
    // One lookup per line plus a shared allowance of two per line for the other splits.
    expect(lookups.length).toBeLessThanOrEqual(MAX_BULK_LINES * 3);
    expect(lookups.length).toBeGreaterThan(MAX_BULK_LINES);
  });
});

describe('parseBulkPrices refusals (R10 and limits)', () => {
  it('refuses page content as a whole', () => {
    for (const text of [
      'Team Captain, 1.33\n<div class="item">Team Captain</div>',
      'Team Captain, 1.33\nhttps://scrap.tf/hats',
      'see SCRAP.TF/buy/hats',
      'https://scrap.tf, 5 ref',
      'http://www.scrap.tf?x=1 5 ref',
      'a < b',
    ]) {
      const r = parse(text);
      expect(r).toEqual({ rows: [], rejected: 0, refusal: PAGE_CONTENT_REFUSAL });
    }
    expect(looksLikePageContent('Team Captain, 1.33')).toBe(false);
    // Item links from other sites are fine.
    expect(looksLikePageContent('https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable 1.33')).toBe(false);
  });

  it('refuses more than 500 item lines, but not comments or blanks', () => {
    const ok = Array.from({ length: MAX_BULK_LINES }, () => 'Team Captain, 1.33').join('\n') + '\n# note\n\n';
    expect(parse(ok).refusal).toBeNull();
    const tooMany = Array.from({ length: MAX_BULK_LINES + 1 }, () => 'Team Captain, 1.33').join('\n');
    const r = parse(tooMany);
    expect(r.rows).toEqual([]);
    expect(r.refusal).toBe('That paste has 501 lines; at most 500 per paste.');
  });

  it('refuses more than 100 KB (UTF-8 bytes)', () => {
    const r = parse('é'.repeat(MAX_BULK_BYTES / 2 + 1));
    expect(r.rows).toEqual([]);
    expect(r.refusal).toMatch(/100 KB/);
    expect(parse('#' + 'x'.repeat(MAX_BULK_BYTES - 1)).refusal).toBeNull();
  });
});

describe('pricesCsv', () => {
  const base: ScrapPrice = {
    id: 1,
    sku: '378;6',
    name: 'Team Captain',
    costKeys: 0,
    costScrap: 12,
    source: 'user',
    observedAt: Date.UTC(2026, 9, 14, 12, 0, 0),
    note: null,
    importBatch: null,
    special: null,
    assetId: null,
    stock: null,
  };

  it('writes BOM, CRLF and one row per price sorted by name', () => {
    const csv = pricesCsv(
      [
        { ...base, id: 2, sku: '5021;6', name: 'Mann Co. Supply Crate Key', costKeys: 1, costScrap: 9, source: 'import', stock: 3, note: '=HYPERLINK("x")' },
        { ...base, special: { paint: 15185211, spells: ['Exorcism'], parts: ['Kills', 'Robots'], sheen: null, killstreaker: null, customName: false, customDesc: false } },
      ],
      450,
    );
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('id,sku,name,cost,cost_keys,cost_metal_ref,cost_ref,key_price_ref,source,observed_at,note,stock,asset_id,paint,spells,parts');
    expect(lines[1]).toBe('2,5021;6,Mann Co. Supply Crate Key,1 key 1.00 ref,1,1,51,50,import,2026-10-14T12:00:00.000Z,"\'=HYPERLINK(""x"")",3,,,,');
    // The SKU carries the paint, as the user priced it.
    expect(lines[2]).toBe('1,378;6;p15185211,Team Captain,1.33 ref,0,1.33,1.33,50,user,2026-10-14T12:00:00.000Z,,,,15185211,Exorcism,Kills | Robots');
    expect(lines[3]).toBe('');
  });

  it('leaves the key-valued total empty without a key price, never guesses one', () => {
    const csv = pricesCsv([{ ...base, costKeys: 2, costScrap: 0 }], null);
    const row = csv.slice(CSV_BOM.length).split('\r\n')[1]!;
    expect(row).toBe('1,378;6,Team Captain,2 keys,2,0,,,user,2026-10-14T12:00:00.000Z,,,,,,');
  });

  it('writes a sku and cost that bulk paste reads back exactly, painted copies included', () => {
    const painted = { paint: 15185211, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };
    const prices: [ScrapPrice, string][] = [
      [{ ...base, costKeys: 2, costScrap: 46 }, '378;6'],
      [{ ...base, id: 4, costKeys: 0, costScrap: 30, special: painted }, '378;6;p15185211'],
      [{ ...base, id: 2, sku: '5021;6', name: 'Mann Co. Supply Crate Key', costKeys: 1.5, costScrap: 0 }, '5021;6'],
      [{ ...base, id: 3, sku: '18;11', name: 'Strange Rocket Launcher', costKeys: 0, costScrap: 17 }, '18;11'],
    ];
    const rows = pricesCsv(
      prices.map(([p]) => p),
      450,
    )
      .slice(CSV_BOM.length)
      .split('\r\n')
      .slice(1, -1)
      .map((l) => l.split(','));
    const paste = rows.map((cells) => `${cells[1]}\t${cells[3]}`).join('\n');
    const back = parse(paste, 'scrap').rows;
    expect(back).toHaveLength(prices.length);
    for (const [p, sku] of prices) {
      expect(back.find((r) => r.sku === sku)).toMatchObject({ costKeys: p.costKeys, costScrap: p.costScrap, error: null });
    }
  });
});

describe('rules backup', () => {
  const rules: PriceRule[] = [
    { id: 7, name: 'Craft hats', filter: { categories: ['hats'], craftable: true, nameContains: null }, costKeys: 0, costScrap: 12, observedAt: 1_700_000_000_000, enabled: true },
    { id: 3, name: 'Strange weapons', filter: { qualities: [11], killstreak: [0, 1] }, costKeys: 1, costScrap: 0, observedAt: 1_700_000_100_000, enabled: false },
  ];

  it('round-trips name, filter, price, date and the on/off switch, without ids', () => {
    const json = rulesToJson(rules, 1_800_000_000_000);
    const data = JSON.parse(json) as { format: string; version: number; exportedAt: number; rules: Record<string, unknown>[] };
    expect(data).toMatchObject({ format: RULES_BACKUP_FORMAT, version: 1, exportedAt: 1_800_000_000_000 });
    expect(data.rules.map((r) => r['name'])).toEqual(['Strange weapons', 'Craft hats']);
    expect(data.rules.every((r) => !('id' in r))).toBe(true);
    const back = rulesFromJson(json);
    expect(back.skipped).toEqual([]);
    expect(back.rules).toEqual([
      { name: 'Strange weapons', filter: { qualities: [11], killstreak: [0, 1] }, costKeys: 1, costScrap: 0, observedAt: 1_700_000_100_000, enabled: false },
      { name: 'Craft hats', filter: { categories: ['hats'], craftable: true, nameContains: null }, costKeys: 0, costScrap: 12, observedAt: 1_700_000_000_000, enabled: true },
    ]);
  });

  it('reads a bare array and a BOM, drops ids and unknown keys, rounds scrap', () => {
    const back = rulesFromJson(BOM + JSON.stringify([{ id: 99, name: '  Hats ', filter: { categories: ['hats'], bogus: 1 }, costScrap: 12.4, extra: true }]));
    expect(back).toEqual({ rules: [{ name: 'Hats', filter: { categories: ['hats'] }, costScrap: 12 }], skipped: [] });
  });

  it('skips invalid rules with a reason and keeps the valid ones', () => {
    const back = rulesFromJson(
      JSON.stringify({
        format: RULES_BACKUP_FORMAT,
        version: 1,
        rules: [
          { name: 'ok', filter: {}, costScrap: 9 },
          { name: '', filter: {}, costScrap: 9 },
          { name: 'Negative', filter: {}, costScrap: -1 },
          { name: 'Bad category', filter: { categories: ['boats'] }, costScrap: 9 },
          { name: 'No filter', costScrap: 9 },
          'junk',
        ],
      }),
    );
    expect(back.rules.map((r) => r.name)).toEqual(['ok']);
    expect(back.skipped).toHaveLength(5);
    expect(back.skipped[0]).toMatch(/^Rule 2: name: /);
    expect(back.skipped[1]).toMatch(/^"Negative": costScrap: must be zero or more/);
    expect(back.skipped[2]).toMatch(/^"Bad category": filter\.categories\.0: /);
    expect(back.skipped[3]).toMatch(/^"No filter": filter: /);
    expect(back.skipped[4]).toMatch(/^Rule 6: /);
  });

  it('refuses files that are not a rules backup', () => {
    expect(() => rulesFromJson('not json')).toThrow('Not a rules backup: the file is not valid JSON.');
    expect(() => rulesFromJson('{"rules": 3}')).toThrow('Not a rules backup: no "rules" list found.');
    expect(() => rulesFromJson('"text"')).toThrow(/no "rules" list/);
    expect(() => rulesFromJson(JSON.stringify({ format: 'something-else', rules: [] }))).toThrow('Not a TF2 Flip Desk rules backup.');
    expect(() => rulesFromJson(JSON.stringify({ format: RULES_BACKUP_FORMAT, version: 2, rules: [] }))).toThrow(/newer version/);
  });

  it('caps what one import adds and how many reasons it lists', () => {
    const many = Array.from({ length: MAX_IMPORT_RULES + 5 }, (_, i) => ({ name: `r${i}`, filter: {}, costScrap: 1 }));
    const r = rulesFromJson(JSON.stringify(many));
    expect(r.rules).toHaveLength(MAX_IMPORT_RULES);
    expect(r.skipped).toEqual([`5 more rules left out: at most ${MAX_IMPORT_RULES} per import`]);

    const bad = Array.from({ length: MAX_SKIP_REASONS + 10 }, () => ({ name: 'x', filter: {}, costScrap: -1 }));
    const b = rulesFromJson(JSON.stringify(bad));
    expect(b.rules).toEqual([]);
    expect(b.skipped).toHaveLength(MAX_SKIP_REASONS + 1);
    expect(b.skipped.at(-1)).toBe('10 more rules skipped as invalid');
  });
});
