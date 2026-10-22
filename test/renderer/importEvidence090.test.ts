// 0.9 (#13): the Import page's side of the parser evidence: importBankUnavailable (a look whose page said its bank is
// not trading), importReportMarkers (the copied reports' counts, summed; a 0.8 report counts 0), the Copy parser
// report toast's evidence sentence (every 0.8 text byte-identical when those counts are 0 or absent), and the scrap.tf
// window's words for the bank-unavailable code. Pure; nothing here reads a file or contacts anything.

import { describe, expect, it } from 'vitest';
import { importBankUnavailable, importReportMarkers, importReportToast, type ImportReportMarkers } from '../../src/renderer/importModel';
import { readWarningText } from '../../src/renderer/scraptfWindowModel';
import { BANK_UNAVAILABLE, BANK_UNAVAILABLE_WARNING } from '../../src/shared/importCodes';
import type { ImportReport } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);

const ZERO: ImportReport['counts'] = {
  dataDefindex: 0,
  cards: 0,
  rows: 0,
  selectedSkipped: 0,
  duplicates: 0,
  lookalikes: 0,
  reserved: 0,
  notTradable: 0,
  markdownSoon: 0,
  markdownOff: 0,
  countdownCards: 0,
  recentlyTraded: 0,
  recentCards: 0,
  bankNotices: 0,
};
function report(counts: Partial<ImportReport['counts']>, id = 1): ImportReport {
  return { id, at: T0, origin: 'file', name: 'hats.html', pageKind: 'buy', bank: 'hats', page: '/buy/hats', format: 'html', batchId: id, counts: { ...ZERO, ...counts }, headerColumns: [], warningCodes: {}, items: [] };
}

describe('0.9 (#13): importBankUnavailable', () => {
  it('is true only when the warnings carry the bank-unavailable code', () => {
    expect(importBankUnavailable({ warnings: [BANK_UNAVAILABLE_WARNING] })).toBe(true);
    expect(importBankUnavailable({ warnings: ['page-kind-guessed: x', `${BANK_UNAVAILABLE}: anything`] })).toBe(true);
    expect(importBankUnavailable({ warnings: ['no-cards-saved: This page was saved without its items.'] })).toBe(false);
    // The code, not a mention of it.
    expect(importBankUnavailable({ warnings: ['no-items: bank-unavailable'] })).toBe(false);
    expect(importBankUnavailable({ warnings: [] })).toBe(false);
    expect(importBankUnavailable(null)).toBe(false);
    expect(importBankUnavailable(undefined)).toBe(false);
    expect(importBankUnavailable({ warnings: [7, null] as unknown as string[] })).toBe(false);
  });
});

describe('0.9 (#13): importReportMarkers', () => {
  it('sums each report: reserved, not tradable, both markdown kinds, countdowns, both "recent" counts and bank notices', () => {
    const m = importReportMarkers([
      report({ reserved: 1, notTradable: 2, markdownSoon: 1, markdownOff: 2, countdownCards: 1, recentlyTraded: 1, recentCards: 3, bankNotices: 1 }, 1),
      report({ reserved: 2, markdownOff: 1, countdownCards: 2, bankNotices: 1 }, 2),
    ]);
    expect(m).toEqual({ reserved: 3, notTradable: 2, markdown: 4, countdowns: 3, recentlyTraded: 1, recentCards: 3, bankNotices: 2 });
  });

  it("counts a 0.8 report's missing fields, and anything not a finite count, as 0", () => {
    const old = { ...report({ reserved: 1, notTradable: 1 }) } as ImportReport;
    const c = old.counts as Partial<ImportReport['counts']>;
    for (const k of ['markdownSoon', 'markdownOff', 'countdownCards', 'recentlyTraded', 'recentCards', 'bankNotices'] as const) delete c[k];
    expect(importReportMarkers([old])).toEqual({ reserved: 1, notTradable: 1, markdown: 0, countdowns: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 });
    const odd = report({ reserved: Number.NaN, notTradable: Infinity, markdownSoon: -2, countdownCards: '3' as unknown as number });
    expect(importReportMarkers([odd])).toEqual({ reserved: 0, notTradable: 0, markdown: 0, countdowns: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 });
    expect(importReportMarkers([{ ...report({}), counts: undefined } as unknown as ImportReport])).toEqual({ reserved: 0, notTradable: 0, markdown: 0, countdowns: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 });
    expect(importReportMarkers([])).toEqual({ reserved: 0, notTradable: 0, markdown: 0, countdowns: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 });
    expect(importReportMarkers(null)).toEqual({ reserved: 0, notTradable: 0, markdown: 0, countdowns: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 });
  });
});

