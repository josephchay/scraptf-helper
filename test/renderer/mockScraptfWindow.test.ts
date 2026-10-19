// F21 in the browser mock: the settings gate refuses and cascades like main's schema; the window methods
// validate like main's router over a fake history (no page is loaded or read anywhere); links.open sends
// static scrap.tf pages to the fake window when the user chose that; 'import.html' refuses address/origin;
// '#/scraptf-bar' is the toolbar demo (window kind 'scraptf', the window on). All in memory.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MOCK_WINDOW_READ_WARNING } from '../../src/renderer/mockScraptfWindow';
import { readStatusText } from '../../src/renderer/scraptfWindowModel';
import { SCRAPTF_BANKS, SCRAPTF_HOME_URL } from '../../src/shared/links';
import type { PushContract } from '../../src/shared/rpc';
import type { ScraptfWindowRead } from '../../src/shared/types';
import {
  IMPORT_HTML_ORIGIN_REFUSAL,
  READ_MANUAL_MIN_GAP_MS,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_NEEDS_ACK,
  SCRAPTF_WINDOW_NEEDS_IMPORT,
  SCRAPTF_WINDOW_OFF,
} from '../../src/shared/scraptfWindowPolicy';

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;
let bridge: MockBridge | null = null;
let clock = T0;

function make(): MockBridge {
  clock = T0;
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => clock });
  return bridge;
}

async function turnOn(b: MockBridge, links = false): Promise<void> {
  await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 }, scraptfWindow: { enabled: true, acknowledgedAt: T0, openLinksInWindow: links } });
}

afterEach(() => {
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
});

describe('settings (mock)', () => {
  it('refuses turning the window on without its gates, as main does', async () => {
    const b = make();
    await expect(b.rpc('settings.set', { scraptfWindow: { enabled: true, acknowledgedAt: T0 } })).rejects.toThrow(`Invalid settings: ${SCRAPTF_WINDOW_NEEDS_IMPORT}`);
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    await expect(b.rpc('settings.set', { scraptfWindow: { enabled: true } })).rejects.toThrow(`Invalid settings: ${SCRAPTF_WINDOW_NEEDS_ACK}`);
    expect((await b.rpc('settings.get', undefined)).scraptfWindow.enabled).toBe(false);
  });

  it('turns the window off with import', async () => {
    const b = make();
    await turnOn(b);
    expect((await b.rpc('settings.get', undefined)).scraptfWindow.enabled).toBe(true);
    const s = await b.rpc('settings.set', { import: { enabled: false } });
    expect(s.scraptfWindow.enabled).toBe(false);
  });
});

describe('scraptfWindow.* (mock)', () => {
  it('refuses actions while off, and reports a closed window', async () => {
    const b = make();
    for (const m of ['scraptfWindow.open', 'scraptfWindow.back', 'scraptfWindow.forward', 'scraptfWindow.reload', 'scraptfWindow.home', 'scraptfWindow.read'] as const) {
      await expect(b.rpc(m, undefined as never), m).rejects.toThrow(SCRAPTF_WINDOW_OFF);
    }
    await expect(b.rpc('scraptfWindow.go', { url: HATS })).rejects.toThrow(SCRAPTF_WINDOW_OFF);
    await expect(b.rpc('scraptfWindow.state', undefined)).resolves.toEqual({ open: false, url: null, canGoBack: false, canGoForward: false, lastRead: null });
  });

  it('walks a fake history of start pages, pushing nav and (read on load) a made-up read', async () => {
    const b = make();
    await turnOn(b);
    const navs: PushContract['scraptfWindow.nav'][] = [];
    const reads: ScraptfWindowRead[] = [];
    b.on('scraptfWindow.nav', (p) => navs.push(p));
    b.on('scraptfWindow.read', (p) => void (p !== null && reads.push(p)));
    await b.rpc('scraptfWindow.open', undefined);
    await b.rpc('scraptfWindow.go', { url: HATS });
    await b.rpc('scraptfWindow.back', undefined);
    expect(navs.map((n) => [n.url, n.canGoBack, n.canGoForward, n.importable])).toEqual([
      ['https://scrap.tf/', false, false, false],
      [HATS, true, false, true],
      ['https://scrap.tf/', false, true, false],
    ]);
    // Like main (F21-4): only a page the import reads is read, so the front page is not.
    expect(reads.map((r) => [r.path, r.bank])).toEqual([['/buy/hats', 'hats']]);
    expect(reads.every((r) => r.warning === MOCK_WINDOW_READ_WARNING)).toBe(true);
    // Made-up flips, so the toolbar demo shows its Show flips; the best one is the mock's hats stock page's
    // top Flips row (0.7.1 step I: as the service's topFlips[0]), so its name is a working link too.
    const top = (await b.rpc('scraptf.bankStock', { bank: 'hats', filter: 'flips', sort: 'profit', limit: 1 })).rows[0]!;
    expect(reads[0]).toMatchObject({ stored: reads[0]!.items, bestFlip: { sku: top.sku, name: top.name, profitScrap: top.profitScrap } });
    expect(reads[0]!.pageFlips).toBeGreaterThanOrEqual(reads[0]!.newFlips);
    await b.rpc('scraptfWindow.forward', undefined);
    expect((await b.rpc('scraptfWindow.state', undefined)).url).toBe(HATS);
  });

  it('refuses Read page now off the pages the import reads, and does not load the page on screen again', async () => {
    const b = make();
    await turnOn(b, true);
    const navs: PushContract['scraptfWindow.nav'][] = [];
    b.on('scraptfWindow.nav', (p) => navs.push(p));
    await b.rpc('scraptfWindow.open', undefined);
    await expect(b.rpc('scraptfWindow.read', undefined)).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.notImportable });
    await b.rpc('scraptfWindow.open', { start: HATS });
    const loads = navs.length;
    // The page already on screen (F21-7): an open or a link only brings the window up.
    await b.rpc('scraptfWindow.open', { start: HATS });
    await expect(b.rpc('links.open', { url: HATS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    expect(navs).toHaveLength(loads);
    expect((await b.rpc('scraptfWindow.state', undefined)).canGoBack).toBe(true);
  });

  it('validates pages as main does and throttles Read page now', async () => {
    const b = make();
    await turnOn(b);
    await expect(b.rpc('scraptfWindow.go', { url: `${HATS}?q=x` })).rejects.toThrow('Invalid parameters for scraptfWindow.go: url: not a scrap.tf page the window opens');
    await expect(b.rpc('scraptfWindow.open', { start: 'https://evil.example/' })).rejects.toThrow(/start: not a scrap\.tf page/);
    await expect(b.rpc('scraptfWindow.read', undefined)).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.notOpen });
    await b.rpc('scraptfWindow.open', { start: HATS });
    // The read on load a moment ago does not count for Read page now's throttle.
    const first = await b.rpc('scraptfWindow.read', undefined);
    expect(first.read).toMatchObject({ path: '/buy/hats', bank: 'hats' });
    await expect(b.rpc('scraptfWindow.read', undefined)).resolves.toEqual({ read: null, reason: SCRAPTF_READ_REASONS.tooSoon });
    clock += READ_MANUAL_MIN_GAP_MS;
    expect((await b.rpc('scraptfWindow.read', undefined)).read).not.toBeNull();
    // Log out & clear: back to Home, the last read gone, and the toolbar told so (a null read), as main does.
    const reads: (ScraptfWindowRead | null)[] = [];
    b.on('scraptfWindow.read', (p) => void reads.push(p));
    await b.rpc('scraptfWindow.clear', undefined);
    expect(await b.rpc('scraptfWindow.state', undefined)).toEqual({ open: true, url: SCRAPTF_HOME_URL, canGoBack: false, canGoForward: false, lastRead: null });
    expect(reads).toEqual([null]);
  });
});

