// F21, the renderer's pure helpers for the opt-in scrap.tf window (scraptfWindowModel.ts): the risk words
// (scrap.tf's ToS verbatim, the staff stance, a ban on both sites), the enable switch from the same rule as
// main's setter, the toolbar's keys, chips, address, Read button and status line, and the Import page's
// origin label. Nothing here calls main or builds a URL: every page is a SCRAPTF_BANKS entry.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { applySettingsPatch } from '../../src/shared/settingsSchema';
import {
  READ_AUTO_MIN_GAP_MS,
  READ_SETTLE_MS,
  SCRAPTF_NOT_READ_AGAIN,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_NEEDS_ACK,
  SCRAPTF_WINDOW_NEEDS_IMPORT,
  SCRAPTF_WINDOW_NOTICES,
  isAllowedWindowStart,
} from '../../src/shared/scraptfWindowPolicy';
import { importBankText } from '../../src/renderer/banksModel';
import type { ScraptfWindowRead, Settings } from '../../src/shared/types';
import {
  activeBankOf,
  addressView,
  BAR_SHORTCUTS,
  barBankChips,
  barFocusMove,
  barShortcut,
  bankWindowView,
  bestFlipTitle,
  importOriginView,
  OPEN_IN_WINDOW_LABEL,
  readButtonView,
  readStatusText,
  readStatusView,
  readWarningText,
  SCRAPTF_TOS_WORDS,
  SCRAPTF_WINDOW_ACK_TEXT,
  SCRAPTF_WINDOW_DOES,
  SCRAPTF_WINDOW_KEEP_HINT,
  SCRAPTF_WINDOW_LINKS_HINT,
  SCRAPTF_WINDOW_NEVER,
  SCRAPTF_WINDOW_READ_HINT,
  SCRAPTF_WINDOW_ORIGIN_LABEL,
  SCRAPTF_WINDOW_PARTITION_NOTE,
  SCRAPTF_WINDOW_RISK,
  SCRAPTF_WINDOW_RISK_PILL,
  SCRAPTF_WINDOW_RISK_TEXT,
  SCRAPTF_WINDOW_RISK_TIP,
  scraptfLinksInWindow,
  scraptfWindowOn,
  showFlipsView,
  windowAckText,
  windowEnableView,
  windowNoticeText,
  windowOpenFailedText,
  windowOpenTitle,
  windowRefusalText,
} from '../../src/renderer/scraptfWindowModel';

const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;

function settings(patch: Parameters<typeof applySettingsPatch>[1] = {}): Settings {
  return applySettingsPatch(DEFAULT_SETTINGS, patch);
}
const IMPORT_ON = { import: { enabled: true, acknowledgedAt: T0 } } as const;

