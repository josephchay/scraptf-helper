// F16 live check parser (parseCheckText): the four text forms (an item alone, "<item> <sep> <price>",
// a copied scrap.tf/items row, name then price on two lines), the refusals every path applies, scrap.tf
// links as not-item (never resolved or fetched), and fuzzy guesses accepted only when confirmed
// unique. No reason ever quotes the text. A stub resolver pins the grammar; the real schema service
// (fixture subset, fake HTTP) checks realistic copies. No network.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import {
  CHECK_MAX_RESOLVES,
  CHECK_SCRAPTF_LINK_REASON,
  parseCheckText,
  type ParseCheckResult,
  type ParsedCheck,
} from '../../src/service/domain/liveCheck';
import { CHECK_MAX_CHARS, CHECK_NOT_ITEM_REASON, CHECK_REFUSALS } from '../../src/shared/check';
import { fromString } from '../../src/shared/sku';
import type { ResolvedItem } from '../../src/shared/types';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const item = (sku: string, name: string, match: ResolvedItem['match'] = 'exact', warnings: string[] = []): ResolvedItem => ({
  sku,
  name,
  skuObject: fromString(sku),
  category: 'hats',
  match,
  warnings,
});

const NAMES: Record<string, ResolvedItem> = {
  'team captain': item('378;6', 'Team Captain'),
  "bill's hat": item('126;6', "Bill's Hat"),
  'tough break key': item('5833;6', 'Tough Break Key'),
  'crocodile dandy': item('31193;6', 'Crocodile Dandy'),
  'rock, paper, scissors': item('1157;6', 'Rock, Paper, Scissors'),
  'strange professional killstreak rocket launcher': item('205;11;kt-3', 'Strange Professional Killstreak Rocket Launcher'),
  'mann co. supply crate series #30': item('5022;6;c30', 'Mann Co. Supply Crate Series #30'),
  'https://backpack.tf/stats/unique/team%20captain/tradable/craftable': item('378;6', 'Team Captain'),
  'https://marketplace.tf/items/tf2/378;6': item('378;6', 'Team Captain', 'sku'),
  // A guess with nothing else wrong, and one that is also incomplete.
  'team captian': item('378;6', 'Team Captain', 'fuzzy', ['No exact item named "team captian"; using the closest match "Team Captain"']),
  'unusual team captian': item('378;5', 'Unusual Team Captain', 'fuzzy', [
    'No exact item named "team captian"; using the closest match "Team Captain"',
    'Unusual without an effect: the effect is unknown',
  ]),
  // scrap.tf's own spelling: the resolver's closest match is the same name but for punctuation.
  'bills hat': item('126;6', "Bill's Hat", 'fuzzy', ['No exact item named "bills hat"; using the closest match "Bill\'s Hat"']),
  'strange bills hat': item('126;11', "Strange Bill's Hat", 'fuzzy', ['No exact item named "bills hat"; using the closest match "Bill\'s Hat"']),
  // Exact, but missing a part (the resolver says so), or carrying only an informational note.
  'unusual team captain': item('378;5', 'Unusual Team Captain', 'exact', ['Unusual without an effect: the effect is unknown']),
  'mann co. supply crate': item('5022;6', 'Mann Co. Supply Crate', 'exact', ['Mann Co. Supply Crate: series number missing']),
  'burning flames team captain': item('378;5;u13', 'Burning Flames Team Captain', 'exact', ['Effect 13 is the BLU twin of 13; using 13']),
};

function resolve(t: string): ResolvedItem | null {
  const s = t.replace(/\s+/g, ' ').trim().toLowerCase();
  if (Object.hasOwn(NAMES, s)) return NAMES[s]!;
  if (/^\d+;\d+(;[a-z0-9-]+)*$/.test(s)) return item(s, `Item ${s}`, 'sku');
  return null;
}

function ok(r: ParseCheckResult): ParsedCheck {
  if (!r.ok) throw new Error(`expected an item, got ${r.status}: ${r.reason}`);
  return r.parsed;
}

const parse = (text: string, confirm?: (t: string, i: ResolvedItem) => boolean) => parseCheckText(text, resolve, confirm ? { confirmFuzzy: confirm } : {});
const NOT_ITEM = { ok: false, status: 'not-item', reason: CHECK_NOT_ITEM_REASON };
const ref = (scrap: number) => ({ keys: 0, scrap });

