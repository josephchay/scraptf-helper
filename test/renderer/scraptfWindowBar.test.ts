// F21, the scrap.tf window's toolbar (pages/ScraptfWindowBar.tsx), mounted with react-dom/client into the
// minimal DOM of domShim.ts against the browser mock (its fake window history: nothing is loaded or read).
// Every control is a click or a key press sent to main as 'scraptfWindow.*'; nothing moves the window on
// mount, on a push or on a timer. The bank chips pass only static SCRAPTF_BANKS pages; the address is text;
// the risk pill is always there; Log out & clear asks first. Plus the stylesheet's limits (48 px, tokens).

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { MOCK_WINDOW_READ_WARNING } from '../../src/renderer/mockScraptfWindow';
import { SCRAPTF_WINDOW_RISK_TIP, WINDOW_CLEARED_TEXT } from '../../src/renderer/scraptfWindowModel';
import { SCRAPTF_BANKS, SCRAPTF_HOME_URL } from '../../src/shared/links';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import { READ_MANUAL_MIN_GAP_MS, SCRAPTF_READ_REASONS } from '../../src/shared/scraptfWindowPolicy';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
/** What moves or reads the window. */
const MOVES = ['scraptfWindow.open', 'scraptfWindow.back', 'scraptfWindow.forward', 'scraptfWindow.reload', 'scraptfWindow.home', 'scraptfWindow.go', 'scraptfWindow.read'];

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
  // The toolbar's arrow keys collect its controls with querySelectorAll('button, input').
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

