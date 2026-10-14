import { describe, expect, it } from 'vitest';
import { categorize } from '../../src/shared/categories';
import { DEFAULT_NOTES_KEYWORDS } from '../../src/shared/defaults';
import { fromString } from '../../src/shared/sku';
import type { Listing } from '../../src/shared/types';
import {
  EXCLUDING_FLAGS,
  UNVERIFIED_AFTER_MS,
  classifyOrder,
  compileKeywords,
  dedupeOrders,
  foldText,
  isSpecialEmpty,
  listingSpecial,
  matchContext,
  notesMatch,
  ruleMatches,
  specialCovers,
  specialEquals,
} from '../../src/service/domain/matcher';
import type { MatchContext, MatchTarget } from '../../src/service/domain/matcher';
import { HOUR, T0, makeListing, special, testSettings } from './helpers';

const PINK = 16738740;
const TEAM_SPIRIT = 12073019;
const HAT_INFO = { itemClass: 'tf_wearable', slot: 'misc', craftClass: 'hat', itemName: 'Team Captain' };

function ctx(over: Partial<MatchContext> = {}): MatchContext {
  return { blocklist: new Set(), notesKeywords: [...DEFAULT_NOTES_KEYWORDS], now: T0, ...over };
}

const clean: MatchTarget = { baseSku: '378;6', special: special() };
const unknown: MatchTarget = { baseSku: '378;6', special: null };
const pink: MatchTarget = { baseSku: '378;6', special: special({ paint: PINK }) };

