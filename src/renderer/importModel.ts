// Pure helpers for pages the user saves (F18): which save type every "save it" instruction
// recommends and why, the Import page's file hint, the 'no-cards-saved' and 'too-large'
// warnings on the Import page and in the dashboard's import toast, and a manual import refused
// for its size.
//
// scrap.tf adds bank cards after its page has loaded. "Webpage, HTML only" writes the page as it
// first loaded, so those cards (or all of them) can be missing; "Webpage, Complete" and
// "Webpage, Single File" write the page as shown. HTML only stays accepted. Nothing here reads a
// saved file or opens anything (R1, R10). F21: a read of the opt-in scrap.tf window (origin 'window')
// is no save, so its no-cards wording differs and the dashboard does not toast it. 0.7.1: the skipped
// items' true total and per-reason counts, refusals first (P5); the parser report the user copies (P4);
// what turning import off also does to the scrap.tf window (UX-12).

import { BENIGN_SKIP_REASONS } from '../shared/importCodes';
import type { ImportReport, ImportResult } from '../shared/types';

/** The save type every instruction recommends. */
export const SAVE_MODE = 'Webpage, Complete';

/** The alternative: one .mhtml file instead of the page plus a <name>_files folder. */
export const SAVE_MODE_ALT = 'Webpage, Single File (.mhtml)';

/**
 * Why scrap.tf/items gets no alternative: one row per item, each with its icon, and a Single File
 * save puts every image in the file, which then goes over the import's limits and is refused.
 */
export const SAVE_MODE_LIST_NOTE = "Not 'Webpage, Single File': scrap.tf/items has an image per item, so one .mhtml file of it goes over 20 MB or 2,000 parts and is refused.";

/** The same exception, said where the choice with its alternative covers every page (Import, Banks). */
export const SAVE_MODE_LIST_ONLY = `For scrap.tf/items, choose '${SAVE_MODE}' only: with an image per item, a Single File save of it is too large to import.`;

/** The short reason shown beside the recommendation. */
export const SAVE_MODE_REASON = 'so cards scrap.tf added after the page loaded are included';

/** The recommendation as one plain sentence, for tooltips. */
export const SAVE_MODE_TEXT = `Choose '${SAVE_MODE}' (or '${SAVE_MODE_ALT}') ${SAVE_MODE_REASON}.`;

/** Why HTML only is still read but not recommended. */
export const SAVE_MODE_HTML_ONLY_NOTE = "'Webpage, HTML only' still imports, but it keeps the page as it first loaded and can miss those cards.";

/** A complete save writes a <name>_files folder beside the page; the folder watch skips it. */
export const SAVE_MODE_FILES_NOTE = 'The _files folder a complete save adds is ignored.';

/** Under "Import saved page…": the file types it takes. */
export const IMPORT_FILE_HINT = 'Takes .html and .mhtml saves (.htm and .mht too).';

/** The warning code the service gives a recognised bank page that parsed to no cards. */
export const NO_CARDS_SAVED = 'no-cards-saved';

/** What the user is told about such a save, wherever it shows. */
export const NO_CARDS_SAVED_REASON =
  "This page was saved without its items. 'HTML only' keeps the page as it first loaded, before scrap.tf added the cards. Save it again as 'Webpage, Complete'.";

/** The banner's hint after that reason: the alternative save type. */
export const NO_CARDS_ALT_HINT = `'${SAVE_MODE_ALT}' works too.`;

/** The hint for a save that already was a Single File one (.mhtml): it was saved too soon. */
export const NO_CARDS_MHTML_HINT = 'Wait until the items show on the page, then save it again.';

/** F21: the same warning for a read of the scrap.tf window (ImportResult.origin 'window'): nothing was saved. */
export const NO_CARDS_WINDOW_REASON = 'This read of the scrap.tf window found no items: scrap.tf adds its cards after the page has loaded.';
export const NO_CARDS_WINDOW_HINT = 'Wait until the items show, then press Read page now in the window.';

/** The warning code the service gives a page the folder watch would not read: over the 20 MB import limit. */
export const TOO_LARGE = 'too-large';

/** What to do about a save over the size limit: a complete save keeps its images out of the page file. */
export const TOO_LARGE_FIX = "Save it again as 'Webpage, Complete': its images go into the _files folder, and the page stays small.";

/** What the user is told about such a save in the dashboard's toast. */
export const TOO_LARGE_REASON = `This save is over the 20 MB import limit, so nothing was imported. ${TOO_LARGE_FIX}`;

/**
 * The no-cards and too-large toasts stay this long, held while hovered, focused or while the dashboard
 * is hidden (the user saves in the browser, often with the dashboard behind it): they ask to save again.
 */
