// F17 on the scrap.tf banks page (U1): each card's "What's new" line from ScraptfBankSummary.whatsNew
// ("Since your save 3 h ago: 5 new (2 flips) · 3 gone · 2 cheaper · 1 pricier", the first-save line,
// nothing for a page never saved) and its View stock button to #/banks/<bank>/stock; the route helpers
// App uses. Rendered server-side, then mounted in the minimal DOM against the browser mock. Nothing
// leaves the process.

import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BANK_FIRST_SAVE_TEXT,
  BANK_STOCK_SEGMENT,
  bankCards,
  bankStockPath,
  bankStockRouteBank,
  bankWhatsNew,
  banksRouteBank,
  emptyBankSummary,
} from '../../src/renderer/banksModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import type { BanksViewProps } from '../../src/renderer/pages/BanksPage';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { ScraptfBank, ScraptfBankSummary, ScraptfBanksResult, ScraptfBankWhatsNew } from '../../src/shared/types';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 568;
const noop = () => undefined;

const info = (bank: ScraptfBank) => SCRAPTF_BANKS.find((b) => b.bank === bank)!;
const summary = (bank: ScraptfBank, over: Partial<ScraptfBankSummary> = {}): ScraptfBankSummary => ({ ...emptyBankSummary(info(bank)), ...over });
const W = (over: Partial<ScraptfBankWhatsNew> = {}): ScraptfBankWhatsNew => ({ new: 5, newFlips: 2, gone: 3, cheaper: 2, pricier: 1, since: NOW - 3 * HOUR, ...over });
const saved = { lastSavedAt: NOW - 4 * MIN };

