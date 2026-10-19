// F14 in the item drawer: the "scrap.tf price list" block (sells / pays / stock / age), "Use as my
// price" (a typed price at the list's price to buy, dated when the list was saved), the pages handed
// to the user's browser, and Record sale following Holdings' better-exit rule. Pure helpers, the
// drawer's wiring read statically, and the price write against the browser mock. No network: the
// app never visits scrap.tf (R1).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, SCRAPTF_ITEMS_URL, STATIC_EXTERNAL_URLS, bankForCategory, isAllowedExternalUrl, scraptfBankInfo, scraptfPageFor } from '../../src/shared/links';
import { valueScraptfListRow } from '../../src/shared/scraptfList';
import { CATEGORIES } from '../../src/shared/types';
import type { ItemDetail, OrderSummary, ScraptfBank, ScraptfListStored } from '../../src/shared/types';
import {
  OPEN_ON_SCRAPTF_LABEL,
  SCRAPTF_NAME_COPIED,
  SCRAPTF_SALE_NOTE,
  bankPageUrl,
  listPriceAlreadySaved,
  listPriceInput,
  listPriceSavedText,
  recordInitTitle,
  recordSaleInit,
  recordTradeInit,
  scraptfListView,
  scraptfOpenTitle,
  scraptfOpenUrl,
  scraptfOpenedToast,
  scraptfSaleInit,
  scraptfSearchName,
  seenBankPageUrl,
  unpaintedName,
} from '../../src/renderer/itemMenuModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { LIST_PRICE_NOTE } from '../../src/renderer/quickModel';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 568;
const P = DEFAULT_SETTINGS.profit;

function stored(over: Partial<ScraptfListStored> = {}): ScraptfListStored {
  return { sku: '378;6', name: 'Team Captain', sellsKeys: 0, sellsScrap: 12, paysKeys: 0, paysScrap: 11, stock: 2, stockLimit: 5, batchId: 101, observedAt: T0 - 3 * MIN, ...over };
}
const listRow = (over: Partial<ScraptfListStored> = {}, k = K) => valueScraptfListRow(stored(over), k);

function order(valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: `l${valueScrap}`,
    steamid: '76561198000000001',
    userName: 'Flip Bot',
    keys: 0,
    metalScrap: valueScrap,
    valueScrap,
    isBot: true,
    online: true,
    lastEventAt: T0 - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
    ...over,
  };
}

const ITEM = { sku: '378;6', name: 'Team Captain' };