describe('classifyOrder (brief §5.2 eligibility matrix)', () => {
  const cases: { name: string; listing: Partial<Listing>; target: MatchTarget; eligible: boolean; flags: string[] }[] = [
    { name: 'generic order, clean item', listing: {}, target: clean, eligible: true, flags: [] },
    { name: 'generic order, unknown extras (assumed clean)', listing: {}, target: unknown, eligible: true, flags: [] },
    { name: 'generic order, painted item', listing: {}, target: pink, eligible: true, flags: ['has-extras'] },
    {
      name: 'generic order, item known to have extras but attrs unknown',
      listing: {},
      target: { baseSku: '378;6', special: null, hasExtras: true },
      eligible: true,
      flags: ['has-extras'],
    },
    { name: 'sell listing', listing: { intent: 'sell' }, target: clean, eligible: false, flags: ['not-buy-order'] },
    { name: 'marketplace.tf mirror', listing: { isMarketplace: true }, target: clean, eligible: false, flags: ['marketplace'] },
    { name: 'banned buyer', listing: { userBanned: true }, target: clean, eligible: false, flags: ['banned'] },
    {
      name: 'paint order, item extras unknown',
      listing: { special: special({ paint: PINK }) },
      target: unknown,
      eligible: false,
      flags: ['attribute-specific'],
    },
    { name: 'paint order, same paint', listing: { special: special({ paint: PINK }) }, target: pink, eligible: true, flags: [] },
    {
      name: 'paint order, clean item',
      listing: { special: special({ paint: PINK }) },
      target: clean,
      eligible: false,
      flags: ['attribute-specific'],
    },
    {
      name: 'paint order, different paint',
      listing: { special: special({ paint: TEAM_SPIRIT }) },
      target: pink,
      eligible: false,
      flags: ['attribute-specific'],
    },
    {
      name: 'paint order, item has the paint plus a spell (extras the order leaves open)',
      listing: { special: special({ paint: PINK }) },
      target: { baseSku: '378;6', special: special({ paint: PINK, spells: ['Exorcism'] }) },
      eligible: true,
      flags: ['has-extras'],
    },
    {
      name: 'Professional Killstreak spell order (sheen/killstreaker open), item has the spell plus sheen and killstreaker',
      listing: { sku: '312;14;kt-3', baseSku: '312;14;kt-3', special: special({ spells: ['Exorcism'] }) },
      target: { baseSku: '312;14;kt-3', special: special({ spells: ['Exorcism'], sheen: 1, killstreaker: 2002 }) },
      eligible: true,
      flags: ['has-extras'],
    },
    {
      name: 'spell order, item has an extra spell',
      listing: { special: special({ spells: ['Exorcism'] }) },
      target: { baseSku: '378;6', special: special({ spells: ['Exorcism', 'Halloween Fire'] }) },
      eligible: true,
      flags: ['has-extras'],
    },
    {
      name: 'spell order, item lacks the spell',
      listing: { special: special({ spells: ['Exorcism'] }) },
      target: { baseSku: '378;6', special: special({ spells: ['Halloween Fire'], sheen: 1 }) },
      eligible: false,
      flags: ['attribute-specific'],
    },
    {
      name: 'sheen order, item has a different sheen',
      listing: { special: special({ sheen: 3 }) },
      target: { baseSku: '378;6', special: special({ sheen: 1, killstreaker: 2002 }) },
      eligible: false,
      flags: ['attribute-specific'],
    },
    {
      name: 'custom name order, item has a custom name and description',
      listing: { special: special({ customName: true }) },
      target: { baseSku: '378;6', special: special({ customName: true, customDesc: true }) },
      eligible: true,
      flags: ['has-extras'],
    },
    {
      name: 'spell order, same spells in another order and case',
      listing: { special: special({ spells: ['Exorcism', 'Halloween Fire'] }) },
      target: { baseSku: '378;6', special: special({ spells: ['halloween fire', 'exorcism'] }) },
      eligible: true,
      flags: [],
    },
    {
      name: 'parts order, item has fewer parts',
      listing: { special: special({ parts: ['Kills', 'Headshot Kills'] }) },
      target: { baseSku: '378;6', special: special({ parts: ['Kills'] }) },
      eligible: false,
      flags: ['attribute-specific'],
    },
    {
      name: 'sheen order vs clean item',
      listing: { special: special({ sheen: 3 }) },
      target: clean,
      eligible: false,
      flags: ['attribute-specific'],
    },
    {
      name: 'custom name order vs unknown item',
      listing: { special: special({ customName: true }) },
      target: unknown,
      eligible: false,
      flags: ['attribute-specific'],
    },
    {
      name: 'paint only in the listing SKU, same paint',
      listing: { sku: `378;6;p${PINK}` },
      target: pink,
      eligible: true,
      flags: [],
    },
    {
      name: 'paint only in the listing SKU, clean item',
      listing: { sku: `378;6;p${PINK}` },
      target: clean,
      eligible: false,
      flags: ['attribute-specific'],
    },
    {
      name: 'notes keyword is flagged, not excluded',
      listing: { details: 'Buying PAINTED ones too, add me' },
      target: clean,
      eligible: true,
      flags: ['notes-flag'],
    },
    {
      name: 'stale listing is unverified, not excluded',
      listing: { lastEventAt: T0 - UNVERIFIED_AFTER_MS - 1 },
      target: clean,
      eligible: true,
      flags: ['unverified'],
    },
    {
      name: 'several reasons at once',
      listing: { isMarketplace: true, userBanned: true, details: 'clean only', lastEventAt: T0 - 30 * HOUR },
      target: clean,
      eligible: false,
      flags: ['marketplace', 'banned', 'notes-flag', 'unverified'],
    },
  ];

  it.each(cases)('$name', ({ listing, target, eligible, flags }) => {
    const r = classifyOrder(makeListing(listing), target, ctx());
    expect(r.flags).toEqual(flags);
    expect(r.eligible).toBe(eligible);
  });

  it('excludes blocklisted buyers', () => {
    const l = makeListing({ steamid: '76561198000000999' });
    expect(classifyOrder(l, clean, ctx({ blocklist: new Set(['76561198000000999']) }))).toEqual({ eligible: false, flags: ['blocklisted'] });
    expect(classifyOrder(l, clean, ctx()).eligible).toBe(true);
  });

  it('builds the blocklist and keywords from settings', () => {
    const c = matchContext(testSettings({ blocklist: ['1', '2'], profit: { notesKeywords: ['nope'] } }), T0);
    expect([...c.blocklist]).toEqual(['1', '2']);
    expect(c.notesKeywords).toEqual(['nope']);
    expect(c.now).toBe(T0);
  });

  it('treats exactly 24 h as still verified', () => {
    const r = classifyOrder(makeListing({ lastEventAt: T0 - UNVERIFIED_AFTER_MS }), clean, ctx());
    expect(r.flags).toEqual([]);
  });

  it('flags a listing with a broken timestamp as unverified', () => {
    expect(classifyOrder(makeListing({ lastEventAt: Number.NaN }), clean, ctx()).flags).toContain('unverified');
  });

  it('only excluding flags make an order ineligible', () => {
    for (const f of ['notes-flag', 'has-extras', 'unverified', 'outlier']) expect(EXCLUDING_FLAGS.has(f)).toBe(false);
    for (const f of ['marketplace', 'banned', 'blocklisted', 'attribute-specific', 'duplicate']) expect(EXCLUDING_FLAGS.has(f)).toBe(true);
  });
});