describe('the risk, in scrap.tf\'s own words', () => {
  it('quotes the ToS verbatim, says the staff stance, that scrap.tf can see the app, and a ban on both sites', () => {
    expect(SCRAPTF_TOS_WORDS).toBe('automation, scripts, user-scripts, auto-refreshers, external tools');
    expect(SCRAPTF_WINDOW_RISK[0]).toBe(`scrap.tf's Terms of Service forbid gaining an advantage through "${SCRAPTF_TOS_WORDS}".`);
    expect(SCRAPTF_WINDOW_RISK_TEXT).toContain('staff have ruled scripts out on its banking pages');
    expect(SCRAPTF_WINDOW_RISK_TEXT).toContain('user agent names this app and Electron');
    expect(SCRAPTF_WINDOW_RISK_TEXT).toMatch(/ban your account[^.]*backpack\.tf account may be banned too: both sites have the same owner\./);
    expect(SCRAPTF_WINDOW_RISK_TEXT).toContain('Whether to use it is your decision.');
    expect(SCRAPTF_WINDOW_RISK_TEXT).toBe(SCRAPTF_WINDOW_RISK.join(' '));
    // The toolbar's pill and its one-line tooltip.
    expect(SCRAPTF_WINDOW_RISK_PILL).toBe('External-tool risk');
    expect(SCRAPTF_WINDOW_RISK_TIP).toBe(
      'scrap.tf\'s terms forbid "external tools" used for an advantage, and scrap.tf can see this window. Browsing it here can get your account banned, on backpack.tf too.',
    );
    expect(SCRAPTF_WINDOW_ACK_TEXT).toMatch(/ban my scrap\.tf account, and possibly my backpack\.tf account, and I accept that risk\.$/);
  });

  it('says plainly what the window does and never does', () => {
    const does = SCRAPTF_WINDOW_DOES.join(' ');
    expect(does).toContain('browse it yourself');
    expect(does).toContain(`once more ${READ_SETTLE_MS / 1000} seconds later`);
    expect(does).toContain('A read sends nothing over the network.');
    const never = SCRAPTF_WINDOW_NEVER.join(' ');
    for (const w of ['poll scrap.tf on its own', '/ajax', 'socket', 'Every page load is your click', 'Click, type, scroll', 'buy, queue or trade', 'cookies', 'user agent', 'Cloudflare check']) {
      expect(never, w).toContain(w);
    }
  });

  it('promises nothing main does not do: no encryption claim for a kept sign-in, and the 30 s gap between reads of a page', () => {
    // The installed app encrypts the cookie store (a fuse), a development run does not: the hint claims neither.
    expect(SCRAPTF_WINDOW_KEEP_HINT).not.toMatch(/encrypt/i);
    expect(SCRAPTF_WINDOW_KEEP_HINT).toContain('in memory only');
    expect(SCRAPTF_WINDOW_KEEP_HINT).toContain('Log out & clear');
    expect(SCRAPTF_WINDOW_KEEP_HINT).toContain('Flip Desk never reads either.');
    expect(SCRAPTF_WINDOW_READ_HINT).toContain(`once more ${READ_SETTLE_MS / 1000} s later`);
    expect(SCRAPTF_WINDOW_READ_HINT).toContain(`within ${READ_AUTO_MIN_GAP_MS / 1000} s is not read again`);
  });

  it("matches the build on the kept sign-in's encryption: the fuse is on, and code and docs say what it covers", () => {
    const root = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
    // One-way and on from the first release: packaged builds encrypt every on-disk cookie store, persist:scraptf too.
    expect(root('electron-builder.yml').replace(/\r\n/g, '\n')).toMatch(/^electronFuses:\n(?: {2}\w+: \w+\n)*? {2}enableCookieEncryption: true$/m);
    const arch = root('docs/ARCHITECTURE.md');
    expect(arch).not.toContain("Electron's cookie encryption is not turned on");
    expect(arch).toContain('encrypted with Windows DPAPI in packaged builds by the `enableCookieEncryption` fuse');
    expect(arch).toContain('an unpackaged development run has no fuses and stores it in plain text');
    const model = root('src/renderer/scraptfWindowModel.ts');
    expect(model).not.toContain('and this app sets none');
    expect(model).toContain('the enableCookieEncryption fuse in electron-builder.yml');
  });

  it("says the same in the README, ARCHITECTURE's R3 and the About page: nothing of the app's runs in a website but the window's one read", () => {
    const root = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
    const readme = root('README.md');
    expect(readme).not.toContain('Nothing is injected into any website.');
    expect(readme).toContain('The one exception is the opt-in scrap.tf window, which runs one read-only snapshot script on the scrap.tf pages shown in it.');
    const r3 = root('docs/ARCHITECTURE.md').split('\n').find((l) => l.startsWith('| R3 |'))!;
    expect(r3).toContain("nothing of the app's runs in another site's page except F21's `READ_SCRIPT`");
    // A read follows the page's own reloads and replaceState too, which the app cannot tell from a click.
    expect(r3).not.toContain('only after a load the user made');
    expect(r3).toContain("what the page's own scripts do");
    // 0.7.1 (F21-3, F21-4): only pages the import reads, and a check or error page is read only on Read page now.
    expect(r3).not.toContain('a check page served at a scrap.tf address is read and imports nothing');
    expect(r3).toContain('`scraptfImportablePath`');
    expect(r3).toContain(
      "Cloudflare's challenge frame are never read; a check or error page served at a scrap.tf address (HTTP 403, 429 or 503), and Chromium's error page after a failed load, is not read when it loads, only on Read page now, and imports nothing",
    );
    const about = root('src/renderer/pages/AboutPage.tsx');
    expect(about).not.toContain('injecting anything into websites.');
    expect(about).toContain("nothing of the app's runs in any website, with one exception: the opt-in scrap.tf window.");
  });

  it('says a read follows the page as well as the user, only on pages it imports, and never on load of a check page', () => {
    // Main cannot tell the user's click from scrap.tf's own reload or replaceState: both start a read.
    expect(SCRAPTF_WINDOW_READ_HINT).toContain('whether it comes from your click or from the page itself');
    expect(SCRAPTF_WINDOW_READ_HINT).not.toContain('each scrap.tf page you open');
    // 0.7.1 (F21-3, F21-4): a challenge, error or rate-limit page is not read on load, nor a page nothing imports from.
    expect(SCRAPTF_WINDOW_READ_HINT).toContain("Cloudflare's check frame are never read; a check or error page shown at a scrap.tf address is not read when it loads, and imports nothing if you read it.");
    expect(SCRAPTF_WINDOW_READ_HINT).toContain('Only pages Flip Desk imports are read: the bank pages, the unusual pages and scrap.tf/items, not the front page, raffles or settings.');
    expect(SCRAPTF_WINDOW_READ_HINT).not.toContain('is read but imports nothing');
    expect(SCRAPTF_WINDOW_READ_HINT).toContain('sends nothing');
    expect(SCRAPTF_WINDOW_DOES.join(' ')).not.toContain('scrap.tf page you opened');
    expect(SCRAPTF_WINDOW_DOES[1]).toMatch(/^When a scrap\.tf page Flip Desk imports \(a bank page, the unusual pages, scrap\.tf\/items\) finishes loading/);
  });

  it("names exactly the opens that use the window, and keeps every other link in the browser", () => {
    // 0.7.1 (F21-9): the Bank stock page's Open follows the setting too.
    expect(SCRAPTF_WINDOW_LINKS_HINT).toContain(
      "The Live market's scrap.tf button and bank link, Open on scrap.tf in the item drawer and the row menu, the scrap.tf banks cards and the Bank stock page's Open open their scrap.tf page here",
    );
    expect(SCRAPTF_WINDOW_LINKS_HINT).toMatch(/Every other link still opens in your browser\.$/);
    expect(SCRAPTF_WINDOW_LINKS_HINT).not.toContain('the Bank stock page and the scrap.tf/items card included');
  });

  it('says a "Stay signed in" change waits for the window to be reopened (F21-6)', () => {
    expect(SCRAPTF_WINDOW_KEEP_HINT).toMatch(/A change applies once you close the scrap\.tf window and open it again; you sign in to scrap\.tf again then\.$/);
    expect(SCRAPTF_WINDOW_KEEP_HINT).not.toContain('the next time the window opens');
    expect(SCRAPTF_WINDOW_PARTITION_NOTE).toBe('Stay signed in changes when you close and reopen this window; you will sign in to scrap.tf again then.');
  });
});