export const NO_CARDS_TOAST_MS = 20_000;

const FILE_NAME_MAX = 60;

/** A warning's code: the text before its first colon ("no-items: …" is 'no-items'), as the service writes them. */
export function importWarningCode(warning: string): string {
  const at = warning.indexOf(':');
  return (at < 0 ? warning : warning.slice(0, at)).trim();
}

function warningsOf(r: Pick<ImportResult, 'warnings'> | null | undefined): string[] {
  return Array.isArray(r?.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [];
}

/** True when the import says the page was saved without its cards ('no-cards-saved'). */
export function importSavedWithoutCards(r: Pick<ImportResult, 'warnings'> | null | undefined): boolean {
  return warningsOf(r).some((w) => importWarningCode(w) === NO_CARDS_SAVED);
}

/** True when the folder watch passed over the save for its size ('too-large'). */
export function importTooLarge(r: Pick<ImportResult, 'warnings'> | null | undefined): boolean {
  return warningsOf(r).some((w) => importWarningCode(w) === TOO_LARGE);
}

/** A Single File save by its name (.mhtml, .mht), as the service tells them. */
function isMhtmlName(name: unknown): boolean {
  return typeof name === 'string' && /\.mht(?:ml)?$/i.test(name.trim());
}

export interface ImportWarningsView {
  /** The 'no-cards-saved' banner, shown first and on its own; null otherwise. */
  noCards: { text: string; hint: string } | null;
  /** Every other warning, in order. */
  rest: string[];
}

/**
 * The Import page's warnings for one result. A save without its cards gets the banner, with the
 * fixed reason whatever text the service sent; its 'no-items' line says the same thing, so it goes.
 * The hint offers Single File, except to a save that was one: that one came too soon. F21: a read of the
 * scrap.tf window was no save at all, so it says to read again once the items show.
 */
export function importWarningsView(r: Pick<ImportResult, 'warnings' | 'fileName' | 'origin'>): ImportWarningsView {
  const all = warningsOf(r);
  if (!importSavedWithoutCards(r)) return { noCards: null, rest: all };
  const noCards =
    r.origin === 'window'
      ? { text: NO_CARDS_WINDOW_REASON, hint: NO_CARDS_WINDOW_HINT }
      : { text: NO_CARDS_SAVED_REASON, hint: isMhtmlName(r.fileName) ? NO_CARDS_MHTML_HINT : NO_CARDS_ALT_HINT };
  return {
    noCards,
    rest: all.filter((w) => {
      const code = importWarningCode(w);
      return code !== NO_CARDS_SAVED && code !== 'no-items';
    }),
  };
}

function clipName(name: string): string {
  const n = name.trim() || 'The saved page';
  return n.length > FILE_NAME_MAX ? `${n.slice(0, FILE_NAME_MAX - 1)}…` : n;
}

/**
 * The dashboard's toast for an 'import.done' (a folder-watch save or "Import saved page…") that came
 * without its cards; null for any other import.
 */
export function noCardsToastText(r: Pick<ImportResult, 'warnings' | 'fileName'> | null | undefined): string | null {
  if (!r || !importSavedWithoutCards(r)) return null;
  return `${clipName(typeof r.fileName === 'string' ? r.fileName : '')}: ${NO_CARDS_SAVED_REASON}`;
}

/**
 * The dashboard's toast for an 'import.done' that asks the user to save the page again: one without
 * its cards, or one the folder watch passed over for its size. Null for any other import. F21: never for
 * a read of the scrap.tf window: its first read often comes before scrap.tf has added the cards (the
 * settle read picks them up), there is nothing to save again, and the window's own status line says it.
 */
export function importNoticeToastText(r: Pick<ImportResult, 'warnings' | 'fileName' | 'origin'> | null | undefined): string | null {
  if (r?.origin === 'window') return null;
  const noCards = noCardsToastText(r);
  if (noCards !== null || !r || !importTooLarge(r)) return noCards;
  return `${clipName(typeof r.fileName === 'string' ? r.fileName : '')}: ${TOO_LARGE_REASON}`;
}

// ---------------------------------------------------------------------------
// 0.7.1: skipped items, the parser report, turning import off
// ---------------------------------------------------------------------------

export interface ImportSkipGroup {
  /** The reason as the service gave it: a refusal code, or one of the benign texts. */
  reason: string;
  count: number;
  /** A refusal (the item could not be read as a price), not a benign skip (out of stock, a cheaper copy). */
  refusal: boolean;
}

export interface ImportSkipSummary {
  /** Every skipped entry (ImportResult.skippedTotal), or the entries listed when the service gave no total. */
  total: number;
  /** The entries listed (ImportResult.skipped, cut at 500). */
  listed: number;
  /** Per reason, refusals first, then the most common; [] when the service gave no counts. */
  groups: ImportSkipGroup[];
}

// Every reason but the benign ones, as the service orders the list ("refusals first"): a refusal code, and
// the plain fallbacks ('no price', 'item not recognised') or a first warning of an item it could not store.
function isRefusal(reason: string): boolean {
  return !BENIGN_SKIP_REASONS.includes(reason);
}

/**
 * P5: "1,240 skipped" from ImportResult.skippedTotal (the list holds at most 500, refusals first) and the
 * per-reason counts (skippedCounts), refusals first, then by count. A result from an older service has
 * neither: the list's length is the total, with no groups.
 */
export function importSkipSummary(r: Pick<ImportResult, 'skipped'> & Partial<Pick<ImportResult, 'skippedTotal' | 'skippedCounts'>>): ImportSkipSummary {
  const listed = Array.isArray(r.skipped) ? r.skipped.length : 0;
  const t = r.skippedTotal;
  const total = typeof t === 'number' && Number.isFinite(t) ? Math.max(listed, Math.floor(t)) : listed;
  const groups: ImportSkipGroup[] = [];
  const counts = r.skippedCounts;
  if (counts && typeof counts === 'object') {
    for (const [reason, n] of Object.entries(counts)) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
      groups.push({ reason, count: Math.floor(n), refusal: isRefusal(reason) });
    }
  }
  groups.sort((a, b) => Number(b.refusal) - Number(a.refusal) || b.count - a.count || a.reason.localeCompare(b.reason));
  return { total, listed, groups };
}

