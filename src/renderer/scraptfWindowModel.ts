// F21: pure helpers for the opt-in scrap.tf window on the renderer side: the toolbar page
// (pages/ScraptfWindowBar.tsx), Settings' "scrap.tf window (opt-in)" section, and the dashboard's
// entry points (the nav item, the banks cards, the Live market / drawer / menu wording, the Import
// page's origin label). Nothing here calls main or builds a URL: every page the window opens is a
// SCRAPTF_BANKS entry (or main's own Home), passed on a user's click only. The window is a page the
// user browses; Flip Desk itself never fetches scrap.tf (the HTTP layer still refuses it, R1).

import { bankStockPagePath } from '../shared/bankStock';
import { LAYOUT_CHANGED, NO_PRICE_COLUMN, NO_STOCK_LIMIT, PARTIAL_READ, UNUSUALS_INDEX } from '../shared/importCodes';
import { SCRAPTF_BANKS } from '../shared/links';
import {
  READ_AUTO_MIN_GAP_MS,
  READ_SETTLE_MS,
  SCRAPTF_NOT_READ_AGAIN,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_NOTICES,
  scraptfWindowEnableProblem,
  SCRAPTF_WINDOW_NEEDS_IMPORT,
  shouldReadUrl,
} from '../shared/scraptfWindowPolicy';
import type { BankStockOpenFilter, ImportOrigin, ScraptfBank, ScraptfWindowNav, ScraptfWindowRead, Settings, UnixMs } from '../shared/types';
import { fmtAgo, fmtDateTime, fmtInt, fmtRefOnly, truncate } from './format';
import { importWarningCode } from './importModel';

// ---------------------------------------------------------------------------
// Words (one place, so the toolbar, Settings and the tests say the same thing)
// ---------------------------------------------------------------------------

/** The nav item, the Settings heading's short form and the tray's subject. */
export const SCRAPTF_WINDOW_NAV_LABEL = 'scrap.tf window';
export const SCRAPTF_WINDOW_NAV_TITLE = 'Opens the scrap.tf window, or brings it to the front. You browse scrap.tf there yourself.';
/** How the Import page names a batch read through the window (ImportBatch.origin 'window'). */
export const SCRAPTF_WINDOW_ORIGIN_LABEL = 'Flip Desk window';
/** The banks cards' button. */
export const OPEN_IN_WINDOW_LABEL = 'Open in Flip Desk window';
/** scrap.tf's Terms of Service, word for word: what they forbid for an advantage. */
export const SCRAPTF_TOS_WORDS = 'automation, scripts, user-scripts, auto-refreshers, external tools';
/** The toolbar's always-visible pill. */
export const SCRAPTF_WINDOW_RISK_PILL = 'External-tool risk';
/** The pill's one-line tooltip. */
export const SCRAPTF_WINDOW_RISK_TIP =
  'scrap.tf\'s terms forbid "external tools" used for an advantage, and scrap.tf can see this window. Browsing it here can get your account banned, on backpack.tf too.';

/** Settings' risk text, sentence by sentence: the ToS words, the staff stance, what scrap.tf sees, the ban. */
export const SCRAPTF_WINDOW_RISK: readonly string[] = Object.freeze([
  `scrap.tf's Terms of Service forbid gaining an advantage through "${SCRAPTF_TOS_WORDS}".`,
  'scrap.tf staff have ruled scripts out on its banking pages.',
  "This window's user agent names this app and Electron, so scrap.tf can tell what you browse it with.",
  'scrap.tf may ban your account for using it, and your backpack.tf account may be banned too: both sites have the same owner.',
  'Flip Desk works fully without it (pages you save, prices you type). Whether to use it is your decision.',
]);
export const SCRAPTF_WINDOW_RISK_TEXT = SCRAPTF_WINDOW_RISK.join(' ');