describe('the price-list block', () => {
  it('reads "sells X · pays Y · stock n/limit · saved 3 min ago", prices as the list shows them', () => {
    const v = scraptfListView(listRow(), K, T0);
    expect(v).toMatchObject({ sells: '1.33 ref', pays: '1.22 ref', stock: '2/5', full: false, fresh: true, saved: 'saved 3 min ago', canUse: true });
    expect(v.line).toBe('sells 1.33 ref · pays 1.22 ref · stock 2/5 · saved 3 min ago');
    // Metal only: nothing to convert, so no hover value.
    expect(v.sellsTitle).toBeUndefined();
    expect(v.title).toMatch(/^Your saved copy of scrap\.tf\/items, .+\. Prices and stock may have changed since\.$/);
  });

  it('keeps keys and metal as listed, with the value at the key price on hover', () => {
    const v = scraptfListView(listRow({ sellsKeys: 2, sellsScrap: 45, paysKeys: 1, paysScrap: 9 }), K, T0);
    expect(v.sells).toBe('2 keys 5.00 ref');
    expect(v.pays).toBe('1 key 1.00 ref');
    // 2 x 568 + 45 = 1181 scrap.
    expect(v.sellsTitle).toBe("131.22 ref at today's key price (63.11 ref)");
    expect(v.paysTitle).toBe("64.11 ref at today's key price (63.11 ref)");
  });

  it('marks a sold-out row (no price to buy: nothing to use) and a row without a pays price', () => {
    const soldOut = scraptfListView(listRow({ sellsKeys: null, sellsScrap: null, stock: 0 }), K, T0);
    expect(soldOut).toMatchObject({ sells: 'sold out', hasSells: false, canUse: false, stock: '0/5' });
    expect(soldOut.unusable).toBe('The saved list shows no price to buy (sold out), so there is nothing to use.');
    expect(scraptfListView(listRow(), K, T0)).toMatchObject({ hasSells: true, canUse: true, unusable: null });
    expect(soldOut.line).toBe('sold out · pays 1.22 ref · stock 0/5 · saved 3 min ago');
    expect(soldOut.sellsTitle).toMatch(/no price to buy/);
    const noPays = scraptfListView(listRow({ paysKeys: null, paysScrap: null }), K, T0);
    expect(noPays.pays).toBe('—');
    expect(noPays.paysTitle).toBe('The saved list shows no price scrap.tf pays for this item.');
  });

  it('flags a full row (scrap.tf buys no more) and leaves stock out when the list shows none', () => {
    const full = scraptfListView(listRow({ stock: 5, stockLimit: 5 }), K, T0);
    expect(full.full).toBe(true);
    expect(full.line).toContain('stock 5/5 (full)');
    expect(full.title).toContain('at its limit');
    expect(scraptfListView(listRow({ stock: null, stockLimit: null }), K, T0).line).toBe('sells 1.33 ref · pays 1.22 ref · saved 3 min ago');
    expect(scraptfListView(listRow({ stock: 3, stockLimit: null }), K, T0).stock).toBe('3');
  });

  it('says when a save is over a day old: Holdings no longer counts it as an exit', () => {
    const v = scraptfListView(listRow({ observedAt: T0 - 26 * HOUR }), K, T0);
    expect(v.fresh).toBe(false);
    expect(v.saved).toBe('saved 1 d ago');
    expect(v.title).toContain('Older than a day');
    expect(scraptfListView(listRow({ observedAt: T0 - 24 * HOUR }), K, T0).fresh).toBe(true);
  });
});