/** P4: the button that copies the newest parser reports ('import.report'). */
export const IMPORT_REPORT_LABEL = 'Copy parser report';
/** P4: what the report holds and where it goes: the clipboard only. */
export const IMPORT_REPORT_NOTE =
  "Copies a summary of your newest page reads to the clipboard, to paste into a bug report: each file's name, counts, warning codes and the item fields the parser read, item titles included. No custom names, Steam IDs, asset IDs, links or gift text. Nothing is sent anywhere.";

/** P4: the reports as the text the button copies (JSON, newest first); null when there is none yet. */
export function importReportText(reports: readonly ImportReport[] | null | undefined): string | null {
  if (!Array.isArray(reports) || reports.length === 0) return null;
  return JSON.stringify(reports, null, 2);
}

/** The toast after Copy parser report. */
export function importReportToast(copied: boolean, count: number): { text: string; tone: 'good' | 'warn' | 'bad' } {
  if (count === 0) return { text: 'No page read yet in this session: import or read a page first, then copy the report.', tone: 'warn' };
  if (!copied) return { text: 'Could not copy the parser report.', tone: 'bad' };
  return { text: `Copied the parser report (${count} ${count === 1 ? 'read' : 'reads'}). Nothing was sent.`, tone: 'good' };
}

/**
 * UX-12: the "Turn import off" card. Turning import off also turns the scrap.tf window off (it needs
 * import) and closes it, and clears the watch folder; `windowOn` (settings.scraptfWindow.enabled) says so.
 */
export function importOffText(windowOn: boolean): { text: string; confirmLabel: string } {
  const base = 'Turning it off stops the folder watch and hides the import buttons. Imported prices stay in your price sheet. Your watch folder choice is cleared.';
  if (!windowOn) return { text: base, confirmLabel: 'Turn off import?' };
  return {
    text: `${base} This also turns off the scrap.tf window and closes it; turn it on again in Settings → scrap.tf window.`,
    confirmLabel: 'Turn off import and the scrap.tf window?',
  };
}

/** The size refusals of "Import saved page…": main's "larger than 20 MB" and the service's "too large". */
const TOO_LARGE_ERROR = /\blarger than 20 MB\b|\btoo large\b/i;

/**
 * The Import page's toast for a failed "Import saved page…". A page refused for its size (a Single
 * File save keeps every image in the file) also says which save type keeps it small, as the folder
 * watch's notice does, and stays as long; any other failure reads as before.
 */
export function importFailedToast(message: string): { text: string; timeoutMs: number | null } {
  const m = message.trim() || 'Unknown error';
  if (!TOO_LARGE_ERROR.test(m)) return { text: `Import failed: ${m}`, timeoutMs: null };
  return { text: `Import failed: ${/[.!?]$/.test(m) ? m : `${m}.`} ${TOO_LARGE_FIX}`, timeoutMs: NO_CARDS_TOAST_MS };
}