describe('settings', () => {
  it('reads the window on and the links switch only while it is on (older settings: off)', () => {
    expect(scraptfWindowOn(null)).toBe(false);
    expect(scraptfWindowOn({} as Partial<Settings>)).toBe(false);
    expect(scraptfWindowOn(DEFAULT_SETTINGS)).toBe(false);
    const on = settings({ ...IMPORT_ON, scraptfWindow: { enabled: true, acknowledgedAt: T0 } });
    expect(scraptfWindowOn(on)).toBe(true);
    expect(scraptfLinksInWindow(on)).toBe(false);
    const links = settings({ ...IMPORT_ON, scraptfWindow: { enabled: true, acknowledgedAt: T0, openLinksInWindow: true } });
    expect(scraptfLinksInWindow(links)).toBe(true);
    // The switch saved while the window is off sends nothing anywhere.
    expect(scraptfLinksInWindow(settings({ scraptfWindow: { openLinksInWindow: true } }))).toBe(false);
    expect(bankWindowView(DEFAULT_SETTINGS)).toBeNull();
    expect(bankWindowView(links)).toEqual({ linksHere: true, readOnLoad: true });
    expect(bankWindowView(settings({ ...IMPORT_ON, scraptfWindow: { enabled: true, acknowledgedAt: T0, readOnLoad: false } }))).toEqual({ linksHere: false, readOnLoad: false });
  });

  it('keeps the switch disabled until import is on and the box is ticked, as main refuses it', () => {
    const off = windowEnableView(DEFAULT_SETTINGS);
    expect(off).toMatchObject({ blocker: 'import', disabled: true });
    expect(off.hint).toMatch(/^Turn on saved-page import first/);
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { scraptfWindow: { enabled: true, acknowledgedAt: T0 } })).toThrow(SCRAPTF_WINDOW_NEEDS_IMPORT);

    const noAck = windowEnableView(settings(IMPORT_ON));
    expect(noAck).toMatchObject({ blocker: 'ack', disabled: true, hint: 'Tick the acknowledgement above first.' });
    expect(() => applySettingsPatch(settings(IMPORT_ON), { scraptfWindow: { enabled: true } })).toThrow(SCRAPTF_WINDOW_NEEDS_ACK);

    const ready = settings({ ...IMPORT_ON, scraptfWindow: { acknowledgedAt: T0 } });
    expect(windowEnableView(ready)).toMatchObject({ blocker: null, disabled: false });
    // What the switch allows, main allows.
    expect(applySettingsPatch(ready, { scraptfWindow: { enabled: true } }).scraptfWindow.enabled).toBe(true);
    const on = windowEnableView(applySettingsPatch(ready, { scraptfWindow: { enabled: true } }));
    expect(on).toMatchObject({ blocker: null, disabled: false });
    expect(on.hint).toMatch(/^On\. Open it from "scrap\.tf window" in the menu/);
  });

  it("words main's refusal as a sentence, and the acknowledgement's date", () => {
    expect(windowRefusalText(`Invalid settings: ${SCRAPTF_WINDOW_NEEDS_IMPORT}`)).toBe('The scrap.tf window needs saved-page import turned on, with its acknowledgement, first.');
    expect(windowRefusalText(`Invalid settings: ${SCRAPTF_WINDOW_NEEDS_ACK}`)).toBe('Tick the scrap.tf window risk acknowledgement first.');
    expect(windowRefusalText('Timed out.')).toBe('Timed out.');
    expect(windowRefusalText('  ')).toBe('The scrap.tf window could not be turned on.');
    expect(windowAckText(null)).toBeNull();
    expect(windowAckText(T0)).toMatch(/^You accepted this on .+\. Unticking it turns the window off\.$/);
  });
});

