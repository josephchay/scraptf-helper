// F15 scrap.tf banks page model (src/renderer/banksModel.ts): one card per scrap.tf page in
// SCRAPTF_BANKS order with static labels and addresses, the header's "N of 8 saved in the last
// hour", freshness, the saved line, flips and what to look for, the drawer's "Seen on" line, grid
// keys, routes, and the loader that keeps one read in flight and never rolls the cards back.
// Pure, plus the browser mock for real answers. No network: nothing here can reach scrap.tf.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BANKS_RECENT_MS,
  BANKS_REFRESH_MS,
  BANKS_ROUTE,
  BANK_SAVE_TIP,
  bankCards,
  bankFlipRow,
  bankFlipsText,
  bankFreshness,
  bankGridMove,
  bankLookForRow,
  bankLookForText,
  bankPath,
  bankSavedText,
  banksHeadline,
  banksInOrder,
  banksPath,
  banksRouteBank,
  banksSavedRecently,
  createBanksLoader,
  emptyBankSummary,
  gridColumns,
  importBankText,
  seenOnText,
} from '../../src/renderer/banksModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { SCRAPTF_BANKS, SCRAPTF_ITEMS_URL, STATIC_EXTERNAL_URLS, isAllowedExternalUrl } from '../../src/shared/links';
import type { ScraptfBank, ScraptfBankSummary, ScraptfBanksResult } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 568;

const info = (bank: ScraptfBank) => SCRAPTF_BANKS.find((b) => b.bank === bank)!;
const summary = (bank: ScraptfBank, over: Partial<ScraptfBankSummary> = {}): ScraptfBankSummary => ({ ...emptyBankSummary(info(bank)), ...over });
const result = (banks: ScraptfBankSummary[], over: Partial<ScraptfBanksResult> = {}): ScraptfBanksResult => ({ banks, importEnabled: true, watchActive: true, generatedAt: NOW, ...over });
const all = (over: Partial<Record<ScraptfBank, Partial<ScraptfBankSummary>>> = {}) => SCRAPTF_BANKS.map((b) => summary(b.bank, over[b.bank] ?? {}));

