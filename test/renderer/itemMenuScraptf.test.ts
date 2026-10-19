// F14 in the row context menu: "Open on scrap.tf (copies name)" copies the item name for scrap.tf's
// own search box and hands the item's static bank page to the user's browser through links.open.
// The menu content is pure; the action runs against a fake bridge and clipboard. Flip Desk never
// loads scrap.tf on its own (R1): the only call is links.open, which main checks against its allowlist.
// F19: armed, it first tells main the item ('check.arm', before the copy) and its toast says how
// the price found there comes back through the Live check.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCRAPTF_ITEMS_URL, scraptfPageFor } from '../../src/shared/links';
import type { LinkSpec } from '../../src/shared/types';
import {
  OPEN_ON_SCRAPTF_LABEL,
  SCRAPTF_NAME_COPIED,
  SCRAPTF_NAME_COPIED_WINDOW,
  SCRAPTF_WINDOW_READ_HINT,
  flattenSections,
  isEnabledItem,
  itemMenuSections,
  scraptfOpenedToast,
  type ItemMenuAction,
} from '../../src/renderer/itemMenuModel';

const target = { sku: '378;6', name: 'Team Captain', bptfName: 'The Team Captain' };
const LINKS: LinkSpec[] = [
  { id: 'bptf-stats', label: 'Stats', url: 'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable', group: 'backpack' },
  { id: 'scraptf-page', label: 'scrap.tf (category page)', url: scraptfPageFor('hats'), group: 'market' },
];

const stfItem = (sections: ReturnType<typeof itemMenuSections>) => flattenSections(sections).find((i) => i.id === 'scraptf-open')!;