async function mount(opts: { readOnLoad?: boolean } = {}) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  let clock = T0;
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => clock }));
  await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 }, scraptfWindow: { enabled: true, acknowledgedAt: T0, readOnLoad: opts.readOnLoad ?? true } });
  const calls: { method: string; params: unknown }[] = [];
  // The toolbar's own push listeners, so a test can deliver a push main would send.
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const w: FlipdeskBridge = {
    windowKind: 'scraptf',
    rpc: (m, p) => {
      calls.push({ method: m, params: p });
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
  const bar = () => all().find((e) => e.getAttribute('role') === 'toolbar')!;
  const byLabel = (label: string) => all().find((e) => e.tagName === 'BUTTON' && e.getAttribute('aria-label') === label)!;
  const byText = (text: RegExp) => all().find((e) => e.tagName === 'BUTTON' && text.test(e.textContent))!;
  const chip = (label: string) => all().find((e) => e.tagName === 'BUTTON' && (e.getAttribute('class') ?? '').includes('stfw-chip') && e.textContent === label)!;
  const address = () => (all().find((e) => e.tagName === 'INPUT') as unknown as { value: string }).value;
  const status = () => all().find((e) => e.getAttribute('role') === 'status')!.textContent;
  const statusLine = () => all().find((e) => (e.getAttribute('class') ?? '').split(' ').includes('stfw-statusline'))!;
  const disabled = (e: ShimElement) => e.hasAttribute('disabled');
  const click = async (e: ShimElement) => {
    act(() => {
      e.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const key = async (target: ShimElement, init: Record<string, unknown>) => {
    act(() => {
      target.dispatchEvent(new ShimEvent('keydown', { bubbles: true, cancelable: true, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...init }));
    });
    await settle();
  };
  const moves = () => calls.filter((c) => MOVES.includes(c.method));
  const push = (event: string, payload: unknown) => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  };
  return { b, push, calls, moves, all, bar, byLabel, byText, chip, address, status, statusLine, disabled, click, key, tick: (ms: number) => (clock += ms), text: () => container.textContent };
}

describe('the toolbar, mounted', () => {
  it('shows every control, labelled, with Back and Forward off and nothing open; mounting moves nothing', async () => {
    const t = await mount();
    expect(t.bar().getAttribute('aria-label')).toBe('scrap.tf window');
    for (const label of ['Back', 'Forward', 'Reload', 'Home (scrap.tf)']) expect(t.byLabel(label), label).toBeDefined();
    expect(t.byLabel('Back').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowLeft');
    expect(t.byLabel('Back').getAttribute('title')).toBe('Back (Alt+Left)');
    expect(t.disabled(t.byLabel('Back'))).toBe(true);
    expect(t.disabled(t.byLabel('Forward'))).toBe(true);
    // Nothing open yet: no reload and no read.
    expect(t.disabled(t.byLabel('Reload'))).toBe(true);
    expect(t.disabled(t.byText(/Read page now/))).toBe(true);
    for (const b of SCRAPTF_BANKS) expect(t.chip(b.label), b.label).toBeDefined();
    const input = t.all().find((e) => e.tagName === 'INPUT')!;
    expect(input.hasAttribute('readonly') || (input as unknown as { readOnly?: boolean }).readOnly).toBe(true);
    expect(input.getAttribute('aria-label')).toBe('Page address (read-only)');
    expect(t.status()).toBe('Not read yet');
    // The risk pill, always: its text, its tooltip, and the tip for screen readers.
    const risk = t.byText(/External-tool risk/);
    expect(risk.getAttribute('title')).toBe(SCRAPTF_WINDOW_RISK_TIP);
    expect(doc.getElementById(risk.getAttribute('aria-describedby')!)?.textContent).toBe(SCRAPTF_WINDOW_RISK_TIP);
    expect(t.byText(/Log out & clear/)).toBeDefined();
    // Mounting asks for the state once and moves nothing.
    expect(t.calls.filter((c) => c.method === 'scraptfWindow.state')).toHaveLength(1);
    expect(t.moves()).toEqual([]);
  });

  it('follows main: a nav push fills the address and marks the chip; a read push fills the status line', async () => {
    const t = await mount();
    // main loads a page (here the mock, called past the toolbar): the toolbar only listens.
    await act(async () => {
      await t.b.rpc('scraptfWindow.open', { start: HATS });
    });
    await settle();
    expect(t.address()).toBe('scrap.tf/buy/hats');
    expect(t.chip('Hats').getAttribute('aria-current')).toBe('page');
    expect(t.chip('Weapons').getAttribute('aria-current')).toBeNull();
    expect(t.status()).toMatch(/^Read \d+ items? from \/buy\/hats/);
    // The line joins its parts with " · ", so the sentence's full stop goes.
    expect(t.status()).toContain(MOCK_WINDOW_READ_WARNING.replace(/\.$/, ''));
    expect(t.disabled(t.byText(/Read page now/))).toBe(false);
    expect(t.disabled(t.byLabel('Reload'))).toBe(false);
    expect(t.moves()).toEqual([]);
  });

  it('sends a chip, Back, Forward, Reload and Home to main on a click, with static pages only', async () => {
    const t = await mount();
    await t.click(t.chip('Stranges'));
    await t.click(t.chip('All items'));
    expect(t.moves()).toEqual([
      { method: 'scraptfWindow.go', params: { url: 'https://scrap.tf/buy/stranges' } },
      { method: 'scraptfWindow.go', params: { url: 'https://scrap.tf/items' } },
    ]);
    expect(t.address()).toBe('scrap.tf/items');
    expect(t.disabled(t.byLabel('Back'))).toBe(false);
    await t.click(t.byLabel('Back'));
    expect(t.address()).toBe('scrap.tf/buy/stranges');
    await t.click(t.byLabel('Forward'));
    await t.click(t.byLabel('Reload'));
    await t.click(t.byLabel('Home (scrap.tf)'));
    expect(t.moves().slice(2).map((c) => c.method)).toEqual(['scraptfWindow.back', 'scraptfWindow.forward', 'scraptfWindow.reload', 'scraptfWindow.home']);
    expect(t.address()).toBe(SCRAPTF_HOME_URL.replace('https://', '').replace(/\/$/, ''));
  });

  it('Read page now reads once per click and says why when main takes no read', async () => {
    const t = await mount({ readOnLoad: false });
    await t.click(t.chip('Hats'));
    // Reading on load is off: the go itself read nothing.
    expect(t.status()).toBe('Not read yet');
    expect(t.statusLine().getAttribute('title')).toMatch(/^Reading on load is off/);
    await t.click(t.byText(/Read page now/));
    expect(t.moves().map((c) => c.method)).toEqual(['scraptfWindow.go', 'scraptfWindow.read']);
    expect(t.status()).toMatch(/^Read \d+ items? from \/buy\/hats/);
    // At once again: main's throttle answers with its reason, shown in the status line.
    await t.click(t.byText(/Read page now/));
    expect(t.status()).toBe(SCRAPTF_READ_REASONS.tooSoon);
    expect((t.statusLine().getAttribute('class') ?? '').split(' ')).toContain('tone-text-warn');
    t.tick(READ_MANUAL_MIN_GAP_MS);
    await t.click(t.byText(/Read page now/));
    expect(t.status()).toMatch(/^Read \d+ items? from \/buy\/hats/);
    expect(t.moves().filter((c) => c.method === 'scraptfWindow.read')).toHaveLength(3);
  });

  it('Log out & clear asks first, then clears and says so', async () => {
    const t = await mount();
    await t.click(t.chip('Hats'));
    const btn = t.byText(/Log out & clear/);
    await t.click(btn);
    // Armed only: nothing cleared yet.
    expect(btn.textContent).toBe('Log out and clear?');
    expect(t.calls.filter((c) => c.method === 'scraptfWindow.clear')).toEqual([]);
    await t.click(btn);
    expect(t.calls.filter((c) => c.method === 'scraptfWindow.clear')).toHaveLength(1);
    expect(t.status()).toBe(WINDOW_CLEARED_TEXT);
    expect(t.address()).toBe('scrap.tf');
  });

  it('drops its last read when Log out & clear runs elsewhere (Settings), and shows when a read is under way', async () => {
    const t = await mount();
    await t.click(t.chip('Hats'));
    expect(t.status()).toMatch(/^Read \d+ items? from \/buy\/hats/);
    // Settings' Log out & clear, past the toolbar: main pushes a null read.
    await act(async () => {
      await t.b.rpc('scraptfWindow.clear', undefined);
    });
    await settle();
    expect(t.status()).toBe(WINDOW_CLEARED_TEXT);
    expect(t.text()).not.toMatch(/Read \d+ items? from \/buy\/hats/);
    // Main's nav push says an automatic read waits for its settle read.
    await act(async () => {
      t.push('scraptfWindow.nav', { url: HATS, canGoBack: false, canGoForward: false, loading: false, reading: true });
    });
    await settle();
    expect(t.text()).toContain('Reading…');
    // The pushes moved and read nothing: only the chip click did.
    expect(t.moves().map((c) => c.method)).toEqual(['scraptfWindow.go']);
  });

  it('the risk pill puts the whole risk in the status line', async () => {
    const t = await mount();
    await t.click(t.byText(/External-tool risk/));
    expect(t.status()).toBe(SCRAPTF_WINDOW_RISK_TIP);
    expect(t.moves()).toEqual([]);
  });

  it('keys: Alt+Left / Alt+Right / F5 / Alt+Home act once per press (never on a repeat), and the arrows move the focus', async () => {
    const t = await mount();
    await t.click(t.chip('Hats'));
    await t.click(t.chip('Skins'));
    const before = t.moves().length;
    await t.key(t.bar(), { key: 'ArrowLeft', altKey: true });
    expect(t.address()).toBe('scrap.tf/buy/hats');
    // Held: the repeats do nothing.
    for (let i = 0; i < 4; i++) await t.key(t.bar(), { key: 'ArrowRight', altKey: true, repeat: true });
    await t.key(t.bar(), { key: 'ArrowRight', altKey: true });
    await t.key(t.bar(), { key: 'F5' });
    for (let i = 0; i < 4; i++) await t.key(t.bar(), { key: 'F5', repeat: true });
    await t.key(t.bar(), { key: 'Home', altKey: true });
    expect(t.moves().slice(before).map((c) => c.method)).toEqual(['scraptfWindow.back', 'scraptfWindow.forward', 'scraptfWindow.reload', 'scraptfWindow.home']);
    // Arrow keys between the controls (toolbar pattern); a disabled control is skipped.
    const hats = t.chip('Hats');
    hats.focus();
    await t.key(hats, { key: 'ArrowRight' });
    expect(doc.activeElement).toBe(t.chip('Weapons'));
    await t.key(t.chip('Weapons'), { key: 'ArrowLeft' });
    expect(doc.activeElement).toBe(hats);
    // No key moved the view.
    expect(t.moves().slice(before)).toHaveLength(4);
  });
});

describe('wiring (static)', () => {
  const page = read('pages/ScraptfWindowBar.tsx');

  it("calls only main's window methods, the state once on mount, and builds no URL", () => {
    const methods = [...new Set([...page.matchAll(/'(scraptfWindow\.[a-z]+)'/g)].map((m) => m[1]))].sort();
    expect(methods).toEqual(['scraptfWindow.back', 'scraptfWindow.clear', 'scraptfWindow.forward', 'scraptfWindow.go', 'scraptfWindow.home', 'scraptfWindow.nav', 'scraptfWindow.read', 'scraptfWindow.reload', 'scraptfWindow.state']);
    expect(page).toContain("rpc('scraptfWindow.go', { url }).catch(fail);");
    // The chips come from the static list (barBankChips reads SCRAPTF_BANKS), the address is text.
    expect(page).toContain('barBankChips().map((c) =>');
    expect(page).not.toMatch(/https?:\/\/|new URL\(|links\.open|openLink|openOrCopy|fetch\(|XMLHttpRequest|WebSocket|<webview|<iframe|window\.open|location\.href/);
    // A note (not main) is the one thing on a timer.
    expect([...page.matchAll(/setTimeout\(/g)]).toHaveLength(1);
    expect(page).toContain('const id = setTimeout(() => setNote(null), NOTE_MS[note.tone]);');
    expect(page).not.toMatch(/setInterval\(/);
  });

  it('is the scrap.tf window kind in Root, titled "scrap.tf · Flip Desk"', () => {
    const app = read('App.tsx');
    expect(app).toContain("scraptf: 'scrap.tf · Flip Desk',");
    expect(app).toMatch(/kind === 'scraptf' \? <ScraptfWindowBar \/>/);
  });
});

describe('scraptf-window.css', () => {
  const css = read('styles/scraptf-window.css');
  const rules = css.replace(/\/\*[^]*?\*\//g, '');

  it('keeps the bar exactly 48 px (main lays the view from there) and on one line', () => {
    expect(rules).toMatch(/\.stfw-bar \{[^}]*height: 48px;[^}]*box-sizing: border-box;[^}]*overflow: hidden;[^}]*white-space: nowrap;/);
    expect(rules).toMatch(/\.stfw-chips \{[^}]*overflow-x: auto;/);
  });

  it('takes every colour from the tokens, animates nothing and loads nothing', () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\brgba?\(|\bhsla?\(/);
    expect(rules).not.toMatch(/animation|transition/);
    expect(rules).not.toMatch(/url\(|@import/);
  });

  it('is the last sheet index.css imports', () => {
    const index = read('styles/index.css').trim().split('\n');
    expect(index[index.length - 1]).toBe("@import './scraptf-window.css';");
  });
});
