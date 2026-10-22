// 0.9 (#1): the Trade lock question on Holdings, its caution, and Settings → Trade lock, rendered with react-dom/client
// into the minimal DOM in domShim.ts with the browser mock as the app bridge. The card asks until the user answers and
// each answer is a settings write (answeredAt now); the caution shows only for an answered Not sure while something is
// held; the Settings section offers the three answers and, while unanswered, a way to keep Not sure. Valve's FAQ is one
// exact allowlisted URL, opened only in the user's browser; the card itself sends no request and names no address.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { STATIC_EXTERNAL_URLS, STEAM_TRADE_PROTECTION_FAQ_URL, isAllowedExternalUrl } from '../../src/shared/links';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import type { Settings, TradeLockSettings } from '../../src/shared/types';
import { TRADE_LOCK_CAUTION, TRADE_LOCK_HELP, TRADE_LOCK_QUESTION, tradeLockAnsweredText } from '../../src/renderer/holdingsModel';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let TradeLockCard: () => ReactNode;
let TradeLockCaution: (p: { held: boolean }) => ReactNode;
let TradeLockSection: (p: { s: Settings }) => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/holdings' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ TradeLockCard, TradeLockCaution } = await import('../../src/renderer/components/TradeLockCard'));
  ({ TradeLockSection } = await import('../../src/renderer/pages/SettingsPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function Section() {
  const { settings } = useApp();
  return settings ? createElement(TradeLockSection, { s: settings }) : null;
}

function Toasts() {
  const { toasts } = useApp();
  return createElement('output', { id: 'toasts' }, toasts.map((t) => t.text).join(' | '));
}

/** Mounts `children` in the app with the mock as the bridge, the stored Trade lock set first; records every RPC sent. */
async function mount(lock: TradeLockSettings | null, children: ReactNode[]) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  // Fake time for the answer's answeredAt (Date.now), without fake timers (the settle loop needs real ones).
  vi.spyOn(Date, 'now').mockReturnValue(T0);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (lock) await b.rpc('settings.set', { tradeLock: lock });
  const sent: { method: string; params: unknown }[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (m, p) => {
      sent.push({ method: m, params: p });
      return b.rpc(m, p);
    },
    on: (e, fn) => b.on(e, fn),
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, ...children, createElement(Toasts))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  for (let i = 0; i < 3; i++) await settle();
  const all = () => container.descendants();
  const button = (text: string) => all().find((e) => e.tagName === 'BUTTON' && e.textContent === text) as ShimElement | undefined;
  return {
    b,
    sent,
    all,
    text: () => container.textContent,
    button,
    click: async (text: string) => {
      const el = button(text);
      expect(el, text).toBeTruthy();
      act(() => {
        el!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle();
    },
    stored: async () => (await b.rpc('settings.get', undefined)).tradeLock,
  };
}

describe("Holdings' Trade lock question (TradeLockCard)", () => {
  it('renders while unanswered: the question, the three answers 7-day first, and the FAQ link', async () => {
    const t = await mount(null, [createElement(TradeLockCard)]);
    expect(t.text()).toContain(TRADE_LOCK_QUESTION);
    const answers = t.all().filter((e) => e.tagName === 'BUTTON' && ['7-day lock', 'No lock', 'Not sure'].includes(e.textContent));
    expect(answers.map((e) => e.textContent)).toEqual(['7-day lock', 'No lock', 'Not sure']);
    expect(answers[0]!.getAttribute('class')).toBe('btn small primary');
    expect(answers[1]!.getAttribute('class')).toBe('btn small');
    expect(answers[0]!.getAttribute('title')).toBe('Items I receive cannot be traded for 7 days');
    const faq = t.all().find((e) => e.tagName === 'BUTTON' && e.textContent.includes("Valve's Trade Protection FAQ"));
    expect(faq?.getAttribute('title')).toBe(STEAM_TRADE_PROTECTION_FAQ_URL);
  });

  it('is not shown once answered', async () => {
    const t = await mount({ mode: 'none', answeredAt: T0 - 1000 }, [createElement(TradeLockCard)]);
    expect(t.text()).not.toContain(TRADE_LOCK_QUESTION);
  });

  it('"7-day lock" writes the answer with its time, says so, and the card goes', async () => {
    const t = await mount(null, [createElement(TradeLockCard)]);
    await t.click('7-day lock');
    const sets = t.sent.filter((s) => s.method === 'settings.set');
    expect(sets).toEqual([{ method: 'settings.set', params: { tradeLock: { mode: '7d', answeredAt: T0 } } }]);
    expect(await t.stored()).toEqual({ mode: '7d', answeredAt: T0 });
    expect(t.text()).toContain('Trade lock set to 7-day lock. Change it in Settings → Trade lock.');
    expect(t.text()).not.toContain(TRADE_LOCK_QUESTION);
  });

  it('"Not sure" is an answer too: it stops the asking and keeps the mode', async () => {
    const t = await mount(null, [createElement(TradeLockCard)]);
    await t.click('Not sure');
    expect(await t.stored()).toEqual({ mode: 'unknown', answeredAt: T0 });
    expect(t.text()).not.toContain(TRADE_LOCK_QUESTION);
  });
});

describe('the Not sure caution (TradeLockCaution)', () => {
  it('shows only for an answered Not sure while something is held', async () => {
    const answered = await mount({ mode: 'unknown', answeredAt: T0 - 1000 }, [createElement(TradeLockCaution, { held: true })]);
    expect(answered.text()).toContain(TRADE_LOCK_CAUTION);
    expect(answered.button('Trade lock setting')).toBeTruthy();
  });

  it('is absent while unanswered, with nothing held, and with an answer other than Not sure', async () => {
    for (const [lock, held] of [
      [null, true],
      [{ mode: 'unknown', answeredAt: T0 - 1000 }, false],
      [{ mode: '7d', answeredAt: T0 - 1000 }, true],
      [{ mode: 'none', answeredAt: T0 - 1000 }, true],
    ] as [TradeLockSettings | null, boolean][]) {
      const t = await mount(lock, [createElement(TradeLockCaution, { held })]);
      expect(t.text(), JSON.stringify([lock, held])).not.toContain(TRADE_LOCK_CAUTION);
      unmounts.pop()!();
      bridge?.dispose();
      bridge = null;
    }
  });
});

describe('Settings → Trade lock (TradeLockSection)', () => {
  it('offers Not sure / No lock / 7-day lock with the hint of the mode set, and the stop-asking button while unanswered', async () => {
    const t = await mount(null, [createElement(Section)]);
    const group = t.all().find((e) => e.getAttribute('role') === 'radiogroup' && e.getAttribute('aria-label') === 'Trade lock')!;
    expect(group).toBeTruthy();
    const options = group.descendants().filter((e) => e.getAttribute('role') === 'radio');
    expect(options.map((e) => e.textContent)).toEqual(['Not sure', 'No lock', '7-day lock']);
    expect(options.map((e) => e.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(t.text()).toContain(TRADE_LOCK_HELP.unknown);
    expect(t.text()).toContain(tradeLockAnsweredText(null));
    expect(t.text()).toContain("Valve's Trade Protection FAQ");
    await t.click('Keep "Not sure" and stop asking');
    expect(await t.stored()).toEqual({ mode: 'unknown', answeredAt: T0 });
    expect(t.button('Keep "Not sure" and stop asking')).toBeUndefined();
    expect(t.text()).toContain(tradeLockAnsweredText(T0));
  });

  it('a segment writes its mode with answeredAt now, and the hint follows', async () => {
    const t = await mount({ mode: 'none', answeredAt: T0 - 5000 }, [createElement(Section)]);
    expect(t.button('Keep "Not sure" and stop asking')).toBeUndefined();
    expect(t.text()).toContain(TRADE_LOCK_HELP.none);
    await t.click('7-day lock');
    expect(await t.stored()).toEqual({ mode: '7d', answeredAt: T0 });
    expect(t.text()).toContain(TRADE_LOCK_HELP['7d']);
  });
});

describe("Valve's Trade Protection FAQ link and the card's source", () => {
  it('is one exact allowlisted URL; other help.steampowered.com pages are not', () => {
    expect(STATIC_EXTERNAL_URLS).toContain(STEAM_TRADE_PROTECTION_FAQ_URL);
    expect(isAllowedExternalUrl(STEAM_TRADE_PROTECTION_FAQ_URL)).toBe(true);
    expect(isAllowedExternalUrl('https://help.steampowered.com/en/faqs/view/0000-0000-0000-0000')).toBe(false);
    expect(isAllowedExternalUrl('https://help.steampowered.com/')).toBe(false);
  });

  it('TradeLockCard.tsx sends no RPC of its own, opens nothing itself and names no address', () => {
    const src = readFileSync(new URL('../../src/renderer/components/TradeLockCard.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\brpc\(/);
    expect(src).not.toMatch(/openOrCopy\(/);
    expect(src).not.toMatch(/https?:\/\//);
  });

  it('Settings lists Trade lock right after Your accounts, in the contents and on the page', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain("['set-own', 'Your accounts'],\n  ['set-trade', 'Trade lock'],");
    expect(page.indexOf('<OwnAccountsSection s={settings} />')).toBeLessThan(page.indexOf('<TradeLockSection s={settings} />'));
    expect(page.match(/<TradeLockSection /g)).toHaveLength(1);
  });

  it('Holdings shows the card and the caution after the toolbar, before the banners', () => {
    const page = readFileSync(new URL('../../src/renderer/pages/HoldingsPage.tsx', import.meta.url), 'utf8');
    const toolbarEnd = page.indexOf('<Icon name="download" size={14} /> Export CSV');
    expect(toolbarEnd).toBeGreaterThan(0);
    expect(page.indexOf('<TradeLockCard />')).toBeGreaterThan(toolbarEnd);
    expect(page.indexOf('<TradeLockCaution held={held} />')).toBeGreaterThan(page.indexOf('<TradeLockCard />'));
    expect(page.indexOf('<TradeLockCaution held={held} />')).toBeLessThan(page.indexOf('{held && paused ? ('));
  });
});