describe('"Use as my price"', () => {
  it('writes a typed price at the list price to buy: base SKU, keys and metal as listed, dated by the list', () => {
    expect(listPriceInput(listRow(), ITEM)).toEqual({
      sku: '378;6',
      name: 'Team Captain',
      costKeys: 0,
      costScrap: 12,
      source: 'user',
      observedAt: T0 - 3 * MIN,
      note: LIST_PRICE_NOTE,
    });
    expect(LIST_PRICE_NOTE).toBe('from scrap.tf list');
    expect(listPriceInput(listRow({ sellsKeys: 2, sellsScrap: 45 }), ITEM)).toMatchObject({ costKeys: 2, costScrap: 45 });
  });

  it('prices the plain copy the list is for, whatever copy the drawer shows, and falls back to the list name', () => {
    // The drawer of a painted copy: the list row is the base SKU's.
    expect(listPriceInput(listRow(), { name: 'Team Captain' })?.sku).toBe('378;6');
    expect(listPriceInput(listRow(), { name: '  ' })?.name).toBe('Team Captain');
    // A painted drawer's name loses its "(Paint: X)": the saved price is the plain copy's.
    expect(listPriceInput(listRow(), { name: 'Team Captain (Paint: Australium Gold)' })?.name).toBe('Team Captain');
  });

  it('is offered once: a list price already on the sheet is not added again', () => {
    const row = listRow();
    const input = listPriceInput(row, ITEM)!;
    const saved = { sku: input.sku, source: 'user' as const, note: LIST_PRICE_NOTE, observedAt: input.observedAt!, costKeys: 0, costScrap: input.costScrap, special: null };
    expect(listPriceAlreadySaved(row, [])).toBe(false);
    expect(listPriceAlreadySaved(row, [saved])).toBe(true);
    // A newer save of the list, another price, a painted copy, an import or a typed price of the user's own is not this one.
    expect(listPriceAlreadySaved(listRow({ observedAt: T0 }), [saved])).toBe(false);
    expect(listPriceAlreadySaved(listRow({ sellsScrap: 13 }), [saved])).toBe(false);
    expect(listPriceAlreadySaved(row, [{ ...saved, special: { paint: 15185211, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false } }])).toBe(false);
    expect(listPriceAlreadySaved(row, [{ ...saved, source: 'import' as const }])).toBe(false);
    expect(listPriceAlreadySaved(row, [{ ...saved, note: null }])).toBe(false);
    expect(listPriceAlreadySaved(listRow({ sellsKeys: null, sellsScrap: null }), [saved])).toBe(false);
  });

  it('has nothing to save for a sold-out row', () => {
    expect(listPriceInput(listRow({ sellsKeys: null, sellsScrap: null }), ITEM)).toBeNull();
    expect(listPriceInput(listRow({ sellsKeys: 0, sellsScrap: 0 }), ITEM)).toBeNull();
  });

  it('has nothing to save for a priced row with stock 0, which the import refuses as a price (F14-DM-1)', () => {
    // The fixture's Earbuds: "10 keys, 50 refined" to buy, scrap.tf pays "8 keys, 10 refined", 0/5 in stock.
    const out = listRow({ sku: '143;6', name: 'Earbuds', sellsKeys: 10, sellsScrap: 450, paysKeys: 8, paysScrap: 90, stock: 0, stockLimit: 5 });
    expect(listPriceInput(out, ITEM)).toBeNull();
    const v = scraptfListView(out, K, T0);
    // The line still reads "sells X" (a price is listed); only Use is off, with the reason.
    expect(v).toMatchObject({ sells: '10 keys 50.00 ref', hasSells: true, canUse: false });
    expect(v.line).toBe('sells 10 keys 50.00 ref · pays 8 keys 10.00 ref · stock 0/5 · saved 3 min ago');
    expect(v.unusable).toBe('Out of stock on scrap.tf (stock 0 in your saved list), so there is nothing to buy at this price.');
    // Nothing to offer, so nothing counts as already saved either.
    const saved = { sku: '143;6', source: 'user' as const, note: LIST_PRICE_NOTE, observedAt: out.observedAt, costKeys: 10, costScrap: 450, special: null };
    expect(listPriceAlreadySaved(out, [saved])).toBe(false);
    // Stock not shown, or in stock, still saves.
    expect(listPriceInput(listRow({ stock: null, stockLimit: null }), ITEM)).not.toBeNull();
    expect(listPriceInput(listRow({ stock: 1 }), ITEM)).not.toBeNull();
  });

  it('confirms with the price and the age of the list', () => {
    expect(listPriceSavedText({ name: 'Team Captain', costKeys: 0, costScrap: 12 }, T0 - 3 * MIN, T0)).toBe('Saved Team Captain at 1.33 ref, from your scrap.tf list saved 3 min ago.');
  });

  describe('against the browser mock', () => {
    let bridge: MockBridge | null = null;
    afterEach(() => {
      bridge?.dispose();
      bridge = null;
    });

    it("is a valid prices.upsert that keeps the list's date and note", async () => {
      const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
      const d = (await b.rpc('item.detail', { sku: '378;6', history: false }))!;
      expect(d.scraptfList).not.toBeNull();
      const input = listPriceInput(d.scraptfList!, d)!;
      const saved = await b.rpc('prices.upsert', input);
      expect(saved).toMatchObject({ sku: '378;6', source: 'user', note: LIST_PRICE_NOTE, observedAt: d.scraptfList!.observedAt, costScrap: d.scraptfList!.sellsScrapRaw });
      const again = (await b.rpc('item.detail', { sku: '378;6', history: false }))!;
      expect(again.scrapPrices.some((p) => p.id === saved.id)).toBe(true);
    });
  });
});

