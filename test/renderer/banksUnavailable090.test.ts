// 0.9 (#13): a bank whose newest look said it was not trading (ScraptfBankSummary.unavailableAt): the Banks card's
// warning line (bankUnavailableText, bankCards, BanksPage), and the Import page's "bank not trading" line for such a
// look (importBankText's 7th parameter) with both title variants. Rendered server-side; nothing leaves the process.

import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { bankCards, bankUnavailableText, importBankText } from '../../src/renderer/banksModel';
import { fmtDateTime } from '../../src/renderer/format';
import type { BanksViewProps } from '../../src/renderer/pages/BanksPage';
import { SCRAPTF_BOUNDARY_SHORT } from '../../src/shared/boundaryText';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { ScraptfBank, ScraptfBankSummary, ScraptfBanksResult } from '../../src/shared/types';
import { installDomShim, ShimElement, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60_000;
const noop = () => undefined;

const info = (bank: ScraptfBank) => SCRAPTF_BANKS.find((b) => b.bank === bank)!;
const summary = (bank: ScraptfBank, over: Partial<ScraptfBankSummary> = {}): ScraptfBankSummary => ({
  bank,
  label: info(bank).label,
  url: info(bank).url,
  lastSavedAt: null,
  pages: 0,
  items: 0,
  inStock: 0,
  flips: 0,
  flipProfitScrap: 0,
  top: [],
  unchecked: 0,
  lookFor: [],
  whatsNew: null,
  ...over,
});
const result = (over: Partial<Record<ScraptfBank, Partial<ScraptfBankSummary>>> = {}): ScraptfBanksResult => ({
  banks: SCRAPTF_BANKS.map((b) => summary(b.bank, over[b.bank] ?? {})),
  importEnabled: true,
  watchActive: true,
  generatedAt: T0,
});

describe('0.9 (#13): bankUnavailableText', () => {
  it('says when the look said the bank was not trading, and what that look did and did not store', () => {
    const at = T0 - 12 * MIN;
    const v = bankUnavailableText({ unavailableAt: at }, T0, 'scrap.tf/buy/hats')!;
    expect(v.text).toBe('scrap.tf said it was not trading at your look 12 min ago');
    expect(v.title).toBe(
      `Your look at scrap.tf/buy/hats of ${fmtDateTime(at)} showed scrap.tf's notice that this bank is not trading (for example "Hat Banking is temporarily disabled"). That look stored no bank stock save, so nothing on it reads as sold; the stock, changes and flips here are from your save before it. Flip Desk reads the notice from the page's text, a form no real save has confirmed yet: if it is wrong, copy the parser report on the Import page. ${SCRAPTF_BOUNDARY_SHORT}`,
    );
    // A look stamped a little ahead of this clock is "just now", never "in the future".
    expect(bankUnavailableText({ unavailableAt: T0 + 30_000 }, T0, 'scrap.tf/buy/hats')!.text).toBe('scrap.tf said it was not trading at your look just now');
  });

  it('is null without the field, or with a time that is not a number', () => {
    expect(bankUnavailableText({}, T0, 'scrap.tf/buy/hats')).toBeNull();
    expect(bankUnavailableText({ unavailableAt: undefined }, T0, 'scrap.tf/buy/hats')).toBeNull();
    expect(bankUnavailableText({ unavailableAt: Number.NaN }, T0, 'scrap.tf/buy/hats')).toBeNull();
    expect(bankUnavailableText({ unavailableAt: 'x' as unknown as number }, T0, 'scrap.tf/buy/hats')).toBeNull();
  });
});

describe('0.9 (#13): bankCards(...).unavailable', () => {
  it('is null on every card without the field, and the line on the card that has it', () => {
    expect(bankCards(result(), 568, T0).every((c) => c.unavailable === null)).toBe(true);
    const cards = bankCards(result({ hats: { lastSavedAt: T0 - 3 * 60 * MIN, unavailableAt: T0 - 5 * MIN } }), 568, T0);
    const hats = cards.find((c) => c.bank === 'hats')!;
    expect(hats.unavailable).toEqual(bankUnavailableText({ unavailableAt: T0 - 5 * MIN }, T0, 'scrap.tf/buy/hats'));
    expect(cards.filter((c) => c.unavailable !== null).map((c) => c.bank)).toEqual(['hats']);
  });
});

describe('0.9 (#13): importBankText for a look whose page said its bank was not trading', () => {
  it('says "bank not trading" first, whatever was stored, with the saved or read wording', () => {
    const saved = importBankText('hats', 0, true, false, false, false, true)!;
    expect(saved.text).toBe('Hats · scrap.tf/buy/hats · bank not trading');
    expect(saved.title).toBe(
      'scrap.tf\'s page said this bank was not trading when it was saved (a notice such as "Hat Banking is temporarily disabled"), so this look stores no bank stock save and nothing on it reads as sold. It stored no prices. Look again once scrap.tf trades again.',
    );
    const read = importBankText('hats', 3, false, true, false, false, true)!;
    expect(read.text).toBe('Hats · scrap.tf/buy/hats · bank not trading');
    expect(read.title).toBe(
      'scrap.tf\'s page said this bank was not trading when it was read (a notice such as "Hat Banking is temporarily disabled"), so this look stores no bank stock save and nothing on it reads as sold. The prices it showed were stored as usual. Look again once scrap.tf trades again.',
    );
    // An ImportBatch keeps no warnings: the stored count alone decides the second sentence.
    expect(importBankText('weapons', undefined, undefined, false, false, false, true)!.title).toContain('It stored no prices.');
  });

  it('leaves every 0.8 line as it was without the flag, and an unknown bank "Not recognised"', () => {
    expect(importBankText('hats', 0, true, false, false, false)).toEqual(importBankText('hats', 0, true, false, false, false, false));
    expect(importBankText('hats', 0, true)!.text).toBe('Hats · scrap.tf/buy/hats · not counted');
    expect(importBankText('hats', 48)!.text).toBe('Hats · scrap.tf/buy/hats');
    expect(importBankText(null, 0, true, false, false, false, true)!.text).toBe('Not recognised');
    expect(importBankText(undefined, 0, true, false, false, false, true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BanksPage, rendered
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let BanksView: typeof import('../../src/renderer/pages/BanksPage').BanksView;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/banks' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ BanksView } = await import('../../src/renderer/pages/BanksPage'));
});

function props(r: ScraptfBanksResult): BanksViewProps {
  return {
    result: r,
    error: null,
    status: null,
    now: T0,
    keyScrap: 568,
    picking: false,
    focusBank: null,
    onRetry: noop,
    onPickFolder: noop,
    onGoImport: noop,
    onCopyPath: noop,
    onOpenBank: noop,
    onImportOff: noop,
    onItem: noop,
    onItemMenu: noop,
    onSeeAll: noop,
    onViewStock: noop,
  };
}
const html = (r: ScraptfBanksResult) => renderToString(createElement(AppProvider, null, createElement(BanksView, props(r)))).replace(/<!-- -->/g, '');

describe('0.9 (#13): the Banks card line, rendered', () => {
  it('shows .bank-unavailable only on the card whose summary has the field, after its saved line', () => {
    expect(html(result())).not.toContain('bank-unavailable');
    const h = html(result({ hats: { lastSavedAt: T0 - 3 * 60 * MIN, unavailableAt: T0 - 5 * MIN } }));
    expect(h.match(/class="bank-unavailable small tone-text-warn"/g)).toHaveLength(1);
    const hats = h.slice(h.indexOf('data-bank="hats"'), h.indexOf('data-bank="weapons"') > 0 ? h.indexOf('data-bank="weapons"') : undefined);
    expect(hats).toMatch(/<p class="bank-unavailable small tone-text-warn" title="Your look at scrap\.tf\/buy\/hats of [^"]+">.*?<\/svg> scrap\.tf said it was not trading at your look 5 min ago<\/p>/);
    expect(hats.indexOf('class="bank-saved"')).toBeLessThan(hats.indexOf('class="bank-unavailable'));
  });
});
