// F3 / F8 / F1 in the item drawer: buyer actions, price actions and the ceiling.

import { describe, expect, it, vi } from 'vitest';
import {
  backgroundCheckListings,
  blockBuyer,
  blocklistWith,
  blocklistWithout,
  buyerMenuSections,
  buyerProfileUrls,
  ceilingVerdict,
  defaultPriceTarget,
  describeBuyerCheck,
  drawerCeiling,
  drawerPriceInput,
  flattenSections,
  fmtDays,
  isEnabledItem,
  isReferenceTooOld,
  isRuleCandidate,
  isSteamId64,
  priceFormHeading,
  reconfirmInput,
  referenceAgeGates,
  unblockBuyer,
  type BlocklistDeps,
} from '../../src/renderer/itemMenuModel';
import { usableReferences } from '../../src/service/domain/pricing';
import type { BuyerCheck, Opportunity, OrderSummary, ReferencePrices, ScrapPrice } from '../../src/shared/types';

const ID = '76561198012345678';
const OTHER = '76561198000000001';

function order(listingId: string, valueScrap: number, steamid = ID): OrderSummary {
  return {
    listingId,
    steamid,
    userName: 'Buyer',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: false,
    online: true,
    lastEventAt: 0,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
}

function opp(over: Partial<Opportunity>): Opportunity {
  return {
    key: '378;6|price:1',
    sku: '378;6',
    name: 'Team Captain',
    category: 'hats',
    inputRef: 'price:1',
    inputKind: 'user',
    costKeys: 0,
    costScrapRaw: 100,
    costScrap: 100,
    bestScrap: null,
    consScrap: null,
    instantScrap: null,
    revenueScrap: null,
    profitScrap: null,
    margin: null,
    maxCostScrap: null,
    confidence: 50,
    confidenceLevel: 'medium',
    flags: [],
    reasons: [],
    buyerCount: 0,
    bestOrder: null,
    consOrder: null,
    instantOrder: null,
    references: { pricedb: null, community: null },
    profitTier: 'none',
    status: 'no-buyers',
    inputObservedAt: 0,
    firstSeenAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function price(over: Partial<ScrapPrice>): ScrapPrice {
  return {
    id: 1,
    sku: '378;6',
    name: 'Team Captain',
    costKeys: 0,
    costScrap: 100,
    source: 'user',
    observedAt: 1000,
    note: null,
    importBatch: null,
    special: null,
    assetId: null,
    stock: null,
    ...over,
  };
}

describe('buyer profile links', () => {
  it('builds the backpack.tf and Steam profile pages of a SteamID64', () => {
    expect(buyerProfileUrls(ID)).toEqual({ backpack: `https://backpack.tf/profiles/${ID}`, steam: `https://steamcommunity.com/profiles/${ID}` });
    expect(buyerProfileUrls(` ${ID} `)?.backpack).toBe(`https://backpack.tf/profiles/${ID}`);
  });

  it('builds nothing from an id that is not 17 digits (no path tricks)', () => {
    for (const bad of ['', '123', `${ID}0`, '7656119801234567x', '../../linkfilter', `${ID.slice(0, 16)}/`]) {
      expect(buyerProfileUrls(bad)).toBeNull();
      expect(isSteamId64(bad)).toBe(false);
    }
  });
});

describe('buyer actions menu', () => {
  const labels = (s: ReturnType<typeof buyerMenuSections>) => flattenSections(s).map((i) => i.label);

  it('offers open, copy, check and block', () => {
    const s = buyerMenuSections(order('a', 10), { blocked: false, highlightCheck: false, checking: false });
    expect(labels(s)).toEqual(['Open on backpack.tf', 'Steam profile', 'Copy SteamID64', 'Check bans', 'Block buyer']);
    expect(flattenSections(s).map((i) => i.action)).toEqual([
      { kind: 'open', url: `https://backpack.tf/profiles/${ID}` },
      { kind: 'open', url: `https://steamcommunity.com/profiles/${ID}` },
      { kind: 'copy-id' },
      { kind: 'check' },
      { kind: 'block' },
    ]);
  });

  it('offers removal for a blocked buyer instead', () => {
    expect(labels(buyerMenuSections(order('a', 10), { blocked: true, highlightCheck: false, checking: false })).at(-1)).toBe('Remove from blocklist');
  });

  it('highlights Check bans on a background-check order and disables it while checking', () => {
    const hi = flattenSections(buyerMenuSections(order('a', 10), { blocked: false, highlightCheck: true, checking: false })).find((i) => i.id === 'check')!;
    expect(hi.tone).toBe('warn');
    expect(isEnabledItem(hi)).toBe(true);
    const plain = flattenSections(buyerMenuSections(order('a', 10), { blocked: false, highlightCheck: false, checking: false })).find((i) => i.id === 'check')!;
    expect(plain.tone).toBeUndefined();
    const busy = flattenSections(buyerMenuSections(order('a', 10), { blocked: false, highlightCheck: true, checking: true })).find((i) => i.id === 'check')!;
    expect(busy.label).toBe('Checking bans…');
    expect(isEnabledItem(busy)).toBe(false);
  });

  it('disables everything but copy for a malformed id', () => {
    const items = flattenSections(buyerMenuSections(order('a', 10, 'bogus'), { blocked: false, highlightCheck: false, checking: false }));
    expect(items.filter(isEnabledItem).map((i) => i.id)).toEqual(['copy-id']);
  });
});

describe('blocklist edits', () => {
  it('appends once, keeps the order and drops duplicates', () => {
    expect(blocklistWith([OTHER], ID)).toEqual([OTHER, ID]);
    expect(blocklistWith([ID, OTHER, OTHER], ID)).toEqual([ID, OTHER]);
    expect(blocklistWith([], ` ${ID} `)).toEqual([ID]);
  });

  it('removes every copy of the id', () => {
    expect(blocklistWithout([OTHER, ID, ID], ID)).toEqual([OTHER]);
    expect(blocklistWithout([OTHER], ID)).toEqual([OTHER]);
  });

  function store(initial: string[]): BlocklistDeps & { list: string[]; saves: string[][] } {
    const s = {
      list: [...initial],
      saves: [] as string[][],
      getSettings: vi.fn(async () => ({ blocklist: [...s.list] })),
      save: vi.fn(async (patch: { blocklist: string[] }) => {
        s.saves.push(patch.blocklist);
        s.list = [...patch.blocklist];
        return { blocklist: [...s.list] };
      }),
    };
    return s;
  }

  it('blocks from a fresh settings read and sends the full list', async () => {
    // Another window added OTHER after this drawer loaded its settings.
    const s = store([OTHER]);
    expect(await blockBuyer(ID, s)).toBe('blocked');
    expect(s.getSettings).toHaveBeenCalledTimes(1);
    expect(s.saves).toEqual([[OTHER, ID]]);
  });

  it('does not write when the buyer is already blocked', async () => {
    const s = store([ID]);
    expect(await blockBuyer(ID, s)).toBe('already');
    expect(s.save).not.toHaveBeenCalled();
  });

  it('reports a failed save (updateSettings returns null)', async () => {
    const s = store([]);
    s.save = vi.fn(async () => null);
    expect(await blockBuyer(ID, s)).toBe('failed');
  });

  it('undo removes only that buyer, from a fresh read', async () => {
    const s = store([]);
    await blockBuyer(ID, s);
    s.list.push(OTHER); // added elsewhere in the meantime
    expect(await unblockBuyer(ID, s)).toBe('unblocked');
    expect(s.list).toEqual([OTHER]);
    expect(await unblockBuyer(ID, s)).toBe('absent');
  });

  it('lets a settings.get failure reach the caller (shown as a toast)', async () => {
    const s = store([]);
    s.getSettings = vi.fn(async () => {
      throw new Error('bridge down');
    });
    await expect(blockBuyer(ID, s)).rejects.toThrow('bridge down');
    expect(s.save).not.toHaveBeenCalled();
  });
});

describe('background-check highlight', () => {
  const cons = order('cons', 900);
  const best = order('best', 1000);

  it('marks the revenue order of a background-check opportunity', () => {
    const o = opp({ flags: ['background-check'], revenueScrap: 900, consOrder: cons, bestOrder: best });
    expect([...backgroundCheckListings([o], 'conservative')]).toEqual(['cons']);
    expect([...backgroundCheckListings([{ ...o, revenueScrap: 1000 }], 'best')]).toEqual(['best']);
  });

  it('marks nothing without the flag or without revenue', () => {
    expect(backgroundCheckListings([opp({ revenueScrap: 900, consOrder: cons })], 'conservative').size).toBe(0);
    expect(backgroundCheckListings([opp({ flags: ['background-check'], consOrder: cons })], 'conservative').size).toBe(0);
  });
});

describe('ban check result', () => {
  const base: BuyerCheck = { steamid: ID, name: 'Trader', bptfBanned: false, banDetails: [], checkedAt: 0, cached: false, error: null };

  it('reads clean, banned, other bans and unknown', () => {
    expect(describeBuyerCheck(base, 60_000)).toMatchObject({ tone: 'good', text: 'No backpack.tf ban (Trader).', needsSettings: false });
    const banned = describeBuyerCheck({ ...base, bptfBanned: true, banDetails: ['backpack.tf: all'] }, 0);
    expect(banned.tone).toBe('bad');
    expect(banned.details).toEqual(['backpack.tf: all']);
    expect(describeBuyerCheck({ ...base, banDetails: ['SteamRep: scammer'] }, 0).tone).toBe('warn');
    expect(describeBuyerCheck({ ...base, bptfBanned: null, name: null }, 0)).toMatchObject({ tone: 'muted', text: 'Ban status unknown.' });
  });

  it('says when and whether it came from the cache', () => {
    expect(describeBuyerCheck({ ...base, cached: true }, 0).when).toMatch(/from cache/);
    expect(describeBuyerCheck(base, 0).when).not.toMatch(/cache/);
  });

  it('points to Settings for a missing token', () => {
    const v = describeBuyerCheck({ ...base, bptfBanned: null, error: 'Add a backpack.tf access token in Settings' }, 0);
    expect(v).toMatchObject({ tone: 'warn', needsSettings: true, when: null, retry: false });
    expect(describeBuyerCheck({ ...base, bptfBanned: null, error: 'The network is paused.' }, 0).needsSettings).toBe(false);
  });

  it('offers another try after a transient failure, never after an answer', () => {
    // The service never caches a failure, so a second click really asks again (within its budget).
    for (const error of ['The network is paused. Resume it from the top bar first.', 'backpack.tf user lookups are rate limited; try again in 30 s.', 'backpack.tf answered HTTP 502.']) {
      expect(describeBuyerCheck({ ...base, bptfBanned: null, error }, 0)).toMatchObject({ needsSettings: false, retry: true });
    }
    expect(describeBuyerCheck({ ...base, bptfBanned: null, error: 'The backpack.tf API is turned off in Settings.' }, 0).retry).toBe(false);
    for (const banned of [true, false, null]) expect(describeBuyerCheck({ ...base, bptfBanned: banned }, 0).retry).toBe(false);
  });
});

describe('price actions', () => {
  it('"Seen now" re-sends the same price with a new time, leaving extras to the stored row', () => {
    const p = price({ id: 7, costKeys: 1, costScrap: 5, source: 'import', note: 'n', stock: 2, assetId: '123' });
    expect(reconfirmInput(p, 99)).toEqual({ id: 7, sku: '378;6', name: 'Team Captain', costKeys: 1, costScrap: 5, source: 'import', observedAt: 99 });
  });

  it('updates the newest typed price by default, never an imported one', () => {
    expect(defaultPriceTarget([price({ id: 1, observedAt: 5 }), price({ id: 2, observedAt: 9 }), price({ id: 3, observedAt: 20, source: 'import' })])).toBe(2);
    expect(defaultPriceTarget([price({ id: 3, source: 'import' })])).toBeNull();
    expect(defaultPriceTarget([])).toBeNull();
  });

  it('adds a new typed price for the drawer SKU', () => {
    expect(drawerPriceInput({ sku: '378;6;p3100495', name: 'Team Captain', price: { keys: 0, scrap: 12 }, note: '  ', target: null, now: 50 })).toEqual({
      sku: '378;6;p3100495',
      name: 'Team Captain',
      costKeys: 0,
      costScrap: 12,
      source: 'user',
      observedAt: 50,
      note: null,
    });
  });

  it('updates the chosen price on its stored SKU and keeps its note unless one is typed', () => {
    const target = price({ id: 4, sku: '378;6', note: 'old note' });
    const kept = drawerPriceInput({ sku: '378;6;p3100495', name: 'x', price: { keys: 1, scrap: 3 }, note: '', target, now: 50 });
    expect(kept).toEqual({ id: 4, sku: '378;6', name: 'Team Captain', costKeys: 1, costScrap: 3, source: 'user', observedAt: 50 });
    expect('note' in kept).toBe(false);
    expect(drawerPriceInput({ sku: '378;6', name: 'x', price: { keys: 0, scrap: 3 }, note: ' new ', target, now: 50 }).note).toBe('new');
  });

  it('labels the form for rule candidates', () => {
    const rule = opp({ inputKind: 'rule', inputRef: 'rule:3' });
    expect(isRuleCandidate({ scrapPrices: [], opportunities: [rule] })).toBe(true);
    expect(priceFormHeading({ scrapPrices: [], opportunities: [rule] }).title).toBe('Found it on scrap.tf? Record the real price');
    expect(isRuleCandidate({ scrapPrices: [price({})], opportunities: [rule] })).toBe(false);
    expect(isRuleCandidate({ scrapPrices: [], opportunities: [] })).toBe(false);
    expect(priceFormHeading({ scrapPrices: [], opportunities: [] }).title).toBe('Add / update scrap.tf price');
  });
});

describe('pay up to', () => {
  it('prefers ItemDetail.revenue, else the inputs', () => {
    const revenue = { bestScrap: 500, consScrap: 450, instantScrap: null, useOrder: 'conservative' as const, revenueScrap: 450, order: null, maxCostScrap: 380, eligibleCount: 2 };
    expect(drawerCeiling({ revenue, opportunities: [opp({ maxCostScrap: 300 })] })).toBe(380);
    expect(drawerCeiling({ revenue: null, opportunities: [opp({ maxCostScrap: 300 }), opp({ maxCostScrap: null })] })).toBe(300);
    expect(drawerCeiling({ revenue: { ...revenue, maxCostScrap: null }, opportunities: [] })).toBeNull();
  });

  it('compares a cost with the ceiling', () => {
    expect(ceilingVerdict(100, 120)).toEqual({ under: true, diffScrap: 20 });
    expect(ceilingVerdict(120, 120)).toEqual({ under: true, diffScrap: 0 });
    expect(ceilingVerdict(130, 120)).toEqual({ under: false, diffScrap: 10 });
    expect(ceilingVerdict(null, 120)).toBeNull();
    expect(ceilingVerdict(100, null)).toBeNull();
  });
});

describe('reference age gate', () => {
  const DAY = 86_400_000;

  it('ignores references older than the setting, like the engine', () => {
    expect(isReferenceTooOld(31 * DAY, 30 * DAY)).toBe(true);
    expect(isReferenceTooOld(30 * DAY, 30 * DAY)).toBe(false);
    expect(isReferenceTooOld(null, 30 * DAY)).toBe(false);
    expect(isReferenceTooOld(undefined, 0)).toBe(false);
    expect(isReferenceTooOld(1, 0)).toBe(true);
  });

  it("marks a community price ignored only past the engine's limit, at least a year", () => {
    const now = 1.8e12;
    const refs = (pDays: number, cDays: number): ReferencePrices => ({
      pricedb: { buyScrap: 90, sellScrap: 99, time: null, ageMs: pDays * DAY },
      community: { valueScrap: 95, valueHighScrap: null, lastUpdate: Math.floor((now - cDays * DAY) / 1000) },
    });
    // 60 days old with the default 30-day setting: the PriceDB price is ignored, the community one is not.
    const g = referenceAgeGates(refs(60, 60), 30 * DAY, now);
    expect(g.pricedb).toMatchObject({ old: true, limitMs: 30 * DAY });
    expect(g.community).toMatchObject({ old: false, limitMs: 365 * DAY });
    expect(fmtDays(g.community.limitMs)).toBe('365 days');
    expect(referenceAgeGates(refs(1, 400), 30 * DAY, now).community.old).toBe(true);
    expect(referenceAgeGates({ pricedb: null, community: null }, 30 * DAY, now)).toMatchObject({ pricedb: { old: false }, community: { old: false, ageMs: null } });
    // Exactly the engine's gate, whatever the ages and the setting.
    for (const days of [0, 29, 31, 60, 364, 366, 400]) {
      for (const limitDays of [0, 30, 365]) {
        const r = refs(days, days);
        const gates = referenceAgeGates(r, limitDays * DAY, now);
        const engine = usableReferences(r, limitDays * DAY, now).references;
        expect(gates.pricedb.old).toBe(engine.pricedb === null);
        expect(gates.community.old).toBe(engine.community === null);
      }
    }
  });

  it('formats the limit in days', () => {
    expect(fmtDays(30 * DAY)).toBe('30 days');
    expect(fmtDays(DAY)).toBe('1 day');
  });
});
