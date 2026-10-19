// F15 in the item drawer and the ItemMenu: ItemDetail.seenOn is the bank of the newest imported
// price shown (its import batch's bank, joined by the repo), for "Seen on scrap.tf/buy/…" and every
// "Open bank page"; a painted item none of whose own prices was imported falls back to its base
// SKU's copies from bank pages (never the /items list). The URL is only ever handed to the user's
// browser (links.open); nothing here fetches it. Real in-memory repo, no network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { buildItemDetail, itemSeenOn } from '../../src/service/domain/views';
import type { KeyPriceState, ScrapPrice, ScrapPriceInput, ScraptfBank } from '../../src/shared/types';
import { HOUR, MIN, T0, createStubSchema, makeListing, special, testSettings } from './helpers';

const KP: KeyPriceState = { valueScrap: 567, source: 'pricedb', observedAt: T0, stale: false, quotes: [], scraptfFromList: null };
const snapshot = { lastAt: T0 - HOUR, available: true, nextAllowedAt: null };
const PAINT = 3100495;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function newRepo(): Repo {
  const r = openRepo(':memory:');
  repos.push(r);
  r.upsertListings([makeListing({ id: 'tc', steamid: 'A', metalScrap: 120 })]);
  return r;
}

function page(repo: Repo, bank: ScraptfBank | null, at: number): number {
  return repo.createImportBatch({ fileName: `${bank ?? 'old'}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: 1, bank });
}

function price(repo: Repo, over: Partial<ScrapPriceInput> & { observedAt: number }): ScrapPrice {
  return repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 30, source: 'import', stock: 1, ...over });
}

function detail(repo: Repo, sku: string, opts: { target?: 'plain' } = {}) {
  return buildItemDetail({ repo, schema: createStubSchema(), sku, keyPrice: KP, settings: testSettings(), now: T0, snapshot, ...opts })!;
}

describe('ItemDetail.seenOn (F15)', () => {
  it('is the newest imported price that names a bank, with its static page and time', () => {
    const repo = newRepo();
    price(repo, { observedAt: T0 - 20 * MIN, importBatch: page(repo, 'stranges', T0 - 20 * MIN) });
    price(repo, { observedAt: T0 - 90 * MIN, importBatch: page(repo, 'hats', T0 - 90 * MIN) });
    // Newer, but typed or from an unrecognised (or 0.4) page: not "seen on" any page.
    price(repo, { observedAt: T0 - MIN, source: 'user' });
    price(repo, { observedAt: T0 - 2 * MIN, importBatch: page(repo, null, T0 - 2 * MIN) });
    const d = detail(repo, '378;6');
    expect(d.seenOn).toEqual({ bank: 'stranges', url: 'https://scrap.tf/buy/stranges', at: T0 - 20 * MIN });
    // Quick entry and the ItemMenu read item.detail as well (target 'plain', history off): same source.
    expect(detail(repo, '378;6', { target: 'plain' }).seenOn).toEqual(d.seenOn);
  });

  it('names the /items list for a price the list wrote, and is null with nothing imported', () => {
    const repo = newRepo();
    expect(detail(repo, '378;6').seenOn).toBeNull();
    price(repo, { observedAt: T0 - 5 * MIN, importBatch: page(repo, 'list', T0 - 5 * MIN) });
    expect(detail(repo, '378;6').seenOn).toEqual({ bank: 'list', url: 'https://scrap.tf/items', at: T0 - 5 * MIN });
  });

  it("reads a painted item's own copies first, then its base copies from bank pages, never the list", () => {
    const repo = newRepo();
    const painted = `378;6;p${PAINT}`;
    // The plain copy was last seen on the list; an older other-paint copy on the hats bank.
    price(repo, { observedAt: T0 - MIN, importBatch: page(repo, 'list', T0 - MIN) });
    price(repo, { observedAt: T0 - 30 * MIN, importBatch: page(repo, 'hats', T0 - 30 * MIN), special: special({ paint: 7511618 }) });
    expect(detail(repo, painted).scrapPrices).toEqual([]);
    expect(detail(repo, painted).seenOn).toEqual({ bank: 'hats', url: 'https://scrap.tf/buy/hats', at: T0 - 30 * MIN });
    // Its own painted copy, once imported, wins whatever its age.
    price(repo, { observedAt: T0 - 3 * HOUR, importBatch: page(repo, 'unusuals', T0 - 3 * HOUR), special: special({ paint: PAINT }) });
    expect(detail(repo, painted).seenOn).toEqual({ bank: 'unusuals', url: 'https://scrap.tf/unusuals', at: T0 - 3 * HOUR });
    // A plain drawer never borrows: it lists every copy itself.
    expect(detail(repo, '378;6').seenOn).toMatchObject({ bank: 'list' });
  });

  it('itemSeenOn: own rows, then base rows without the list, else null', () => {
    const row = (id: number, bank: ScrapPrice['bank'], observedAt: number, source: ScrapPrice['source'] = 'import') =>
      ({ id, sku: '1;6', name: 'x', costKeys: 0, costScrap: 1, source, observedAt, note: null, importBatch: 1, special: null, assetId: null, stock: 1, bank }) satisfies ScrapPrice;
    expect(itemSeenOn([row(1, 'hats', 5)], null)).toEqual({ bank: 'hats', url: 'https://scrap.tf/buy/hats', at: 5 });
    expect(itemSeenOn([], null)).toBeNull();
    expect(itemSeenOn([row(1, null, 9)], [row(2, 'list', 8), row(3, 'skins', 4), row(4, 'weapons', 6, 'user')])).toEqual({ bank: 'skins', url: 'https://scrap.tf/buy/skins', at: 4 });
    expect(itemSeenOn([], [row(2, 'list', 8)])).toBeNull();
  });
});
