import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_MISSING_MESSAGE, isMock, resolveBridge } from '../../src/renderer/api';
import { commitSucceeded } from '../../src/renderer/components/Controls';
import { trapFocusTarget } from '../../src/renderer/components/Drawer';
import { UNUSED_BUDGET_IDS, snapshotUnavailableReason, visibleBudgets } from '../../src/renderer/format';
import { REVENUE_ORDER_TITLES, exportQuery, filtersToQuery, isSearchShortcut, revenueOrderOf, DEFAULT_FILTERS } from '../../src/renderer/oppModel';
import { chooseWatchFolder } from '../../src/renderer/pages/ImportPage';
import { BUDGETS } from '../../src/service/net/budgets';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import type { HostBudget, OrderSummary, Settings } from '../../src/shared/types';

describe('Import page: choosing a watch folder', () => {
  it('saves the folder main returns, so the service starts watching it', async () => {
    const save = vi.fn(async (patch: unknown) => mergeSettings(DEFAULT_SETTINGS, patch as Partial<Settings>));
    const saved = await chooseWatchFolder(async () => ({ folder: 'C:\\pages' }), save);
    expect(save).toHaveBeenCalledWith({ import: { watchFolder: 'C:\\pages' } });
    expect(saved).toBe('C:\\pages');
  });

  it('saves nothing when the dialog is cancelled', async () => {
    const save = vi.fn(async () => DEFAULT_SETTINGS);
    expect(await chooseWatchFolder(async () => ({ folder: null }), save)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('reports no folder when saving fails (no false "Watching" message)', async () => {
    expect(await chooseWatchFolder(async () => ({ folder: 'C:\\pages' }), async () => null)).toBeNull();
  });
});

describe('CommitInput save result', () => {
  it('treats fire-and-forget and settled settings as saved', async () => {
    expect(await commitSucceeded(undefined)).toBe(true);
    expect(await commitSucceeded(Promise.resolve(DEFAULT_SETTINGS))).toBe(true);
  });

  it('treats a rejected patch (updateSettings resolves to null) or a thrown save as not saved, so the draft reverts', async () => {
    expect(await commitSucceeded(Promise.resolve(null))).toBe(false);
    expect(await commitSucceeded(Promise.resolve(false))).toBe(false);
    expect(await commitSucceeded(Promise.reject(new Error('Invalid settings')))).toBe(false);
  });
});

describe('Drawer focus trap', () => {
  const items = ['close', 'refresh', 'link'];

  it('wraps Tab from the last control to the first, and from the panel itself to the first', () => {
    expect(trapFocusTarget(items, 'link', false)).toBe('close');
    expect(trapFocusTarget(items, null, false)).toBe('close');
    expect(trapFocusTarget(items, 'close', false)).toBeNull();
  });

  it('wraps Shift+Tab from the first control (or the panel) to the last', () => {
    expect(trapFocusTarget(items, 'close', true)).toBe('link');
    expect(trapFocusTarget(items, null, true)).toBe('link');
    expect(trapFocusTarget(items, 'refresh', true)).toBeNull();
  });

  it('does nothing without focusable controls', () => {
    expect(trapFocusTarget([], null, false)).toBeNull();
  });
});

describe('Opportunities "/" shortcut', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  const button = { tagName: 'BUTTON', isContentEditable: false };

  it('focuses search from the page', () => {
    expect(isSearchShortcut(key('/'), button, false)).toBe(true);
    expect(isSearchShortcut(key('/'), null, false)).toBe(true);
  });

  it('is ignored while the item drawer is open, while typing, or with modifiers', () => {
    expect(isSearchShortcut(key('/'), button, true)).toBe(false);
    expect(isSearchShortcut(key('/'), { tagName: 'INPUT', isContentEditable: false }, false)).toBe(false);
    expect(isSearchShortcut(key('/'), { tagName: 'DIV', isContentEditable: true }, false)).toBe(false);
    expect(isSearchShortcut(key('/', { ctrlKey: true }), button, false)).toBe(false);
    expect(isSearchShortcut(key('a'), button, false)).toBe(false);
  });
});

describe('Opportunities CSV export query', () => {
  it('keeps the visible filters and sort but drops paging and grouping', () => {
    const q = filtersToQuery({ ...DEFAULT_FILTERS, status: ['profitable'], categories: ['hats'], minConfidence: 70, search: 'captain' }, { sort: 'margin', dir: 'asc', groupBy: 'tier', limit: 5000, offset: 0 });
    expect(exportQuery(q)).toEqual({ status: ['profitable'], categories: ['hats'], minConfidence: 70, search: 'captain', sort: 'margin', dir: 'asc' });
  });
});

function order(id: string, valueScrap: number, over: Partial<OrderSummary> = {}): OrderSummary {
  return { listingId: id, steamid: id, userName: id, keys: 0, metalScrap: valueScrap, valueScrap, isBot: false, online: true, lastEventAt: 0, bumpedAt: null, details: '', flags: [], eligible: true, ...over };
}

describe('revenue order (Buyer column, quick entry)', () => {
  const best = order('outlier', 300, { flags: ['outlier'] });
  const cons = order('human', 200, { isBot: false, online: false });
  const instant = order('bot', 180, { isBot: true, online: true });
  const o = { bestOrder: best, consOrder: cons, instantOrder: instant };

  it('follows the configured order the profit was computed from', () => {
    expect(revenueOrderOf({ ...o, revenueScrap: 200 }, 'conservative')).toBe(cons);
    expect(revenueOrderOf({ ...o, revenueScrap: 300 }, 'best')).toBe(best);
    expect(revenueOrderOf({ ...o, revenueScrap: 180 }, 'instant')).toBe(instant);
  });

  it('matches the stored revenue when the setting changed before re-evaluation', () => {
    expect(revenueOrderOf({ ...o, revenueScrap: 200 }, 'instant')).toBe(cons);
  });

  it('shows no buyer when there is no revenue (never falls back to the outlier best order)', () => {
    expect(revenueOrderOf({ ...o, consOrder: null, revenueScrap: null }, 'conservative')).toBeNull();
  });

  it('labels the Revenue column for every setting', () => {
    expect(REVENUE_ORDER_TITLES.conservative).toMatch(/^Conservative/);
    expect(REVENUE_ORDER_TITLES.best).toMatch(/^Best/);
    expect(REVENUE_ORDER_TITLES.instant).toMatch(/^Instant/);
  });
});

describe('item drawer snapshot reason', () => {
  const s = (bptfApi: boolean) => ({ connectors: { bptfApi } });

  it('names the missing access token first, like item.refresh (an API key alone is not enough)', () => {
    expect(snapshotUnavailableReason({ bptfAccessToken: false }, s(true))).toEqual({ text: expect.stringMatching(/access token/), settings: true });
    expect(snapshotUnavailableReason({ bptfAccessToken: false }, s(false)).text).toMatch(/access token/);
  });

  it('then the API switch, then an outage', () => {
    expect(snapshotUnavailableReason({ bptfAccessToken: true }, s(false))).toEqual({ text: expect.stringMatching(/turned off in Settings/), settings: true });
    expect(snapshotUnavailableReason({ bptfAccessToken: true }, s(true))).toEqual({ text: expect.stringMatching(/unavailable right now/), settings: false });
    expect(snapshotUnavailableReason(null, null).settings).toBe(false);
  });
});

describe('Data health budgets', () => {
  const budget = (id: string, host: string, over: Partial<HostBudget> = {}): HostBudget => ({ id, host, policy: id, usedLastHour: 0, pausedUntil: null, consecutive429: 0, ...over });

  it('hides budgets for hosts the app never contacts, and keeps one row per budget id', () => {
    const all = BUDGETS.map((b) => budget(b.id, b.host));
    const shown = visibleBudgets(all);
    const hosts = new Set(shown.map((b) => b.host));
    for (const h of ['api.mannco.store', 'marketplace.tf', 'api.stntrading.eu', 'api.steampowered.com']) expect(hosts.has(h), h).toBe(false);
    expect(hosts).toEqual(new Set(['api.backpack.tf', 'pricedb.io', 'sku.pricedb.io', 'steamcommunity.com']));
    // Unique React keys: several budgets share api.backpack.tf.
    expect(new Set(shown.map((b) => b.id)).size).toBe(shown.length);
    expect(shown.filter((b) => b.host === 'api.backpack.tf').length).toBeGreaterThan(1);
  });

  it('still shows an unused budget that saw traffic or a pause', () => {
    expect(visibleBudgets([budget('mannco', 'api.mannco.store', { usedLastHour: 1 })])).toHaveLength(1);
    expect(visibleBudgets([budget('stn', 'api.stntrading.eu', { pausedUntil: 5 })])).toHaveLength(1);
    expect(visibleBudgets([budget('mptf', 'marketplace.tf')])).toHaveLength(0);
    expect([...UNUSED_BUDGET_IDS].every((id) => BUDGETS.some((b) => b.id === id))).toBe(true);
  });
});

describe('preload bridge fallback', () => {
  const native = { rpc: vi.fn(), on: vi.fn(), windowKind: 'dashboard' } as unknown as FlipdeskBridge;

  it('uses the preload bridge when present', async () => {
    await expect(resolveBridge(native, null)).resolves.toBe(native);
  });

  it('fails closed in a packaged build instead of switching to fake data', async () => {
    await expect(resolveBridge(null, null)).rejects.toThrow(BRIDGE_MISSING_MESSAGE);
  });

  it('uses the mock only when a development build provides it', async () => {
    const mock = vi.fn(async () => native);
    await expect(resolveBridge(null, mock)).resolves.toBe(native);
    expect(mock).toHaveBeenCalledOnce();
    // vitest runs as a development build without a preload, so the dev mock is active here.
    expect(isMock).toBe(true);
  });
});
