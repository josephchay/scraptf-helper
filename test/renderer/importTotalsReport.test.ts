// 0.7.1 on the Import page. P5: the skipped items' true total (the list holds the first 500, refusals first)
// and the count per reason, refusals first. P4: "Copy parser report" reads the service's in-memory
// reports ('import.report') and copies them, as JSON text, to the clipboard only; the page says nothing is
// sent. Helpers checked as data, the result rendered server-side, then the page mounted with
// react-dom/client into the minimal DOM in domShim.ts against the browser mock. Nothing leaves the process.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_REPORT_LABEL,
  IMPORT_REPORT_NOTE,
  importReportText,
  importReportToast,
  importSkipSummary,
} from '../../src/renderer/importModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { ImportResultView } from '../../src/renderer/pages/ImportPage';
import { SKIP_NEWER_SAVE, SKIP_OUT_OF_STOCK, SKIP_SAME_OR_CHEAPER } from '../../src/shared/importCodes';
import type { ImportReport, ImportResult } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');

function result(over: Partial<ImportResult> = {}): ImportResult {
  return { batchId: 7, fileName: 'scrap.tf - Items.html', pageKind: 'items-list', parsed: 0, stored: 0, skipped: [], warnings: [], bank: 'list', ...over };
}

describe('skipped items (P5)', () => {
  it('the true total and the count per reason, refusals first, then the most common', () => {
    const skipped = Array.from({ length: 500 }, (_, i) => ({ title: `Item ${i}`, reason: i < 3 ? 'unusual-without-effect' : SKIP_OUT_OF_STOCK }));
    const s = importSkipSummary({
      skipped,
      skippedTotal: 9100,
      skippedCounts: { [SKIP_OUT_OF_STOCK]: 8000, [SKIP_SAME_OR_CHEAPER]: 900, 'unusual-without-effect': 3, 'no-price': 197, junk: Number.NaN, zero: 0 },
    });
    expect(s).toMatchObject({ total: 9100, listed: 500 });
    expect(s.groups).toEqual([
      { reason: 'no-price', count: 197, refusal: true },
      { reason: 'unusual-without-effect', count: 3, refusal: true },
      { reason: SKIP_OUT_OF_STOCK, count: 8000, refusal: false },
      { reason: SKIP_SAME_OR_CHEAPER, count: 900, refusal: false },
    ]);
    expect(importSkipSummary({ skipped: [], skippedCounts: { [SKIP_NEWER_SAVE]: 2 } }).groups[0]).toMatchObject({ refusal: false });
    // As the service orders the list (refusals first): every reason but the three benign ones, the plain
    // fallbacks and a non-refusal first warning included, is something to fix, never sorted among the benign.
    expect(importSkipSummary({ skipped: [], skippedCounts: { [SKIP_OUT_OF_STOCK]: 50, 'item not recognised': 2, 'no price': 1 } }).groups).toEqual([
      { reason: 'item not recognised', count: 2, refusal: true },
      { reason: 'no price', count: 1, refusal: true },
      { reason: SKIP_OUT_OF_STOCK, count: 50, refusal: false },
    ]);
  });

  it('an older service (no totals): the list is the total, with no groups', () => {
    const s = importSkipSummary({ skipped: [{ title: 'a', reason: 'x' }, { title: 'b', reason: 'y' }] });
    expect(s).toEqual({ total: 2, listed: 2, groups: [] });
    // A total under the list's length (a broken answer) never undercounts it.
    expect(importSkipSummary({ skipped: [{ title: 'a', reason: 'x' }], skippedTotal: 0 }).total).toBe(1);
  });

  it('the Import page shows the total, says the list is cut, and counts each reason', () => {
    const r = result({
      skipped: [
        { title: 'Unusual Le Sapeur', reason: 'unusual-without-effect' },
        { title: 'Earbuds', reason: SKIP_OUT_OF_STOCK },
      ],
      skippedTotal: 1240,
      skippedCounts: { 'unusual-without-effect': 1, [SKIP_OUT_OF_STOCK]: 1239 },
    });
    const h = renderToString(createElement(ImportResultView, { r })).replace(/<!-- -->/g, '');
    expect(h).toContain('<summary>1,240 skipped (the first 2 listed, refusals first)</summary>');
    expect(h).toMatch(/<li class="tone-text-warn"><span class="num">1<\/span> unusual-without-effect<\/li><li class="muted"><span class="num">1,239<\/span> out of stock on scrap\.tf<\/li>/);
    // Without totals: as before.
    const before = renderToString(createElement(ImportResultView, { r: result({ skipped: [{ title: 'Earbuds', reason: SKIP_OUT_OF_STOCK }] }) })).replace(/<!-- -->/g, '');
    expect(before).toContain('<summary>1 skipped</summary>');
    expect(before).not.toContain('import-skip-counts');
  });
});