describe('parseCheckText: the item alone (form 1)', () => {
  // 0.7.4: craftStated (F41) says whether the item part names its copy: a SKU or an item link does, a plain name not.
  it.each<[string, string, boolean]>([
    ['Team Captain', '378;6', false],
    ['  team CAPTAIN \u00a0', '378;6', false],
    ['\u200bTeam Captain', '378;6', false],
    ['378;6', '378;6', true],
    ['205;11;kt-3', '205;11;kt-3', true],
    ['Strange Professional Killstreak Rocket Launcher', '205;11;kt-3', false],
    // A name ending in a number is not read as "<name> <price>".
    ['Mann Co. Supply Crate Series #30', '5022;6;c30', false],
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable', '378;6', true],
    // An item link holding a separator (";") resolves as a whole.
    ['https://marketplace.tf/items/tf2/378;6', '378;6', true],
  ])('reads %j as %s', (text, sku, craftStated) => {
    expect(ok(parse(text))).toEqual({
      form: 'name',
      item: expect.objectContaining({ sku }),
      price: null,
      pays: null,
      paysCopied: false,
      stock: null,
      stockLimit: null,
      soldOut: false,
      fuzzy: false,
      incomplete: false,
      craftStated,
      priceAmbiguous: false,
    });
  });

  it('answers not-item for text that names nothing', () => {
    for (const t of ['hello there', '1.33 ref', 'https://example.com/team-captain', '!!!']) expect(parse(t), t).toEqual(NOT_ITEM);
  });
});

describe('parseCheckText: "<item> <sep> <price>" (form 2, the bulk paste grammar)', () => {
  it.each([
    ['Team Captain, 1.33 ref', '378;6', ref(12)],
    ['Team Captain; 1.33', '378;6', ref(12)],
    ['Team Captain = 2 keys', '378;6', { keys: 2, scrap: 0 }],
    ['Team Captain @ 1 key 5.33 ref', '378;6', { keys: 1, scrap: 48 }],
    ['Team Captain - 3 rec', '378;6', ref(9)],
    ['Team Captain\t1.33 ref', '378;6', ref(12)],
    ['Team Captain 1.33', '378;6', ref(12)],
    // Bare numbers are refined.
    ['Team Captain, 5', '378;6', ref(45)],
    ['Rock, Paper, Scissors, 3 ref', '1157;6', ref(27)],
    ['378;6, 1 key, 2 ref', '378;6', { keys: 1, scrap: 18 }],
    ['https://marketplace.tf/items/tf2/378;6, 1.33 ref', '378;6', ref(12)],
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable 1.33 ref', '378;6', ref(12)],
  ])('reads %j', (text, sku, price) => {
    expect(ok(parse(text))).toMatchObject({ form: 'priced', item: { sku }, price, soldOut: false, fuzzy: false });
  });

  it('keeps the item but no price when the copied price is zero', () => {
    expect(ok(parse('Team Captain, 0 ref'))).toMatchObject({ form: 'priced', item: { sku: '378;6' }, price: null });
  });
});