describe('"Open on scrap.tf (copies name)"', () => {
  it('goes to the bank page of the item category, or the full list without one', () => {
    for (const c of CATEGORIES) expect(scraptfOpenUrl(c, null)).toBe(scraptfPageFor(c));
    expect(scraptfOpenUrl(undefined, null)).toBe(SCRAPTF_ITEMS_URL);
  });

  it("uses links.forSku's bank page in the item menu, waits while the links load, and never another URL", () => {
    const page = { id: 'scraptf-page', label: 'scrap.tf (category page)', url: scraptfPageFor('hats'), group: 'market' as const };
    expect(scraptfOpenUrl(undefined, { status: 'loading' })).toBeNull();
    expect(scraptfOpenUrl(undefined, { status: 'ready', links: [page] })).toBe(scraptfPageFor('hats'));
    expect(scraptfOpenUrl(undefined, { status: 'ready', links: [] })).toBe(SCRAPTF_ITEMS_URL);
    expect(scraptfOpenUrl(undefined, { status: 'ready', links: [{ ...page, url: 'https://scrap.tf/ajax/x' }] })).toBe(SCRAPTF_ITEMS_URL);
    expect(scraptfOpenUrl(undefined, { status: 'error', message: 'restarting' })).toBe(SCRAPTF_ITEMS_URL);
    // A known category wins over everything else.
    expect(scraptfOpenUrl('weapons', { status: 'loading' })).toBe(scraptfPageFor('weapons'));
  });

  it('F15: goes to the bank page the item was last seen on first, else the category\'s (never the /items list)', () => {
    const seen = (bank: ScraptfBank) => ({ bank, url: 'https://example.com/not-used', at: T0 });
    // Seen on the stranges page: that page, whatever the category or the links say.
    expect(scraptfOpenUrl('hats', null, seen('stranges'))).toBe(scraptfPageFor('stranges'));
    expect(scraptfOpenUrl(undefined, { status: 'loading' }, seen('unusuals'))).toBe('https://scrap.tf/unusuals');
    expect(scraptfOpenUrl('taunts', null, seen('items'))).toBe('https://scrap.tf/buy/items');
    // Seen only on the /items list (nothing is bought there), or nowhere: the category's bank.
    expect(scraptfOpenUrl('hats', null, seen('list'))).toBe(scraptfPageFor('hats'));
    expect(scraptfOpenUrl('hats', null, null)).toBe(scraptfPageFor('hats'));
    expect(scraptfOpenUrl(undefined, { status: 'loading' }, seen('list'))).toBeNull();
    // A stray bank id is ignored; the static address is used, never the one the service sent.
    expect(scraptfOpenUrl('weapons', null, { bank: '__proto__' as ScraptfBank })).toBe(scraptfPageFor('weapons'));
    expect(seenBankPageUrl(seen('skins'))).toBe(scraptfPageFor('skins'));
    expect(seenBankPageUrl(seen('list'))).toBeNull();
    expect(seenBankPageUrl(null)).toBeNull();
  });

  it('F15: every "Open bank page" uses seenOn, else bankForCategory', () => {
    for (const c of CATEGORIES) {
      expect(bankPageUrl(null, c)).toBe(scraptfBankInfo(bankForCategory(c))!.url);
      expect(bankPageUrl(null, c)).toBe(scraptfPageFor(c));
      expect(bankPageUrl({ bank: 'list' }, c)).toBe(scraptfPageFor(c));
    }
    expect(bankPageUrl({ bank: 'killstreaks' }, 'hats')).toBe('https://scrap.tf/buy/killstreaks');
    for (const b of SCRAPTF_BANKS) {
      const url = bankPageUrl({ bank: b.bank }, 'other');
      expect(STATIC_EXTERNAL_URLS).toContain(url);
      expect(isAllowedExternalUrl(url)).toBe(true);
    }
  });

  it('only ever hands static allowlisted pages to links.open', () => {
    const urls = [...CATEGORIES.map((c) => scraptfOpenUrl(c, null)), scraptfOpenUrl(undefined, null)];
    for (const u of urls) {
      expect(STATIC_EXTERNAL_URLS).toContain(u);
      expect(isAllowedExternalUrl(u!)).toBe(true);
    }
  });

  it('copies the name (the SKU without one) and says what to do next', () => {
    expect(scraptfSearchName({ sku: '378;6', name: ' Team Captain ' })).toBe('Team Captain');
    expect(scraptfSearchName({ sku: '378;6', name: '' })).toBe('378;6');
    // scrap.tf names items unpainted; the schema's "(Paint: X)" would find nothing in its search.
    expect(scraptfSearchName({ sku: '378;6;p15185211', name: 'Team Captain (Paint: Australium Gold)' })).toBe('Team Captain');
    expect(unpaintedName('Texas Ten Gallon (Paint: Pink as Hell)')).toBe('Texas Ten Gallon');
    expect(unpaintedName('Strange Professional Killstreak Rocket Launcher')).toBe('Strange Professional Killstreak Rocket Launcher');
    expect(unpaintedName('Mann Co. Supply Crate Series #92')).toBe('Mann Co. Supply Crate Series #92');
    expect(SCRAPTF_NAME_COPIED).toBe("Name copied. Paste it into scrap.tf's search.");
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, SCRAPTF_ITEMS_URL)).toEqual({ text: SCRAPTF_NAME_COPIED, tone: 'good' });
    expect(scraptfOpenedToast(false, { opened: true, reason: null }, SCRAPTF_ITEMS_URL).tone).toBe('warn');
    const refused = scraptfOpenedToast(true, { opened: false, reason: 'Browser preview.' }, SCRAPTF_ITEMS_URL);
    expect(refused).toEqual({ text: `Browser preview. The name was copied: open ${SCRAPTF_ITEMS_URL} in your browser and paste it into scrap.tf's search.`, tone: 'warn' });
    expect(scraptfOpenedToast(false, { opened: false, reason: null }, SCRAPTF_ITEMS_URL).text).toBe(`The link could not be opened. ${SCRAPTF_ITEMS_URL}`);
    expect(OPEN_ON_SCRAPTF_LABEL).toBe('Open on scrap.tf (copies name)');
    expect(scraptfOpenTitle(SCRAPTF_ITEMS_URL, 'Team Captain')).toContain('The app never visits scrap.tf.');
  });
});