/** What the window does: plain words, no promise beyond what main does. */
export const SCRAPTF_WINDOW_DOES: readonly string[] = Object.freeze([
  'Shows scrap.tf in a window of its own. You click, sign in through Steam and browse it yourself, and you solve any Cloudflare check yourself.',
  `When a scrap.tf page Flip Desk imports (a bank page, the unusual pages, scrap.tf/items) finishes loading in the window (from your click, or one the page makes itself), it reads the page already on screen, and once more ${READ_SETTLE_MS / 1000} seconds later because scrap.tf adds its cards late; the two are imported as one save. Or only when you press Read page now. A read sends nothing over the network.`,
  'Imports what it read like a page you saved with Ctrl+S: prices, bank stock, history and new-flip notifications.',
]);

/** What it never does (main and the compliance scan hold it to this). */
export const SCRAPTF_WINDOW_NEVER: readonly string[] = Object.freeze([
  'Load, reload or poll scrap.tf on its own, or call its /ajax pages or its socket. Every page load is your click.',
  'Click, type, scroll or change anything in the page, or buy, queue or trade for you.',
  'Read, export or reuse your cookies or sign-in, change its user agent, or get past a Cloudflare check for you.',
]);

/** The acknowledgement the user ticks (settings.scraptfWindow.acknowledgedAt). */
export const SCRAPTF_WINDOW_ACK_TEXT =
  'I have read this. I understand scrap.tf may treat this window as an external tool and ban my scrap.tf account, and possibly my backpack.tf account, and I accept that risk.';

export const SCRAPTF_WINDOW_ENABLE_LABEL = 'Turn on the scrap.tf window';
export const SCRAPTF_WINDOW_KEEP_LABEL = 'Stay signed in after Flip Desk quits';
// No claim either way here: the installed app encrypts the window's on-disk cookie store with Windows' own
// encryption (the enableCookieEncryption fuse in electron-builder.yml), a development run does not. Log out &
// clear is the way to remove a kept sign-in.
export const SCRAPTF_WINDOW_KEEP_HINT =
  "Off: the window keeps your sign-in in memory only, gone when Flip Desk quits. On: it is kept on this computer in the window's own browser storage, the way a browser keeps it, until you use Log out & clear. Flip Desk never reads either. A change applies once you close the scrap.tf window and open it again; you sign in to scrap.tf again then.";
/** 0.7.1 (F21-6): the toolbar's note while a "Stay signed in" change waits for the window to be reopened. */
export const SCRAPTF_WINDOW_PARTITION_NOTE = 'Stay signed in changes when you close and reopen this window; you will sign in to scrap.tf again then.';
export const SCRAPTF_WINDOW_PARTITION_PILL = 'Reopen to apply';
export const SCRAPTF_WINDOW_READ_LABEL = 'Read scrap.tf pages as they load';
export const SCRAPTF_WINDOW_READ_HINT = `On: a read follows each scrap.tf page load or in-page navigation in the window, whether it comes from your click or from the page itself (a reload, a page switch it makes), when the page finishes loading and once more ${READ_SETTLE_MS / 1000} s later, imported once. Only pages Flip Desk imports are read: the bank pages, the unusual pages and scrap.tf/items, not the front page, raffles or settings. A page loaded again within ${READ_AUTO_MIN_GAP_MS / 1000} s is not read again, unless nothing could be imported from it then (a Cloudflare check you had to solve, say), and an unchanged page is not imported twice within a minute. A read is a snapshot of the page on screen and sends nothing. Off: only when you press Read page now. Steam sign-in and Cloudflare's check frame are never read; a check or error page shown at a scrap.tf address is not read when it loads, and imports nothing if you read it.`;
export const SCRAPTF_WINDOW_LINKS_LABEL = "Open Flip Desk's scrap.tf links in this window";
export const SCRAPTF_WINDOW_LINKS_HINT =
  "The Live market's scrap.tf button and bank link, Open on scrap.tf in the item drawer and the row menu, the scrap.tf banks cards and the Bank stock page's Open open their scrap.tf page here instead of your browser. Every other link still opens in your browser.";
export const SCRAPTF_WINDOW_CLEAR_TITLE =
  "Signs you out in the scrap.tf window: clears its cookies, site storage and cache, then shows scrap.tf's front page if the window is open. Your Flip Desk data is not touched.";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type WindowSettings = Pick<Settings, 'scraptfWindow'>;

