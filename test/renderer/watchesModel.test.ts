// 0.8 (G1/G3): the dashboard's watch words and form rules (watchesModel.ts): the form reads a price as traders type
// it (keys and metal kept as typed) and a profit in ref, refuses with fixed texts, and hands the shared rules
// (watchInputProblem, watchWriteOf) what the service gets; the copy text, where a watch stands now (each tone, its
// save named), the notes that say why a watch would tell nothing, the undo input and the count.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fmtAgo } from '../../src/renderer/format';
import {
  WATCHES_EMPTY,
  WATCH_BOUNDARY_NOTE,
  WATCH_MENU_LABEL,
  WATCH_MENU_TITLE,
  WATCH_PRICE_ERROR,
  WATCH_PROFIT_ERROR,
  WATCH_PROFIT_KEYS_ERROR,
  changeMenuTarget,
  oppMenuTarget,
  priceMenuTarget,
  watchCopyText,
  watchesCountText,
  watchesForCopy,
  watchFormInit,
  watchFormInput,
  watchNotifyNote,
  watchNowView,
  watchRemovedText,
  watchUndoInput,
  type WatchFormState,
} from '../../src/renderer/watchesModel';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import { SCRAPTF_BOUNDARY_SHORT } from '../../src/shared/boundaryText';
import { opportunityCopyKey } from '../../src/shared/copyExtras';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { ScraptfWatch, ScraptfWatchNow, Settings } from '../../src/shared/types';
import { WATCHES_MAX, WATCH_EMPTY, WATCH_ZERO_PRICE, watchCovers, watchFloorOf, watchIndexOf, watchWriteOf } from '../../src/shared/watches';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const KEY = 600;
const PINK = bankStockSpecialKey({ paint: 16738740 });

function watch(over: Partial<ScraptfWatch> = {}): ScraptfWatch {
  return { id: 1, sku: '378;6', specialKey: '', name: 'Team Captain', maxCostKeys: 0, maxCostScrap: 17, minProfitScrap: null, onRestock: false, enabled: true, createdAt: T0 - MIN, updatedAt: T0 - MIN, ...over };
}

const form = (over: Partial<WatchFormState> = {}): WatchFormState => ({ copies: 'one', price: '', profit: '', onRestock: false, ...over });
const args = { sku: '378;6', special: null, name: 'Team Captain', unit: 'ref' as const, keyScrap: KEY };

describe('the watch texts', () => {
  it('say where a watch is checked, in the boundary wording the app keeps', () => {
    expect(WATCH_MENU_LABEL).toBe('Watch on scrap.tf…');
    expect(WATCH_MENU_TITLE).toContain('Flip Desk never loads scrap.tf on its own and never buys anything.');
    expect(WATCH_BOUNDARY_NOTE).toContain('Checked only on the scrap.tf pages you read in the window or save');
    expect(WATCH_BOUNDARY_NOTE).toContain('Nothing is bought for you.');
    expect(WATCHES_EMPTY.title).toBe('No watches yet');
    expect(WATCHES_EMPTY.body).toContain('Watch on scrap.tf…');
    expect(watchesCountText(3)).toBe(`3 of ${WATCHES_MAX}`);
    expect(watchRemovedText(watch())).toBe('Stopped watching Team Captain');
  });
});

describe('watchFormInit', () => {
  it('is blank without a watch', () => {
    expect(watchFormInit(null, 'any')).toEqual({ copies: 'any', price: '', profit: '', onRestock: false });
  });

  it('shows a metal price without its unit when bare numbers read as ref, keys and metal as typed, the profit in ref', () => {
    expect(watchFormInit(watch(), 'one')).toEqual({ copies: 'one', price: '1.88', profit: '', onRestock: false });
    expect(watchFormInit(watch({ maxCostKeys: 2, maxCostScrap: 46, minProfitScrap: 11, onRestock: true }), 'one')).toEqual({
      copies: 'one',
      price: '2 keys 5.11 ref',
      profit: '1.22 ref',
      onRestock: true,
    });
    expect(watchFormInit(watch({ maxCostKeys: 2, maxCostScrap: 0 }), 'one').price).toBe('2 keys');
    // Under another unit a bare "1.88" would read as scrap or keys: the unit stays.
    expect(watchFormInit(watch(), 'one', 'scrap').price).toBe('1.88 ref');
    expect(watchFormInit(watch({ maxCostScrap: null, minProfitScrap: 9 }), 'any')).toEqual({ copies: 'any', price: '', profit: '1.00 ref', onRestock: false });
  });

  it('reads back as the same targets', () => {
    for (const w of [watch(), watch({ maxCostKeys: 2, maxCostScrap: 46, minProfitScrap: 11 }), watch({ maxCostKeys: 1.5, maxCostScrap: 0, onRestock: true })]) {
      for (const unit of ['ref', 'scrap', 'keys'] as const) {
        const r = watchFormInput(watchFormInit(w, 'one', unit), { ...args, unit });
        expect('input' in r && r.input).toMatchObject({ maxCostKeys: w.maxCostKeys, maxCostScrap: w.maxCostScrap, minProfitScrap: w.minProfitScrap, onRestock: w.onRestock });
      }
    }
  });
});

