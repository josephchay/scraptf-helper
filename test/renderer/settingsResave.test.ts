// F20 U4: Settings → Saved-page import's re-save reminders. The field helpers agree with main's settings
// schema (whole minutes 0-1440; resaveBanks [] = every saved bank, so the last box never saves []), the
// description names what keeps reminders silent, and the section, mounted with react-dom/client into
// domShim.ts against the browser mock, saves exactly settings.import.resaveReminderMin / resaveBanks with
// the helper text "Flip Desk can't refresh scrap.tf for you; this reminds you to save the page again".

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import {
  RESAVE_LAST_BANK_TITLE,
  RESAVE_MINUTES,
  resaveBanksHint,
  resaveBanksShown,
  resaveMinutesOf,
  resaveReminderHint,
  setResaveBank,
  validateResaveMinutes,
} from '../../src/renderer/settingsFields';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { SCRAPTF_RESAVE_HELP, SCRAPTF_RESAVE_MAX_MIN } from '../../src/shared/scraptfHistory';
import { applySettingsPatch } from '../../src/shared/settingsSchema';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import { SCRAPTF_BANK_IDS, type ScraptfBank, type Settings } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

function mainAccepts(patch: Parameters<typeof applySettingsPatch>[1]): boolean {
  try {
    applySettingsPatch(DEFAULT_SETTINGS, patch);
    return true;
  } catch {
    return false;
  }
}

describe('the minutes field agrees with the settings schema', () => {
  it('takes whole minutes 0 to 1440, and an empty field is not 0', () => {
    expect(RESAVE_MINUTES).toEqual({ min: 0, max: SCRAPTF_RESAVE_MAX_MIN });
    for (const ok of ['0', '1', '60', ' 90 ', '1440']) {
      expect(validateResaveMinutes(ok), ok).toBeNull();
      expect(mainAccepts({ import: { resaveReminderMin: resaveMinutesOf(ok) } }), ok).toBe(true);
    }
    expect(resaveMinutesOf(' 90 ')).toBe(90);
    expect(validateResaveMinutes('')).toBe('Enter the minutes; 0 turns reminders off.');
    for (const bad of ['1.5', '-5', 'x', '1e3', '0x10', '60 min']) expect(validateResaveMinutes(bad), bad).toBe('Whole minutes, 0 to 1440.');
    expect(validateResaveMinutes('1441')).toBe('At most 1440 minutes (a day).');
    // What the field refuses, main refuses too.
    expect(mainAccepts({ import: { resaveReminderMin: 1441 } })).toBe(false);
    expect(mainAccepts({ import: { resaveReminderMin: 1.5 } })).toBe(false);
    expect(DEFAULT_SETTINGS.import.resaveReminderMin).toBe(0);
  });
});

describe('the bank boxes', () => {
  it('[] (the default) shows every box ticked: every bank saved at least once', () => {
    expect(DEFAULT_SETTINGS.import.resaveBanks).toEqual([]);
    expect(resaveBanksShown([])).toEqual([...SCRAPTF_BANK_IDS]);
    expect(resaveBanksShown(undefined)).toEqual([...SCRAPTF_BANK_IDS]);
    expect(resaveBanksShown(['unusuals', 'hats'])).toEqual(['hats', 'unusuals']);
    expect(resaveBanksHint([])).toMatch(/^Every bank you have saved at least once, including ones you save later\./);
    expect(resaveBanksHint(['hats'])).toMatch(/^Only the ticked banks/);
  });

  it('unticking from every bank saves the rest; ticking the last one back saves []; the last box stays ticked', () => {
    const rest = setResaveBank([], 'skins', false)!;
    expect(rest).toEqual(SCRAPTF_BANK_IDS.filter((b) => b !== 'skins'));
    expect(setResaveBank(rest, 'skins', true)).toEqual([]);
    expect(setResaveBank(['hats'], 'weapons', true)).toEqual(['hats', 'weapons']);
    expect(setResaveBank(['weapons', 'hats'], 'hats', false)).toEqual(['weapons']);
    // [] would mean every bank: the last tick is refused, never saved as [].
    expect(setResaveBank(['hats'], 'hats', false)).toBeNull();
    expect(RESAVE_LAST_BANK_TITLE).toContain('set the minutes to 0');
    // Everything it saves, main accepts.
    for (const v of [rest, ['hats'], ['hats', 'weapons'], [] as ScraptfBank[]]) expect(mainAccepts({ import: { resaveBanks: v } })).toBe(true);
    // Ticking an unknown id does nothing beyond the known banks.
    expect(setResaveBank(['hats'], 'moon' as ScraptfBank, true)).toEqual(['hats']);
  });
});

describe('the description', () => {
  const on = { minutes: 60, importOn: true, notificationsOn: true, networkPaused: false };

  it('off at 0; else what a reminder does, the title it shows and that a click opens the page', () => {
    expect(resaveReminderHint({ ...on, minutes: 0 })).toMatch(/^Off\. /);
    const t = resaveReminderHint(on);
    expect(t).toBe(
      'A desktop notification for each bank below that you have saved, once it has not been saved for 60 minutes, then at most once every 60 minutes until you save it: "Re-save scrap.tf/buy/hats". Clicking it opens that page in your browser. Silent notifications apply.',
    );
    expect(resaveReminderHint({ ...on, minutes: 1 })).toContain('for 1 minute, then at most once every 1 minute');
  });

  it('names whatever keeps reminders silent first, as the service gates them', () => {
    const base = resaveReminderHint(on);
    expect(resaveReminderHint({ ...on, importOn: false })).toBe(`Saved-page import is off (Import), so none come yet. ${base}`);
    expect(resaveReminderHint({ ...on, notificationsOn: false })).toBe(`Desktop notifications are off (Notifications), so none come yet. ${base}`);
    expect(resaveReminderHint({ ...on, networkPaused: true })).toBe(`The network is paused, so none come yet. ${base}`);
    expect(resaveReminderHint({ ...on, importOn: false, notificationsOn: false, networkPaused: true })).toBe(
      `Saved-page import is off (Import), desktop notifications are off (Notifications) and the network is paused, so none come yet. ${base}`,
    );
  });
});