describe("bankWhatsNew: the card's line", () => {
  it('"Since your save 3 h ago: 5 new (2 flips) · 3 gone · 2 cheaper · 1 pricier"', () => {
    const v = bankWhatsNew({ ...saved, whatsNew: W() }, NOW, 'scrap.tf/buy/hats')!;
    expect(v.kind).toBe('changes');
    expect(v.lead).toBe('Since your save 3 h ago:');
    expect(v.parts.map((p) => [p.text, p.extra, p.strong])).toEqual([
      ['5 new', '(2 flips)', true],
      ['3 gone', null, false],
      ['2 cheaper', null, false],
      ['1 pricier', null, false],
    ]);
    expect(v.parts.map((p) => p.tone)).toEqual(['good', null, 'good', 'bad']);
    expect(v.title).toContain('Your newest save of scrap.tf/buy/hats against your previous save (');
    expect(v.title).toContain('5 new on sale (2 of them flips), 3 gone, 2 cheaper, 1 pricier. Stock between the two saves is unknown.');
  });

  it('leaves zero counts out, and says so when nothing changed', () => {
    const v = bankWhatsNew({ ...saved, whatsNew: W({ new: 1, newFlips: 1, gone: 0, cheaper: 0, pricier: 0 }) }, NOW)!;
    expect(v.parts.map((p) => [p.text, p.extra])).toEqual([['1 new', '(1 flip)']]);
    const plain = bankWhatsNew({ ...saved, whatsNew: W({ new: 2, newFlips: 0 }) }, NOW)!;
    expect(plain.parts[0]).toMatchObject({ text: '2 new', extra: null, tone: null });
    const none = bankWhatsNew({ ...saved, whatsNew: W({ new: 0, newFlips: 0, gone: 0, cheaper: 0, pricier: 0 }) }, NOW)!;
    expect(none.parts).toEqual([{ text: 'nothing new, gone or repriced', extra: null, tone: 'muted', strong: false }]);
  });

  it('reads odd values safely: no previous time, a clock ahead, negative or broken counts', () => {
    expect(bankWhatsNew({ ...saved, whatsNew: W({ since: null }) }, NOW)!.lead).toBe('Since your previous save:');
    expect(bankWhatsNew({ ...saved, whatsNew: W({ since: NOW + 2 * MIN }) }, NOW)!.lead).toBe('Since your save just now:');
    const odd = bankWhatsNew({ ...saved, whatsNew: W({ new: 2, newFlips: 9, gone: -3, cheaper: Number.NaN, pricier: 1.7 }) }, NOW)!;
    expect(odd.parts.map((p) => [p.text, p.extra])).toEqual([
      ['2 new', '(2 flips)'],
      ['1 pricier', null],
    ]);
  });

  it('a first save asks for another; a page never saved has no line', () => {
    const first = bankWhatsNew({ ...saved, whatsNew: null }, NOW, 'scrap.tf/buy/killstreaks')!;
    expect(first).toMatchObject({ kind: 'first', lead: BANK_FIRST_SAVE_TEXT, parts: [] });
    expect(BANK_FIRST_SAVE_TEXT).toBe('First save: save it again later to see what changed');
    expect(first.title).toContain('Only one save of scrap.tf/buy/killstreaks so far.');
    expect(bankWhatsNew({ lastSavedAt: null, whatsNew: null }, NOW)).toBeNull();
    // A stray whatsNew on a page with no save date stays hidden: the card already says "Never saved".
    expect(bankWhatsNew({ lastSavedAt: null, whatsNew: W() }, NOW)).toBeNull();
  });

  it('every card carries its line and its stock page route', () => {
    const result: ScraptfBanksResult = {
      banks: SCRAPTF_BANKS.map((b) => (b.bank === 'hats' ? summary('hats', { ...saved, items: 48, inStock: 31, whatsNew: W() }) : b.bank === 'killstreaks' ? summary('killstreaks', saved) : summary(b.bank))),
      importEnabled: true,
      watchActive: true,
      generatedAt: NOW,
    };
    const cards = bankCards(result, K, NOW);
    expect(cards.map((c) => c.stockPath)).toEqual(SCRAPTF_BANKS.map((b) => `banks/${b.bank}/stock`));
    expect(cards.find((c) => c.bank === 'hats')!.whatsNew!.lead).toBe('Since your save 3 h ago:');
    expect(cards.find((c) => c.bank === 'killstreaks')!.whatsNew!.kind).toBe('first');
    expect(cards.filter((c) => c.whatsNew === null).map((c) => c.bank)).toEqual(['weapons', 'stranges', 'skins', 'items', 'unusuals', 'list']);
    expect(cards[0]!.stockTitle).toContain('scrap.tf/buy/hats');
  });
});

describe('the stock page route', () => {
  it('banks/<bank>/stock for every known bank, and nothing else', () => {
    for (const b of SCRAPTF_BANKS) {
      expect(bankStockPath(b.bank)).toBe(`banks/${b.bank}/${BANK_STOCK_SEGMENT}`);
      expect(bankStockRouteBank(['banks', b.bank, 'stock'])).toBe(b.bank);
    }
    expect(bankStockPath('nope' as ScraptfBank)).toBeNull();
    expect(bankStockPath(null)).toBeNull();
    expect(bankStockRouteBank(['banks', 'hats'])).toBeNull();
    expect(bankStockRouteBank(['banks'])).toBeNull();
    expect(bankStockRouteBank(['banks', '__proto__', 'stock'])).toBeNull();
    expect(bankStockRouteBank(['banks', 'stock', 'stock'])).toBeNull();
    expect(bankStockRouteBank(['market', 'hats', 'stock'])).toBeNull();
    expect(bankStockRouteBank(['banks', 'hats', 'flips'])).toBeNull();
    // #/banks/<bank> still focuses that card on the banks page.
    expect(banksRouteBank(['banks', 'hats'])).toBe('hats');
  });
});

// ---------------------------------------------------------------------------
// The card, rendered and mounted
// ---------------------------------------------------------------------------

let BanksView: typeof import('../../src/renderer/pages/BanksPage').BanksView;
let BanksPage: typeof import('../../src/renderer/pages/BanksPage').BanksPage;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  win()['location'] = { hash: '#/banks' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ BanksView, BanksPage } = await import('../../src/renderer/pages/BanksPage'));
});