describe('menu content', () => {
  it('adds "Open on scrap.tf (copies name)" after Record sale…, before the links, leaving the rest in place', () => {
    const items = flattenSections(itemMenuSections(target, { status: 'ready', links: LINKS }));
    expect(items.slice(0, 8).map((i) => i.label)).toEqual([
      'Open details',
      'Copy SKU',
      'Copy name',
      'Copy backpack.tf name',
      'Record scrap.tf price…',
      'Record buy…',
      'Record sale…',
      OPEN_ON_SCRAPTF_LABEL,
    ]);
    const sections = itemMenuSections(target, { status: 'ready', links: LINKS });
    expect(sections.findIndex((s) => s.id === 'scraptf')).toBe(sections.findIndex((s) => s.id === 'trade') + 1);
    expect(sections.findIndex((s) => s.id.startsWith('links'))).toBeGreaterThan(sections.findIndex((s) => s.id === 'scraptf'));
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("opens the item's bank page from links.forSku with the name to paste", () => {
    const item = stfItem(itemMenuSections(target, { status: 'ready', links: LINKS }));
    expect(isEnabledItem(item)).toBe(true);
    expect(item.action).toEqual({ kind: 'scraptf', url: scraptfPageFor('hats'), name: 'Team Captain' } satisfies ItemMenuAction);
    expect(item.hint).toBe('scrap.tf');
    expect(item.title).toContain('Flip Desk never loads scrap.tf on its own.');
  });

  it('needs no links when the row knows the category, and waits for them otherwise', () => {
    expect(stfItem(itemMenuSections({ ...target, category: 'weapons' }, { status: 'loading' })).action).toEqual({ kind: 'scraptf', url: scraptfPageFor('weapons'), name: 'Team Captain' });
    const waiting = stfItem(itemMenuSections(target, { status: 'loading' }));
    expect(isEnabledItem(waiting)).toBe(false);
    expect(waiting.label).toBe(OPEN_ON_SCRAPTF_LABEL);
    // Links failed or no category: the full price list, which lists every item scrap.tf trades.
    expect(stfItem(itemMenuSections(target, { status: 'error', message: 'x' })).action).toEqual({ kind: 'scraptf', url: SCRAPTF_ITEMS_URL, name: 'Team Captain' });
  });

  it('F15: opens the bank page the item was last seen on (item.detail seenOn), else the category, at once', () => {
    const seenOn = { bank: 'stranges' as const, url: 'https://example.com/ignored', at: 1 };
    // Before item.detail answers the category's bank stands in, enabled; then the page it was seen on.
    expect(stfItem(itemMenuSections({ ...target, category: 'hats' }, { status: 'loading' })).action).toEqual({ kind: 'scraptf', url: scraptfPageFor('hats'), name: 'Team Captain' });
    expect(stfItem(itemMenuSections({ ...target, category: 'hats' }, { status: 'loading' }, seenOn)).action).toEqual({ kind: 'scraptf', url: scraptfPageFor('stranges'), name: 'Team Captain' });
    expect(stfItem(itemMenuSections(target, { status: 'loading' }, seenOn)).title).toContain(scraptfPageFor('stranges'));
    // Seen only on the /items list: still the category's bank page.
    expect(stfItem(itemMenuSections({ ...target, category: 'hats' }, { status: 'loading' }, { ...seenOn, bank: 'list' })).action).toMatchObject({ url: scraptfPageFor('hats') });
  });

  it('F15: a row from a scrap.tf bank card names its page, which wins over seenOn', () => {
    const sections = itemMenuSections({ ...target, bank: 'unusuals' }, { status: 'loading' }, { bank: 'hats' });
    expect(stfItem(sections).action).toEqual({ kind: 'scraptf', url: 'https://scrap.tf/unusuals', name: 'Team Captain' });
    // The list card's rows have no bank page of their own: the usual fallbacks apply.
    expect(stfItem(itemMenuSections({ ...target, bank: 'list', category: 'weapons' }, { status: 'loading' })).action).toMatchObject({ url: scraptfPageFor('weapons') });
  });
});

describe('the action', () => {
  const order: string[] = [];
  const writeText = vi.fn(async (text: string) => {
    order.push(`copy:${text}`);
  });
  const rpc = vi.fn(async (method: string, params: { url: string }) => {
    order.push(`${method}:${params.url}`);
    return { opened: true, reason: null };
  });

  beforeEach(() => {
    order.length = 0;
    writeText.mockClear();
    rpc.mockClear();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { flipdesk: { windowKind: 'dashboard', rpc, on: () => () => undefined } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copies the name first, then opens the page through links.open, and says to paste it', async () => {
    const { openOnScraptf } = await import('../../src/renderer/components/ItemMenu');
    const toast = vi.fn();
    await openOnScraptf(scraptfPageFor('hats'), 'Team Captain', toast);
    // Copy before the browser takes focus: an unfocused page may not write the clipboard.
    expect(order).toEqual(['copy:Team Captain', `links.open:${scraptfPageFor('hats')}`]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(SCRAPTF_NAME_COPIED, 'good');
  });

  it('still opens the page when the copy fails, and says so', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const { openOnScraptf } = await import('../../src/renderer/components/ItemMenu');
    const toast = vi.fn();
    await openOnScraptf(SCRAPTF_ITEMS_URL, 'Team Captain', toast);
    expect(rpc).toHaveBeenCalledWith('links.open', { url: SCRAPTF_ITEMS_URL, allowWindow: true });
    expect(toast.mock.calls[0]![1]).toBe('warn');
    expect(String(toast.mock.calls[0]![0])).toMatch(/could not be copied/);
  });
});

describe('the toast with the way back (F19)', () => {
  const BACK = 'Copy the price there and press Ctrl+Alt+C to check it here.';

  it('names the static page it opened, and keeps the way back after every failure the user can still act on', () => {
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, scraptfPageFor('hats'), BACK)).toEqual({
      text: `Opened scrap.tf/buy/hats in your browser. The name is copied; paste it into scrap.tf's search. ${BACK}`,
      tone: 'good',
    });
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, 'https://scrap.tf/unusuals', BACK).text).toMatch(/^Opened scrap\.tf\/unusuals in your browser\./);
    const notCopied = scraptfOpenedToast(false, { opened: true, reason: null }, scraptfPageFor('hats'), BACK);
    expect(notCopied).toMatchObject({ tone: 'warn' });
    expect(notCopied.text).toMatch(/could not be copied\. Type it into scrap\.tf's search\. Copy the price there/);
    const refused = scraptfOpenedToast(true, { opened: false, reason: 'Browser preview.' }, scraptfPageFor('hats'), BACK);
    expect(refused.text).toBe(`Browser preview. The name was copied: open ${scraptfPageFor('hats')} in your browser and paste it into scrap.tf's search. ${BACK}`);
    // Nothing worked: the address only, no instructions for a page that is not open.
    expect(scraptfOpenedToast(false, { opened: false, reason: null }, scraptfPageFor('hats'), BACK).text).toBe(`The link could not be opened. ${scraptfPageFor('hats')}`);
  });

  it('opened in the Flip Desk window that reads pages as they load: the price comes back by itself (UX-5)', () => {
    const win = { opened: true, reason: null, openedIn: 'window' as const };
    expect(SCRAPTF_WINDOW_READ_HINT).toBe('It is read when it loads; its price shows here by itself.');
    // The Live check's copy-a-price hint gives way to it.
    expect(scraptfOpenedToast(true, win, scraptfPageFor('hats'), BACK, true)).toEqual({
      text: `Opened scrap.tf/buy/hats in the Flip Desk window. The name is copied; paste it into scrap.tf's search. ${SCRAPTF_WINDOW_READ_HINT}`,
      tone: 'good',
    });
    // Unarmed too: it is still read on load.
    expect(scraptfOpenedToast(true, win, scraptfPageFor('hats'), null, true).text).toContain(SCRAPTF_WINDOW_READ_HINT);
    expect(scraptfOpenedToast(false, win, scraptfPageFor('hats'), BACK, true).text).toMatch(/could not be copied. Type it into scrap.tf's search. It is read when it loads/);
    // Reading on load off, or the browser: as before.
    expect(scraptfOpenedToast(true, win, scraptfPageFor('hats'), BACK, false).text).toContain(BACK);
    expect(scraptfOpenedToast(true, win, scraptfPageFor('hats'), null, false)).toEqual({ text: SCRAPTF_NAME_COPIED_WINDOW, tone: 'good' });
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, scraptfPageFor('hats'), BACK, true).text).toContain(BACK);
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, scraptfPageFor('hats'), BACK, true).text).not.toContain(SCRAPTF_WINDOW_READ_HINT);
  });

  it("passes the window's readOnLoad from the opener's settings", () => {
    const menu = readFileSync(new URL('../../src/renderer/components/ItemMenu.tsx', import.meta.url), 'utf8');
    expect(menu).toContain('scraptfOpenedToast(copied, opened, url, back, arm?.settings?.scraptfWindow?.readOnLoad !== false)');
  });

  it('without a way back it is the F14 toast, word for word', () => {
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, scraptfPageFor('hats'))).toEqual({ text: SCRAPTF_NAME_COPIED, tone: 'good' });
    expect(scraptfOpenedToast(true, { opened: true, reason: null }, scraptfPageFor('hats'), null)).toEqual({ text: SCRAPTF_NAME_COPIED, tone: 'good' });
  });
});