/** The window is on (settings from before 0.7 have no group: off). */
export function scraptfWindowOn(s: Partial<WindowSettings> | null | undefined): boolean {
  return s?.scraptfWindow?.enabled === true;
}

/**
 * Flip Desk's static scrap.tf links open in the window (main routes links.open so, only while the window
 * is on): the wording of the market, drawer, menu and banks opens follows it.
 */
export function scraptfLinksInWindow(s: Partial<WindowSettings> | null | undefined): boolean {
  return scraptfWindowOn(s) && s?.scraptfWindow?.openLinksInWindow === true;
}

export interface WindowEnableView {
  /** What keeps the switch from turning on: saved-page import, or the risk acknowledgement; null when nothing. */
  blocker: 'import' | 'ack' | null;
  /** The switch is disabled: off with a blocker (turning it off always works). */
  disabled: boolean;
  /** The switch's description. */
  hint: string;
}

/** The enable switch, from the same rule as main's setter (scraptfWindowEnableProblem). */
export function windowEnableView(s: Pick<Settings, 'import' | 'scraptfWindow'>): WindowEnableView {
  const problem = scraptfWindowEnableProblem(s);
  const blocker = problem === null ? null : problem === SCRAPTF_WINDOW_NEEDS_IMPORT ? 'import' : 'ack';
  const on = s.scraptfWindow.enabled;
  const hint = on
    ? `On. Open it from "${SCRAPTF_WINDOW_NAV_LABEL}" in the menu, a scrap.tf banks card or the button below.`
    : blocker === 'import'
      ? 'Turn on saved-page import first, with its acknowledgement, on the Import page: the window imports what it reads the same way.'
      : blocker === 'ack'
        ? 'Tick the acknowledgement above first.'
        : 'Off. Nothing opens until you turn it on.';
  return { blocker, disabled: !on && blocker !== null, hint };
}