describe('watchFormInput', () => {
  it('reads a price as typed (keys and metal kept) and a profit in ref', () => {
    expect(watchFormInput(form({ price: '1.88' }), args)).toEqual({
      input: { sku: '378;6', copies: 'one', special: null, name: 'Team Captain', maxCostKeys: 0, maxCostScrap: 17, minProfitScrap: null, onRestock: false, enabled: true },
    });
    const keys = watchFormInput(form({ price: '2 keys 5.11', profit: '1.22' }), args);
    expect('input' in keys && keys.input).toMatchObject({ maxCostKeys: 2, maxCostScrap: 46, minProfitScrap: 11 });
    // A bare number reads in the unit chosen.
    const scrap = watchFormInput(form({ price: '14' }), { ...args, unit: 'scrap' });
    expect('input' in scrap && scrap.input).toMatchObject({ maxCostKeys: 0, maxCostScrap: 14 });
    // A profit in keys is valued at the key price, rounded.
    const kProfit = watchFormInput(form({ profit: '1.5 keys' }), args);
    expect('input' in kProfit && kProfit.input.minProfitScrap).toBe(900);
  });

  it('refuses an unreadable price or profit, a profit in keys without a key price, then as the shared rules do', () => {
    expect(watchFormInput(form({ price: 'cheap' }), args)).toEqual({ error: WATCH_PRICE_ERROR });
    expect(watchFormInput(form({ profit: 'lots' }), args)).toEqual({ error: WATCH_PROFIT_ERROR });
    expect(watchFormInput(form({ profit: '1 key' }), { ...args, keyScrap: null })).toEqual({ error: WATCH_PROFIT_KEYS_ERROR });
    expect(watchFormInput(form(), args)).toEqual({ error: WATCH_EMPTY });
    expect(watchFormInput(form({ price: '0' }), args)).toEqual({ error: WATCH_ZERO_PRICE });
    // "Back on sale" alone is a watch.
    expect('input' in watchFormInput(form({ onRestock: true }), args)).toBe(true);
  });

  it('watches the form\'s copy or every copy, updates by id, trims the name and turns the watch on', () => {
    const one = watchFormInput(form({ price: '1' }), { ...args, special: PINK, id: 7, name: '  Team Captain  ' });
    expect('input' in one && one.input).toMatchObject({ id: 7, copies: 'one', special: PINK, name: 'Team Captain', enabled: true });
    const any = watchFormInput(form({ copies: 'any', price: '1' }), { ...args, special: PINK });
    expect('input' in any && any.input).toMatchObject({ copies: 'any', special: null });
    expect('input' in any && 'id' in any.input).toBe(false);
    // What the service gets is what watchWriteOf turns into the stored watch.
    const w = 'input' in one ? watchWriteOf(one.input, watch({ id: 7, specialKey: PINK }), () => null) : null;
    expect(w).toMatchObject({ id: 7, sku: '378;6', specialKey: PINK, maxCostKeys: 0, maxCostScrap: 9 });
  });
});

describe('watchCopyText', () => {
  it('says any copy, a clean copy, or the copy\'s extras', () => {
    expect(watchCopyText({ sku: '378;6', specialKey: null })).toBe('Any copy');
    expect(watchCopyText({ sku: '378;6', specialKey: '' })).toBe('Clean copy');
    expect(watchCopyText({ sku: '378;6', specialKey: PINK })).toBe('Paint: Pink as Hell');
    expect(watchCopyText({ sku: '378;6', specialKey: 'not json' })).toBe('This copy');
  });
});