describe('Record sale follows the better exit (Holdings rule)', () => {
  const exit = (over: Partial<ScraptfListStored> = {}) => ({ list: listRow(over), now: T0 });

  it('sells to scrap.tf at its listed pays price when the fresh list pays more than the buyer', () => {
    expect(recordSaleInit(ITEM, order(10), exit())).toEqual({ side: 'sell', sku: '378;6', name: 'Team Captain', venue: 'scrap.tf', keys: 0, scrap: 11, note: SCRAPTF_SALE_NOTE });
    // Keys and metal as the list shows them.
    expect(recordSaleInit(ITEM, order(560), exit({ paysKeys: 1, paysScrap: 5 }))).toMatchObject({ venue: 'scrap.tf', keys: 1, scrap: 5 });
    // No buyer at all: scrap.tf is the only exit.
    expect(recordSaleInit(ITEM, null, exit())).toMatchObject({ venue: 'scrap.tf', scrap: 11 });
  });

  it('stays on backpack.tf for a tie, a full or stale list, or no pays price', () => {
    const bp = { side: 'sell', sku: '378;6', name: 'Team Captain', venue: 'backpack.tf', keys: 0, scrap: 11, note: 'Sold to Flip Bot' };
    expect(recordSaleInit(ITEM, order(11), exit())).toEqual(bp);
    expect(recordSaleInit(ITEM, order(10), exit({ stock: 5, stockLimit: 5 })).venue).toBe('backpack.tf');
    expect(recordSaleInit(ITEM, order(10), exit({ observedAt: T0 - 25 * HOUR })).venue).toBe('backpack.tf');
    expect(recordSaleInit(ITEM, null, exit({ paysKeys: null, paysScrap: null }))).toEqual({ side: 'sell', sku: '378;6', name: 'Team Captain', venue: 'backpack.tf' });
    // Without the list (the 0.3 call) nothing changes.
    expect(recordSaleInit(ITEM, order(10))).toMatchObject({ venue: 'backpack.tf', scrap: 10 });
  });

  it('prefills the item menu the same way from item.detail', () => {
    const d = { name: 'Team Captain', scrapPrices: [], revenue: null, buyOrders: [order(10)], scraptfList: listRow() } satisfies Pick<ItemDetail, 'name' | 'scrapPrices' | 'revenue' | 'buyOrders' | 'scraptfList'>;
    expect(recordTradeInit('sell', ITEM, d, P, T0)).toMatchObject({ venue: 'scrap.tf', keys: 0, scrap: 11, note: SCRAPTF_SALE_NOTE });
    expect(recordTradeInit('sell', ITEM, { ...d, scraptfList: null }, P, T0)).toMatchObject({ venue: 'backpack.tf', scrap: 10 });
    expect(recordTradeInit('buy', ITEM, d, P, T0).venue).toBe('scrap.tf');
  });

  it('writes a scrap.tf sale only with a price, and the button says where', () => {
    expect(scraptfSaleInit(ITEM, { paysKeys: null, paysScrapRaw: null })).toEqual({ side: 'sell', sku: '378;6', name: 'Team Captain', venue: 'scrap.tf' });
    expect(recordInitTitle(recordSaleInit(ITEM, order(10), exit()))).toBe('Write a sale at 1.22 ref on scrap.tf (Sold to scrap.tf) to your journal; you can change it first. Nothing is traded.');
  });
});