/** The setter's refusal as a sentence: "Invalid settings: scraptfWindow.enabled: tick …" reads "Tick …". */
export function windowRefusalText(message: string): string {
  const m = message
    .trim()
    .replace(/^Invalid settings:\s*/i, '')
    .replace(/^scraptfWindow\.\w+:\s*/, '')
    .trim();
  if (!m) return 'The scrap.tf window could not be turned on.';
  const s = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** "You accepted this on 19 Oct 2026, 12:00." under the acknowledgement; null while not ticked. */
export function windowAckText(acknowledgedAt: UnixMs | null | undefined): string | null {
  return typeof acknowledgedAt === 'number' && Number.isFinite(acknowledgedAt) ? `You accepted this on ${fmtDateTime(acknowledgedAt)}. Unticking it turns the window off.` : null;
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

/** A toolbar control that moves the view (each one is main's 'scraptfWindow.<action>'). */
export type BarAction = 'back' | 'forward' | 'reload' | 'home';

/** aria-keyshortcuts and the titles' hints, for the keys barShortcut takes. */
export const BAR_SHORTCUTS: Readonly<Record<BarAction, { aria: string; text: string }>> = Object.freeze({
  back: { aria: 'Alt+ArrowLeft', text: 'Alt+Left' },
  forward: { aria: 'Alt+ArrowRight', text: 'Alt+Right' },
  reload: { aria: 'F5 Control+R', text: 'F5' },
  home: { aria: 'Alt+Home', text: 'Alt+Home' },
});

interface KeyLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * The toolbar's keys, while it has the focus: Alt+Left back, Alt+Right forward, F5 or Ctrl+R reload,
 * Alt+Home home. Each press is the user's; the page ignores a held key's repeats, so holding F5 is one reload.
 */
export function barShortcut(e: KeyLike): BarAction | null {
  if (e.metaKey || e.shiftKey) return null;
  if (e.altKey && !e.ctrlKey) {
    if (e.key === 'ArrowLeft') return 'back';
    if (e.key === 'ArrowRight') return 'forward';
    if (e.key === 'Home') return 'home';
    return null;
  }
  if (!e.altKey && !e.ctrlKey && e.key === 'F5') return 'reload';
  if (e.ctrlKey && !e.altKey && (e.key === 'r' || e.key === 'R')) return 'reload';
  return null;
}

/** The toolbar's arrow keys between its controls (wrapping), Home and End to the ends; null for any other key. */
export function barFocusMove(index: number, key: string, total: number): number | null {
  if (total <= 0) return null;
  const at = Math.min(Math.max(0, Math.floor(index) || 0), total - 1);
  const next = key === 'ArrowRight' ? (at + 1) % total : key === 'ArrowLeft' ? (at - 1 + total) % total : key === 'Home' ? 0 : key === 'End' ? total - 1 : null;
  return next === null || next === at ? null : next;
}

export interface BarBankChip {
  bank: ScraptfBank;
  label: string;
  /** The static SCRAPTF_BANKS page: only ever passed to 'scraptfWindow.go'. */
  url: string;
  title: string;
}

/** The bank shortcut chips, in SCRAPTF_BANKS order: labels and pages from the static list only. */
export function barBankChips(): BarBankChip[] {
  return SCRAPTF_BANKS.map((b) => ({ bank: b.bank, label: b.label, url: b.url, title: `Go to ${bankStockPagePath(b.url)}` }));
}

/** The chip of the page on screen (its exact static address), or null. */
export function activeBankOf(url: string | null | undefined): ScraptfBank | null {
  return typeof url === 'string' ? (SCRAPTF_BANKS.find((b) => b.url === url)?.bank ?? null) : null;
}

export interface AddressView {
  /** "scrap.tf/buy/hats"; the address main sent never carries a query or hash (windowDisplayUrl). */
  text: string;
  title: string;
  kind: 'scraptf' | 'steam' | 'other' | 'none';
}

/** The read-only address. */
export function addressView(url: string | null | undefined): AddressView {
  if (typeof url !== 'string' || url === '') return { text: '', title: 'No page open yet', kind: 'none' };
  const text = bankStockPagePath(url) || url;
  if (shouldReadUrl(url)) return { text, title: url, kind: 'scraptf' };
  if (/^https:\/\/steamcommunity\.com\//i.test(url)) return { text, title: `${url} · Steam sign-in: Flip Desk never reads this page`, kind: 'steam' };
  return { text, title: `${url} · not a scrap.tf page: Flip Desk never reads it`, kind: 'other' };
}

/**
 * "Read page now": disabled off scrap.tf (Steam sign-in, nothing open), on a scrap.tf page the import cannot
 * read (main's nav.importable false, F21-4: the front page, raffles, settings) and while a read runs.
 */
export function readButtonView(url: string | null | undefined, busy: boolean, importable?: boolean): { disabled: boolean; label: string; title: string } {
  if (busy) return { disabled: true, label: 'Reading…', title: 'Reading the page on screen…' };
  if (typeof url !== 'string' || url === '') return { disabled: true, label: 'Read page now', title: 'Open a scrap.tf page first.' };
  if (!shouldReadUrl(url)) return { disabled: true, label: 'Read page now', title: SCRAPTF_READ_REASONS.notScraptf };
  if (importable === false) {
    return { disabled: true, label: 'Read page now', title: `${SCRAPTF_READ_REASONS.notImportable} Flip Desk reads bank pages, the unusual pages and scrap.tf/items.` };
  }
  return {
    disabled: false,
    label: 'Read page now',
    title: 'Reads the page on screen now and imports it, like saving it with Ctrl+S. Nothing is sent over the network.',
  };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/**
 * The import's warning codes, said for a page on screen rather than a saved file. Main sends the code alone,
 * or with its counts as digits ('partial-read: 3 48'); a function words those counts.
 */
const WINDOW_WARNINGS: Readonly<Record<string, string | ((n: readonly number[]) => string)>> = Object.freeze({
  'no-cards-saved': 'no items on screen yet; wait for them, then Read page now',
  'no-items': 'no items on this page',
  'page-kind-unknown': 'not a page Flip Desk imports',
  'schema-not-loaded': 'item names are still loading; read again in a moment',
  'too-large': 'the page is over the 20 MB import limit',
  // 0.7.1 (F21-10), the codes main picks first, in its order.
  [PARTIAL_READ]: (n: readonly number[]) =>
    `${n.length >= 2 ? `only ${fmtInt(n[0])} of ~${fmtInt(n[1])} items were on screen` : 'only part of the page was on screen'}, so no stock save: Read page now once every card shows`,
  [LAYOUT_CHANGED]: "scrap.tf changed this page's layout: its items could not be read",
  [NO_STOCK_LIMIT]: (n: readonly number[]) => `stock unreadable for ${n.length >= 1 ? plural(n[0]!, 'row', 'rows') : 'some rows'}, so no stock save`,
  'no-sku': (n: readonly number[]) => (n.length >= 2 ? `${fmtInt(n[0])} of ${fmtInt(n[1])} items not recognised` : 'some items not recognised'),
  [NO_PRICE_COLUMN]: 'no "Price to buy" column found, so no prices were read',
  'unknown-bank': 'not a scrap.tf bank page Flip Desk knows',
  'no-pays-column': 'no "Price we pay" column found, so what scrap.tf pays was not read',
  [SCRAPTF_NOT_READ_AGAIN]: 'Read page now to read it again',
  // 0.7.3: scrap.tf's bare /unusuals index (the Unusuals chip's page) never shows items itself.
  [UNUSUALS_INDEX]: 'this is the Unusuals index, which lists no items: open one of its pages to read it',
});

/** Warnings that say how to read again, not that something is wrong: no warning tone. */
const INFO_WARNINGS: ReadonlySet<string> = new Set([SCRAPTF_NOT_READ_AGAIN, UNUSUALS_INDEX]);

/** A read's warning (main sends the import's warning code, or a fixed SCRAPTF_READ_REASONS or notice text). */
export function readWarningText(warning: string | null | undefined): string | null {
  if (typeof warning !== 'string' || warning.trim() === '') return null;
  const code = importWarningCode(warning);
  if (Object.hasOwn(WINDOW_WARNINGS, code)) {
    const words = WINDOW_WARNINGS[code]!;
    if (typeof words === 'string') return words;
    // Digits only from what follows the code, never other text.
    const at = warning.indexOf(':');
    const counts = (at < 0 ? [] : (warning.slice(at + 1).match(/\d{1,9}/g) ?? [])).slice(0, 2).map(Number);
    return words(counts);
  }
  return truncate(warning.trim(), 140);
}

/** A best flip's name, ready to show: its item (a click opens it in the dashboard) and its profit. */
export interface BestFlipView {
  sku: string;
  name: string;
  /** "+0.44 ref". */
  profit: string;
}

export interface ReadStatusView {
  /** "Read 48 items from /buy/hats · stored 46 · 10 flips (2 new) · best Team Captain +0.44 ref" (changes only with a new read: the live region). */
  main: string;
  /** "3 s ago" (ticks; outside the live region); '' before any read. */
  age: string;
  tone: 'good' | 'warn' | 'muted' | null;
  title: string;
  /**
   * `main` in three pieces, for the toolbar to make the best flip's name a button: `main` is `lead`, then
   * " · best <name> <profit>" when `best` is set, then `tail`.
   */
  lead: string;
  best: BestFlipView | null;
  tail: string;
}

/** The status line's words for main's failed reads (failedRead's fixed texts, and a challenge page that gave nothing). */
const READ_FAILURE_LINES: Readonly<Record<string, string>> = Object.freeze({
  [SCRAPTF_READ_REASONS.failed]: 'try Read page now again',
  [SCRAPTF_READ_REASONS.empty]: 'nothing to read yet (still loading, or over the 20 MB limit)',
  [SCRAPTF_READ_REASONS.schemaLoading]: 'item data is still loading; press Read page now in a moment',
  [SCRAPTF_WINDOW_NOTICES.challenge]: 'a Cloudflare check or error page is on screen: solve it in the page',
  [SCRAPTF_WINDOW_NOTICES.rateLimited]: 'scrap.tf is rate-limiting this window: wait a minute before reloading',
  // Read page now on Chromium's error page after a failed load: main words it by the load's notice.
  [SCRAPTF_WINDOW_NOTICES.offline]: 'scrap.tf could not be reached: press Reload',
  [SCRAPTF_WINDOW_NOTICES.insecure]: 'the connection to scrap.tf could not be secured: press Reload',
  [SCRAPTF_WINDOW_NOTICES.badResponse]: 'scrap.tf sent a page that could not be shown: press Reload',
  [SCRAPTF_WINDOW_NOTICES.loadFailed]: 'the page did not load: press Reload',
});

function bestFlipOf(b: ScraptfWindowRead['bestFlip']): BestFlipView | null {
  if (!b || typeof b.sku !== 'string' || typeof b.name !== 'string' || b.name.trim() === '' || typeof b.profitScrap !== 'number' || !Number.isFinite(b.profitScrap)) return null;
  const profit = fmtRefOnly(b.profitScrap);
  return { sku: b.sku, name: truncate(b.name.trim(), 60), profit: b.profitScrap > 0 ? `+${profit}` : profit };
}

/**
 * "10 flips (2 new)" when main says how many flips are on sale on the page; "2 new flips" otherwise. 0.8 (G2): flips
 * this read dropped under Pay up to (`dropped`) join the brackets, "10 flips (2 new, 1 cheaper)"; with none the
 * words are as before.
 */
function flipsPart(pageFlips: number | null, fresh: number, dropped = 0): string | null {
  const onPage = pageFlips === null ? 0 : Math.max(pageFlips, fresh + dropped);
  const which = [fresh ? `${fmtInt(fresh)} new` : '', dropped ? `${fmtInt(dropped)} cheaper` : ''].filter(Boolean).join(', ');
  if (onPage > 0) return `${plural(onPage, 'flip', 'flips')}${which ? ` (${which})` : ''}`;
  const told = fresh + dropped;
  return told > 0 ? `${which} ${told === 1 ? 'flip' : 'flips'}` : null;
}

/** The toolbar's status line for the newest read; `readOnLoad` words the line before the first one. */
export function readStatusView(read: ScraptfWindowRead | null | undefined, now: UnixMs, readOnLoad = true): ReadStatusView {
  if (!read) {
    const main = 'Not read yet';
    return {
      main,
      age: '',
      tone: 'muted',
      title: readOnLoad ? 'scrap.tf pages are read when they finish loading in the window.' : 'Reading on load is off: press Read page now to read the page on screen.',
      lead: main,
      best: null,
      tail: '',
    };
  }
  const items = count(read.items);
  const flips = count(read.newFlips);
  const path = typeof read.path === 'string' && read.path ? read.path : '/';
  const at = typeof read.at === 'number' && Number.isFinite(read.at) ? read.at : null;
  // A read stamped a little ahead of this clock reads "just now", not "in 2 s".
  const age = at === null ? '' : fmtAgo(Math.min(at, now), now);
  const sent = typeof read.warning === 'string' ? read.warning.trim() : '';
  if (Object.hasOwn(READ_FAILURE_LINES, sent)) {
    // Main's failed read (the script failed, the page gave nothing, the item data was loading, a challenge page
    // gave nothing): nothing was imported, so no "Read 0 items".
    const main = `Could not read ${path} · ${READ_FAILURE_LINES[sent]!}`;
    // 0.7.3: a challenge read's tooltip follows the setting, as the notice does.
    const said = windowNoticeText(sent, readOnLoad) ?? sent;
    return { main, age, tone: 'warn', title: `${at === null ? '' : `${fmtDateTime(at)}: `}${said} Nothing was imported from scrap.tf${path}.`, lead: main, best: null, tail: '' };
  }
  // The line joins its parts with " · ", so a sentence's own full stop goes.
  const warn = readWarningText(read.warning)?.replace(/[.\s]+$/, '') || null;
  const info = warn !== null && INFO_WARNINGS.has(importWarningCode(sent));
  // 0.7.1 (UX-3, P5): the prices stored when not every item was, and the flips on sale on this page.
  const stored = typeof read.stored === 'number' && Number.isFinite(read.stored) ? count(read.stored) : null;
  const pageFlips = typeof read.pageFlips === 'number' && Number.isFinite(read.pageFlips) ? count(read.pageFlips) : null;
  const best = bestFlipOf(read.bestFlip);
  const parts = [`Read ${plural(items, 'item', 'items')} from ${path}`];
  if (stored !== null && items > 0 && stored !== items) parts.push(`stored ${fmtInt(stored)}`);
  // 0.7.4 (F53): a bank page left before its settle read stored prices but no stock save, so its history,
  // stock and gone cards did not move on: the line says so, and the title what to do.
  const unsettled = read.stockSave === 'unsettled' && items > 0 && read.bank !== null;
  if (unsettled) parts.push('no stock save');
  // 0.8 (G2): flips this read dropped under Pay up to (ImportResult.droppedFlips), when main reported them.
  const dropped = count(read.droppedFlips);
  const flipsText = flipsPart(pageFlips, flips, dropped);
  if (flipsText) parts.push(flipsText);
  const lead = parts.join(' · ');
  const tail = warn ? ` · ${warn}` : '';
  const main = `${best ? `${lead} · best ${best.name} ${best.profit}` : lead}${tail}`;
  const bank = SCRAPTF_BANKS.find((b) => b.bank === read.bank);
  const onPage = pageFlips === null ? 0 : Math.max(pageFlips, flips + dropped);
  const title = [
    `${at === null ? 'Read' : `Read ${fmtDateTime(at)}`}: ${plural(items, 'item', 'items')} on scrap.tf${path}${bank ? ` (${bank.label})` : ''}, imported like a saved page.`,
    stored !== null && items > 0 ? `${fmtInt(stored)} stored as prices.` : '',
    unsettled ? `Prices stored, but no stock save: the page was left before it finished loading, so its stock and history did not change. Stay on a page a few seconds, or press Read page now.` : '',
    onPage > 0
      ? `${plural(onPage, 'flip', 'flips')} on sale on this page now${flips > 0 ? `, ${fmtInt(flips)} of them new since your previous save` : ''}.`
      : flips > 0
        ? `${fmtInt(flips)} of them new since your previous save and a flip now.`
        : '',
    dropped > 0 ? `${fmtInt(dropped)} of them dropped under your Pay up to on this read.` : '',
    best ? `Best: ${best.name}, ${best.profit} profit.` : '',
    warn ? `Note: ${warn}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { main, age, tone: warn && !info ? 'warn' : onPage > 0 || flips > 0 || dropped > 0 ? 'good' : null, title, lead, best, tail };
}

/** The toolbar's "Show flips" (0.7.1, F21-2): the read's bank and the chip its stock page opens on. */
export interface ShowFlipsView {
  bank: ScraptfBank;
  filter: BankStockOpenFilter;
  label: string;
  title: string;
}

/**
 * "Show flips" once a read recognised a bank and found flips, always on the Flips chip: every flip on sale on
 * the page, the new ones with their New badges. Not the New chip (UX-071-2): the read's "k new" counts new
 * since the read before, while that chip counts new since the session's baseline (CQ-2) and holds non-flips,
 * so it could hold none of them. A click shows the dashboard (app.showBankStock); it loads nothing here.
 */
export function showFlipsView(read: ScraptfWindowRead | null | undefined): ShowFlipsView | null {
  if (!read || typeof read.bank !== 'string') return null;
  const bank = SCRAPTF_BANKS.find((b) => b.bank === read.bank);
  if (!bank) return null;
  const fresh = count(read.newFlips);
  const onPage = count(read.pageFlips);
  if (fresh <= 0 && onPage <= 0) return null;
  const filter: BankStockOpenFilter = 'flips';
  // An older service sends no pageFlips: its new flips are on sale on the page too.
  const flips = plural(Math.max(onPage, fresh), 'flip', 'flips');
  const fresher = fresh > 0 ? ` (${fmtInt(fresh)} new since your previous read)` : '';
  return { bank: bank.bank, filter, label: 'Show flips', title: `Shows ${bank.label} in the dashboard's Bank stock, on Flips: ${flips} on sale on this page${fresher}. Nothing is loaded in this window.` };
}

/** The best flip's name: a click opens the item in the dashboard. */
export function bestFlipTitle(best: BestFlipView): string {
  return `Opens ${best.name} in the dashboard (${best.profit} profit at scrap.tf's price on this page).`;
}

/** 0.7.3: main's challenge notice with reading on load off, when no automatic read follows the real page. */
export const SCRAPTF_CHALLENGE_NOTICE_READ_OFF = 'Cloudflare check or error page on screen: solve it in the page, then press Read page now once the real page loads.';

/**
 * main's notice about the page on screen (nav.notice, fixed text), for the status line; null when none. With
 * reading on load off the challenge notice says to press Read page now: nothing reads the real page by itself.
 */
export function windowNoticeText(notice: unknown, readOnLoad = true): string | null {
  const text = typeof notice === 'string' ? notice.trim() : '';
  if (text === '') return null;
  if (!readOnLoad && text === SCRAPTF_WINDOW_NOTICES.challenge) return SCRAPTF_CHALLENGE_NOTICE_READ_OFF;
  return truncate(text, 200);
}

/** The status line as one string: "Read 48 items from /buy/hats · 2 new flips · 3 s ago" (or "Could not read …"). */
export function readStatusText(read: ScraptfWindowRead | null | undefined, now: UnixMs, readOnLoad = true): string {
  const v = readStatusView(read, now, readOnLoad);
  return v.age ? `${v.main} · ${v.age}` : v.main;
}

/** The toolbar's line after Log out & clear. */
export const WINDOW_CLEARED_TEXT = "Signed out: the window's cookies, site storage and cache are cleared.";

// ---------------------------------------------------------------------------
// Entry points elsewhere in the dashboard
// ---------------------------------------------------------------------------

/** What the banks cards need of the window: null while it is off (no button). */
export interface BankWindowView {
  /** Flip Desk's scrap.tf links open there (openLinksInWindow): "Open in browser" would land there too, so it goes. */
  linksHere: boolean;
  readOnLoad: boolean;
}

export function bankWindowView(s: Partial<WindowSettings> | null | undefined): BankWindowView | null {
  if (!scraptfWindowOn(s)) return null;
  return { linksHere: scraptfLinksInWindow(s), readOnLoad: s?.scraptfWindow?.readOnLoad !== false };
}

/** A banks card's "Open in Flip Desk window" tooltip. */
export function windowOpenTitle(path: string, readOnLoad: boolean): string {
  return `Opens ${path} in the Flip Desk window, where you browse it yourself. ${readOnLoad ? 'The page is read when it finishes loading.' : 'Press Read page now there to read it.'} ${SCRAPTF_WINDOW_RISK_TIP}`;
}

/** The toast after a window open failed (refused while off, a bad page, main not answering). */
export function windowOpenFailedText(message: string): string {
  return `Could not open the scrap.tf window: ${message.trim() || 'unknown error'}`;
}

// ---------------------------------------------------------------------------
// The Import page
// ---------------------------------------------------------------------------

/** The file name main gives a window read ('scrap.tf window /buy/hats', windowReadFileName). */
const WINDOW_FILE_PREFIX = 'scrap.tf window ';

export interface ImportOriginView {
  /** "Flip Desk window" for a read of the window; null for a saved file (or a batch from before 0.7). */
  origin: string | null;
  /** What the File column shows: the page ("scrap.tf/buy/hats") for a window read, else the file name. */
  file: string;
  title: string;
}

/** How the Import page names where a batch or result came from. Text only: nothing here is opened. */
export function importOriginView(b: { origin?: ImportOrigin | null; fileName: string }): ImportOriginView {
  const name = typeof b.fileName === 'string' ? b.fileName : '';
  if (b.origin !== 'window') return { origin: null, file: name, title: name };
  const path = name.startsWith(WINDOW_FILE_PREFIX) ? name.slice(WINDOW_FILE_PREFIX.length).trim() : '';
  const file = path.startsWith('/') ? `scrap.tf${path === '/' ? '' : path}` : name;
  return { origin: SCRAPTF_WINDOW_ORIGIN_LABEL, file, title: `Read from the page on screen in the Flip Desk window (${file}), not from a saved file.` };
}