describe('parseCheckText: a copied scrap.tf/items row (form 3)', () => {
  it.each<[string, Partial<ParsedCheck>]>([
    ['Tough Break Key\t1 key, 6 refined\t1 key, 1 refined\t49/50', { price: { keys: 1, scrap: 54 }, pays: { keys: 1, scrap: 9 }, paysCopied: true, stock: 49, stockLimit: 50 }],
    // The limits bar's two numbers on one line.
    ['Team Captain\t1.33 refined\t1.22 refined\t3 5', { price: ref(12), pays: ref(11), paysCopied: true, stock: 3, stockLimit: 5 }],
    // A plain-text copy of the same row: runs of 2+ spaces.
    ['Team Captain   1.33 refined   1.22 refined   3/5', { price: ref(12), pays: ref(11), stock: 3, stockLimit: 5 }],
    ['Team Captain  1.33 ref  1.22 ref  3 / 5', { price: ref(12), pays: ref(11), stock: 3, stockLimit: 5 }],
    ['Team Captain\t1.33 ref\t1.22 ref\t3 of 5', { price: ref(12), pays: ref(11), stock: 3, stockLimit: 5 }],
    // The leading icon cell came along.
    ['\tIcon\tTeam Captain\t1.33 refined\t1.22 refined\t3/5', { price: ref(12), pays: ref(11), stock: 3, stockLimit: 5 }],
    // n and limit as two cells (the limits bar's two numbers).
    ['Team Captain\t1.33 refined\t1.22 refined\t3\t5', { price: ref(12), pays: ref(11), stock: 3, stockLimit: 5 }],
    // No pays column selected.
    ['Team Captain\t1.33 refined\t3/5', { price: ref(12), pays: null, paysCopied: false, stock: 3, stockLimit: 5 }],
    ['Team Captain\t1.33 refined\t1.22 refined', { price: ref(12), pays: ref(11), stock: null, stockLimit: null }],
    // Bare ref prices: an integer before n/limit is what scrap.tf pays.
    ['Team Captain\t2\t1\t3/5', { price: ref(18), pays: ref(9), stock: 3, stockLimit: 5 }],
    // Labelled cells ("we pay").
    ['Team Captain  price to buy: 1.33 ref  we pay: 1.22 ref  3/5', { price: ref(12), pays: ref(11), stock: 3, stockLimit: 5 }],
    // A dash in the pays column still takes it: copied, and scrap.tf pays nothing.
    ['Team Captain\t1.33 ref\t—\t3/5', { price: ref(12), pays: null, paysCopied: true, stock: 3, stockLimit: 5 }],
  ])('reads %j', (text, want) => {
    expect(ok(parse(text))).toMatchObject({ form: 'items-row', item: { sku: text.includes('Tough') ? '5833;6' : '378;6' }, soldOut: false, ...want });
  });

  it('reads a "Sold out" row as no cost, keeping what scrap.tf pays and its stock', () => {
    for (const text of ['Crocodile Dandy\tSold out\t1.33 refined\t0/5', 'Crocodile Dandy   SOLD OUT   1.33 refined   0/5', 'Crocodile Dandy\tsold out']) {
      expect(ok(parse(text)), text).toMatchObject({ form: 'items-row', item: { sku: '31193;6' }, price: null, soldOut: true });
    }
    expect(ok(parse('Crocodile Dandy\tSold out\t1.33 refined\t0/5'))).toMatchObject({ pays: ref(12), stock: 0, stockLimit: 5 });
  });

  it('joins a limits cell that wrapped onto its own lines, and ignores a selected header row', () => {
    expect(ok(parse('Tough Break Key\t1 key, 6 refined\t1 key, 1 refined\t49\n50'))).toMatchObject({ form: 'items-row', stock: 49, stockLimit: 50, pays: { keys: 1, scrap: 9 } });
    expect(ok(parse('Tough Break Key\t1 key, 6 refined\t1 key, 1 refined\n49\n50'))).toMatchObject({ form: 'items-row', stock: 49, stockLimit: 50 });
    expect(ok(parse('Icon\tItem\tPrice to buy\tPrice we pay\tItem Limits\nTeam Captain\t1.33 refined\t1.22 refined\t3/5'))).toMatchObject({
      form: 'items-row',
      item: { sku: '378;6' },
      price: ref(12),
      pays: ref(11),
      stock: 3,
      stockLimit: 5,
    });
  });

  it('is not a row when the second cell is no price', () => {
    expect(parse('Team Captain\tHat\tLevel 1')).toEqual(NOT_ITEM);
  });
});

describe('parseCheckText: name, then price (form 4)', () => {
  it('reads a card tooltip copied as two lines', () => {
    expect(ok(parse('Team Captain\n1.33 ref'))).toMatchObject({ form: 'two-lines', item: { sku: '378;6' }, price: ref(12), soldOut: false });
    expect(ok(parse('Strange Professional Killstreak Rocket Launcher\r\n2 keys, 5 refined\r\n'))).toMatchObject({ form: 'two-lines', price: { keys: 2, scrap: 45 } });
    expect(ok(parse('Team Captain\n\n  Price: 5\n'))).toMatchObject({ form: 'two-lines', price: ref(45) });
    expect(ok(parse('Crocodile Dandy\nSold out'))).toMatchObject({ form: 'two-lines', price: null, soldOut: true });
  });

  it('is not-item when either line does not fit', () => {
    expect(parse('Team Captain\nLevel 1 Hat')).toEqual(NOT_ITEM);
    expect(parse('Nothing Known\n1.33 ref')).toEqual(NOT_ITEM);
    expect(parse('Team Captain\n1.33 ref\nsomething else')).toEqual(NOT_ITEM);
  });
});

