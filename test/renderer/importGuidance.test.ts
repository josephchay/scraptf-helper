// F18 save guidance in the dashboard: every "save it" instruction recommends "Webpage, Complete"
// (or "Webpage, Single File (.mhtml)") with its short reason, the Import page's file hint names
// .mhtml, and a bank page saved without its cards ('no-cards-saved') is shown prominently: a
// banner on the Import page and one toast per batch on any page of the dashboard. The pure helpers
// in importModel.ts, the Import page's result rendered server-side, the copy checked statically,
// then AppProvider mounted into the minimal DOM in domShim.ts with the browser mock as the app
// bridge and 'import.done' pushed by the test. Nothing reads a file and nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_FILE_HINT,
  NO_CARDS_ALT_HINT,
  NO_CARDS_MHTML_HINT,
  NO_CARDS_SAVED,
  NO_CARDS_SAVED_REASON,
  NO_CARDS_TOAST_MS,
  TOO_LARGE_FIX,
  TOO_LARGE_REASON,
  SAVE_MODE,
  SAVE_MODE_ALT,
  SAVE_MODE_HTML_ONLY_NOTE,
  SAVE_MODE_LIST_ONLY,
  SAVE_MODE_REASON,
  SAVE_MODE_TEXT,
  importFailedToast,
  importNoticeToastText,
  importOffText,
  importSavedWithoutCards,
  importTooLarge,
  importWarningCode,
  importWarningsView,
  noCardsToastText,
} from '../../src/renderer/importModel';
import { tooLargeWarning } from '../../src/service/import/savedPage';
import { BANK_SAVE_TIP, LIST_SAVE_TIP, bankCards, bankFreshness, bankSavedText, importBankText } from '../../src/renderer/banksModel';
import { bankStockFilterEmpty, bankStockHeader } from '../../src/renderer/bankStockModel';
import { COVERAGE_TIP, drawerBankStockLine, emptyFiltersText } from '../../src/renderer/marketModel';
import { errorMessage } from '../../src/renderer/format';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { ImportResultView } from '../../src/renderer/pages/ImportPage';
import { ALL_ITEMS_TIP, listPaysCell, listStatusLine } from '../../src/renderer/scraptfListModel';
import { ImportTooLargeError, NO_CARDS_SAVED_WARNING } from '../../src/service/import/scraptfHtml';
import type { FlipdeskBridge } from '../../src/shared/rpc';
import type { ImportResult } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

const NO_CARDS_WARNING = `${NO_CARDS_SAVED}: scrap.tf/buy/hats parsed to 0 cards`;

function result(over: Partial<ImportResult> = {}): ImportResult {
  return { batchId: 7, fileName: 'scrap.tf - Buy Hats.html', pageKind: 'buy', parsed: 0, stored: 0, skipped: [], warnings: [], bank: 'hats', ...over };
}

describe('the save type and its reason', () => {
  it('recommends Webpage, Complete, with Single File (.mhtml) as the alternative, and says why', () => {
    expect(SAVE_MODE).toBe('Webpage, Complete');
    expect(SAVE_MODE_ALT).toBe('Webpage, Single File (.mhtml)');
    expect(SAVE_MODE_REASON).toBe('so cards scrap.tf added after the page loaded are included');
    expect(SAVE_MODE_TEXT).toBe("Choose 'Webpage, Complete' (or 'Webpage, Single File (.mhtml)') so cards scrap.tf added after the page loaded are included.");
    // HTML only stays accepted; it is only not recommended.
    expect(SAVE_MODE_HTML_ONLY_NOTE).toMatch(/^'Webpage, HTML only' still imports/);
  });

  it('names .mhtml in the Import page file hint', () => {
    expect(IMPORT_FILE_HINT).toBe('Takes .html and .mhtml saves (.htm and .mht too).');
  });

  it('gives the user-facing reason for a save without its cards word for word', () => {
    expect(NO_CARDS_SAVED_REASON).toBe(
      "This page was saved without its items. 'HTML only' keeps the page as it first loaded, before scrap.tf added the cards. Save it again as 'Webpage, Complete'.",
    );
  });
});

