// 0.7.4 (review R30): the copy tag beside an Opportunities row's name. Its hover said "Pay up to is for a clean
// copy", but each copy's row is priced against the buyers who take that copy (classifyOrder admits an order for
// the copy's own paint), so a painted copy's ceiling can be above the clean copy's. And a paint the row's own SKU
// carries (the dev mock keeps typed painted SKUs) already has its chip beside the name, so the tag no longer
// repeats it. Engine with a stub schema; nothing leaves the process.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine } from '../../src/service/domain/engine';
import { copyLabelOf } from '../../src/renderer/oppModel';
import { itemTags } from '../../src/renderer/format';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import { opportunityCopyKey } from '../../src/shared/copyExtras';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, special } from '../domain/helpers';

const K = 567;
const VIOLET = 5322826;
const AFTER_EIGHT = 2960676;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

describe('the copy tag (R30)', () => {
  it("says each copy is priced against its own buyers, not a clean copy's", () => {
    const tag = copyLabelOf({ copyKey: bankStockSpecialKey({ sheen: 1, killstreaker: 2002 }), inputKind: 'import' })!;
    expect(tag.title).not.toMatch(/clean copy/);
    expect(tag.title).toBe(
      'This copy: Team Shine, Fire Horns. Each copy of an item is its own row, priced against the buyers who take this copy (generic orders and any that ask for its extras).',
    );
  });

  it('leaves out a paint the row SKU carries (its chip shows it), and keeps the other extras', () => {
    const sku = `378;6;p${VIOLET}`;
    expect(itemTags(sku).some((t) => t.kind === 'paint')).toBe(true);
    // A typed painted price: its copy key is the SKU's paint (opportunityCopyKey moves it in).
    const onlyPaint = opportunityCopyKey(sku, null);
    expect(copyLabelOf({ sku, copyKey: onlyPaint, inputKind: 'user' })).toBeNull();
    const withSpell = bankStockSpecialKey({ paint: VIOLET, spells: ['Exorcism'] });
    expect(copyLabelOf({ sku, copyKey: withSpell, inputKind: 'user' })).toMatchObject({ text: 'Spell: Exorcism', title: expect.stringMatching(/^This copy: Noble Hatter's Violet, Spell: Exorcism\./) });
    // The base SKU (the service's stored form) keeps the paint in the tag; another paint than the SKU's too.
    expect(copyLabelOf({ sku: '378;6', copyKey: onlyPaint, inputKind: 'user' })?.text).toBe("Noble Hatter's Violet");
    expect(copyLabelOf({ sku: `378;6;p${AFTER_EIGHT}`, copyKey: onlyPaint, inputKind: 'user' })?.text).toBe("Noble Hatter's Violet");
  });

  it("a painted copy's Pay up to follows a buyer who asks for its paint (the engine)", async () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
    const clock = new FakeClock();
    const engine = createEngine({ ...makeDeps(repo, clock, () => DEFAULT_SETTINGS), schema: createStubSchema(), events: recordingEvents(), timers: new FakeTimers(clock) });
    const order = (id: string, scrap: number, steamid: string) =>
      makeListing({ id, sku: '378;6', baseSku: '378;6', steamid, metalScrap: scrap, isBot: true, userOnline: true, lastEventAt: T0 - MIN });
    repo.upsertListings([order('generic', 677, 'S1'), { ...order('violet', 977, 'S2'), special: special({ paint: VIOLET }) }]);
    const clean = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 500, source: 'user', observedAt: T0 - 5 * MIN });
    const painted = repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 500, source: 'user', observedAt: T0 - 5 * MIN, special: special({ paint: VIOLET }) });
    await engine.runNow();
    const rowOf = (id: number) => repo.getOpportunity(`378;6|price:${id}`)!;
    expect(rowOf(painted.id).revenueScrap).toBe(977);
    expect(rowOf(clean.id).revenueScrap).toBe(677);
    expect(rowOf(painted.id).maxCostScrap!).toBeGreaterThan(rowOf(clean.id).maxCostScrap!);
  });
});