describe('notes keywords', () => {
  const kw = [...DEFAULT_NOTES_KEYWORDS];

  it.each([
    ['Paying keys, clean only please', true],
    ['buying any PAINTED version', true],
    ['spelled ones welcome', true],
    ['no dupes', true],
    ['CLEAN   ONLY', true],
    ['Has strange parts?', true],
    ['part-time trader', true],
    ['unpainted is fine', false],
    ['paintball enthusiast', false],
    ['buying for 5 keys', false],
    ['', false],
  ])('%j -> %s', (text, hit) => {
    expect(notesMatch(text, kw)).toBe(hit);
  });

  it('is NFKD-normalised and accent/width insensitive', () => {
    expect(notesMatch('ＣＬＥＡＮ ＯＮＬＹ', kw)).toBe(true);
    expect(notesMatch('Spéll required', kw)).toBe(true);
    expect(foldText('Ｄｕｐｅ')).toBe('dupe');
  });

  it('uses custom keywords and escapes regex characters', () => {
    expect(notesMatch('needs a.b tag', ['a.b'])).toBe(true);
    expect(notesMatch('needs axb tag', ['a.b'])).toBe(false);
    expect(notesMatch('anything', [])).toBe(false);
    expect(notesMatch('anything', ['   '])).toBe(false);
  });

  it('caches compiled keyword sets', () => {
    expect(compileKeywords(['foo', 'bar'])).toBe(compileKeywords(['foo', 'bar']));
    expect(compileKeywords([])).toBeNull();
  });

  it('ignores non-string details', () => {
    expect(notesMatch(undefined, kw)).toBe(false);
    expect(notesMatch(42, kw)).toBe(false);
  });
});

describe('special attributes', () => {
  it('compares sets regardless of order, case and duplicates', () => {
    expect(specialEquals(special({ spells: ['A', 'b', 'a'] }), special({ spells: ['B', 'A'] }))).toBe(true);
    expect(specialEquals(special({ paint: 1 }), special({ paint: 2 }))).toBe(false);
    expect(specialEquals(special({ customDesc: true }), special())).toBe(false);
  });

  it('specialCovers: the item has every attribute the order names', () => {
    expect(specialCovers(special({ spells: ['exorcism'] }), special({ spells: ['Exorcism', 'Halloween Fire'], sheen: 1 }))).toBe(true);
    expect(specialCovers(special({ parts: ['Kills', 'Headshot Kills'] }), special({ parts: ['kills'] }))).toBe(false);
    expect(specialCovers(special({ paint: 1 }), special({ paint: 2 }))).toBe(false);
    expect(specialCovers(special({ customDesc: true }), special({ customName: true }))).toBe(false);
    expect(specialCovers(special({ killstreaker: 2002 }), special({ sheen: 1, killstreaker: 2002 }))).toBe(true);
    expect(specialCovers(special(), special({ paint: 1 }))).toBe(true);
  });

  it('treats junk values as empty', () => {
    expect(isSpecialEmpty(null)).toBe(true);
    expect(isSpecialEmpty(special({ paint: 0, spells: [' '], sheen: Number.NaN }))).toBe(true);
    expect(isSpecialEmpty(special({ killstreaker: 2002 }))).toBe(false);
  });

  it('takes the paint from the SKU token when the attributes omit it', () => {
    expect(listingSpecial(makeListing({ sku: `378;6;p${PINK}` })).paint).toBe(PINK);
    expect(listingSpecial(makeListing({ sku: `378;6;p${PINK}`, special: special({ paint: TEAM_SPIRIT }) })).paint).toBe(TEAM_SPIRIT);
  });
});