describe('the action, armed (F19)', () => {
  const order: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const writeText = vi.fn(async (text: string) => {
    order.push(`copy:${text}`);
  });
  let armAnswer: () => Promise<unknown> = async () => ({ armedUntil: 1_000 });
  let hotkeysAnswer: () => Promise<unknown> = async () => ({
    quickEntry: { accelerator: 'CommandOrControl+Alt+Q', registered: true, error: null },
    check: { accelerator: 'CommandOrControl+Alt+C', registered: true, error: null },
  });
  const rpc = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === 'check.arm') {
      order.push('check.arm');
      return armAnswer();
    }
    if (method === 'app.hotkeys') return hotkeysAnswer();
    order.push(`${method}:${(params as { url: string }).url}`);
    return { opened: true, reason: null };
  });
  const settings = (over: { hotkey?: string; watchClipboard?: boolean; networkPaused?: boolean } = {}) => ({
    check: { hotkey: over.hotkey ?? 'CommandOrControl+Alt+C', watchClipboard: over.watchClipboard ?? false, notifyFlips: true, popup: true },
    networkPaused: over.networkPaused ?? false,
  });

  beforeEach(() => {
    order.length = 0;
    calls.length = 0;
    armAnswer = async () => ({ armedUntil: 1_000 });
    hotkeysAnswer = async () => ({
      quickEntry: { accelerator: 'CommandOrControl+Alt+Q', registered: true, error: null },
      check: { accelerator: 'CommandOrControl+Alt+C', registered: true, error: null },
    });
    writeText.mockClear();
    rpc.mockClear();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { flipdesk: { windowKind: 'dashboard', rpc, on: () => () => undefined } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('arms with the SKU and exactly the copied name, then copies, then opens, and says how to come back', async () => {
    const { openOnScraptf } = await import('../../src/renderer/components/ItemMenu');
    const toast = vi.fn();
    await openOnScraptf(scraptfPageFor('hats'), 'Team Captain', toast, { sku: '378;6', settings: settings() });
    expect(order).toEqual(['check.arm', 'copy:Team Captain', `links.open:${scraptfPageFor('hats')}`]);
    expect(calls.find((c) => c.method === 'check.arm')!.params).toEqual({ sku: '378;6', name: 'Team Captain' });
    // Main methods and links.open only: nothing else is asked, and no text but the name leaves.
    expect(calls.map((c) => c.method).sort()).toEqual(['app.hotkeys', 'check.arm', 'links.open']);
    expect(toast).toHaveBeenCalledWith(
      "Opened scrap.tf/buy/hats in your browser. The name is copied; paste it into scrap.tf's search. Copy the price there and press Ctrl+Alt+C to check it here.",
      'good',
    );
  });

  it('a failed or refused arm still copies and opens; the toast then asks for the name with the price', async () => {
    armAnswer = async () => {
      throw new Error('Invalid parameters for check.arm: sku: not a SKU');
    };
    const { openOnScraptf } = await import('../../src/renderer/components/ItemMenu');
    const toast = vi.fn();
    await openOnScraptf(scraptfPageFor('weapons'), 'Rocket Launcher', toast, { sku: '18;6', settings: settings() });
    expect(order).toEqual(['check.arm', 'copy:Rocket Launcher', `links.open:${scraptfPageFor('weapons')}`]);
    expect(toast.mock.calls[0]![0]).toContain('Copy the name and price there and press Ctrl+Alt+C to check it here.');
    expect(toast.mock.calls[0]![1]).toBe('good');
  });

  it('does not ask main to arm a name it would refuse (too long, a control character), but still opens', async () => {
    const { openOnScraptf } = await import('../../src/renderer/components/ItemMenu');
    for (const name of ['x'.repeat(201), 'Team\u0007Captain']) {
      order.length = 0;
      calls.length = 0;
      await openOnScraptf(scraptfPageFor('hats'), name, vi.fn(), { sku: '378;6', settings: settings() });
      expect(calls.map((c) => c.method)).not.toContain('check.arm');
      expect(order).toEqual([`copy:${name}`, `links.open:${scraptfPageFor('hats')}`]);
    }
  });

  it('words the way back from Settings → Live check and the hotkey main holds', async () => {
    const { openOnScraptf } = await import('../../src/renderer/components/ItemMenu');
    const run = async (s: ReturnType<typeof settings>) => {
      const toast = vi.fn();
      await openOnScraptf(scraptfPageFor('hats'), 'Team Captain', toast, { sku: '378;6', settings: s });
      return String(toast.mock.calls[0]![0]);
    };
    expect(await run(settings({ watchClipboard: true }))).toContain('Copy the price there: the clipboard check picks it up, or press Ctrl+Alt+C.');
    expect(await run(settings({ hotkey: '', watchClipboard: true }))).toContain('Copy the price there: the clipboard check picks it up here.');
    expect(await run(settings({ hotkey: '' }))).toContain('set a check hotkey in Settings → Live check.');
    // The watcher reads nothing while the network is paused.
    expect(await run(settings({ hotkey: '', watchClipboard: true, networkPaused: true }))).toContain('set a check hotkey');
    // Another app holds the chord: no "press Ctrl+Alt+C" that would do nothing.
    hotkeysAnswer = async () => ({
      quickEntry: { accelerator: '', registered: false, error: null },
      check: { accelerator: 'CommandOrControl+Alt+C', registered: false, error: 'taken' },
    });
    const taken = await run(settings());
    expect(taken).not.toContain('press Ctrl+Alt+C');
    expect(taken).toContain('free the check hotkey Ctrl+Alt+C or pick another in Settings → Live check.');
    // app.hotkeys failing is no reason to drop the hint: the setting is trusted.
    hotkeysAnswer = async () => {
      throw new Error('no main');
    };
    expect(await run(settings())).toContain('press Ctrl+Alt+C to check it here.');
  });

  it('without arm options it is the F14 action exactly: no arm, no hotkeys read, the short toast', async () => {
    const { openOnScraptf } = await import('../../src/renderer/components/ItemMenu');
    const toast = vi.fn();
    await openOnScraptf(scraptfPageFor('hats'), 'Team Captain', toast);
    expect(calls.map((c) => c.method)).toEqual(['links.open']);
    expect(toast).toHaveBeenCalledWith(SCRAPTF_NAME_COPIED, 'good');
  });
});

describe('ItemMenu wiring', () => {
  const menu = readFileSync(new URL('../../src/renderer/components/ItemMenu.tsx', import.meta.url), 'utf8');

  it('runs the action through openOnScraptf, which uses only main (arm), the clipboard and links.open', () => {
    // F19: armed with the menu's item and exactly the name the action copies.
    expect(menu).toMatch(/case 'scraptf':\s+(\/\/.*\s+)*void openOnScraptf\(a\.url, a\.name, toast, \{ sku: target\.sku, settings \}\);/);
    const fn = menu.slice(menu.indexOf('export async function openOnScraptf'), menu.indexOf('interface OpenState'));
    expect(fn.indexOf('copyText(name)')).toBeGreaterThan(0);
    // F21: worded for the scrap.tf window (scraptfOpenTitle), so main may open it there.
    expect(fn.indexOf('openLink(url, { allowWindow: true })')).toBeGreaterThan(fn.indexOf('copyText(name)'));
    // The arm lands before the copy (main's watcher must know the name first), and names the copied string.
    expect(fn.indexOf("rpc('check.arm', params)")).toBeGreaterThan(0);
    expect(fn.indexOf("rpc('check.arm', params)")).toBeLessThan(fn.indexOf('copyText(name)'));
    expect(fn).toContain('checkArmFor(arm.sku, name)');
    expect([...fn.matchAll(/rpc\('([a-z.A-Z]+)'/g)].map((m) => m[1]).sort()).toEqual(['app.hotkeys', 'check.arm']);
    expect(menu).not.toMatch(/https?:\/\/[^'"`\s]*scrap\.tf/);
    expect(menu).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
  });

  it('F15: reads seenOn from the local item.detail once per open, unless the row names its bank', () => {
    expect(menu).toMatch(/bank\?: ScraptfBank;/);
    const view = menu.slice(menu.indexOf('function ItemMenuView'), menu.indexOf('// Generic menu popover'));
    expect(view).toMatch(/if \(namedBank\) return;\s*let alive = true;\s*rpc\('item\.detail', \{ sku: target\.sku, history: false \}\)/);
    expect(view).toContain('if (alive) setSeenOn(d?.seenOn ?? null);');
    // F21: the scrap.tf window's openLinksInWindow words the action's tooltip only.
    expect(view).toContain('itemMenuSections(target, links, seenOn, inWindow)');
    expect(view).toContain('const inWindow = scraptfLinksInWindow(settings);');
  });

  it('lets a row pass its category (optional, so every existing caller still works)', () => {
    expect(menu).toMatch(/category\?: Category;/);
    const holdings = readFileSync(new URL('../../src/renderer/pages/HoldingsPage.tsx', import.meta.url), 'utf8');
    expect(holdings).toContain('menuRef.current({ sku: r.sku, name: r.name, category: r.category }, at)');
  });

  it('gets the category from every page whose rows know it, so "Open on scrap.tf" needs no links.forSku wait', () => {
    const read = (p: string) => readFileSync(new URL(`../../src/renderer/pages/${p}`, import.meta.url), 'utf8');
    expect(read('MarketPage.tsx')).toContain('openMenuRef.current({ sku: r.sku, name: r.name, category: r.category }, at)');
    expect(read('ShoppingPage.tsx')).toContain('openMenuRef.current({ sku: r.sku, name: r.name, category: r.category }, at)');
    expect(read('OpportunitiesPage.tsx')).toContain('openMenuRef.current({ sku: o.sku, name: o.name, category: o.category }, at)');
    expect(read('LogPage.tsx')).toContain('menu.open({ sku: e.sku, name: e.name, category: e.category }, ');
  });
});