describe('wiring (static)', () => {
  const page = readFileSync(new URL('../../src/renderer/pages/SettingsPage.tsx', import.meta.url), 'utf8');

  it('a Saved-page import section after Notifications, saving only the two F20 keys, with the shared helper text', () => {
    expect(page).toContain("['set-import', 'Saved-page import']");
    expect(page.indexOf("['set-notify'")).toBeLessThan(page.indexOf("['set-import'"));
    expect(page).toContain('<ImportSection s={settings} />');
    const section = page.slice(page.indexOf('export function ImportSection'), page.indexOf('function AppearanceSection'));
    expect(section).toContain('{SCRAPTF_RESAVE_HELP}');
    expect([...section.matchAll(/updateSettings\(\{ import: \{ (\w+):/g)].map((m) => m[1]).sort()).toEqual(['resaveBanks', 'resaveReminderMin']);
    // The import switches themselves stay on the Import page, behind the acknowledgement.
    expect(section).not.toMatch(/import: \{ (enabled|acknowledgedAt|watchFolder|permission)/);
    // Nothing opened from here: the bank paths are text.
    expect(section).not.toMatch(/openOrCopy|links\.open|ExternalLink|href=/);
    // Other tests slice NotifySection to FeedSection: the new section is not between them.
    const notify = page.slice(page.indexOf('function NotifySection'), page.indexOf('function FeedSection'));
    expect(notify).not.toContain('ImportSection(');
  });
});

// ---------------------------------------------------------------------------
// Mounted
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
let ImportSection: (p: { s: Settings }) => ReactNode;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  win()['location'] = { hash: '#/settings' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ ImportSection } = await import('../../src/renderer/pages/SettingsPage'));
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
  const { settings } = useApp();
  return settings ? createElement(ImportSection, { s: settings }) : null;
}

async function mount(patch?: Parameters<typeof applySettingsPatch>[1]) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (patch) await b.rpc('settings.set', patch);
  const calls: { method: string; params: unknown }[] = [];
  const w: FlipdeskBridge = {
    windowKind: 'dashboard',
    rpc: (m, p) => {
      calls.push({ method: m, params: p });
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
  // React may set an input's type as a property rather than an attribute.
  const isBox = (e: ShimElement) => e.tagName === 'INPUT' && (e.getAttribute('type') === 'checkbox' || (e as unknown as { type?: string }).type === 'checkbox');
  const boxes = () => all().filter(isBox) as (ShimElement & { checked: boolean })[];
  const box = (label: string) => boxes().find((e) => e.parentNode?.textContent.startsWith(label))!;
  const toggle = async (label: string) => {
    const e = box(label);
    e.checked = !e.checked;
    act(() => {
      e.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const sets = () => calls.filter((c) => c.method === 'settings.set').map((c) => c.params);
  return { b, all, boxes, box, toggle, sets, text: () => container.textContent };
}

describe('Settings → Saved-page import, mounted', () => {
  it('shows the helper text, the minutes and every bank ticked by default, each by its SCRAPTF_BANKS label and path', async () => {
    const t = await mount();
    expect(t.text()).toContain(`${SCRAPTF_RESAVE_HELP}.`);
    expect(SCRAPTF_RESAVE_HELP).toBe("Flip Desk can't refresh scrap.tf for you; this reminds you to save the page again");
    const minutes = t.all().find((e) => e.getAttribute('id') === 'imp-resave') as ShimElement & { value: string };
    expect(minutes.value).toBe('0');
    expect(t.text()).toContain('Off. Enter the minutes');
    expect(t.boxes()).toHaveLength(SCRAPTF_BANKS.length);
    expect(t.boxes().every((b) => b.checked)).toBe(true);
    for (const info of SCRAPTF_BANKS) expect(t.box(info.label).parentNode!.textContent).toBe(`${info.label}${info.url.replace(/^https:\/\//, '')}`);
    expect(t.text()).toContain('Import is off');
  });

  it('unticking a bank saves the others; ticking it back saves every bank ([])', async () => {
    const t = await mount();
    await t.toggle('Skins');
    expect(t.sets()).toEqual([{ import: { resaveBanks: SCRAPTF_BANK_IDS.filter((b) => b !== 'skins') } }]);
    expect(t.box('Skins').checked).toBe(false);
    await t.toggle('Skins');
    expect(t.sets()[1]).toEqual({ import: { resaveBanks: [] } });
    expect((await t.b.rpc('settings.get', undefined)).import.resaveBanks).toEqual([]);
  });

  it('the last ticked bank cannot be unticked: [] would mean every bank', async () => {
    const t = await mount({ import: { resaveBanks: ['hats'], resaveReminderMin: 30 } });
    const hats = t.box('Hats');
    expect(hats.checked).toBe(true);
    expect(hats.hasAttribute('disabled')).toBe(true);
    expect((hats.parentNode as ShimElement).getAttribute('title')).toBe(RESAVE_LAST_BANK_TITLE);
    expect(t.boxes().filter((b) => b.checked)).toHaveLength(1);
    expect(t.text()).toContain('Only the ticked banks');
    // Import is off in a fresh mock: the description says so first.
    expect(t.text()).toContain('Saved-page import is off (Import), so none come yet.');
  });
});
