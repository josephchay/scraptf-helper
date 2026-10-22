// 0.7.4 (review R28, R32): "Open on scrap.tf" in the item menu and in the drawer agree.
//  - R28: ItemDetail.seenOn can name the /items list (the newest price came from a proven /items row). The
//    menu merged seenOn and kindBank with `??`, so a list seenOn dropped the kind bank and fell back to the
//    category's page: a killstreak weapon opened /buy/killstreaks (kits only), a strange cosmetic
//    /buy/stranges (weapons only), while the drawer opened /buy/items and /buy/hats. itemMenuSections now
//    takes kindBank apart and calls scraptfOpenUrl as the drawer does; a row that names its bank still wins.
//  - R32: the mock's item.detail sends kindBank (mockBankOf), as the service's buildItemDetail does, so the
//    mock drawer and menu open the page the mock's Live market row links.
// Pure, plus the mock bridge; only static allowlisted pages come out, nothing is fetched.

import { afterEach, describe, expect, it } from 'vitest';
import { flattenSections, itemMenuSections, bankPageUrl, scraptfOpenUrl } from '../../src/renderer/itemMenuModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { SEED_KIT } from '../../src/renderer/mockData';
import type { Category, ScraptfBank } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

const menuUrl = (target: { sku: string; name: string; category?: Category; bank?: ScraptfBank }, seenOn: { bank: ScraptfBank } | null, kindBank: ScraptfBank | null) => {
  const item = flattenSections(itemMenuSections(target, { status: 'ready', links: [] }, seenOn, false, kindBank)).find((i) => i.id === 'scraptf-open')!;
  return item.action && item.action.kind === 'scraptf' ? item.action.url : null;
};

describe("the item menu's Open on scrap.tf (R28)", () => {
  it('an item last seen on the /items list opens its kind bank, as the drawer', () => {
    const cases: [string, string, Category, ScraptfBank, string][] = [
      ['205;6;kt-1', 'Killstreak Rocket Launcher', 'killstreaks', 'items', 'https://scrap.tf/buy/items'],
      ['378;11', 'Strange Team Captain', 'stranges', 'hats', 'https://scrap.tf/buy/hats'],
    ];
    for (const [sku, name, category, kindBank, url] of cases) {
      const seenOn = { bank: 'list' as const };
      expect(menuUrl({ sku, name, category }, seenOn, kindBank), sku).toBe(url);
      // The drawer's own call (ItemDrawer.tsx) gives the same page.
      expect(scraptfOpenUrl(category, null, seenOn, kindBank), sku).toBe(url);
      expect(bankPageUrl(seenOn, category, kindBank), sku).toBe(url);
    }
  });

  it('a bank page a save showed still wins over the kind bank; no seenOn uses the kind bank', () => {
    expect(menuUrl({ sku: '378;11', name: 'Strange Team Captain', category: 'stranges' }, { bank: 'stranges' }, 'hats')).toBe('https://scrap.tf/buy/stranges');
    expect(menuUrl({ sku: '378;11', name: 'Strange Team Captain', category: 'stranges' }, null, 'hats')).toBe('https://scrap.tf/buy/hats');
    // Without a kind bank (an older service): the category's page, as before.
    expect(menuUrl({ sku: '378;11', name: 'Strange Team Captain', category: 'stranges' }, { bank: 'list' }, null)).toBe('https://scrap.tf/buy/stranges');
  });

  it('a row that names its bank (the banks page) goes there whatever the item read says', () => {
    expect(menuUrl({ sku: '378;11', name: 'Strange Team Captain', category: 'stranges', bank: 'stranges' }, { bank: 'list' }, 'hats')).toBe('https://scrap.tf/buy/stranges');
  });
});

describe("the mock's item.detail (R32)", () => {
  let b: MockBridge | null = null;
  afterEach(() => {
    b?.dispose();
    b = null;
  });

  it('sends kindBank, so the drawer, the menu and the Live market row agree', async () => {
    b = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
    const sku = '200;6;kt-1';
    await b.rpc('prices.upsert', { sku, costScrap: 50, source: 'user' });
    const d = (await b.rpc('item.detail', { sku, history: false }))!;
    expect(d.kindBank).toBe('items');
    expect(scraptfOpenUrl(d.category, null, d.seenOn, d.kindBank ?? null)).toBe('https://scrap.tf/buy/items');
    expect(bankPageUrl(d.seenOn, d.category, d.kindBank)).toBe('https://scrap.tf/buy/items');
    expect(menuUrl({ sku, name: d.name, category: d.category }, d.seenOn, d.kindBank ?? null)).toBe('https://scrap.tf/buy/items');
    const row = (await b.rpc('market.list', { limit: 2000 })).rows.find((r) => r.sku === sku);
    if (row && row.scraptfLink.source === 'category') expect(row.scraptfLink.url).toBe('https://scrap.tf/buy/items');

    const kit = (await b.rpc('item.detail', { sku: SEED_KIT.sku, history: false }))!;
    expect(kit.kindBank).toBe('killstreaks');
  });
});
