// 0.9 (#11): an account backpack.tf flags as impersonating another user (Listing.userImpersonated, V16
// listings.user_impersonated) is excluded like a ban, under its own 'impersonator' flag: as a buyer (classifyOrder),
// as a seller (the drawer's sell listings and the ask side). And the bot service a client names is a label on the
// order summary only (OrderSummary.botService). Real in-memory repo; nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { askCandidatesOf } from '../../src/service/domain/asks';
import { EXCLUDING_FLAGS, classifyOrder, matchContext } from '../../src/service/domain/matcher';
import { toOrderSummary, valueOrders } from '../../src/service/domain/pricing';
import { buildItemDetail } from '../../src/service/domain/views';
import type { Listing } from '../../src/shared/types';
import { flagInfo } from '../../src/renderer/format';
import { T0, createStubSchema, makeListing, special, testSettings } from './helpers';

const KEY = 567;
const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

const target = { baseSku: '378;6', special: special() };
const match = () => matchContext(testSettings(), T0);

function sell(metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ intent: 'sell', sku: '378;6', baseSku: '378;6', metalScrap, ...over });
}

describe("the 'impersonator' flag", () => {
  it('excludes an impersonator buyer, apart from a ban', () => {
    expect(EXCLUDING_FLAGS.has('impersonator')).toBe(true);
    const r = classifyOrder(makeListing({ userImpersonated: true }), target, match());
    expect(r.flags).toContain('impersonator');
    expect(r.flags).not.toContain('banned');
    expect(r.eligible).toBe(false);
    // Banned and impersonating: both said.
    expect(classifyOrder(makeListing({ userImpersonated: true, userBanned: true }), target, match()).flags).toEqual(['banned', 'impersonator']);
    // Absent or false: an ordinary buyer.
    expect(classifyOrder(makeListing({}), target, match())).toEqual({ eligible: true, flags: [] });
    expect(classifyOrder(makeListing({ userImpersonated: false }), target, match()).eligible).toBe(true);
  });

  it('marks an impersonator seller excluded on the ask side', () => {
    const out = askCandidatesOf(
      [sell(100, { id: 'imp', steamid: 'S1', userImpersonated: true }), sell(120, { id: 'ok', steamid: 'S2', userImpersonated: false })],
      null,
      match(),
      KEY,
    );
    expect(out.map((c) => [c.id, c.excluded])).toEqual([
      ['imp', true],
      ['ok', false],
    ]);
  });

  it("flags the drawer's buy orders and sell listings, from the stored column, and leaves them out of the ask", () => {
    const repo = openRepo(':memory:');
    openRepos.push(repo);
    repo.upsertListings([
      makeListing({ id: 'b-imp', steamid: 'B1', metalScrap: 95, userImpersonated: true }),
      makeListing({ id: 'b-ok', steamid: 'B2', metalScrap: 90 }),
      sell(110, { id: 's-imp', steamid: 'S1', userImpersonated: true }),
      sell(130, { id: 's-ok', steamid: 'S2' }),
    ]);
    const d = buildItemDetail({ repo, schema: createStubSchema(), sku: '378;6', keyPrice: null, settings: testSettings(), now: T0, snapshot: null as never })!;
    const buyImp = d.buyOrders.find((o) => o.listingId === 'b-imp')!;
    expect(buyImp.flags).toContain('impersonator');
    expect(buyImp.eligible).toBe(false);
    expect(d.buyOrders.find((o) => o.listingId === 'b-ok')!.eligible).toBe(true);
    const sellImp = d.sellListings.find((o) => o.listingId === 's-imp')!;
    expect(sellImp.flags).toContain('impersonator');
    expect(sellImp.eligible).toBe(false);
    // The revenue order and the ask are the clean ones.
    expect(d.revenue?.order?.listingId).toBe('b-ok');
    expect(d.ask).toMatchObject({ lowestScrap: 130, count: 1 });
  });
});

describe('OrderSummary.botService (a label only)', () => {
  const summary = (over: Partial<Listing>) => toOrderSummary(valueOrders([{ listing: makeListing({ id: 'x', ...over }), eligible: true, flags: [] }], KEY)[0]!);

  it("names a bot's service from its client text", () => {
    const s = summary({ isBot: true, uaClient: 'TF2Autobot - Run your own bot for free' });
    expect(s.botService).toBe('TF2Autobot');
    expect(s.isBot).toBe(true);
    // Nothing else changes: the same eligibility and flags.
    expect(s).toMatchObject({ eligible: true, flags: [] });
  });

  it('has no key for a human, an unnamed client or no client', () => {
    expect('botService' in summary({ isBot: false, uaClient: 'TF2Autobot - Run your own bot for free' })).toBe(false);
    expect('botService' in summary({ isBot: true, uaClient: null })).toBe(false);
    expect('botService' in summary({ isBot: true, uaClient: 'User Agent - 1.0' })).toBe(false);
  });
});

describe('0.9 (#11): the flag in the dashboard', () => {
  it("words 'impersonator' as an excluding flag (tone bad), apart from a ban", () => {
    const info = flagInfo('impersonator');
    expect(info).toMatchObject({ label: 'Impersonator', tone: 'bad' });
    expect(info.help).toContain('Excluded, like a ban.');
    expect(info.help).not.toBe(flagInfo('banned').help);
  });
});