const RESULT: ScraptfBanksResult = {
  banks: SCRAPTF_BANKS.map((b) =>
    b.bank === 'hats'
      ? summary('hats', { ...saved, pages: 1, items: 48, inStock: 31, whatsNew: W() })
      : b.bank === 'killstreaks'
        ? summary('killstreaks', { lastSavedAt: NOW - 26 * HOUR, pages: 1, items: 10, inStock: 8 })
        : summary(b.bank),
  ),
  importEnabled: true,
  watchActive: true,
  generatedAt: NOW,
};

function props(over: Partial<BanksViewProps> = {}): BanksViewProps {
  return {
    result: RESULT,
    error: null,
    status: null,
    now: NOW,
    keyScrap: K,
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
    ...over,
  };
}

const html = () => renderToString(createElement(AppProvider, null, createElement(BanksView, props()))).replace(/<!-- -->/g, '');
const cardHtml = (h: string, bank: ScraptfBank) => {
  const at = h.indexOf(`data-bank="${bank}"`);
  const next = h.indexOf('<section class="card bank-card', at + 1);
  return h.slice(at, next < 0 ? undefined : next);
};

describe('the card, rendered', () => {
  it('shows what changed, the new count in bold, and View stock on every card', () => {
    const h = html();
    const hats = cardHtml(h, 'hats');
    expect(hats).toContain(
      'Since your save 3 h ago:<span class="tone-text-good"> <strong>5 new</strong> (2 flips)</span><span> · 3 gone</span><span class="tone-text-good"> · 2 cheaper</span><span class="tone-text-bad"> · 1 pricier</span>',
    );
    expect(cardHtml(h, 'killstreaks')).toMatch(/<p class="bank-whats-new muted"[^>]*>First save: save it again later to see what changed<\/p>/);
    expect(cardHtml(h, 'skins')).not.toContain('bank-whats-new');
    expect(h.match(/>View stock<svg/g)).toHaveLength(SCRAPTF_BANKS.length);
    for (const b of SCRAPTF_BANKS) expect(h).toContain(`aria-label="View stock: ${b.url.replace('https://', '')}"`);
  });
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  win()['location'] = { hash: '#/banks' };
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function fire(target: ShimElement, type: string) {
  act(() => {
    target.dispatchEvent(new ShimEvent(type, { bubbles: true, cancelable: true }));
  });
}

function mount(node: ReactNode) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, node)));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const card = (bank: ScraptfBank) => container.descendants().find((e) => e.tagName === 'SECTION' && e.getAttribute('data-bank') === bank)!;
  const viewStock = (bank: ScraptfBank) => card(bank).descendants().find((e) => e.tagName === 'BUTTON' && e.textContent === 'View stock')!;
  return { card, viewStock };
}

describe('the card, mounted', () => {
  it('View stock asks for that bank, also on a page never saved', () => {
    const onViewStock = vi.fn();
    const t = mount(createElement(BanksView, props({ onViewStock })));
    fire(t.viewStock('stranges'), 'click');
    fire(t.viewStock('hats'), 'click');
    expect(onViewStock.mock.calls).toEqual([['stranges'], ['hats']]);
  });

  it('against the mock: the line from scraptf.banks, and View stock opens #/banks/<bank>/stock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW }));
    win()['flipdesk'] = b;
    const t = mount(createElement(BanksPage));
    await settle();
    const r = await b.rpc('scraptf.banks', undefined);
    const hats = r.banks.find((x) => x.bank === 'hats')!.whatsNew!;
    expect(t.card('hats').textContent).toContain(`Since your save 3 h ago: ${hats.new} new`);
    expect(t.card('killstreaks').textContent).toContain(BANK_FIRST_SAVE_TEXT);
    expect(t.card('skins').textContent).not.toContain('Since your save');
    fire(t.viewStock('hats'), 'click');
    expect(win()['location']).toEqual({ hash: '#/banks/hats/stock' });
  });
});