describe('the parser report (P4)', () => {
  it('copies the reports as JSON text, and says nothing is sent', () => {
    expect(IMPORT_REPORT_LABEL).toBe('Copy parser report');
    expect(IMPORT_REPORT_NOTE).toContain('Nothing is sent anywhere.');
    // What the report holds is said as it is (P4's whitelist: titles, not custom names; ids and links scrubbed).
    expect(IMPORT_REPORT_NOTE).toContain('item titles included. No custom names, Steam IDs, asset IDs, links or gift text.');
    expect(importReportText([])).toBeNull();
    expect(importReportText(null)).toBeNull();
    const one = { id: 1, at: T0, origin: 'file', name: 'x.html', pageKind: 'buy', bank: 'hats', page: '/buy/hats', format: 'html', batchId: 3, counts: { dataDefindex: 1, cards: 1, rows: 0, selectedSkipped: 0, duplicates: 0, lookalikes: 0, reserved: 0, notTradable: 0, markdownSoon: 0, markdownOff: 0, countdownCards: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 }, headerColumns: [], warningCodes: {}, items: [] } as ImportReport;
    expect(JSON.parse(importReportText([one])!)).toEqual([one]);
    expect(importReportToast(true, 1)).toEqual({ text: 'Copied the parser report (1 read). Nothing was sent.', tone: 'good' });
    expect(importReportToast(true, 3).text).toBe('Copied the parser report (3 reads). Nothing was sent.');
    expect(importReportToast(false, 2).tone).toBe('bad');
    expect(importReportToast(false, 0).tone).toBe('warn');
  });

  it('the Import page reads import.report on the click, and only copies it', () => {
    const page = read('pages/ImportPage.tsx');
    expect(page).toContain("const reports = await rpc('import.report', {});");
    expect(page).toContain('const copied = text !== null && (await copyText(text));');
    expect(page).toContain('onClick={() => void copyReport()}');
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|links\.open|openLink|openOrCopy\(/);
  });
});

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ImportPage: () => ReactNode;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  win()['location'] = { hash: '#/import' };
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ ImportPage } = await import('../../src/renderer/pages/ImportPage'));
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

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('Copy parser report, against the mock', () => {
  it("reads 'import.report' on the click only and puts its JSON on the clipboard", async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } });
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    await b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    const rpc = vi.spyOn(b, 'rpc');
    win()['flipdesk'] = b;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(AppProvider, null, createElement(ImportPage))));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    await settle();
    const reports = () => rpc.mock.calls.filter((c) => c[0] === 'import.report');
    expect(reports()).toEqual([]);
    const button = container.descendants().find((e) => e.tagName === 'BUTTON' && e.textContent.includes(IMPORT_REPORT_LABEL))!;
    expect(button).toBeDefined();
    act(() => {
      button.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(reports()).toHaveLength(1);
    expect(copied).toHaveLength(1);
    const sample = await b.rpc('import.report', {});
    expect(JSON.parse(copied[0]!)).toEqual(sample);
    expect(container.textContent).toContain(IMPORT_REPORT_NOTE);
  });
});