describe('watchNowView', () => {
  const now = (over: Partial<ScraptfWatchNow> = {}): ScraptfWatchNow => ({
    bank: 'hats',
    savedAt: T0 - 5 * MIN,
    costKeys: 0,
    costScrapRaw: 19,
    costScrap: 19,
    revenueScrap: 30,
    profitScrap: 11,
    verdict: 'flip',
    met: null,
    overTargetScrap: 1,
    ...over,
  });
  const save = `(your save ${fmtAgo(T0 - 5 * MIN, T0)})`;

  it('says a watch with no copy on sale is not on sale in the saves, and how to check', () => {
    expect(watchNowView({ now: null }, KEY, T0)).toEqual({
      text: 'Not on sale in your saves',
      title: `None of your saved pages' newest saves lists it on sale. Read or save its page to check; ${SCRAPTF_BOUNDARY_SHORT}`,
      tone: 'muted',
    });
  });

  it('says at your target, profit target met, over your target, or the price, each dated by its save', () => {
    const price = watchNowView({ now: now({ met: 'price', costScrapRaw: 17, costScrap: 17, overTargetScrap: 0 }) }, KEY, T0);
    expect(price).toMatchObject({ text: 'At your target: 1.88 ref on Hats', tone: 'good' });
    const profit = watchNowView({ now: now({ met: 'profit' }) }, KEY, T0);
    expect(profit).toMatchObject({ text: 'Profit target met: +1.22 ref at 2.11 ref on Hats', tone: 'good' });
    const over = watchNowView({ now: now() }, KEY, T0);
    expect(over).toMatchObject({ text: '2.11 ref on Hats: 0.11 ref over your target', tone: 'warn' });
    const plain = watchNowView({ now: now({ overTargetScrap: null }) }, KEY, T0);
    expect(plain).toMatchObject({ text: '2.11 ref on Hats', tone: 'muted' });
    // A copy listed in keys keeps its keys.
    expect(watchNowView({ now: now({ costKeys: 1, costScrapRaw: 9, costScrap: 609, overTargetScrap: null }) }, KEY, T0).text).toBe('1 key 1.00 ref on Hats');
    for (const v of [price, profit, over, plain]) expect(v.title).toContain(save);
  });
});

describe('watchNotifyNote', () => {
  const on: Settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: true }, import: { ...DEFAULT_SETTINGS.import, enabled: true, acknowledgedAt: T0 } };

  it('says the first thing that keeps a watch silent, else nothing', () => {
    expect(watchNotifyNote(null)).toBeNull();
    expect(watchNotifyNote(on)).toBeNull();
    expect(watchNotifyNote({ ...on, notifications: { ...on.notifications, enabled: false } })).toBe('Desktop notifications are off (Settings → Notifications): watches show here only.');
    expect(watchNotifyNote({ ...on, notifications: { ...on.notifications, watches: false } })).toBe('Watch notifications are off (Settings → Notifications).');
    expect(watchNotifyNote({ ...on, import: { ...on.import, acknowledgedAt: null } })).toBe('Saved-page import is off, so no page is read for your watches (Import).');
    expect(watchNotifyNote({ ...on, import: { ...on.import, enabled: false } })).toBe('Saved-page import is off, so no page is read for your watches (Import).');
  });
});

describe('watchesForCopy, watchUndoInput', () => {
  const list = [watch({ id: 1, specialKey: '' }), watch({ id: 2, specialKey: PINK }), watch({ id: 3, specialKey: null }), watch({ id: 4, sku: '30001;6', specialKey: null })];

  it('finds the form copy\'s watch (the SKU\'s own when no copy is given) and the any-copy one of that base only', () => {
    expect(watchesForCopy(list, '378;6', null)).toEqual({ one: list[0], any: list[2] });
    expect(watchesForCopy(list, '378;6', PINK)).toEqual({ one: list[1], any: list[2] });
    // A painted SKU's own copy is its paint.
    expect(watchesForCopy(list, '378;6;p16738740', null)).toEqual({ one: list[1], any: list[2] });
    expect(watchesForCopy(list, '5021;6', null)).toEqual({ one: null, any: null });
  });

  it('adds a removed watch back with its copy, targets and switches', () => {
    for (const w of list) {
      const back = watchWriteOf(watchUndoInput({ ...w, minProfitScrap: 20, onRestock: true, enabled: false }), null, () => null);
      expect(back).toEqual({ sku: w.sku, specialKey: w.specialKey, name: w.name, maxCostKeys: w.maxCostKeys, maxCostScrap: w.maxCostScrap, minProfitScrap: 20, onRestock: true, enabled: false });
    }
  });
});