describe("the 'no-cards-saved' warning", () => {
  it('reads a warning code as the service writes it: the text before the first colon', () => {
    expect(importWarningCode('no-cards-saved: 0 cards on scrap.tf/buy/hats')).toBe('no-cards-saved');
    expect(importWarningCode('no-cards-saved')).toBe('no-cards-saved');
    expect(importWarningCode('price-mismatch: "2 ref: x" but data-item-value is 18 scrap')).toBe('price-mismatch');
    expect(importWarningCode('')).toBe('');
  });

  it("matches the parser's own warning: the same code, and the same reason after it", () => {
    expect(importWarningCode(NO_CARDS_SAVED_WARNING)).toBe(NO_CARDS_SAVED);
    expect(NO_CARDS_SAVED_WARNING).toBe(`${NO_CARDS_SAVED}: ${NO_CARDS_SAVED_REASON}`);
    expect(importSavedWithoutCards({ warnings: [NO_CARDS_SAVED_WARNING] })).toBe(true);
  });

  it('is found by its code only, whatever text follows', () => {
    expect(importSavedWithoutCards(result({ warnings: [NO_CARDS_WARNING] }))).toBe(true);
    expect(importSavedWithoutCards(result({ warnings: ['schema-not-loaded: x', 'no-cards-saved'] }))).toBe(true);
    expect(importSavedWithoutCards(result({ warnings: ['no-items: no item cards or price rows found'] }))).toBe(false);
    expect(importSavedWithoutCards(result({ warnings: ['see no-cards-saved: later'] }))).toBe(false);
    expect(importSavedWithoutCards(result())).toBe(false);
    // An answer of another shape says nothing.
    expect(importSavedWithoutCards(null)).toBe(false);
    expect(importSavedWithoutCards({ warnings: 'no-cards-saved' as never })).toBe(false);
    expect(importSavedWithoutCards({ warnings: [42, null] as never })).toBe(false);
  });

  it('leads the warnings with the fixed reason, and drops the no-items line that says the same', () => {
    const v = importWarningsView(result({ warnings: ['page-kind-guessed: treated as buy', NO_CARDS_WARNING, 'no-items: no item cards or price rows found'] }));
    expect(v.noCards).toEqual({ text: NO_CARDS_SAVED_REASON, hint: "'Webpage, Single File (.mhtml)' works too." });
    expect(v.rest).toEqual(['page-kind-guessed: treated as buy']);
  });

  it("does not offer Single File to a save that was one (.mhtml, .mht): it came before the items showed", () => {
    expect(NO_CARDS_ALT_HINT).toBe("'Webpage, Single File (.mhtml)' works too.");
    expect(NO_CARDS_MHTML_HINT).toBe('Wait until the items show on the page, then save it again.');
    for (const fileName of ['Hat Trading - TF2 - Scrap.TF.mhtml', 'hats.MHT', ' x.mhtml ']) {
      expect(importWarningsView(result({ fileName, warnings: [NO_CARDS_WARNING] })).noCards).toEqual({ text: NO_CARDS_SAVED_REASON, hint: NO_CARDS_MHTML_HINT });
    }
    for (const fileName of ['scrap.tf - Buy Hats.html', 'hats.htm', 'mhtml.html', 42 as never]) {
      expect(importWarningsView(result({ fileName, warnings: [NO_CARDS_WARNING] })).noCards?.hint).toBe(NO_CARDS_ALT_HINT);
    }
  });

  it('leaves every warning in place without it', () => {
    const warnings = ['no-items: no item cards or price rows found', 'schema-not-loaded: x'];
    expect(importWarningsView(result({ warnings }))).toEqual({ noCards: null, rest: warnings });
  });

  it('toasts the file name and the reason, clipping a long name; nothing for any other import', () => {
    expect(noCardsToastText(result({ warnings: [NO_CARDS_WARNING] }))).toBe(`scrap.tf - Buy Hats.html: ${NO_CARDS_SAVED_REASON}`);
    const long = noCardsToastText(result({ warnings: [NO_CARDS_WARNING], fileName: `${'x'.repeat(100)}.html` }))!;
    expect(long.startsWith(`${'x'.repeat(59)}…: This page`)).toBe(true);
    expect(noCardsToastText(result({ warnings: [NO_CARDS_WARNING], fileName: '  ' }))).toBe(`The saved page: ${NO_CARDS_SAVED_REASON}`);
    expect(noCardsToastText(result({ warnings: ['no-items: x'] }))).toBeNull();
    expect(noCardsToastText(null)).toBeNull();
  });

  it("toasts a save the folder watch passed over for its size (the service's too-large warning), with the file name", () => {
    const big = result({ bank: null, pageKind: 'unknown', fileName: 'Item Trading - TF2 - Scrap.TF.mhtml', warnings: [tooLargeWarning('24 MB is over the 20 MB import limit')] });
    expect(importTooLarge(big)).toBe(true);
    expect(importNoticeToastText(big)).toBe(`Item Trading - TF2 - Scrap.TF.mhtml: ${TOO_LARGE_REASON}`);
    expect(TOO_LARGE_REASON).toContain("Save it again as 'Webpage, Complete'");
    // The no-cards notice is the same as before; any other import says nothing.
    expect(importNoticeToastText(result({ warnings: [NO_CARDS_WARNING] }))).toBe(noCardsToastText(result({ warnings: [NO_CARDS_WARNING] })));
    expect(importNoticeToastText(result({ warnings: ['mhtml-no-html: x; save the page again'] }))).toBeNull();
    expect(importNoticeToastText(result({ warnings: ['see too-large: later'] }))).toBeNull();
    expect(importNoticeToastText(null)).toBeNull();
  });

  it('stays up long enough to read, under the toast cap', () => {
    expect(NO_CARDS_TOAST_MS).toBe(20_000);
  });

  it('tells a manual import refused for its size how to save it, as the folder watch notice does', () => {
    const srcOf = (rel: string) => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8');
    // Main's refusals and the service's, as they reach the page (errorMessage strips the IPC wrapper).
    expect(srcOf('main/ipc.ts')).toContain("throw new Error('That file is larger than 20 MB.')");
    expect(srcOf('service/rpcHandlers.ts')).toContain("'the page is larger than 20 MB'");
    const fromMain = errorMessage(new Error("Error invoking remote method 'rpc': Error: That file is larger than 20 MB."));
    expect(importFailedToast(fromMain)).toEqual({ text: `Import failed: That file is larger than 20 MB. ${TOO_LARGE_FIX}`, timeoutMs: NO_CARDS_TOAST_MS });
    const fromService = new ImportTooLargeError(24 * 1024 * 1024).message;
    expect(importFailedToast(fromService).text).toBe(`Import failed: ${fromService}. ${TOO_LARGE_FIX}`);
    expect(importFailedToast('Invalid parameters for import.html: html: the page is larger than 20 MB').timeoutMs).toBe(NO_CARDS_TOAST_MS);
    expect(TOO_LARGE_REASON.endsWith(TOO_LARGE_FIX)).toBe(true);
    // Any other failure reads as before.
    expect(importFailedToast('Choose a saved .html or .mhtml page.')).toEqual({ text: 'Import failed: Choose a saved .html or .mhtml page.', timeoutMs: null });
    expect(importFailedToast('  ')).toEqual({ text: 'Import failed: Unknown error', timeoutMs: null });
    expect(read('pages/ImportPage.tsx')).toContain('const t = importFailedToast(errorMessage(e));');
  });
});