describe('the cards', () => {
  it('are the eight SCRAPTF_BANKS pages in order, the /items list last', () => {
    expect(SCRAPTF_BANKS).toHaveLength(8);
    const cards = bankCards(result(all()), K, NOW);
    expect(cards.map((c) => c.bank)).toEqual(['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'items', 'unusuals', 'list']);
    expect(cards.map((c) => c.path)).toEqual([
      'scrap.tf/buy/hats',
      'scrap.tf/buy/weapons',
      'scrap.tf/buy/stranges',
      'scrap.tf/buy/killstreaks',
      'scrap.tf/buy/skins',
      'scrap.tf/buy/items',
      'scrap.tf/unusuals',
      'scrap.tf/items',
    ]);
    expect(cards.filter((c) => c.isList).map((c) => c.bank)).toEqual(['list']);
    // Only the bank pages have things to look for (the list sells no category of its own).
    expect(cards.filter((c) => c.lookFor === null).map((c) => c.bank)).toEqual(['list']);
  });

  it('keep the static labels and addresses, whatever the service sent, and only allowlisted ones', () => {
    const odd = result([
      { ...summary('unusuals'), label: 'Evil', url: 'https://evil.example/x' },
      summary('hats'),
      summary('hats', { items: 99 }),
      { ...summary('hats'), bank: '__proto__' as ScraptfBank },
      { ...summary('hats'), bank: 'nope' as ScraptfBank },
    ]);
    const rows = banksInOrder(odd);
    expect(rows.map((r) => r.summary.bank)).toEqual(SCRAPTF_BANKS.map((b) => b.bank));
    expect(rows.find((r) => r.info.bank === 'unusuals')!.summary).toMatchObject({ label: 'Unusuals', url: 'https://scrap.tf/unusuals' });
    // The first summary of a bank counts; a repeat cannot change it.
    expect(rows.find((r) => r.info.bank === 'hats')!.summary.items).toBe(0);
    for (const c of bankCards(odd, K, NOW)) {
      expect(STATIC_EXTERNAL_URLS).toContain(c.url);
      expect(isAllowedExternalUrl(c.url)).toBe(true);
    }
    expect(bankCards(odd, K, NOW).find((c) => c.bank === 'list')!.url).toBe(SCRAPTF_ITEMS_URL);
    // Nothing answered yet, or a broken answer: every bank, never saved.
    for (const r of [null, undefined, { banks: null as never }]) {
      expect(banksInOrder(r).map((x) => x.summary)).toEqual(SCRAPTF_BANKS.map((b) => emptyBankSummary(b)));
    }
  });

  it('name a page by its address without the scheme', () => {
    expect(bankPath('https://scrap.tf/buy/hats')).toBe('scrap.tf/buy/hats');
    expect(bankPath(SCRAPTF_ITEMS_URL)).toBe('scrap.tf/items');
  });
});

describe('the header', () => {
  it('counts the pages saved in the last hour, out of all eight', () => {
    const banks = all({ hats: { lastSavedAt: NOW - 4 * MIN }, unusuals: { lastSavedAt: NOW - HOUR }, stranges: { lastSavedAt: NOW - HOUR - 1 }, list: { lastSavedAt: NOW + 90_000 } });
    expect(BANKS_RECENT_MS).toBe(HOUR);
    expect(banksSavedRecently(banks, NOW)).toBe(3);
    expect(banksHeadline(result(banks), NOW).text).toBe('3 of 8 scrap.tf pages saved in the last hour');
    expect(banksHeadline(result(all()), NOW).text).toBe('0 of 8 scrap.tf pages saved in the last hour');
    expect(banksHeadline(null, NOW).text).toBe('… of 8 scrap.tf pages saved in the last hour');
    expect(banksHeadline(null, NOW).title).toContain('Older saves still count');
    expect(banksSavedRecently([{ lastSavedAt: Number.NaN }, { lastSavedAt: null }], NOW)).toBe(0);
  });
});

describe('one card', () => {
  it('tones its pill like the coverage chips: green to 15 min, amber to 2 h, else muted or never saved', () => {
    expect(bankFreshness(NOW - 15 * MIN, NOW)).toMatchObject({ tone: 'good', label: 'Fresh' });
    expect(bankFreshness(NOW + MIN, NOW)).toMatchObject({ tone: 'good', label: 'Fresh' });
    expect(bankFreshness(NOW - 15 * MIN - 1, NOW)).toMatchObject({ tone: 'warn', label: 'Aging' });
    expect(bankFreshness(NOW - 2 * HOUR, NOW)).toMatchObject({ tone: 'warn', label: 'Aging' });
    expect(bankFreshness(NOW - 2 * HOUR - 1, NOW)).toMatchObject({ tone: 'muted', label: 'Stale' });
    expect(bankFreshness(null, NOW)).toMatchObject({ tone: 'muted', label: 'Never saved' });
    expect(bankFreshness(Number.NaN, NOW).label).toBe('Never saved');
  });

  it('says when it was saved, how many items and how many in stock', () => {
    expect(bankSavedText({ lastSavedAt: NOW - 4 * MIN, pages: 1, items: 48, inStock: 31 }, NOW).text).toBe('saved 4 min ago · 48 items (31 in stock)');
    expect(bankSavedText({ lastSavedAt: NOW - 1000, pages: 1, items: 1, inStock: 1 }, NOW).text).toBe('saved just now · 1 item (1 in stock)');
    // Another machine's file time a little ahead of the clock reads "just now".
    expect(bankSavedText({ lastSavedAt: NOW + 2 * MIN, pages: 1, items: 2341, inStock: 1800 }, NOW).text).toBe('saved just now · 2,341 items (1,800 in stock)');
    // In stock never exceeds the items; junk reads as 0.
    expect(bankSavedText({ lastSavedAt: NOW - HOUR, pages: 1, items: 3, inStock: 9 }, NOW).text).toBe('saved 1 h ago · 3 items (3 in stock)');
    expect(bankSavedText({ lastSavedAt: NOW - HOUR, pages: 1, items: Number.NaN, inStock: -2 }, NOW).text).toBe('saved 1 h ago · 0 items (0 in stock)');
    const many = bankSavedText({ lastSavedAt: NOW - 3 * MIN, pages: 3, items: 244, inStock: 188 }, NOW, true);
    expect(many.title).toContain('from 3 saved pages');
    expect(many.title).toContain('on your saved price list');
    expect(bankSavedText({ lastSavedAt: null, pages: 0, items: 0, inStock: 0 }, NOW)).toMatchObject({ text: 'Not saved yet' });
    expect(bankSavedText({ lastSavedAt: null, pages: 0, items: 0, inStock: 0 }, NOW, true).title).toContain('scrap.tf/items');
  });

  it('counts its flips and their profit: "Flips from this page: 3 (+2.11 ref)"', () => {
    expect(bankFlipsText({ flips: 3, flipProfitScrap: 19 }, K)).toMatchObject({ text: 'Flips from this page: 3', profit: '(+2.11 ref)' });
    expect(bankFlipsText({ flips: 3, flipProfitScrap: 19 }, K, true).text).toBe('Flips from your price list: 3');
    expect(bankFlipsText({ flips: 1, flipProfitScrap: 600 }, K).profit).toBe('(+1 key 3.55 ref)');
    expect(bankFlipsText({ flips: 0, flipProfitScrap: 0 }, K)).toMatchObject({ text: 'Flips from this page: 0', profit: null });
    expect(bankFlipsText({ flips: 0, flipProfitScrap: 0 }, K).title).toMatch(/^No profitable opportunity/);
  });

  it('lists a flip with its profit, cost and confidence, and what to look for with its Pay up to', () => {
    const f = bankFlipRow({ sku: '211;11;kt-2', name: 'Strange Specialized Killstreak Medi Gun', profitScrap: 32, costScrap: 40, revenueScrap: 80, confidenceLevel: 'high' }, K);
    expect(f).toMatchObject({ sku: '211;11;kt-2', profit: '+3.55 ref', cost: 'buy 4.44 ref', level: 'high', confidence: 'High' });
    expect(f.title).toContain('a backpack.tf buyer pays 8.88 ref');
    // A row without a name shows its SKU; an unknown confidence reads as low.
    expect(bankFlipRow({ sku: '5021;6', name: ' ', profitScrap: 1, costScrap: 1, revenueScrap: 3, confidenceLevel: 'nope' as never }, K)).toMatchObject({ name: '5021;6', level: 'low' });
    const l = bankLookForRow({ sku: '30357;6', name: 'Dell in the Shell', maxCostScrap: 7, revenueScrap: 12 }, K);
    expect(l).toMatchObject({ sku: '30357;6', name: 'Dell in the Shell', payUpTo: 'up to 0.77 ref' });
    expect(l.title).toContain('no scrap.tf price for it yet');
  });

  it('says why nothing is listed to look for, and links to all of them', () => {
    expect(bankLookForText({ unchecked: 23, lookFor: [{ sku: 'a', name: 'A', maxCostScrap: 1, revenueScrap: 2 }] })).toMatchObject({ empty: null, seeAll: 'See all 23 not checked' });
    expect(bankLookForText({ unchecked: 0, lookFor: [] })).toMatchObject({ seeAll: null });
    expect(bankLookForText({ unchecked: 0, lookFor: [] }).empty).toMatch(/^Nothing to look for/);
    expect(bankLookForText({ unchecked: 1, lookFor: [] })).toMatchObject({ empty: '1 item with buyers has no scrap.tf price of yours, none with a Pay up to above 0.', seeAll: 'See all 1 not checked' });
    expect(bankLookForText({ unchecked: 1, lookFor: [] }).seeAllTitle).toContain('Not checked');
  });

  it('caps the rows it shows and skips broken ones', () => {
    const flip = (i: number) => ({ sku: `${i};6`, name: `Item ${i}`, profitScrap: 10 - i, costScrap: 5, revenueScrap: 20, confidenceLevel: 'medium' as const });
    const look = (i: number) => ({ sku: `${i};6`, name: `Item ${i}`, maxCostScrap: 10 - i, revenueScrap: 20 });
    const c = bankCards(result(all({ hats: { flips: 5, flipProfitScrap: 40, top: [flip(1), { sku: 1 } as never, flip(2), flip(3), flip(4)], unchecked: 9, lookFor: [1, 2, 3, 4, 5, 6].map(look) } })), K, NOW)[0]!;
    expect(c.top.map((r) => r.sku)).toEqual(['1;6', '2;6', '3;6']);
    expect(c.lookFor!.rows.map((r) => r.sku)).toEqual(['1;6', '2;6', '3;6', '4;6', '5;6']);
    expect(c.lookFor!.seeAll).toBe('See all 9 not checked');
    expect(c.openTitle).toBe(`Opens scrap.tf/buy/hats in your own browser; the app never visits it. ${BANK_SAVE_TIP}`);
    // F18: which save type, the alternative and why.
    expect(BANK_SAVE_TIP).toBe(
      "Save it with Ctrl+S into your watch folder as 'Webpage, Complete' (or 'Webpage, Single File (.mhtml)') so cards scrap.tf added after the page loaded are included; it updates here within seconds.",
    );
  });
});

describe('the item drawer: "Seen on scrap.tf/buy/stranges · 12 min ago"', () => {
  it('names the static page the newest imported price came from, and when', () => {
    expect(seenOnText({ bank: 'stranges', at: NOW - 12 * MIN }, NOW)).toMatchObject({ text: 'Seen on scrap.tf/buy/stranges · 12 min ago' });
    expect(seenOnText({ bank: 'unusuals', at: NOW + MIN }, NOW)!.text).toBe('Seen on scrap.tf/unusuals · just now');
    expect(seenOnText({ bank: 'list', at: NOW - 2 * HOUR }, NOW)!.text).toBe('Seen on scrap.tf/items · 2 h ago');
    expect(seenOnText({ bank: 'hats', at: Number.NaN }, NOW)!.text).toBe('Seen on scrap.tf/buy/hats');
    expect(seenOnText({ bank: 'hats', at: NOW }, NOW)!.title).toContain('The app never visits scrap.tf.');
    expect(seenOnText(null, NOW)).toBeNull();
    expect(seenOnText({ bank: '__proto__' as ScraptfBank, at: NOW }, NOW)).toBeNull();
  });

  it('never claims an imported price of its own for a painted item seen through another copy', () => {
    // itemSeenOn falls back to the base SKU's other copies for a painted SKU with no imported price
    // (test/domain/viewsSeenOn.test.ts), and the drawer shows this same line for it.
    const title = seenOnText({ bank: 'hats', at: NOW - 30 * MIN }, NOW)!.title;
    expect(title).not.toMatch(/^Your newest imported price for this item came from/);
    expect(title).toContain('for a painted item with none of its own, for another copy of it');
    expect(title).toContain('came from your saved copy of scrap.tf/buy/hats');
    // The README says the same.
    const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
    const line = readme.split('\n').find((l) => l.includes('*Seen on scrap.tf/buy/stranges'))!;
    expect(line).toMatch(/painted item with no imported price of its own shows where another copy of it/);
  });
});

describe('the Import page: which card a saved page counts for', () => {
  it('names the static page the parser recognised, says when none was, and nothing without the field', () => {
    expect(importBankText('stranges')).toMatchObject({ text: 'Stranges · scrap.tf/buy/stranges' });
    expect(importBankText('list')!.text).toBe(`${info('list').label} · scrap.tf/items`);
    expect(importBankText('unusuals')!.title).toContain('scrap.tf/unusuals');
    // An unrecognised page (an unknown /buy/<slug>, a page saved elsewhere) is filed by its items' categories.
    expect(importBankText(null)).toMatchObject({ text: 'Not recognised' });
    expect(importBankText(null)!.title).toContain('categories');
    expect(importBankText('__proto__' as ScraptfBank)!.text).toBe('Not recognised');
    expect(importBankText(undefined)).toBeNull();
  });
});

describe('keys and routes', () => {
  it('moves through a wrapped grid: left and right by one, up and down by a row, Home and End', () => {
    // 8 cards in 3 columns: rows [0 1 2] [3 4 5] [6 7].
    expect(bankGridMove(0, 'ArrowRight', 8, 3)).toBe(1);
    expect(bankGridMove(1, 'ArrowLeft', 8, 3)).toBe(0);
    expect(bankGridMove(0, 'ArrowLeft', 8, 3)).toBeNull();
    expect(bankGridMove(7, 'ArrowRight', 8, 3)).toBeNull();
    expect(bankGridMove(1, 'ArrowDown', 8, 3)).toBe(4);
    expect(bankGridMove(4, 'ArrowDown', 8, 3)).toBe(7);
    expect(bankGridMove(5, 'ArrowDown', 8, 3)).toBeNull();
    expect(bankGridMove(4, 'ArrowUp', 8, 3)).toBe(1);
    expect(bankGridMove(1, 'ArrowUp', 8, 3)).toBeNull();
    expect(bankGridMove(4, 'Home', 8, 3)).toBe(0);
    expect(bankGridMove(4, 'End', 8, 3)).toBe(7);
    expect(bankGridMove(7, 'End', 8, 3)).toBeNull();
    expect(bankGridMove(2, 'Enter', 8, 3)).toBeNull();
    // One column (a narrow window): up and down step one.
    expect(bankGridMove(2, 'ArrowDown', 8, 1)).toBe(3);
    expect(bankGridMove(2, 'ArrowDown', 8, 0)).toBe(3);
    expect(bankGridMove(0, 'ArrowRight', 0, 3)).toBeNull();
  });

  it("reads the columns from the cards' top edges", () => {
    expect(gridColumns([10, 10, 10, 200, 200, 200, 390, 390])).toBe(3);
    expect(gridColumns([10, 11, 200])).toBe(2);
    expect(gridColumns([0, 0, 0, 0])).toBe(4);
    expect(gridColumns([])).toBe(1);
  });

  it('routes #/banks and #/banks/<bank>, and nothing else', () => {
    expect(BANKS_ROUTE).toBe('banks');
    expect(banksPath()).toBe('banks');
    expect(banksPath(null)).toBe('banks');
    expect(banksPath('hats')).toBe('banks/hats');
    expect(banksPath('list')).toBe('banks/list');
    expect(banksPath('nope' as ScraptfBank)).toBe('banks');
    expect(banksRouteBank(['banks', 'unusuals'])).toBe('unusuals');
    expect(banksRouteBank(['banks'])).toBeNull();
    expect(banksRouteBank(['banks', '__proto__'])).toBeNull();
    expect(banksRouteBank(['market', 'hats'])).toBeNull();
  });
});

describe('the loader', () => {
  interface Pending {
    resolve(r: ScraptfBanksResult): void;
    reject(e: unknown): void;
  }
  function harness() {
    const pending: Pending[] = [];
    const shown: ScraptfBanksResult[] = [];
    const errors: string[] = [];
    const call = () =>
      new Promise<ScraptfBanksResult>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    const loader = createBanksLoader(call, { data: (r) => shown.push(r), error: (m) => errors.push(m) });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { pending, shown, errors, loader, flush };
  }
  const at = (generatedAt: number) => result(all(), { generatedAt });

  it('keeps one read in flight: a burst of refreshes is one more read, after it', async () => {
    const h = harness();
    h.loader.refresh();
    h.loader.refresh();
    h.loader.refresh();
    expect(h.pending).toHaveLength(1);
    h.pending[0]!.resolve(at(NOW));
    await h.flush();
    expect(h.shown.map((r) => r.generatedAt)).toEqual([NOW]);
    // The pushes during the read: one more, so the newest state lands.
    expect(h.pending).toHaveLength(2);
    h.pending[1]!.resolve(at(NOW + 1000));
    await h.flush();
    expect(h.shown.map((r) => r.generatedAt)).toEqual([NOW, NOW + 1000]);
    expect(h.pending).toHaveLength(2);
    expect(BANKS_REFRESH_MS).toBe(2000);
  });

  it('never lets an older read overtake a newer one, and shows answers in read order whatever the clock says', async () => {
    const h = harness();
    // Reads never overlap, so a refresh during a read cannot answer before it.
    h.loader.refresh();
    h.loader.refresh();
    expect(h.pending).toHaveLength(1);
    h.pending[0]!.resolve(at(NOW));
    await h.flush();
    expect(h.pending).toHaveLength(2);
    // The service's clock stepped back: the later read is still the newer state, so it lands
    // (comparing generatedAt would freeze the cards until the clock caught up).
    h.pending[1]!.resolve(at(NOW - 5000));
    await h.flush();
    expect(h.shown.map((r) => r.generatedAt)).toEqual([NOW, NOW - 5000]);
    // The same instant again is fine too (the mock's clock can stand still).
    h.loader.refresh();
    h.pending[2]!.resolve(at(NOW - 5000));
    await h.flush();
    expect(h.shown).toHaveLength(3);
  });

  it('is the stale-response guard the architecture doc describes (read order, never generatedAt)', () => {
    // A change that "restores" a generatedAt check from the doc would freeze the cards after a clock step back.
    const arch = readFileSync(fileURLToPath(new URL('../../docs/ARCHITECTURE.md', import.meta.url)), 'utf8');
    const f15 = arch.slice(arch.indexOf('## scrap.tf banks (F15)'), arch.indexOf('## Live check (F16)'));
    const bullet = f15.slice(f15.indexOf('- **Live refresh.**'), f15.indexOf('- **See all**'));
    expect(bullet).toContain('createBanksLoader');
    expect(bullet).not.toMatch(/drops an answer older/);
    expect(bullet.replace(/\s+/g, ' ')).toMatch(/reads never overlap, an older answer can never replace a newer one \(`generatedAt` is not compared/);
  });

  it('reports a failed read, and the next refresh reads again', async () => {
    const h = harness();
    h.loader.refresh();
    h.pending[0]!.reject(new Error('The background service is restarting.'));
    await h.flush();
    expect(h.errors).toEqual(['The background service is restarting.']);
    h.loader.refresh();
    expect(h.pending).toHaveLength(2);
    // A call that throws at once is a failed read too, not a stuck loader.
    const errors: string[] = [];
    const broken = createBanksLoader(
      () => {
        throw new Error('no bridge');
      },
      { data: () => undefined, error: (m) => errors.push(m) },
    );
    broken.refresh();
    await h.flush();
    expect(errors).toEqual(['no bridge']);
  });

  it('says nothing once disposed (the page was left)', async () => {
    const h = harness();
    h.loader.refresh();
    h.loader.refresh();
    h.loader.dispose();
    h.pending[0]!.resolve(at(NOW));
    await h.flush();
    expect(h.shown).toEqual([]);
    expect(h.pending).toHaveLength(1);
    h.loader.refresh();
    expect(h.pending).toHaveLength(1);
  });
});

describe('against the browser mock', () => {
  let bridge: MockBridge | null = null;
  afterEach(() => {
    bridge?.dispose();
    bridge = null;
  });

  it("builds a card per bank from the mock's answer: fresh, stale and never-saved pages, flips and things to look for", async () => {
    bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => NOW });
    const r = await bridge.rpc('scraptf.banks', undefined);
    const cards = bankCards(r, K, NOW);
    const by = new Map(cards.map((c) => [c.bank, c]));
    expect(by.get('hats')!.freshness.label).toBe('Fresh');
    expect(by.get('hats')!.saved.text).toBe('saved 4 min ago · 48 items (31 in stock)');
    expect(by.get('stranges')!.freshness.label).toBe('Aging');
    expect(by.get('killstreaks')!.freshness.label).toBe('Stale');
    expect(by.get('skins')!.freshness.label).toBe('Never saved');
    expect(banksHeadline(r, NOW).text).toBe(`${r.banks.filter((b) => b.lastSavedAt !== null && NOW - b.lastSavedAt <= HOUR).length} of 8 scrap.tf pages saved in the last hour`);
    for (const c of cards) {
      const s = r.banks.find((b) => b.bank === c.bank)!;
      expect(c.top.map((t) => t.sku)).toEqual(s.top.map((t) => t.sku));
      if (c.lookFor) expect(c.lookFor.rows.map((l) => l.sku)).toEqual(s.lookFor.map((l) => l.sku));
    }
    expect(cards.some((c) => c.top.length > 0)).toBe(true);
    expect(cards.some((c) => (c.lookFor?.rows.length ?? 0) > 0)).toBe(true);
  });
});