describe('links.open and import.html (mock)', () => {
  it('sends static scrap.tf pages to the window only when the user chose that', async () => {
    const b = make();
    await expect(b.rpc('links.open', { url: HATS })).resolves.toMatchObject({ opened: false });
    await turnOn(b, true);
    // Only an open worded for the window (allowWindow) goes there; any other link stays a browser link.
    await expect(b.rpc('links.open', { url: HATS })).resolves.toMatchObject({ opened: false });
    expect((await b.rpc('scraptfWindow.state', undefined)).open).toBe(false);
    await expect(b.rpc('links.open', { url: HATS, allowWindow: true })).resolves.toEqual({ opened: true, reason: null, openedIn: 'window' });
    expect((await b.rpc('scraptfWindow.state', undefined)).url).toBe(HATS);
    await expect(b.rpc('links.open', { url: `${HATS}?x=1`, allowWindow: true })).resolves.toMatchObject({ opened: false });
  });

  it("refuses a page's address or origin", async () => {
    const b = make();
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    await expect(b.rpc('import.html', { html: '<p/>', fileName: 'a.html', mtimeMs: T0, origin: 'window' })).rejects.toThrow(IMPORT_HTML_ORIGIN_REFUSAL);
    await expect(b.rpc('import.html', { html: '<p/>', fileName: 'a.html', mtimeMs: T0, address: HATS })).rejects.toThrow(IMPORT_HTML_ORIGIN_REFUSAL);
    await expect(b.rpc('import.html', { html: '<p/>', fileName: 'a.html', mtimeMs: T0 })).resolves.toMatchObject({ fileName: 'a.html' });
  });
});

describe('the toolbar demo (#/scraptf-bar)', () => {
  it("is window kind 'scraptf' with the window on", async () => {
    vi.stubGlobal('location', { hash: '#/scraptf-bar' });
    const b = make();
    expect(b.windowKind).toBe('scraptf');
    expect((await b.rpc('settings.get', undefined)).scraptfWindow).toMatchObject({ enabled: true, acknowledgedAt: T0 });
    await expect(b.rpc('scraptfWindow.open', undefined)).resolves.toEqual({ ok: true });
  });

  it('says what was read, and when', () => {
    expect(readStatusText(null, T0)).toBe('Not read yet');
    expect(readStatusText({ at: T0 - 3_000, path: '/buy/hats', items: 48, bank: 'hats', newFlips: 2, warning: null }, T0)).toMatch(/^Read 48 items from \/buy\/hats · 2 new flips · /);
    expect(readStatusText({ at: T0, path: '/', items: 1, bank: null, newFlips: 1, warning: 'x' }, T0)).toMatch(/^Read 1 item from \/ · 1 new flip · x · /);
  });
});