describe('parseCheckText: refusals and links', () => {
  it('refuses with the shared reasons before resolving anything', () => {
    const spy = vi.fn(resolve);
    expect(parseCheckText('<b>Team Captain</b>', spy)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.markup });
    expect(parseCheckText('Team Captain, 1 ref <', spy)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.markup });
    expect(parseCheckText('Team Captain\n1 ref\nBill\'s Hat\n2 ref', spy)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.list });
    expect(parseCheckText('Team Captain '.repeat(40).slice(0, CHECK_MAX_CHARS + 1), spy)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.tooLong });
    expect(parseCheckText(' \n\t ', spy)).toEqual({ ok: false, status: 'refused', reason: CHECK_REFUSALS.empty });
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers a scrap.tf link as not-item without resolving it', () => {
    const spy = vi.fn(resolve);
    for (const t of ['https://scrap.tf/items', 'scrap.tf/buy/hats Team Captain', 'Team Captain https://scrap.tf']) {
      expect(parseCheckText(t, spy), t).toEqual({ ok: false, status: 'not-item', reason: CHECK_SCRAPTF_LINK_REASON });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('never quotes the text in a reason', () => {
    const MARKER = 'Zq7MARKER';
    const texts = [`${MARKER}`, `<${MARKER}>`, `${MARKER}\n1\n2\n3`, `${MARKER} `.repeat(60), `${MARKER}, 1 ref`, `https://scrap.tf/${MARKER}`, `team captian ${MARKER}`];
    for (const t of texts) {
      const r = parseCheckText(t, resolve);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(MARKER);
    }
  });

  it('bounds the resolver calls one text can cause', () => {
    const spy = vi.fn(() => null);
    parseCheckText('a, b, c, d; e = f @ g - h, i, j 1 ref', spy);
    parseCheckText('x\ty\tz\t1 ref\t2 ref\t3/5', spy);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2 * CHECK_MAX_RESOLVES);
    const one = vi.fn(() => null);
    parseCheckText('a, b, c, d; e = f @ g - h, i, j 1 ref', one);
    expect(one.mock.calls.length).toBeLessThanOrEqual(CHECK_MAX_RESOLVES);
  });

  it('survives a resolver that throws (its message may hold the text)', () => {
    const boom = () => {
      throw new Error('cannot resolve Team Captain');
    };
    expect(parseCheckText('Team Captain, 1 ref', boom)).toEqual(NOT_ITEM);
  });
});