describe('the Import page result', () => {
  const text = (html: string) => html.replace(/<!-- -->/g, '');

  it('shows a save without its cards first, in a warning banner with the reason, not as one more line', () => {
    const h = text(renderToString(createElement(ImportResultView, { r: result({ warnings: [NO_CARDS_WARNING, 'no-items: x', 'schema-not-loaded: y'] }) })));
    expect(h).toMatch(/^<div class="import-result"><div class="banner tone-warn">/);
    expect(h).toContain(`<strong>${NO_CARDS_SAVED_REASON.replace(/'/g, '&#x27;')}</strong> &#x27;Webpage, Single File (.mhtml)&#x27; works too.`);
    expect(h).not.toContain('no-cards-saved');
    expect(h).not.toContain('no-items');
    expect(h).toContain('schema-not-loaded: y');
    expect(h.match(/class="tone-text-warn"/g)).toHaveLength(1);
    // It dates no banks card (F18 S3), so its page line does not say "Counted as a save".
    expect(h).toContain('>Hats · scrap.tf/buy/hats · not counted</dd>');
    expect(h).not.toContain('Counted as a save');
  });

  it('gives a Single File save without its cards the hint that fits it, not "Single File works too"', () => {
    const h = text(renderToString(createElement(ImportResultView, { r: result({ fileName: 'Hat Trading - TF2 - Scrap.TF.mhtml', warnings: [NO_CARDS_WARNING] }) })));
    expect(h).toContain(`<strong>${NO_CARDS_SAVED_REASON.replace(/'/g, '&#x27;')}</strong> ${NO_CARDS_MHTML_HINT}`);
    expect(h).not.toContain('works too');
  });

  it("does not tell an older save whose cards a newer save already priced to change its save type", () => {
    // Every card read, every one skipped: no 'no-cards-saved', so the page was saved fine.
    const skipped = Array.from({ length: 3 }, (_, i) => ({ reason: 'a newer saved page already set this price', title: `Hat ${i}` }));
    const h = text(renderToString(createElement(ImportResultView, { r: result({ parsed: 3, stored: 0, skipped }) })));
    expect(h).not.toContain('class="banner');
    expect(h).toContain('>Hats · scrap.tf/buy/hats · not counted</dd>');
    expect(h).toContain('The skipped items say why.');
    expect(h).not.toContain('Webpage, Complete');
    // A save without its cards still gets the remedy on its page line.
    const none = text(renderToString(createElement(ImportResultView, { r: result({ warnings: [NO_CARDS_WARNING] }) })));
    expect(none).toContain('pass over it. Save it again as &#x27;Webpage, Complete&#x27;.">Hats · scrap.tf/buy/hats · not counted</dd>');
  });

  it('shows the warnings as before for any other import', () => {
    const h = text(renderToString(createElement(ImportResultView, { r: result({ parsed: 3, stored: 3, warnings: ['schema-not-loaded: y'] }) })));
    expect(h).not.toContain('class="banner');
    expect(h).toContain('schema-not-loaded: y');
    expect(h).toContain('<strong>3</strong> of 3 items read');
    expect(h).toContain('title="Counted as a save of scrap.tf/buy/hats on the scrap.tf banks page and the Live market strip.">Hats · scrap.tf/buy/hats</dd>');
  });

  it("says a bank page that stored nothing is not counted, as the banks page treats it; the list's always counts", () => {
    const NOT_COUNTED = 'Not counted as a save of scrap.tf/buy/hats: it stored no items, so the scrap.tf banks page and the Live market strip pass over it.';
    const empty = importBankText('hats', 0, true)!;
    expect(empty.text).toBe('Hats · scrap.tf/buy/hats · not counted');
    expect(empty.title).toBe(`${NOT_COUNTED} Save it again as 'Webpage, Complete'.`);
    // Its cards were read but every one was skipped (prices a newer save already set, say): the save type is not to blame.
    expect(importBankText('hats', 0, false)).toEqual({ text: empty.text, title: `${NOT_COUNTED} The skipped items say why.` });
    // A Recent batches row keeps no warnings, so it cannot tell: the remedy is hedged.
    expect(importBankText('hats', 0)).toEqual({ text: empty.text, title: `${NOT_COUNTED} If it was saved before its items showed, save it again as 'Webpage, Complete'.` });
    expect(importBankText('unusuals', 0)!.text).toMatch(/ · not counted$/);
    // Every row sold out still saves the list; a count unknown or above 0 counts as before.
    for (const [bank, stored] of [['list', 0], ['hats', 3], ['hats', undefined], ['hats', null], ['hats', Number.NaN]] as const) {
      expect(importBankText(bank, stored)!.title).toMatch(/^Counted as a save of /);
    }
    expect(importBankText(null, 0)!.text).toBe('Not recognised');
    expect(importBankText(undefined, 0)).toBeNull();
  });
});