describe('item drawer wiring (F14)', () => {
  const drawer = readFileSync(new URL('../../src/renderer/pages/ItemDrawer.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/renderer/styles/drawer-extra.css', import.meta.url), 'utf8');

  it('shows the price-list block from item.detail and saves "Use as my price" through prices.upsert only', () => {
    expect(drawer).toContain('<ScraptfListSection d={d} row={d.scraptfList}');
    expect(drawer).toContain('<h3 id="sec-stf-list">scrap.tf price list</h3>');
    expect(drawer).toContain('const input = row ? listPriceInput(row, d) : null;');
    expect(drawer).toContain("await rpc('prices.upsert', input)");
    expect(drawer).toMatch(/if \(!row \|\| !input \|\| used \|\| savingRef\.current\) return;/);
    expect(drawer).toContain('The app never visits scrap.tf; your browser does, and you choose when.');
  });

  it('opens scrap.tf pages only in the user browser (links.open), from the shared constants', () => {
    expect(drawer).toContain('openOrCopy(SCRAPTF_ITEMS_URL, toast)');
    // F15: the bank page the item was last seen on, else its category's (bankPageUrl).
    expect(drawer).toContain('const bankPage = bankPageUrl(d.seenOn, d.category);');
    expect(drawer).toContain('openOrCopy(bankPage, toast)');
    expect(drawer).toContain('const stfUrl = scraptfOpenUrl(d.category, null, d.seenOn) ?? SCRAPTF_ITEMS_URL;');
    // F19: armed with the drawer's SKU and exactly the name it copies, so a price copied there comes back.
    expect(drawer).toContain('openOnScraptf(stfUrl, scraptfSearchName(d), toast, { sku: d.sku, settings })');
    expect(drawer.match(/openOnScraptf\(/g)).toHaveLength(1);
    expect(drawer).toContain('{OPEN_ON_SCRAPTF_LABEL}');
    // No scrap.tf address written out (only the "scrap.tf/items" label), and nothing fetched.
    expect(drawer).not.toMatch(/https?:\/\/[^'"`\s]*scrap\.tf/);
    expect(drawer).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
  });

  it('refreshes on a new list and prefills Record sale at the better exit', () => {
    expect(drawer).toContain("useVisiblePush('scraptf.listChanged', reload);");
    expect(drawer).toContain('recordSaleInit(d, previewRevenue(d, profit).order, d.scraptfList ? { list: d.scraptfList, now } : null)');
    // "Record sale to this buyer" stays that buyer's order.
    expect(drawer).toContain('recordTrade.open(recordSaleInit(d, o))');
    // "Use as my price" cannot add the same list price twice.
    // A painted drawer's prices leave out the plain copy's row, so the service's flag answers for it (UI-1).
    expect(drawer).toContain('const used = row ? d.scraptfListSaved || listPriceAlreadySaved(row, d.scrapPrices) : false;');
    expect(drawer).toContain('disabled={!view.canUse || used || saving}');
    // A stock-0 row keeps its "sells" label, and the disabled button says why (F14-DM-1).
    expect(drawer).toContain('{view.hasSells ? (');
    expect(drawer).toContain('? (view.unusable ?? undefined)');
  });

  it('styles the block from the tokens only', () => {
    const block = css.slice(css.indexOf('scrap.tf price list (F14)'), css.indexOf('your scrap.tf prices ----'));
    expect(block).toContain('.stf-list-line');
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(block).not.toMatch(/\brgba?\(/);
  });
});