describe('parseCheckText: fuzzy matches', () => {
  it('refuses a closest-match guess unless it is confirmed unique', () => {
    expect(parse('Team Captian')).toEqual(NOT_ITEM);
    expect(parse('Team Captian, 1.33 ref')).toEqual(NOT_ITEM);
    expect(parse('Team Captian', () => false)).toEqual(NOT_ITEM);
    // Ambiguous: the confirmer sees the item text and the guess.
    const confirm = vi.fn((t: string, i: ResolvedItem) => t === 'Team Captian' && i.sku === '378;6');
    expect(ok(parse('Team Captian', confirm))).toMatchObject({ form: 'name', item: { sku: '378;6', match: 'fuzzy' }, fuzzy: true });
    expect(ok(parse('Team Captian, 1.33 ref', confirm))).toMatchObject({ form: 'priced', price: ref(12), fuzzy: true });
    expect(ok(parse('Team Captian\t1.33 ref\t1.22 ref\t3/5', confirm))).toMatchObject({ form: 'items-row', fuzzy: true, stock: 3 });
    expect(ok(parse('Team Captian\n1.33 ref', confirm))).toMatchObject({ form: 'two-lines', fuzzy: true });
  });

  it('never confirms a guess that is also incomplete', () => {
    const confirm = vi.fn(() => true);
    expect(parse('Unusual Team Captian', confirm)).toEqual(NOT_ITEM);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('prefers an exact item over a confirmed guess', () => {
    const confirm = vi.fn(() => true);
    expect(ok(parse('Team Captain', confirm))).toMatchObject({ fuzzy: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('treats a confirmer that throws as no', () => {
    expect(
      parse('Team Captian', () => {
        throw new Error('search failed');
      }),
    ).toEqual(NOT_ITEM);
  });

  it("reads scrap.tf's spelling of a name (punctuation and case only) as that item, with no guess to confirm", () => {
    const confirm = vi.fn(() => false);
    expect(ok(parse('Bills Hat', confirm))).toMatchObject({ form: 'name', item: { sku: '126;6' }, fuzzy: false });
    expect(ok(parse('STRANGE  Bills Hat', confirm))).toMatchObject({ form: 'name', item: { sku: '126;11' }, fuzzy: false });
    expect(ok(parse('Bills Hat\t3 keys, 53 refined\t3 keys, 42 refined\t2\n5', confirm))).toMatchObject({
      form: 'items-row',
      item: { sku: '126;6' },
      price: { keys: 3, scrap: 477 },
      stock: 2,
      stockLimit: 5,
      fuzzy: false,
    });
    expect(ok(parse('Bills Hat, 1.33 ref', confirm))).toMatchObject({ form: 'priced', item: { sku: '126;6' }, fuzzy: false });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('parseCheckText: exact matches the resolver flagged', () => {
  it('keeps them, marked incomplete, unless the only note is a BLU twin', () => {
    expect(ok(parse('Unusual Team Captain'))).toMatchObject({ form: 'name', item: { sku: '378;5' }, incomplete: true, fuzzy: false });
    expect(ok(parse('Mann Co. Supply Crate, 1 ref'))).toMatchObject({ form: 'priced', item: { sku: '5022;6' }, price: ref(9), incomplete: true });
    expect(ok(parse('Burning Flames Team Captain'))).toMatchObject({ item: { sku: '378;5;u13' }, incomplete: false });
    expect(ok(parse('Team Captain'))).toMatchObject({ incomplete: false });
  });
});

describe('parseCheckText with the real resolver (schema fixture, fake HTTP)', () => {
  let schema: SchemaService;
  beforeAll(async () => {
    schema = createSchemaService(makeDeps(schemaRoute()));
    await schema.init();
  });
  const real = (t: string) => parseCheckText(t, (x) => schema.resolve(x), { confirmFuzzy: (x, i) => schema.search(x, 2).length === 1 && schema.search(x, 2)[0]!.sku === i.sku });

  it.each<[string, string, Partial<ParsedCheck>]>([
    ['Team Captain', '378;6', { form: 'name', price: null, priceAmbiguous: false }],
    ['Team Captain, 1.33 ref', '378;6', { form: 'priced', price: ref(12), priceAmbiguous: false }],
    ['Team Captain 1.33', '378;6', { form: 'priced', price: ref(12), priceAmbiguous: false }],
    // 0.7.4 (F44): a bare whole number is read as ref, but flagged: scrap.tf always writes a unit.
    ['Team Captain 2', '378;6', { form: 'priced', price: ref(18), priceAmbiguous: true }],
    ['Mann Co. Supply Crate Key = 62.33 ref', '5021;6', { form: 'priced', price: ref(561) }],
    ['Strange Professional Killstreak Rocket Launcher, 1 key 2 ref', '205;11;kt-3', { form: 'priced', price: { keys: 1, scrap: 18 } }],
    ['Crocodile Dandy\tSold out\t1.33 refined\t0/5', '31193;6', { form: 'items-row', soldOut: true, pays: ref(12), stock: 0, stockLimit: 5 }],
    ["Bill's Hat\t1 key, 6 refined\t1 key, 1 refined\t2/5", '126;6', { form: 'items-row', price: { keys: 1, scrap: 54 }, pays: { keys: 1, scrap: 9 } }],
    // As scrap.tf/items spells it and a browser copies the row (icon cell, limits bar on two lines).
    ['\tBills Hat\t3 keys, 53 refined\t3 keys, 42 refined\t2\n5\n', '126;6', { form: 'items-row', price: { keys: 3, scrap: 477 }, pays: { keys: 3, scrap: 378 }, stock: 2, stockLimit: 5 }],
    ['Unusual Team Captain', '378;5', { form: 'name', incomplete: true }],
    ['Strange Rocket Launcher\n2 keys', '205;11', { form: 'two-lines', price: { keys: 2, scrap: 0 }, priceAmbiguous: false }],
    ['Strange Rocket Launcher\n2', '205;11', { form: 'two-lines', price: ref(18), priceAmbiguous: true }],
    ['378;6', '378;6', { form: 'name' }],
    ['https://marketplace.tf/items/tf2/378;6', '378;6', { form: 'name' }],
    ['https://marketplace.tf/items/tf2/378;6, 1.33 ref', '378;6', { form: 'priced', price: ref(12) }],
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable', '378;6', { form: 'name', price: null }],
    // A link followed by a price: as one URL the price would land in the last path segment and be dropped.
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable, 1.33 ref', '378;6', { form: 'priced', price: ref(12) }],
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable 1.33 ref', '378;6', { form: 'priced', price: ref(12) }],
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable\t1.33 ref', '378;6', { form: 'priced', price: ref(12) }],
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable = 1.33 ref', '378;6', { form: 'priced', price: ref(12) }],
    // ...and "Non-Craftable, 1.33 ref" would not read as Non-Craftable: the wrong item.
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Non-Craftable, 1.33 ref', '378;6;uncraftable', { form: 'priced', price: ref(12) }],
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Non-Craftable', '378;6;uncraftable', { form: 'name', price: null }],
  ])('reads %j', (text, sku, want) => {
    expect(ok(real(text))).toMatchObject({ item: { sku }, fuzzy: false, ...want });
  });

  it('answers not-item for everyday text', () => {
    for (const t of ['see you tomorrow', 'git commit -m "fix"', '12:30', 'C:\\Users\\me\\file.txt']) expect(real(t).ok, t).toBe(false);
  });
});
