// F21, Settings → "scrap.tf window (opt-in)": what the window does and never does, the risk in scrap.tf's
// own words (ToS, staff stance, a ban possible on both sites), the acknowledgement, the switch that stays
// disabled until import is on and the box is ticked (main's refusal shown when it comes anyway), the three
// options, Open the scrap.tf window and Log out & clear. Mounted with react-dom/client into domShim.ts
// against the browser mock, which applies main's gate; plus the page's wiring, checked statically.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import {
  SCRAPTF_TOS_WORDS,
  SCRAPTF_WINDOW_ACK_TEXT,
  SCRAPTF_WINDOW_ENABLE_LABEL,
  SCRAPTF_WINDOW_KEEP_LABEL,
  SCRAPTF_WINDOW_LINKS_LABEL,
  SCRAPTF_WINDOW_READ_LABEL,
  SCRAPTF_WINDOW_RISK,
} from '../../src/renderer/scraptfWindowModel';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import { SCRAPTF_WINDOW_NEEDS_ACK } from '../../src/shared/scraptfWindowPolicy';
import type { Settings } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');

describe('wiring (static)', () => {
  it('a "scrap.tf window" section right after Saved-page import, in the contents and on the page', () => {
    expect(page).toContain("['set-window', 'scrap.tf window']");
    expect(page.indexOf("['set-import'")).toBeLessThan(page.indexOf("['set-window'"));
    expect(page.indexOf("['set-window'")).toBeLessThan(page.indexOf("['set-feed'"));
    expect(page.indexOf('<ImportSection s={settings} />')).toBeLessThan(page.indexOf('<ScraptfWindowSection s={settings} />'));
    expect(page.indexOf('<ScraptfWindowSection s={settings} />')).toBeLessThan(page.indexOf('<FeedSection s={settings} />'));
    expect(page).toContain('title="scrap.tf window (opt-in)"');
  });

  it('saves only scraptfWindow keys, opens the window only through main, and opens no scrap.tf page itself', () => {
    const section = page.slice(page.indexOf('export function ScraptfWindowSection'), page.indexOf('function AboutAppSection'));
    expect([...section.matchAll(/updateSettings\(\{ (\w+):/g)].map((m) => m[1])).toEqual(['scraptfWindow']);
    expect(section).toContain("rpc('settings.set', { scraptfWindow: { enabled: on } })");
    expect(section).toContain("rpc('scraptfWindow.open')");
    expect(section).toContain("rpc('scraptfWindow.clear')");
    expect(section).not.toMatch(/openOrCopy\(|openLink\(|openOnScraptf\(|links\.open|href=|\bwindow\.open/);
    // Settings is on F20's opener-free list: no scrap.tf page opens from here, not even the terms
    // (ExternalLink is openOrCopy); the About page links them.
    expect(section).not.toContain('<ExternalLink');
    expect(section).toContain("onClick={() => navigate('about')}");
  });
});

// ---------------------------------------------------------------------------
// Mounted
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let ScraptfWindowSection: (p: { s: Settings }) => ReactNode;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '#/settings' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ ScraptfWindowSection } = await import('../../src/renderer/pages/SettingsPage'));
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

function Section() {
  const { settings, toasts } = useApp();
  return createElement(
    'div',
    null,
    settings ? createElement(ScraptfWindowSection, { s: settings }) : null,
    createElement('output', { 'data-toasts': toasts.map((t) => t.text).join('|') }),
  );
}

async function mount(opts: { patch?: Parameters<MockBridge['rpc']>[1]; refuse?: string } = {}) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (opts.patch) await b.rpc('settings.set', opts.patch as never);
  const calls: { method: string; params: unknown }[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (m, p) => {
      calls.push({ method: m, params: p });
      // Main's setter refusing what the page sent (a gate removed in another window meanwhile).
      if (opts.refuse && m === 'settings.set' && (p as { scraptfWindow?: { enabled?: boolean } })?.scraptfWindow?.enabled === true) return Promise.reject(new Error(opts.refuse));
      return b.rpc(m, p);
    },
    on: (e, fn) => b.on(e, fn),
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(Section))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  for (let i = 0; i < 2; i++) await settle();
  const all = () => container.descendants();
  const isBox = (e: ShimElement) => e.tagName === 'INPUT' && (e.getAttribute('type') === 'checkbox' || (e as unknown as { type?: string }).type === 'checkbox');
  const box = (label: string) => all().filter(isBox).find((e) => e.parentNode?.textContent.includes(label)) as (ShimElement & { checked: boolean }) | undefined;
  const toggle = async (label: string) => {
    const e = box(label)!;
    e.checked = !e.checked;
    act(() => {
      e.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const button = (text: RegExp) => all().find((e) => e.tagName === 'BUTTON' && text.test(e.textContent))!;
  const click = async (e: ShimElement) => {
    act(() => {
      e.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const sets = () => calls.filter((c) => c.method === 'settings.set').map((c) => c.params);
  const stored = async () => (await b.rpc('settings.get', undefined)).scraptfWindow;
  const toasts = () => all().find((e) => e.tagName === 'OUTPUT')!.getAttribute('data-toasts') ?? '';
  return { b, calls, all, box, toggle, button, click, sets, stored, toasts, text: () => container.textContent };
}

const IMPORT_ON = { import: { enabled: true, acknowledgedAt: T0 } };

describe('Settings → scrap.tf window, mounted', () => {
  it('explains what it does and never does, and the risk in scrap.tf\'s words, with the window off by default', async () => {
    const t = await mount();
    const text = t.text();
    expect(text).toContain('What it does');
    expect(text).toContain('What it never does');
    expect(text).toContain(`"${SCRAPTF_TOS_WORDS}"`);
    for (const s of SCRAPTF_WINDOW_RISK) expect(text).toContain(s);
    expect(text).toContain('staff have ruled scripts out');
    expect(text).toContain('backpack.tf account may be banned too');
    expect(text).toContain(SCRAPTF_WINDOW_ACK_TEXT);
    // Off, unticked, and the switch waits for import first.
    expect(t.box(SCRAPTF_WINDOW_ACK_TEXT)!.checked).toBe(false);
    expect(t.box(SCRAPTF_WINDOW_ENABLE_LABEL)!.checked).toBe(false);
    expect(t.box(SCRAPTF_WINDOW_ENABLE_LABEL)!.hasAttribute('disabled')).toBe(true);
    expect(text).toContain('Turn on saved-page import first');
    expect(t.button(/^Go to Import$/)).toBeDefined();
    expect(t.button(/Open the scrap\.tf window/).hasAttribute('disabled')).toBe(true);
    // Defaults of the options.
    expect(t.box(SCRAPTF_WINDOW_KEEP_LABEL)!.checked).toBe(false);
    expect(t.box(SCRAPTF_WINDOW_READ_LABEL)!.checked).toBe(true);
    expect(t.box(SCRAPTF_WINDOW_LINKS_LABEL)!.checked).toBe(false);
    expect(t.calls.filter((c) => c.method.startsWith('scraptfWindow.'))).toEqual([]);
    // The terms: a step to the About page, which links them; nothing opens from Settings.
    await t.click(t.button(/terms are linked on the About page/));
    expect((win()['location'] as { hash: string }).hash).toBe('#/about');
    expect(t.calls.filter((c) => c.method === 'links.open')).toEqual([]);
    (win()['location'] as { hash: string }).hash = '#/settings';
  });

  it('with import on: ticking the box saves when, then the switch turns the window on', async () => {
    const t = await mount({ patch: IMPORT_ON });
    expect(t.box(SCRAPTF_WINDOW_ENABLE_LABEL)!.hasAttribute('disabled')).toBe(true);
    expect(t.text()).toContain('Tick the acknowledgement above first.');
    await t.toggle(SCRAPTF_WINDOW_ACK_TEXT);
    const ack = t.sets()[0] as { scraptfWindow: { acknowledgedAt: number } };
    expect(Object.keys(ack.scraptfWindow)).toEqual(['acknowledgedAt']);
    expect(typeof ack.scraptfWindow.acknowledgedAt).toBe('number');
    expect(t.text()).toMatch(/You accepted this on .+\. Unticking it turns the window off\./);
    expect(t.box(SCRAPTF_WINDOW_ENABLE_LABEL)!.hasAttribute('disabled')).toBe(false);
    await t.toggle(SCRAPTF_WINDOW_ENABLE_LABEL);
    expect(t.sets()[1]).toEqual({ scraptfWindow: { enabled: true } });
    expect((await t.stored()).enabled).toBe(true);
    expect(t.box(SCRAPTF_WINDOW_ENABLE_LABEL)!.checked).toBe(true);
    expect(t.text()).toContain('On. Open it from "scrap.tf window" in the menu');
    // Open the scrap.tf window: main's open, on the click only.
    expect(t.button(/Open the scrap\.tf window/).hasAttribute('disabled')).toBe(false);
    await t.click(t.button(/Open the scrap\.tf window/));
    expect(t.calls.filter((c) => c.method === 'scraptfWindow.open')).toEqual([{ method: 'scraptfWindow.open', params: undefined }]);
    expect((await t.b.rpc('scraptfWindow.state', undefined)).open).toBe(true);
  });

  it('unticking the acknowledgement turns the window off (as main does)', async () => {
    const t = await mount({ patch: { ...IMPORT_ON, scraptfWindow: { enabled: true, acknowledgedAt: T0 } } });
    expect(t.box(SCRAPTF_WINDOW_ENABLE_LABEL)!.checked).toBe(true);
    await t.toggle(SCRAPTF_WINDOW_ACK_TEXT);
    expect(t.sets()).toEqual([{ scraptfWindow: { acknowledgedAt: null } }]);
    expect(await t.stored()).toMatchObject({ enabled: false, acknowledgedAt: null });
    expect(t.box(SCRAPTF_WINDOW_ENABLE_LABEL)!.checked).toBe(false);
  });

  it("shows main's refusal under the switch, in words", async () => {
    const t = await mount({ patch: { ...IMPORT_ON, scraptfWindow: { acknowledgedAt: T0 } }, refuse: `Invalid settings: ${SCRAPTF_WINDOW_NEEDS_ACK}` });
    await t.toggle(SCRAPTF_WINDOW_ENABLE_LABEL);
    const alert = t.all().find((e) => e.getAttribute('role') === 'alert');
    expect(alert?.textContent.trim()).toBe('Tick the scrap.tf window risk acknowledgement first.');
    expect((await t.stored()).enabled).toBe(false);
  });

  it('saves each option alone', async () => {
    const t = await mount({ patch: { ...IMPORT_ON, scraptfWindow: { enabled: true, acknowledgedAt: T0 } } });
    await t.toggle(SCRAPTF_WINDOW_KEEP_LABEL);
    await t.toggle(SCRAPTF_WINDOW_READ_LABEL);
    await t.toggle(SCRAPTF_WINDOW_LINKS_LABEL);
    expect(t.sets()).toEqual([{ scraptfWindow: { keepLoggedIn: true } }, { scraptfWindow: { readOnLoad: false } }, { scraptfWindow: { openLinksInWindow: true } }]);
    expect(await t.stored()).toMatchObject({ enabled: true, keepLoggedIn: true, readOnLoad: false, openLinksInWindow: true });
  });

  it('Log out & clear asks first, works while the window is off, and says when done', async () => {
    const t = await mount();
    const btn = t.button(/Log out & clear/);
    await t.click(btn);
    expect(t.calls.filter((c) => c.method === 'scraptfWindow.clear')).toEqual([]);
    await t.click(btn);
    expect(t.calls.filter((c) => c.method === 'scraptfWindow.clear')).toHaveLength(1);
    expect(t.toasts()).toContain("Signed out: the window's cookies, site storage and cache are cleared.");
  });
});