describe('dedupeOrders', () => {
  it('keeps the newest order per (steamid, base SKU, intent)', () => {
    const old = makeListing({ id: 'a', steamid: 'S1', lastEventAt: T0 - 2 * HOUR, metalScrap: 90 });
    const fresh = makeListing({ id: 'b', steamid: 'S1', lastEventAt: T0 - HOUR, metalScrap: 50 });
    const other = makeListing({ id: 'c', steamid: 'S2' });
    const sell = makeListing({ id: 'd', steamid: 'S1', intent: 'sell' });
    const otherSku = makeListing({ id: 'e', steamid: 'S1', baseSku: '126;6', sku: '126;6' });
    const { kept, duplicates } = dedupeOrders([old, fresh, other, sell, otherSku]);
    expect(kept.map((l) => l.id)).toEqual(['b', 'c', 'd', 'e']);
    expect(duplicates.map((l) => l.id)).toEqual(['a']);
  });

  it('breaks timestamp ties by bump time, then id', () => {
    const a = makeListing({ id: 'a', steamid: 'S1', lastEventAt: T0, bumpedAt: 100 });
    const b = makeListing({ id: 'b', steamid: 'S1', lastEventAt: T0, bumpedAt: 200 });
    expect(dedupeOrders([a, b]).kept.map((l) => l.id)).toEqual(['b']);
    const c = makeListing({ id: 'c', steamid: 'S1', lastEventAt: T0, bumpedAt: null, listedAt: null });
    const d = makeListing({ id: 'd', steamid: 'S1', lastEventAt: T0, bumpedAt: null, listedAt: null });
    expect(dedupeOrders([d, c]).kept.map((l) => l.id)).toEqual(['d']);
  });

  it('never merges listings without a steamid', () => {
    const a = makeListing({ id: 'a', steamid: '' });
    const b = makeListing({ id: 'b', steamid: '' });
    expect(dedupeOrders([a, b]).kept).toHaveLength(2);
  });
});

describe('ruleMatches', () => {
  const subject = (sku: string, category: 'hats' | 'weapons' | 'unusuals' = 'hats', name = 'Team Captain') => ({
    obj: fromString(sku),
    category,
    name,
  });

  it('matches everything with an empty filter', () => {
    expect(ruleMatches({}, subject('378;6'))).toBe(true);
  });

  it('checks each criterion', () => {
    const s = subject('378;6');
    expect(ruleMatches({ categories: ['hats'] }, s)).toBe(true);
    expect(ruleMatches({ categories: ['weapons'] }, s)).toBe(false);
    expect(ruleMatches({ qualities: [6, 11] }, s)).toBe(true);
    expect(ruleMatches({ qualities: [11] }, s)).toBe(false);
    expect(ruleMatches({ craftable: true }, s)).toBe(true);
    expect(ruleMatches({ craftable: false }, s)).toBe(false);
    expect(ruleMatches({ craftable: null }, s)).toBe(true);
    expect(ruleMatches({ australium: true }, subject('205;11;australium', 'weapons'))).toBe(true);
    expect(ruleMatches({ australium: false }, subject('205;11;australium', 'weapons'))).toBe(false);
    expect(ruleMatches({ killstreak: [0] }, s)).toBe(true);
    expect(ruleMatches({ killstreak: [3] }, subject('205;11;kt-3', 'weapons'))).toBe(true);
    expect(ruleMatches({ killstreak: [1, 2] }, subject('205;11;kt-3', 'weapons'))).toBe(false);
    expect(ruleMatches({ hasEffect: true }, subject('378;5;u13', 'unusuals'))).toBe(true);
    expect(ruleMatches({ hasEffect: false }, subject('378;5;u13', 'unusuals'))).toBe(false);
    expect(ruleMatches({ hasEffect: false }, s)).toBe(true);
    expect(ruleMatches({ defindexes: [378] }, s)).toBe(true);
    expect(ruleMatches({ defindexes: [126] }, s)).toBe(false);
    expect(ruleMatches({ nameContains: 'captain' }, s)).toBe(true);
    expect(ruleMatches({ nameContains: 'hat' }, s)).toBe(false);
    expect(ruleMatches({ nameContains: '' }, s)).toBe(true);
    expect(ruleMatches({ categories: [], qualities: [] }, s)).toBe(true);
  });

  // A generic any-effect Unusual base (378;5) must not be priced by a Unique-hat rule.
  it('treats the generic any-effect Unusual base as an unusual, not an effect-less hat', () => {
    const generic = { obj: fromString('378;5'), category: categorize(fromString('378;5'), HAT_INFO), name: 'Unusual Team Captain' };
    expect(generic.category).toBe('unusuals');
    expect(ruleMatches({ categories: ['hats'], hasEffect: false }, generic)).toBe(false);
    expect(ruleMatches({ hasEffect: false }, generic)).toBe(false);
    expect(ruleMatches({ hasEffect: true }, generic)).toBe(true);
    expect(ruleMatches({ categories: ['unusuals'] }, generic)).toBe(true);
  });

  it('computes the name only when nameContains needs it', () => {
    let calls = 0;
    const name = () => {
      calls++;
      return 'Team Captain';
    };
    ruleMatches({ qualities: [6] }, { obj: fromString('378;6'), category: 'hats', name });
    expect(calls).toBe(0);
    ruleMatches({ nameContains: 'team' }, { obj: fromString('378;6'), category: 'hats', name });
    expect(calls).toBe(1);
  });
});
