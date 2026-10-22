// 0.8 (H3, PC-7): the copy-matched ask side. Which sell listings are the same copy (askCopyMatches), which count
// (askCandidatesOf), and the item drawer's ItemDetail.ask from the sell listings it already reads. Real in-memory
// repo; nothing here touches the network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { askCandidatesOf, askCopyMatches } from '../../src/service/domain/asks';
import { matchContext } from '../../src/service/domain/matcher';
import { buildItemDetail } from '../../src/service/domain/views';
import type { Listing } from '../../src/shared/types';
import { MIN, T0, createStubSchema, makeListing, special, testSettings } from './helpers';

const openRepos: Repo[] = [];
afterEach(() => {
  while (openRepos.length) openRepos.pop()!.close();
});

const PAINT = 3100495;
const KEY = 567;

function sell(metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ intent: 'sell', sku: '378;6', baseSku: '378;6', metalScrap, ...over });
}

describe('askCopyMatches', () => {
  it('matches a clean copy only against a clean listing; sheen and killstreaker are free', () => {
    expect(askCopyMatches(sell(100), null)).toBe(true);
    expect(askCopyMatches(sell(100, { special: special({ sheen: 2, killstreaker: 2003 }) }), null)).toBe(true);
    expect(askCopyMatches(sell(100, { special: special({ spells: ['Exorcism'] }) }), null)).toBe(false);
    expect(askCopyMatches(sell(100, { special: special({ parts: ['Kills'] }) }), null)).toBe(false);
    expect(askCopyMatches(sell(100, { special: special({ customName: true }) }), null)).toBe(false);
    expect(askCopyMatches(sell(100, { special: special({ customDesc: true }) }), null)).toBe(false);
  });

  it('matches a painted copy on its paint, read from the SKU token when the attributes omit it', () => {
    expect(askCopyMatches(sell(100, { special: special({ paint: PAINT }) }), null)).toBe(false);
    expect(askCopyMatches(sell(100, { special: special({ paint: PAINT }) }), PAINT)).toBe(true);
    expect(askCopyMatches(sell(100, { sku: `378;6;p${PAINT}` }), PAINT)).toBe(true);
    expect(askCopyMatches(sell(100, { sku: `378;6;p${PAINT}` }), null)).toBe(false);
    expect(askCopyMatches(sell(100), PAINT)).toBe(false);
  });
});

describe('askCandidatesOf', () => {
  it('values sell listings and excludes marketplace.tf, banned and blocklisted sellers; buy orders never count', () => {
    const match = matchContext(testSettings({ blocklist: ['BLOCKED'] }), T0);
    const out = askCandidatesOf(
      [
        sell(0, { id: 'k', steamid: 'S1', keys: 1, metalScrap: 9, isBot: true }),
        sell(100, { id: 'mp', steamid: 'S2', isMarketplace: true }),
        sell(100, { id: 'ban', steamid: 'S3', userBanned: true }),
        sell(100, { id: 'bl', steamid: 'BLOCKED' }),
        makeListing({ id: 'buy', intent: 'buy', metalScrap: 200 }),
        sell(Number.NaN, { id: 'nan', steamid: 'S4', keys: Number.NaN }),
      ],
      null,
      match,
      KEY,
    );
    expect(out.map((c) => [c.id, c.valueScrap, c.excluded])).toEqual([
      ['k', KEY + 9, false],
      ['mp', 100, true],
      ['ban', 100, true],
      ['bl', 100, true],
      ['nan', 0, false],
    ]);
    expect(out[0]).toMatchObject({ steamid: 'S1', keys: 1, metalScrap: 9, isBot: true, lastEventAt: T0 - MIN });
  });
});

describe('buildItemDetail(...).ask', () => {
  function seeded(): Repo {
    const repo = openRepo(':memory:');
    openRepos.push(repo);
    repo.upsertListings([
      makeListing({ id: 'b1', intent: 'buy', metalScrap: 90 }),
      sell(130, { id: 'clean1', steamid: 'S1', isBot: true }),
      sell(125, { id: 'clean2', steamid: 'S2' }),
      sell(140, { id: 'mine', steamid: 'ME' }),
      sell(110, { id: 'mine2', steamid: 'ME' }),
      sell(150, { id: 'painted', steamid: 'S3', sku: `378;6;p${PAINT}`, special: special({ paint: PAINT }) }),
    ]);
    return repo;
  }
  const detail = (repo: Repo, sku: string, ownSteamIds: string[] = []) =>
    buildItemDetail({ repo, schema: createStubSchema(), sku, keyPrice: null, settings: testSettings({ ownSteamIds }), now: T0, snapshot: null as never })!;

  it("reads the clean copy's lowest ask from the drawer's sell listings", () => {
    const d = detail(seeded(), '378;6');
    expect(d.ask).toMatchObject({ lowestScrap: 110, count: 3, botCount: 1, ownLeftOut: 0, mayIncludeOwn: true });
  });

  it("reads a painted SKU's ask from listings of that paint only", () => {
    const d = detail(seeded(), `378;6;p${PAINT}`);
    expect(d.ask).toMatchObject({ lowestScrap: 150, count: 1, mayIncludeOwn: true });
  });

  it("leaves the user's own listings out with settings.ownSteamIds", () => {
    const d = detail(seeded(), '378;6', ['ME']);
    expect(d.ask).toMatchObject({ lowestScrap: 125, count: 2, ownLeftOut: 2, mayIncludeOwn: false });
  });

  it('is null without a matching ask', () => {
    const repo = openRepo(':memory:');
    openRepos.push(repo);
    repo.upsertListings([makeListing({ id: 'b1', intent: 'buy', metalScrap: 90 })]);
    expect(detail(repo, '378;6').ask).toBeNull();
  });
});
