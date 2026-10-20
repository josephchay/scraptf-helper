// Audit window-5: with "Read scrap.tf pages as they load" off, a Cloudflare check in the scrap.tf window told
// the user the real page "is read once the real page loads", but nothing reads it then. The toolbar now words
// main's challenge notice by the setting it already holds: with reading on load off it says to press Read
// page now once the real page loads. main's notice text, every other notice and the on-load wording stay as
// they were. Pure model checks, plus the toolbar mounted against the browser mock (nothing is read or moved).

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { readStatusView, SCRAPTF_CHALLENGE_NOTICE_READ_OFF, windowNoticeText } from '../../src/renderer/scraptfWindowModel';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import { SCRAPTF_WINDOW_NOTICES } from '../../src/shared/scraptfWindowPolicy';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const PROMISE = 'it is read once the real page loads';

describe('the challenge notice by the reading-on-load setting', () => {
  it('says to press Read page now with reading on load off, and is unchanged with it on', () => {
    expect(windowNoticeText(SCRAPTF_WINDOW_NOTICES.challenge, false)).toBe(SCRAPTF_CHALLENGE_NOTICE_READ_OFF);
    expect(SCRAPTF_CHALLENGE_NOTICE_READ_OFF).toContain('press Read page now');
    expect(SCRAPTF_CHALLENGE_NOTICE_READ_OFF).not.toContain(PROMISE);
    expect(SCRAPTF_CHALLENGE_NOTICE_READ_OFF.length).toBeLessThanOrEqual(200);
    expect(windowNoticeText(SCRAPTF_WINDOW_NOTICES.challenge)).toBe(SCRAPTF_WINDOW_NOTICES.challenge);
    expect(windowNoticeText(SCRAPTF_WINDOW_NOTICES.challenge, true)).toBe(SCRAPTF_WINDOW_NOTICES.challenge);
  });

  it('leaves every other notice, and no notice, as before with reading on load off', () => {
    for (const [name, text] of Object.entries(SCRAPTF_WINDOW_NOTICES)) {
      if (name !== 'challenge') expect(windowNoticeText(text, false), name).toBe(text);
    }
    expect(windowNoticeText(null, false)).toBeNull();
    expect(windowNoticeText('  ', false)).toBeNull();
    expect(windowNoticeText(undefined, false)).toBeNull();
  });

  it("words a challenge read's tooltip by the setting too; its visible line is unchanged", () => {
    const read = { at: T0, path: '/buy/hats', items: 0, bank: 'hats' as const, newFlips: 0, warning: SCRAPTF_WINDOW_NOTICES.challenge };
    const off = readStatusView(read, T0, false);
    expect(off.title).toContain('press Read page now');
    expect(off.title).not.toContain(PROMISE);
    expect(off.main).toBe('Could not read /buy/hats · a Cloudflare check or error page is on screen: solve it in the page');
    const on = readStatusView(read, T0, true);
    expect(on.title).toContain(SCRAPTF_WINDOW_NOTICES.challenge);
    expect(on.main).toBe(off.main);
  });
});

// ---------------------------------------------------------------------------
// The toolbar, mounted
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ScraptfWindowBar: () => ReactNode;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/scraptf-bar' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const proto = ShimElement.prototype as unknown as Record<string, unknown>;
  proto['querySelectorAll'] ??= function (this: ShimElement) {
    return this.descendants().filter((e) => e.tagName === 'BUTTON' || e.tagName === 'INPUT');
  };
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ ScraptfWindowBar } = await import('../../src/renderer/pages/ScraptfWindowBar'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
});

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(readOnLoad: boolean) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 }, scraptfWindow: { enabled: true, acknowledgedAt: T0, readOnLoad } });
  const calls: string[] = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'scraptf',
    rpc: (m, p) => {
      calls.push(m);
      return b.rpc(m, p);
    },
    on: (e, fn) => {
      const own = (listeners.get(e) ?? new Set()).add(fn as (p: unknown) => void);
      listeners.set(e, own);
      const off = b.on(e, fn);
      return () => {
        own.delete(fn as (p: unknown) => void);
        off();
      };
    },
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(ScraptfWindowBar))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const all = () => container.descendants();
  const status = () => all().find((e) => e.getAttribute('role') === 'status')!.textContent;
  const statusLine = () => all().find((e) => (e.getAttribute('class') ?? '').split(' ').includes('stfw-statusline'))!;
  const push = (event: string, payload: unknown) => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  };
  const moves = () => calls.filter((m) => /^scraptfWindow\.(?:open|back|forward|reload|home|go|read)$/.test(m));
  return { b, push, status, statusLine, moves };
}

describe('the toolbar with reading on load off', () => {
  it('shows the challenge notice with Read page now, warn-toned, and follows the setting live', async () => {
    const t = await mount(false);
    await act(async () => {
      t.push('scraptfWindow.nav', { url: 'https://scrap.tf/buy/hats', canGoBack: false, canGoForward: false, loading: false, importable: true, notice: SCRAPTF_WINDOW_NOTICES.challenge });
    });
    await settle();
    expect(t.status()).toBe(SCRAPTF_CHALLENGE_NOTICE_READ_OFF);
    expect(t.statusLine().getAttribute('title')).toBe(SCRAPTF_CHALLENGE_NOTICE_READ_OFF);
    expect((t.statusLine().getAttribute('class') ?? '').split(' ')).toContain('tone-text-warn');
    // Turned back on in Settings: the line says the page is read when it loads.
    await act(async () => {
      await t.b.rpc('settings.set', { scraptfWindow: { readOnLoad: true } });
    });
    await settle();
    expect(t.status()).toBe(SCRAPTF_WINDOW_NOTICES.challenge);
    expect(t.moves()).toEqual([]);
  });
});