describe('the toolbar', () => {
  it('takes Alt+Left, Alt+Right, F5 / Ctrl+R and Alt+Home, nothing else', () => {
    const k = (key: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => barShortcut({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(k('ArrowLeft', { altKey: true })).toBe('back');
    expect(k('ArrowRight', { altKey: true })).toBe('forward');
    expect(k('F5')).toBe('reload');
    expect(k('r', { ctrlKey: true })).toBe('reload');
    expect(k('R', { ctrlKey: true })).toBe('reload');
    expect(k('Home', { altKey: true })).toBe('home');
    for (const none of [k('ArrowLeft'), k('Home'), k('F5', { shiftKey: true }), k('r'), k('r', { ctrlKey: true, altKey: true }), k('ArrowLeft', { altKey: true, metaKey: true }), k('Enter')]) expect(none).toBeNull();
    expect(BAR_SHORTCUTS.back).toEqual({ aria: 'Alt+ArrowLeft', text: 'Alt+Left' });
    expect(BAR_SHORTCUTS.reload.aria).toBe('F5 Control+R');
  });

  it('moves between its controls with the arrows (wrapping), Home and End', () => {
    expect(barFocusMove(0, 'ArrowRight', 5)).toBe(1);
    expect(barFocusMove(4, 'ArrowRight', 5)).toBe(0);
    expect(barFocusMove(0, 'ArrowLeft', 5)).toBe(4);
    expect(barFocusMove(3, 'Home', 5)).toBe(0);
    expect(barFocusMove(1, 'End', 5)).toBe(4);
    expect(barFocusMove(4, 'End', 5)).toBeNull();
    expect(barFocusMove(0, 'ArrowDown', 5)).toBeNull();
    expect(barFocusMove(0, 'ArrowRight', 0)).toBeNull();
    expect(barFocusMove(0, 'ArrowRight', 1)).toBeNull();
  });

  it('has one chip per SCRAPTF_BANKS page, each a static start page the window opens', () => {
    const chips = barBankChips();
    expect(chips.map((c) => c.label)).toEqual(['Hats', 'Weapons', 'Stranges', 'Killstreaks', 'Skins', 'Items', 'Unusuals', 'All items']);
    expect(chips.map((c) => c.url)).toEqual(SCRAPTF_BANKS.map((b) => b.url));
    for (const c of chips) expect(isAllowedWindowStart(c.url), c.url).toBe(true);
    expect(chips[0]!.title).toBe('Go to scrap.tf/buy/hats');
    expect(activeBankOf(HATS)).toBe('hats');
    expect(activeBankOf('https://scrap.tf/items')).toBe('list');
    expect(activeBankOf('https://scrap.tf/')).toBeNull();
    expect(activeBankOf(`${HATS}/2`)).toBeNull();
    expect(activeBankOf(null)).toBeNull();
  });

  it('shows the address as text, and says which pages are never read', () => {
    expect(addressView(null)).toEqual({ text: '', title: 'No page open yet', kind: 'none' });
    expect(addressView(HATS)).toEqual({ text: 'scrap.tf/buy/hats', title: HATS, kind: 'scraptf' });
    expect(addressView('https://scrap.tf/')).toMatchObject({ text: 'scrap.tf', kind: 'scraptf' });
    expect(addressView('https://steamcommunity.com/openid/login')).toMatchObject({ text: 'steamcommunity.com/openid/login', kind: 'steam' });
    expect(addressView('https://steamcommunity.com/openid/login').title).toContain('Flip Desk never reads this page');
    expect(addressView('https://challenges.cloudflare.com/x').kind).toBe('other');
  });

  it('enables Read page now on scrap.tf pages only, and not twice at once', () => {
    expect(readButtonView(HATS, false)).toMatchObject({ disabled: false, label: 'Read page now' });
    expect(readButtonView(HATS, false).title).toContain('Nothing is sent over the network.');
    expect(readButtonView(HATS, true)).toMatchObject({ disabled: true, label: 'Reading…' });
    expect(readButtonView(null, false)).toMatchObject({ disabled: true, title: 'Open a scrap.tf page first.' });
    expect(readButtonView('https://steamcommunity.com/login/home', false)).toMatchObject({ disabled: true, title: SCRAPTF_READ_REASONS.notScraptf });
  });

  it('says what was read, how many new flips, any warning in window words, and how long ago', () => {
    const read: ScraptfWindowRead = { at: T0 - 3_000, path: '/buy/hats', items: 48, bank: 'hats', newFlips: 2, warning: null };
    expect(readStatusText(read, T0)).toBe('Read 48 items from /buy/hats · 2 new flips · just now');
    expect(readStatusText({ ...read, at: T0 - 42_000 }, T0)).toBe('Read 48 items from /buy/hats · 2 new flips · 42 s ago');
    const v = readStatusView(read, T0);
    expect(v).toMatchObject({ main: 'Read 48 items from /buy/hats · 2 new flips', age: 'just now', tone: 'good' });
    expect(v.title).toMatch(/48 items on scrap\.tf\/buy\/hats \(Hats\), imported like a saved page\. 2 of them new since your previous save and a flip now\.$/);
    expect(readStatusText({ ...read, items: 1, newFlips: 1 }, T0)).toBe('Read 1 item from /buy/hats · 1 new flip · just now');
    expect(readStatusView({ ...read, newFlips: 0 }, T0).tone).toBeNull();
    // A read stamped a little ahead of this clock is "just now".
    expect(readStatusView({ ...read, at: T0 + 30_000 }, T0).age).toBe('just now');
    // Warnings: the import's codes in window words; a fixed reason or any other text as sent, clipped.
    const warned = readStatusView({ ...read, items: 0, newFlips: 0, warning: 'no-cards-saved' }, T0);
    expect(warned).toMatchObject({ main: 'Read 0 items from /buy/hats · no items on screen yet; wait for them, then Read page now', tone: 'warn' });
    expect(readWarningText('no-cards-saved: This page was saved without its items.')).toBe('no items on screen yet; wait for them, then Read page now');
    expect(readWarningText('page-kind-unknown')).toBe('not a page Flip Desk imports');
    expect(readWarningText(SCRAPTF_READ_REASONS.empty)).toBe(SCRAPTF_READ_REASONS.empty);
    expect(readWarningText('x'.repeat(300))!.length).toBeLessThanOrEqual(140);
    expect(readWarningText('')).toBeNull();
    expect(readWarningText(null)).toBeNull();
    // A sentence main sent ("Nothing to import on this page.") loses its full stop in the line, and the
    // tooltip ends with one, not two.
    const nothing = readStatusView({ ...read, path: '/', items: 0, newFlips: 0, bank: null, warning: 'Nothing to import on this page.' }, T0);
    expect(nothing.main).toBe('Read 0 items from / · Nothing to import on this page');
    expect(nothing.title).toMatch(/Note: Nothing to import on this page\.$/);
    // Main's failed reads (failedRead: the script failed, or the page gave nothing) read nothing: no "Read 0 items".
    const failed = readStatusView({ ...read, items: 0, newFlips: 0, bank: null, warning: SCRAPTF_READ_REASONS.failed }, T0);
    expect(failed).toMatchObject({ main: 'Could not read /buy/hats · try Read page now again', age: 'just now', tone: 'warn' });
    expect(failed.title).toContain(`${SCRAPTF_READ_REASONS.failed} Nothing was imported from scrap.tf/buy/hats.`);
    expect(readStatusText({ ...read, items: 0, newFlips: 0, bank: null, warning: SCRAPTF_READ_REASONS.empty }, T0)).toBe(
      'Could not read /buy/hats · nothing to read yet (still loading, or over the 20 MB limit) · just now',
    );
    // Lookups are own keys only: a warning naming an Object.prototype member is plain text.
    expect(readStatusView({ ...read, warning: 'toString' }, T0).main).toBe('Read 48 items from /buy/hats · 2 new flips · toString');
    // Nothing read yet: the hint follows readOnLoad.
    expect(readStatusView(null, T0)).toMatchObject({ main: 'Not read yet', age: '', tone: 'muted' });
    expect(readStatusView(null, T0).title).toBe('scrap.tf pages are read when they finish loading in the window.');
    expect(readStatusView(null, T0, false).title).toMatch(/^Reading on load is off: press Read page now/);
    expect(readStatusText(null, T0)).toBe('Not read yet');
  });

  it('0.7.4 (F53): says a bank page left before it settled stored prices but no stock save', () => {
    const read: ScraptfWindowRead = { at: T0 - 3_000, path: '/buy/hats', items: 48, bank: 'hats', newFlips: 0, warning: null, stored: 48, stockSave: 'unsettled' };
    const v = readStatusView(read, T0);
    expect(v.main).toBe('Read 48 items from /buy/hats · no stock save');
    expect(v.title).toContain('Prices stored, but no stock save: the page was left before it finished loading');
    expect(v.title).toContain('press Read page now.');
    // A whole save, an older service (absent) and a page with no bank say nothing of it.
    for (const r of [{ ...read, stockSave: 'written' as const }, { ...read, stockSave: undefined }, { ...read, bank: null }]) {
      expect(readStatusView(r, T0).main).toBe('Read 48 items from /buy/hats');
      expect(readStatusView(r, T0).title).not.toContain('no stock save');
    }
  });
});

describe('the toolbar, 0.7.1 (UX-3, ACT-5, F21-2, F21-3, F21-4, F21-10)', () => {
  const read: ScraptfWindowRead = { at: T0 - 3_000, path: '/buy/hats', items: 48, bank: 'hats', newFlips: 2, warning: null };

  it('says how many prices it stored, the flips on the page and the best one', () => {
    const full: ScraptfWindowRead = { ...read, stored: 46, pageFlips: 10, bestFlip: { sku: '378;6', name: 'Team Captain', profitScrap: 4 } };
    expect(readStatusText(full, T0)).toBe('Read 48 items from /buy/hats · stored 46 · 10 flips (2 new) · best Team Captain +0.44 ref · just now');
    const v = readStatusView(full, T0);
    expect(v).toMatchObject({ tone: 'good', lead: 'Read 48 items from /buy/hats · stored 46 · 10 flips (2 new)', best: { sku: '378;6', name: 'Team Captain', profit: '+0.44 ref' }, tail: '' });
    expect(`${v.lead} · best ${v.best!.name} ${v.best!.profit}${v.tail}`).toBe(v.main);
    expect(v.title).toContain('46 stored as prices. 10 flips on sale on this page now, 2 of them new since your previous save. Best: Team Captain, +0.44 ref profit.');
    expect(bestFlipTitle(v.best!)).toBe("Opens Team Captain in the dashboard (+0.44 ref profit at scrap.tf's price on this page).");
    // Every price stored: no "stored" part (the tooltip still says it); one flip, none new; no best.
    expect(readStatusText({ ...read, newFlips: 0, stored: 48, pageFlips: 1, bestFlip: null }, T0)).toBe('Read 48 items from /buy/hats · 1 flip · just now');
    expect(readStatusView({ ...read, newFlips: 0, stored: 48, pageFlips: 1 }, T0).title).toContain('48 stored as prices. 1 flip on sale on this page now.');
    // None stored (a newer save had them all) is said; flips on the page that main does not report: as before.
    expect(readStatusText({ ...read, stored: 0 }, T0)).toBe('Read 48 items from /buy/hats · stored 0 · 2 new flips · just now');
    expect(readStatusText({ ...read, newFlips: 0, pageFlips: 0, bestFlip: null }, T0)).toBe('Read 48 items from /buy/hats · just now');
    expect(readStatusView({ ...read, newFlips: 0, pageFlips: 0 }, T0).tone).toBeNull();
    // A warning goes after the best flip, and colours the line.
    const warned = readStatusView({ ...full, warning: 'no-sku: 3 48' }, T0);
    expect(warned.main).toBe('Read 48 items from /buy/hats · stored 46 · 10 flips (2 new) · best Team Captain +0.44 ref · 3 of 48 items not recognised');
    expect(warned).toMatchObject({ tone: 'warn', tail: ' · 3 of 48 items not recognised' });
  });

  it('0.8 (G2): says how many flips this read dropped under Pay up to, and nothing new without them', () => {
    const full: ScraptfWindowRead = { ...read, stored: 46, pageFlips: 10, droppedFlips: 1 };
    expect(readStatusView(full, T0).lead).toBe('Read 48 items from /buy/hats · stored 46 · 10 flips (2 new, 1 cheaper)');
    expect(readStatusView(full, T0).title).toContain('10 flips on sale on this page now, 2 of them new since your previous save. 1 of them dropped under your Pay up to on this read.');
    expect(readStatusView({ ...full, newFlips: 0 }, T0).lead).toBe('Read 48 items from /buy/hats · stored 46 · 10 flips (1 cheaper)');
    // The page counts at least the flips the read told of.
    expect(readStatusView({ ...full, newFlips: 0, pageFlips: 0, droppedFlips: 3 }, T0)).toMatchObject({ lead: 'Read 48 items from /buy/hats · stored 46 · 3 flips (3 cheaper)', tone: 'good' });
    // An older main (no pageFlips) still names them.
    expect(readStatusView({ ...read, droppedFlips: 1 }, T0).lead).toBe('Read 48 items from /buy/hats · 2 new, 1 cheaper flips');
    expect(readStatusView({ ...read, newFlips: 0, droppedFlips: 1 }, T0).lead).toBe('Read 48 items from /buy/hats · 1 cheaper flip');
    // Zero, absent or junk: the words of 0.7.4.
    for (const droppedFlips of [0, undefined, Number.NaN, -2]) {
      const r = { ...read, stored: 46, pageFlips: 10, ...(droppedFlips !== undefined ? { droppedFlips } : {}) };
      expect(readStatusView(r, T0).lead).toBe('Read 48 items from /buy/hats · stored 46 · 10 flips (2 new)');
      expect(readStatusView(r, T0).title).not.toContain('dropped under');
    }
  });

  it('offers Show flips once a read found flips on a bank page, always on the Flips chip', () => {
    expect(showFlipsView(null)).toBeNull();
    expect(showFlipsView({ ...read, newFlips: 0 })).toBeNull();
    expect(showFlipsView({ ...read, newFlips: 0, pageFlips: 0 })).toBeNull();
    expect(showFlipsView({ ...read, bank: null, pageFlips: 10 })).toBeNull();
    // UX-071-2: new flips too land on Flips, which lists every flip on sale with its New badge. The New chip
    // counts new since the session's baseline and holds non-flips, so it could hold none of the 2 counted.
    expect(showFlipsView({ ...read, pageFlips: 10 })).toEqual({
      bank: 'hats',
      filter: 'flips',
      label: 'Show flips',
      title: "Shows Hats in the dashboard's Bank stock, on Flips: 10 flips on sale on this page (2 new since your previous read). Nothing is loaded in this window.",
    });
    expect(showFlipsView({ ...read, newFlips: 0, pageFlips: 10 })).toMatchObject({ bank: 'hats', filter: 'flips' });
    expect(showFlipsView({ ...read, newFlips: 0, pageFlips: 1 })!.title).toContain('on Flips: 1 flip on sale on this page.');
    // An older main (no pageFlips) with new flips still offers it, counting those.
    expect(showFlipsView(read)).toMatchObject({ filter: 'flips' });
    expect(showFlipsView(read)!.title).toContain('on Flips: 2 flips on sale on this page (2 new since your previous read).');
    expect(showFlipsView({ ...read, bank: 'list', newFlips: 0, pageFlips: 3 })).toMatchObject({ bank: 'list', filter: 'flips' });
  });

  it('words the import codes main picks for a page on screen, with their counts as digits only', () => {
    expect(readWarningText('partial-read: 3 48')).toBe('only 3 of ~48 items were on screen, so no stock save: Read page now once every card shows');
    expect(readWarningText('partial-read')).toBe('only part of the page was on screen, so no stock save: Read page now once every card shows');
    expect(readWarningText('layout-changed')).toBe("scrap.tf changed this page's layout: its items could not be read");
    expect(readWarningText('no-stock-limit: 5')).toBe('stock unreadable for 5 rows, so no stock save');
    expect(readWarningText('no-stock-limit: 1')).toBe('stock unreadable for 1 row, so no stock save');
    expect(readWarningText('no-sku: 2 48')).toBe('2 of 48 items not recognised');
    expect(readWarningText('no-sku: <b>x</b>')).toBe('some items not recognised');
    expect(readWarningText('no-price-column')).toBe('no "Price to buy" column found, so no prices were read');
    expect(readWarningText('unknown-bank')).toBe('not a scrap.tf bank page Flip Desk knows');
    expect(readWarningText('no-pays-column')).toBe('no "Price we pay" column found, so what scrap.tf pays was not read');
    // A page not read again within the gap: its last read, and how to read it again, without a warning tone.
    const again = readStatusView({ ...read, warning: SCRAPTF_NOT_READ_AGAIN }, T0);
    expect(again.main).toBe('Read 48 items from /buy/hats · 2 new flips · Read page now to read it again');
    expect(again.tone).toBe('good');
    expect(readStatusView({ ...read, newFlips: 0, warning: SCRAPTF_NOT_READ_AGAIN }, T0).tone).toBeNull();
  });

  it("says a read was refused while item data loads, and a challenge page's read that found nothing, as failed reads", () => {
    const failed = (warning: string) => ({ ...read, items: 0, newFlips: 0, bank: null, warning });
    expect(readStatusText(failed(SCRAPTF_READ_REASONS.schemaLoading), T0)).toBe('Could not read /buy/hats · item data is still loading; press Read page now in a moment · just now');
    expect(readStatusText({ ...failed(SCRAPTF_WINDOW_NOTICES.challenge), bank: 'hats' }, T0)).toBe(
      'Could not read /buy/hats · a Cloudflare check or error page is on screen: solve it in the page · just now',
    );
    expect(readStatusText(failed(SCRAPTF_WINDOW_NOTICES.rateLimited), T0)).toBe(
      'Could not read /buy/hats · scrap.tf is rate-limiting this window: wait a minute before reloading · just now',
    );
    expect(readStatusView(failed(SCRAPTF_READ_REASONS.schemaLoading), T0)).toMatchObject({ tone: 'warn', best: null });
    // Read page now on Chromium's error page after a failed load: worded by the load's notice, never "Read 0 items".
    expect(readStatusText({ ...failed(SCRAPTF_WINDOW_NOTICES.offline), bank: 'hats' }, T0)).toBe('Could not read /buy/hats · scrap.tf could not be reached: press Reload · just now');
    for (const n of [SCRAPTF_WINDOW_NOTICES.insecure, SCRAPTF_WINDOW_NOTICES.badResponse, SCRAPTF_WINDOW_NOTICES.loadFailed]) {
      expect(readStatusText(failed(n), T0)).toMatch(/^Could not read \/buy\/hats · .+: press Reload · just now$/);
    }
  });

  it('disables Read page now on a scrap.tf page the import cannot read, and shows main notices as sent', () => {
    expect(readButtonView('https://scrap.tf/raffles', false, false)).toEqual({
      disabled: true,
      label: 'Read page now',
      title: 'Nothing to import on this page. Flip Desk reads bank pages, the unusual pages and scrap.tf/items.',
    });
    expect(readButtonView(HATS, false, true).disabled).toBe(false);
    // An older main sends no importable: as before.
    expect(readButtonView('https://scrap.tf/raffles', false).disabled).toBe(false);
    expect(readButtonView('https://steamcommunity.com/login/home', false, false).title).toBe(SCRAPTF_READ_REASONS.notScraptf);
    expect(windowNoticeText(SCRAPTF_WINDOW_NOTICES.challenge)).toBe(SCRAPTF_WINDOW_NOTICES.challenge);
    expect(windowNoticeText('  ')).toBeNull();
    expect(windowNoticeText(null)).toBeNull();
    expect(windowNoticeText(undefined)).toBeNull();
    expect(windowNoticeText('x'.repeat(500))!.length).toBeLessThanOrEqual(200);
  });
});

describe('entry points and the Import page', () => {
  it("words the banks card's window button and a failed open", () => {
    expect(OPEN_IN_WINDOW_LABEL).toBe('Open in Flip Desk window');
    expect(windowOpenTitle('scrap.tf/buy/hats', true)).toMatch(/^Opens scrap\.tf\/buy\/hats in the Flip Desk window, where you browse it yourself\. The page is read when it finishes loading\. /);
    expect(windowOpenTitle('scrap.tf/buy/hats', false)).toContain('Press Read page now there to read it.');
    expect(windowOpenTitle('scrap.tf/buy/hats', true)).toContain(SCRAPTF_WINDOW_RISK_TIP);
    expect(windowOpenFailedText('The scrap.tf window is turned off.')).toBe('Could not open the scrap.tf window: The scrap.tf window is turned off.');
  });

  it('labels a window read "Flip Desk window" with its page; a file keeps its name', () => {
    expect(SCRAPTF_WINDOW_ORIGIN_LABEL).toBe('Flip Desk window');
    expect(importOriginView({ origin: 'window', fileName: 'scrap.tf window /buy/hats' })).toEqual({
      origin: 'Flip Desk window',
      file: 'scrap.tf/buy/hats',
      title: 'Read from the page on screen in the Flip Desk window (scrap.tf/buy/hats), not from a saved file.',
    });
    expect(importOriginView({ origin: 'window', fileName: 'scrap.tf window /' }).file).toBe('scrap.tf');
    // A name main did not make stays as sent (text only, never opened).
    expect(importOriginView({ origin: 'window', fileName: 'odd' }).file).toBe('odd');
    expect(importOriginView({ origin: 'file', fileName: 'Hats.html' })).toEqual({ origin: null, file: 'Hats.html', title: 'Hats.html' });
    expect(importOriginView({ origin: null, fileName: 'old.html' }).origin).toBeNull();
    expect(importOriginView({ fileName: 'older.html' }).origin).toBeNull();
  });

  it("words an empty bank read's remedy for the window, not as a save", () => {
    const fromWindow = importBankText('hats', 0, undefined, true)!;
    expect(fromWindow.text).toBe('Hats · scrap.tf/buy/hats · not counted');
    expect(fromWindow.title).toMatch(/press Read page now in the window once they show\.$/);
    expect(fromWindow.title).not.toContain('save it again');
    // A read whose cards were all read but skipped says why, as a save does.
    expect(importBankText('hats', 0, false, true)!.title).toMatch(/The skipped items say why\.$/);
    expect(importBankText('hats', 0, true, true)!.title).toMatch(/Read page now/);
    expect(importBankText(null, 0, undefined, true)!.title).toMatch(/^The page read in the Flip Desk window is not a scrap\.tf page this app knows/);
    // Saved files keep their F18 wording.
    expect(importBankText('hats', 0, true)!.title).toMatch(/Save it again as 'Webpage, Complete'\.$/);
    expect(importBankText('hats', 0)!.title).toMatch(/If it was saved before its items showed, save it again as/);
    expect(importBankText(null, 0)!.title).toMatch(/^The saved page's address did not name/);
  });
});