describe('turning import off (UX-12)', () => {
  it('names what it also does to the scrap.tf window while the window is on', () => {
    const off = importOffText(false);
    expect(off.confirmLabel).toBe('Turn off import?');
    expect(off.text).toBe('Turning it off stops the folder watch and hides the import buttons. Imported prices stay in your price sheet. Your watch folder choice is cleared.');
    const on = importOffText(true);
    expect(on.text).toBe(
      `${off.text} This also turns off the scrap.tf window and closes it; turn it on again in Settings → scrap.tf window.`,
    );
    expect(on.confirmLabel).toBe('Turn off import and the scrap.tf window?');
    const page = read('pages/ImportPage.tsx');
    expect(page).toContain("const off = importOffText(settings?.scraptfWindow?.enabled === true);");
    expect(page).toContain('confirmLabel={off.confirmLabel}');
    expect(page).toContain("{off.text}");
  });
});

describe('the copy', () => {
  const imp = read('pages/ImportPage.tsx');

  it('Import page: Ctrl+S and the save type, the HTML only note, and the .mhtml file hint by the button', () => {
    expect(imp).toContain('Press <kbd>Ctrl</kbd>+<kbd>S</kbd> and <SaveModeChoice />.');
    // The step offers Single File for any page, so it says the one page it does not suit.
    expect(imp).toContain('{SAVE_MODE_HTML_ONLY_NOTE} {SAVE_MODE_FILES_NOTE} {SAVE_MODE_LIST_ONLY}');
    expect(SAVE_MODE_LIST_ONLY).toBe("For scrap.tf/items, choose 'Webpage, Complete' only: with an image per item, a Single File save of it is too large to import.");
    expect(imp).toMatch(/Import saved page…'\}\s*<\/button>\s*<span id="import-file-hint" className="muted small">\s*\{IMPORT_FILE_HINT\}\s*<\/span>/);
    // The hint is the button's description, so a screen reader hears it on the button too.
    expect(imp).toMatch(/<button type="button" className="btn primary" disabled=\{busy\} aria-describedby="import-file-hint" onClick=\{\(\) => void pickFile\(\)\}>/);
    expect(imp).not.toContain('Webpage, HTML only');
  });

  it('Import page: Recent batches dates a bank by what each batch stored, as the banks page does', () => {
    // F21: a read of the scrap.tf window words its remedy for the window (origin 'window'); 0.7.3: a batch an
    // update emptied names the update, and a result from the bare Unusuals index says so.
    expect(imp).toContain("const bank = b.bank ? importBankText(b.bank, b.itemCount, undefined, b.origin === 'window', importBatchItemsRemoved(b)) : null;");
    expect(imp).toContain("importBankText(r.bank, r.stored, importSavedWithoutCards(r), r.origin === 'window', false, importUnusualsIndex(r))");
  });

  it("Import page: a manual import without cards leaves its toast to the dashboard's, so it shows once", () => {
    expect(imp).toMatch(/if \(!importSavedWithoutCards\(r\)\) \{\s*const t = importToastText\(r\);\s*toast\(t\.text, t\.tone\);/);
  });

  it('no instruction anywhere in the dashboard recommends HTML only', () => {
    for (const f of ['pages/ImportPage.tsx', 'pages/BanksPage.tsx', 'pages/BankStockPage.tsx', 'pages/ItemDrawer.tsx', 'components/ScraptfListCard.tsx', 'banksModel.ts', 'bankStockModel.ts', 'scraptfListModel.ts', 'marketModel.ts']) {
      expect(read(f)).not.toMatch(/(choose|as) <strong>Webpage, HTML only|'Webpage, HTML only'/);
    }
  });

  it('every save step and tip names the save type', () => {
    // scrap.tf/items: Webpage, Complete only (an image per row puts a Single File save over the limits).
    // UX-5: "Or, in your browser, press" with the scrap.tf window on.
    const card = read('components/ScraptfListCard.tsx');
    expect(card).toContain("{w ? 'Or, in your browser, press ' : 'Press '}");
    expect(card).toContain('<kbd>Ctrl</kbd>+<kbd>S</kbd>, <SaveModeChoice alt={false} />, and save it into your watch folder');
    const banks = read('pages/BanksPage.tsx');
    expect(banks).toContain('In the save dialog, <SaveModeChoice />. {SAVE_MODE_LIST_ONLY}');
    expect(banks).toContain('Save it with <kbd>Ctrl</kbd>+<kbd>S</kbd> as <strong>{SAVE_MODE}</strong> into your watch folder');
    const stock = read('pages/BankStockPage.tsx');
    expect(stock).toContain("Save it with <kbd>Ctrl</kbd>+<kbd>S</kbd> into your watch folder and <SaveModeChoice alt={p.bank !== 'list'} />");
    expect(stock).toContain("Press <kbd>Ctrl</kbd>+<kbd>S</kbd>, <SaveModeChoice alt={head.bank !== 'list'} />, and save it into your watch folder");
  });

  it('tooltips that say to save a page name the save type too', () => {
    const complete = "as 'Webpage, Complete'";
    expect(bankFreshness(null, T0).title).toContain(`save it (Ctrl+S) ${complete} into your watch folder`);
    expect(ALL_ITEMS_TIP).toContain(`save scrap.tf/items (Ctrl+S) ${complete} into your watch folder`);
    // 0.7.4 (R38): a list save prices only the rows that show which copy they are, never every price.
    expect(ALL_ITEMS_TIP).not.toMatch(/every scrap\.tf price|price every item/);
    expect(ALL_ITEMS_TIP).toContain('only rows that show which copy they are become prices');
    const notOnList = listPaysCell({ scraptfPaysScrap: null, scraptfStock: null, scraptfStockLimit: null, scraptfFull: false, scraptfListAt: null, revenueScrap: 9 }, null, T0);
    expect(notOnList.title).toContain(`save scrap.tf/items (Ctrl+S) ${complete} into your watch folder`);
    expect(BANK_SAVE_TIP).toContain(`${SAVE_MODE_ALT}') ${SAVE_MODE_REASON}`);
    // A page never saved: what to save, and as what.
    const never = { lastSavedAt: null, pages: 0, items: 0, inStock: 0 };
    expect(bankSavedText(never, T0).title).toBe(`Save this page ${complete} into your watch folder to add its items, prices and stock.`);
    expect(bankSavedText(never, T0, true).title).toMatch(new RegExp(`^Save scrap\\.tf/items ${complete} into your watch folder`));
    expect(listStatusLine({ items: 0, newestAt: null, oldestAt: null, pages: 0 }, T0).title).toMatch(new RegExp(`^Save scrap\\.tf/items ${complete} into your watch folder`));
    const stockNever = bankStockHeader('hats', { savedAt: null, previousSavedAt: null, saves: 0, counts: {}, pages: [], oldestSavedAt: null } as never, T0)!;
    expect(stockNever.saved.title).toContain(`save the page ${complete} into your watch folder`);
    expect(read('pages/BankStockPage.tsx')).toContain('then save {head.path} as <strong>{SAVE_MODE}</strong> into your watch folder.');
    // The item drawer's first-time step and the Live market's "save it again" reminders.
    expect(read('pages/ItemDrawer.tsx')).toContain('Open scrap.tf/items, save it with Ctrl+S as <strong>{SAVE_MODE}</strong> into your watch folder (Import)');
    expect(COVERAGE_TIP).toContain(`save it again (Ctrl+S, ${complete})`);
    expect(emptyFiltersText({ newOnScraptf: true })).toContain(`Ctrl+S into your watch folder, ${complete}`);
    expect(emptyFiltersText({ newOnScraptf: false })).not.toContain('Ctrl+S');
    const drawerLine = drawerBankStockLine({ bank: 'hats', savedAt: T0 - 60_000, change: null, previousCostScrap: null, stock: 1 }, null, T0)!;
    expect(drawerLine.title).toContain(`Save the page again (Ctrl+S, ${complete}) to update this`);
    // Nothing on sale: sold out, or saved before scrap.tf added its cards.
    expect(bankStockFilterEmpty('all').body).toBe(
      "The page you saved lists no item with a price to buy and stock: everything may have been sold out, or the page was saved before scrap.tf added its cards. Save it again as 'Webpage, Complete'.",
    );
  });

  it("lists the brief's 'HTML only' save as a deviation, since the docs that disagree with ARCHITECTURE defer to its list", () => {
    const doc = (rel: string) => readFileSync(new URL(`../../docs/${rel}`, import.meta.url), 'utf8');
    const arch = doc('ARCHITECTURE.md');
    expect(arch).toContain('Where they disagree, this file wins; the deviations are listed at the end.');
    // The brief still says "HTML only" (it is not edited), so its deviation list must say what replaced it.
    expect(doc('DESIGN_BRIEF.md')).toContain('with "HTML only"');
    const deviations = arch.slice(arch.indexOf('## Deviations from the design brief'));
    const entry = deviations.split(/\n(?=\d+\. )/).find((d) => d.includes('"HTML only"'));
    expect(entry).toBeDefined();
    expect(entry).toContain(`"${SAVE_MODE}"`);
    expect(entry).toContain(`"${SAVE_MODE_ALT}"`);
    expect(entry).toContain('scrap.tf/items');
    expect(entry).toContain('`.mhtml`');
  });

  it("scrap.tf/items' Open in browser tooltips offer no Single File save, which the list would be refused for", () => {
    const cards = bankCards(null, null, T0);
    const list = cards.find((c) => c.isList)!;
    expect(list.bank).toBe('list');
    expect(list.openTitle).toBe(`Opens scrap.tf/items in your own browser. Flip Desk never loads scrap.tf on its own. ${LIST_SAVE_TIP}`);
    const stockList = bankStockHeader('list', null, T0)!;
    expect(stockList.openTitle).toBe(list.openTitle);
    for (const t of [list.openTitle, stockList.openTitle]) {
      expect(t).not.toContain(SAVE_MODE_ALT);
      expect(t).toContain(`'${SAVE_MODE}'`);
    }
    // Every bank page keeps the alternative.
    for (const c of cards.filter((x) => !x.isList)) expect(c.openTitle).toContain(SAVE_MODE_ALT);
    expect(bankStockHeader('hats', null, T0)!.openTitle).toContain(BANK_SAVE_TIP);
  });

  it('the dashboard toasts import.done only in its own window, once per batch', () => {
    const ctx = read('hooks/appContext.tsx');
    expect(ctx).toContain("usePush('import.done', (r) => {");
    expect(ctx).toContain("if (windowKind() !== 'dashboard') return;");
    expect(ctx).toContain('notice.current?.batchId === r.batchId');
  });
});

// ---------------------------------------------------------------------------
// The dashboard's toast, mounted against the browser mock
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ToastStack: () => ReactNode;
let useApp: typeof import('../../src/renderer/hooks/appContext').useApp;
/** What useApp().lastImport held at the last render of the probe below. */
let seenLastImport: ImportResult | null | undefined;
function LastImportProbe(): ReactNode {
  seenLastImport = useApp().lastImport;
  return null;
}

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom/client loads: it checks for a DOM once, at import.
  doc = installDomShim();
  win()['location'] = { hash: '#/banks' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider, useApp } = await import('../../src/renderer/hooks/appContext'));
  ({ ToastStack } = await import('../../src/renderer/components/Feedback'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  (win()['location'] as { hash: string }).hash = '#/banks';
});

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(kind: 'dashboard' | 'check' = 'dashboard') {
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  const done = new Set<(p: ImportResult) => void>();
  const w: FlipdeskBridge = {
    windowKind: kind,
    rpc: (m, p) => b.rpc(m, p),
    on: (e, fn) => {
      // 'import.done' comes from the test only: the mock imports nothing without cards.
      if (e !== 'import.done') return b.on(e, fn);
      const f = fn as (p: ImportResult) => void;
      done.add(f);
      return () => done.delete(f);
    },
  };
  win()['flipdesk'] = w;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  seenLastImport = undefined;
  act(() => root.render(createElement(AppProvider, null, createElement(ToastStack), createElement(LastImportProbe))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const toasts = () => container.descendants().filter((e) => (e.getAttribute('class') ?? '').split(/\s+/).includes('toast'));
  const push = async (r: ImportResult) => {
    act(() => {
      for (const f of done) f(r);
    });
    await settle(2);
  };
  const click = async (el: ShimElement | undefined) => {
    expect(el).toBeDefined();
    act(() => {
      el!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle(2);
  };
  /** The push alone, for tests on fake timers (settle waits on a real setTimeout). */
  const pushNow = (r: ImportResult) =>
    act(() => {
      for (const f of done) f(r);
    });
  return { toasts, push, pushNow, click, listeners: () => done.size };
}

describe('the no-cards toast', () => {
  it('shows on any dashboard page, with How to save opening the Import page', async () => {
    const t = await mount();
    expect(t.listeners()).toBeGreaterThan(0);
    await t.push(result({ warnings: [NO_CARDS_WARNING] }));
    const [toast] = t.toasts();
    expect(t.toasts()).toHaveLength(1);
    expect(toast!.getAttribute('class')).toContain('tone-warn');
    expect(toast!.textContent).toContain(`scrap.tf - Buy Hats.html: ${NO_CARDS_SAVED_REASON}`);
    const how = toast!.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent === 'How to save');
    await t.click(how);
    expect((win()['location'] as { hash: string }).hash).toBe('#/import');
    expect(t.toasts()).toHaveLength(0);
  });

  it('shows once per batch, and a newer one replaces the last', async () => {
    const t = await mount();
    await t.push(result({ batchId: 7, warnings: [NO_CARDS_WARNING] }));
    await t.push(result({ batchId: 7, warnings: [NO_CARDS_WARNING] }));
    expect(t.toasts()).toHaveLength(1);
    await t.push(result({ batchId: 8, fileName: 'scrap.tf - Buy Stranges.html', warnings: [NO_CARDS_WARNING] }));
    expect(t.toasts()).toHaveLength(1);
    expect(t.toasts()[0]!.textContent).toContain('scrap.tf - Buy Stranges.html: ');
  });

  it('also toasts a save the folder watch passed over for its size, with How to save', async () => {
    const t = await mount();
    await t.push(result({ batchId: 11, bank: null, pageKind: 'unknown', fileName: 'Item Trading.mhtml', warnings: [tooLargeWarning('24 MB is over the 20 MB import limit')] }));
    expect(t.toasts()).toHaveLength(1);
    expect(t.toasts()[0]!.getAttribute('class')).toContain('tone-warn');
    expect(t.toasts()[0]!.textContent).toContain(`Item Trading.mhtml: ${TOO_LARGE_REASON}`);
    expect(t.toasts()[0]!.descendants().some((e) => e.tagName === 'BUTTON' && e.textContent === 'How to save')).toBe(true);
  });

  it('counts its 20 s only while the dashboard is shown: the user saves in the browser, with the dashboard hidden', async () => {
    const t = await mount();
    const setVisible = (on: boolean) =>
      act(() => {
        (doc as unknown as { visibilityState: string }).visibilityState = on ? 'visible' : 'hidden';
        doc.dispatchEvent(new ShimEvent('visibilitychange'));
      });
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    setVisible(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // Pushed while hidden: still there however long the dashboard stays hidden.
      t.pushNow(result({ batchId: 21, warnings: [NO_CARDS_WARNING] }));
      expect(t.toasts()).toHaveLength(1);
      await advance(NO_CARDS_TOAST_MS * 3);
      expect(t.toasts()).toHaveLength(1);
      // Shown again: the countdown starts from where it was, and runs out.
      setVisible(true);
      await advance(NO_CARDS_TOAST_MS - 1_000);
      expect(t.toasts()).toHaveLength(1);
      await advance(2_000);
      expect(t.toasts()).toHaveLength(0);

      // Pushed while shown, then hidden part-way: the rest waits until it is shown again.
      t.pushNow(result({ batchId: 22, warnings: [NO_CARDS_WARNING] }));
      await advance(NO_CARDS_TOAST_MS / 2);
      setVisible(false);
      await advance(NO_CARDS_TOAST_MS * 3);
      expect(t.toasts()).toHaveLength(1);
      setVisible(true);
      await advance(NO_CARDS_TOAST_MS / 2 + 1_000);
      expect(t.toasts()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      setVisible(true);
    }
  });

  it('says nothing for an import with its cards', async () => {
    const t = await mount();
    await t.push(result({ parsed: 12, stored: 12, warnings: ['no-sku: 1 of 12 items could not be identified'] }));
    expect(t.toasts()).toHaveLength(0);
  });

  it('stays out of the quick-entry and live check windows', async () => {
    const t = await mount('check');
    await t.push(result({ warnings: [NO_CARDS_WARNING] }));
    expect(t.toasts()).toHaveLength(0);
    expect(seenLastImport).toBeNull();
  });

  it('leaves the save it was about for the Import page that How to save opens', async () => {
    const t = await mount();
    expect(seenLastImport).toBeNull();
    const empty = result({ batchId: 9, warnings: [NO_CARDS_WARNING] });
    await t.push(empty);
    expect(seenLastImport).toEqual(empty);
    // The page starts on it, so it shows the banner rather than "Nothing imported in this session yet".
    expect(read('pages/ImportPage.tsx')).toContain('const [last, setLast] = useState<ImportResult | null>(lastImport);');
    const html = renderToString(createElement(ImportResultView, { r: seenLastImport! }));
    expect(html).toContain(NO_CARDS_SAVED_REASON.replace(/'/g, '&#x27;'));
    // Any later import replaces it, with its cards or not.
    const next = result({ batchId: 10, parsed: 12, stored: 12, warnings: [] });
    await t.push(next);
    expect(seenLastImport).toEqual(next);
  });
});