describe('0.9 (#13): the Copy parser report toast', () => {
  const base = 'Copied the parser report (2 reads). Nothing was sent.';
  const m = (over: Partial<ImportReportMarkers>): ImportReportMarkers => ({ reserved: 0, notTradable: 0, ...over });

  it('adds one sentence naming each kind of wording the reads showed, in order', () => {
    expect(importReportToast(true, 2, m({ markdown: 1 })).text).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (1 price-drop line); the report shows it.`);
    expect(importReportToast(true, 2, m({ markdown: 3 })).text).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (3 price-drop lines); the report shows it.`);
    expect(importReportToast(true, 2, m({ countdowns: 1 })).text).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (1 countdown); the report shows it.`);
    expect(importReportToast(true, 2, m({ countdowns: 2 })).text).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (2 countdowns); the report shows it.`);
    expect(importReportToast(true, 2, m({ recentlyTraded: 4 })).text).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (a "recently traded" section); the report shows it.`);
    expect(importReportToast(true, 2, m({ bankNotices: 1 })).text).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (1 bank notice); the report shows it.`);
    expect(importReportToast(true, 2, m({ bankNotices: 2 })).text).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (2 bank notices); the report shows it.`);
    expect(importReportToast(true, 2, { reserved: 1, notTradable: 0, markdown: 2, countdowns: 1, recentlyTraded: 1, bankNotices: 1 })).toEqual({
      text: `${base} Your reads marked 1 card reserved and 0 not tradable; the report shows how. They also showed scrap.tf wording Flip Desk only records (2 price-drop lines, 1 countdown, a "recently traded" section, 1 bank notice); the report shows it.`,
      tone: 'good',
    });
  });

  it('names a "recently traded" section only when that wording was seen, never for cards under a mere "recent" id or class', () => {
    // A /buy/hats page whose cards sit in <div class="recently-viewed"> and that says nothing about "recently traded".
    const viewed = importReportMarkers([report({ recentCards: 1 })]);
    expect(viewed).toMatchObject({ recentlyTraded: 0, recentCards: 1 });
    const one = importReportToast(true, 2, viewed).text;
    expect(one).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (1 card in a part of the page marked "recent"); the report shows it.`);
    expect(one).not.toContain('recently traded');
    expect(importReportToast(true, 2, m({ recentCards: 3 })).text).toBe(`${base} They also showed scrap.tf wording Flip Desk only records (3 cards in a part of the page marked "recent"); the report shows it.`);
    // With the wording seen, the section is named (its cards are the section's).
    expect(importReportToast(true, 2, importReportMarkers([report({ recentlyTraded: 1, recentCards: 2 })])).text).toBe(
      `${base} They also showed scrap.tf wording Flip Desk only records (a "recently traded" section); the report shows it.`,
    );
  });

  it('keeps every 0.8 text byte-identical with the new counts at 0 or absent', () => {
    expect(importReportToast(true, 2, m({ markdown: 0, countdowns: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 })).text).toBe(base);
    expect(importReportToast(true, 2, m({})).text).toBe(base);
    expect(importReportToast(true, 1).text).toBe('Copied the parser report (1 read). Nothing was sent.');
    expect(importReportToast(true, 2, { reserved: 1, notTradable: 2 }).text).toBe(`${base} Your reads marked 1 card reserved and 2 not tradable; the report shows how.`);
    // Nothing copied, or nothing read: no evidence sentence either.
    expect(importReportToast(false, 2, m({ markdown: 3 }))).toEqual({ text: 'Could not copy the parser report.', tone: 'bad' });
    expect(importReportToast(true, 0, m({ bankNotices: 1 })).tone).toBe('warn');
    // The sum of reports with no evidence gives the 0.8 text.
    expect(importReportToast(true, 2, importReportMarkers([report({}), report({}, 2)])).text).toBe(base);
  });
});

describe("0.9 (#13): the scrap.tf window's words for a page saying its bank is not trading", () => {
  it('reads the code in window words, under the 140-character cap', () => {
    const words = 'scrap.tf says this bank is not trading right now: no stock save, and nothing on it reads as sold';
    expect(readWarningText(BANK_UNAVAILABLE_WARNING)).toBe(words);
    expect(readWarningText(`${BANK_UNAVAILABLE}: anything the page said`)).toBe(words);
    expect(words.length).toBeLessThanOrEqual(140);
  });
});