describe('Watch on scrap.tf… from a row that prices one copy (oppMenuTarget, priceMenuTarget, changeMenuTarget)', () => {
  // An imported painted Last Laugh: the plain base SKU, the paint only in the price's extras and the row's copyKey.
  const SKU = '30478;6';
  const AFTER_EIGHT = 1315860;
  const copyKey = opportunityCopyKey(SKU, { paint: AFTER_EIGHT });
  const save = (target: { sku: string; name: string; special?: string }) => {
    const r = watchFormInput(
      { copies: 'one', price: '', profit: '1', onRestock: false },
      { sku: target.sku, special: target.special ?? null, name: target.name, unit: 'ref', keyScrap: KEY },
    );
    if (!('input' in r)) throw new Error(r.error);
    return watchWriteOf(r.input, null, () => null);
  };
  const stored = (specialKey: string | null): ScraptfWatch => watch({ sku: SKU, specialKey, maxCostScrap: null, minProfitScrap: 9 });

  it("saves \"This copy\" as the row's own copy, so the watch covers the painted copy and not the clean one", () => {
    expect(copyKey).not.toBe('');
    const target = oppMenuTarget({ sku: SKU, name: 'The Last Laugh', category: 'hats', copyKey });
    expect(target).toEqual({ sku: SKU, name: 'The Last Laugh', category: 'hats', special: copyKey });
    const w = save(target);
    expect(w.specialKey).toBe(copyKey);
    const index = watchIndexOf([stored(w.specialKey)]);
    expect(watchCovers(stored(w.specialKey), { sku: SKU, specialKey: copyKey })).toBe(true);
    expect(watchCovers(stored(w.specialKey), { sku: SKU, specialKey: '' })).toBe(false);
    // The engine's bar (path B) applies to the painted copy's opportunity, not the clean one's.
    expect(watchFloorOf(index, SKU, copyKey)).toBe(9);
    expect(watchFloorOf(index, SKU, '')).toBeNull();
    // Without the copy (0.8 as first written) "This copy" was the clean copy.
    expect(save({ sku: SKU, name: 'The Last Laugh' }).specialKey).toBe('');
  });

  it('keeps the SKU\'s own copy for an older row without a copyKey, and names the copy of a price and a change event', () => {
    expect(oppMenuTarget({ sku: SKU, name: 'X', category: 'hats' })).toEqual({ sku: SKU, name: 'X', category: 'hats' });
    expect(oppMenuTarget({ sku: SKU, name: 'X', category: 'hats', copyKey: '' }).special).toBe('');
    expect(priceMenuTarget({ sku: SKU, name: 'X', special: { paint: AFTER_EIGHT } as never })).toEqual({ sku: SKU, name: 'X', special: copyKey });
    // A typed price with the paint in its SKU names the same copy.
    expect(save(priceMenuTarget({ sku: `${SKU};p${AFTER_EIGHT}`, name: 'X', special: null })).specialKey).toBe(copyKey);
    expect(changeMenuTarget({ sku: SKU, name: 'X', bank: 'hats', specialKey: copyKey })).toEqual({ sku: SKU, name: 'X', bank: 'hats', special: copyKey });
  });

  it('is what the Opportunities, Prices and Log pages open the item menu with', () => {
    const read = (f: string) => readFileSync(new URL(`../../src/renderer/pages/${f}`, import.meta.url), 'utf8');
    expect(read('OpportunitiesPage.tsx')).toContain('openMenuRef.current(oppMenuTarget(o), at)');
    expect(read('PricesPage.tsx')).toContain('menu.open(priceMenuTarget(p), { x: e.clientX, y: e.clientY })');
    expect(read('LogPage.tsx')).toContain('menuRef.current(changeMenuTarget(e), at)');
  });
});
