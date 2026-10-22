// F19 S2, the live check hint: while main holds a check.arm (the item the user opened on scrap.tf from
// the Live market), a copied text that is only a price ("1.33 ref", "2 keys 5.11", a price cell) is
// checked as the hinted SKU, priced from the copy (source 'clipboard'), with a reason naming the resolved
// item (checkHintedNote). Text that names an item wins; without a hint, or with an invalid one, nothing
// changes. The text is never echoed, kept or logged. Real in-memory repo and market index, fake clock and
// timers; nothing touches scrap.tf or any network (R1).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpClient, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import {
  CHECK_SCHEMA_LOADING_REASON,
  checkHintPrice,
  createLiveCheck,
  hintedCheck,
  parseCheckText,
  type LiveCheck,
} from '../../src/service/domain/liveCheck';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache } from '../../src/service/domain/scraptfList';
import { buildItemDetail } from '../../src/service/domain/views';
import {
  CHECK_HINTED_NOTE_TAIL,
  CHECK_NOT_ITEM_REASON,
  CHECK_REFUSALS,
  CHECK_SCRAPTF_LINK_REASON,
  checkHintedNote,
  checkMatchedByHint,
} from '../../src/shared/check';
import { fromString } from '../../src/shared/sku';
import type { CheckHint, CheckResult, CheckSource, Listing, ResolvedItem, ScraptfListStored } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, noNetwork, recordingLogger, silentLogger, testSettings } from './helpers';

const PAINT = 3100495;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  vi.restoreAllMocks();
});

const NAMES: Record<string, string> = { 'team captain': '378;6', 'rocket launcher': '205;6' };

/** schema.resolve for the stub schema: SKUs and two exact names; prices and anything else resolve to nothing. */
function stubResolve(t: string): ResolvedItem | null {
  const s = t.replace(/\s+/g, ' ').trim().toLowerCase();
  const of = (sku: string, match: ResolvedItem['match']): ResolvedItem => ({ sku, name: sku, skuObject: fromString(sku), category: 'hats', match, warnings: [] });
  if (/^\d+;\d+(;[a-z0-9-]+)*$/.test(s)) return of(s, 'sku');
  return Object.hasOwn(NAMES, s) ? of(NAMES[s]!, 'exact') : null;
}

function buy(sku: string, metalScrap: number, over: Partial<Listing> = {}): Listing {
  return makeListing({ sku, baseSku: sku, metalScrap, lastEventAt: T0 - MIN, ...over });
}

function setup(opts: { loaded?: boolean } = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  repo.upsertListings([
    ...['a', 'b', 'c'].map((x, i) => buy('378;6', 120 - i, { id: `tc-${x}`, steamid: `TC${x}` })),
    buy('205;6', 60, { id: 'rl', steamid: 'RL' }),
  ]);
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = testSettings();
  let list!: ReturnType<typeof createScraptfListCache>;
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
  list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
  let requests = 0;
  const http = {
    ...noNetwork,
    request(): never {
      requests++;
      throw new Error('live check must not make HTTP requests');
    },
  } as HttpClient;
  const schema = { ...createStubSchema({ loaded: opts.loaded ?? true }), resolve: stubResolve, search: () => [] };
  const market = createMarketIndex({ ...makeDeps(repo, clock, () => settings), http, schema, timers, keyPrice, onChanged: () => undefined, folderWatchActive: () => false, scraptfList: list });
  const log = recordingLogger();
  const lc: LiveCheck = createLiveCheck({ repo, schema, log, settings: () => settings, keyPrice, market, scraptfList: list });
  return {
    repo,
    clock,
    list,
    lc,
    log,
    requests: () => requests,
    check: (text: string, hint?: CheckHint, source: CheckSource = 'hotkey'): CheckResult => (hint ? lc.check(text, source, clock.now(), hint) : lc.check(text, source, clock.now())),
    detail: (sku: string) =>
      buildItemDetail({ repo, schema, sku, keyPrice: keyPrice(), settings, now: clock.now(), snapshot: { lastAt: null, available: false, nextAllowedAt: null }, history: [], target: 'plain' })!,
  };
}

const TC: CheckHint = { sku: '378;6' };

const SOURCES: readonly CheckSource[] = ['hotkey', 'watch', 'manual'];
/** Numbers people copy outside TF2: a one-time code, a phone number, a year, a SteamID64, an order id. */
const NOT_PRICES = ['482913', '5551234567', '2026', '2024', '123456', '5912345678', '76561198012345678', '1234.5', '1,200'];

describe('checkHintPrice (pure)', () => {
  it('reads a text that is only a price, from every source: one non-blank line with a unit, or a short decimal ref figure', () => {
    for (const source of SOURCES) {
      expect(checkHintPrice('1.33 ref', source), source).toEqual({ keys: 0, scrap: 12 });
      expect(checkHintPrice('2 keys 5.11', source), source).toEqual({ keys: 2, scrap: 46 });
      expect(checkHintPrice('1 key, 6 refined', source), source).toEqual({ keys: 1, scrap: 54 });
      expect(checkHintPrice('1.33', source), source).toEqual({ keys: 0, scrap: 12 });
      expect(checkHintPrice('63,11', source), source).toEqual({ keys: 0, scrap: 568 });
      expect(checkHintPrice('\n  14 scrap \r\n\n', source), source).toEqual({ keys: 0, scrap: 14 });
      expect(checkHintPrice('​1.33 ref﻿', source), source).toEqual({ keys: 0, scrap: 12 });
      expect(checkHintPrice('5000 keys', source), source).toEqual({ keys: 5000, scrap: 0 });
    }
  });

  it('takes a short bare whole number as ref, and a one-letter unit, only for a check the user asked for', () => {
    for (const source of ['hotkey', 'manual'] as const) {
      expect(checkHintPrice('5', source)).toEqual({ keys: 0, scrap: 45 });
      expect(checkHintPrice('  49 ', source)).toEqual({ keys: 0, scrap: 441 });
      expect(checkHintPrice('5k', source)).toEqual({ keys: 5, scrap: 0 });
      expect(checkHintPrice('14s', source)).toEqual({ keys: 0, scrap: 14 });
    }
  });

  it('F19-PRIV-1: from the watcher, a bare whole number or a one-letter unit is no price (copies from any app)', () => {
    for (const t of ['5', '1', '49', '482913', '5551234567', '2026', '5k', '3s', '2r', '1.33r', '2 k']) {
      expect(checkHintPrice(t, 'watch'), t).toBeNull();
    }
  });

  it('F19-HINT-BARE-NUMBER: an id, a year, a phone number or an absurd amount is no price from any source', () => {
    for (const source of SOURCES) {
      for (const t of [...NOT_PRICES, '76561198012345678 ref', '5001 keys', '50001 ref', '99999999 scrap']) {
        expect(checkHintPrice(t, source), `${source}: ${t}`).toBeNull();
      }
    }
  });

  it('is null for anything else: an item, two lines, a zero price, Sold out, a refused text', () => {
    for (const source of SOURCES) {
      for (const t of ['Team Captain, 1.33 ref', 'Team Captain', '1.33 ref\n1.22 ref', '0 ref', '0', 'Sold out', '-1 ref', '', '   ', '<b>1 ref</b>', 'a\nb\nc\nd', 'x'.repeat(401), 'https://scrap.tf/buy/hats']) {
        expect(checkHintPrice(t, source), JSON.stringify(t).slice(0, 40)).toBeNull();
      }
    }
  });
});

describe('hintedCheck (pure)', () => {
  it("is the hinted SKU at the copied price, as form 'hinted', never fuzzy or incomplete", () => {
    expect(hintedCheck('1.33 ref', TC, 'watch')).toEqual({
      form: 'hinted',
      item: expect.objectContaining({ sku: '378;6', match: 'sku', warnings: [] }),
      price: { keys: 0, scrap: 12 },
      pays: null,
      paysCopied: false,
      stock: null,
      stockLimit: null,
      soldOut: false,
      fuzzy: false,
      incomplete: false,
      // 0.7.4: the arm comes from a backpack.tf row, the price from a scrap.tf card: the copy is not stated (F41),
      // and the price was already read by the source (F44).
      craftStated: false,
      priceAmbiguous: false,
    });
    // The SKU rule as 'check.text's zod: trimmed, lower case, canonical.
    expect(hintedCheck('1 ref', { sku: ` 378;6;P${PAINT} ` }, 'hotkey')?.item.sku).toBe(`378;6;p${PAINT}`);
  });

  it('is null without a valid hint, or for text that is not only a price', () => {
    for (const hint of [undefined, null, {}, { sku: '' }, { sku: 'Team Captain' }, { sku: '378;6;uncratable' }, { sku: 378 }, { sku: `${'1'.repeat(300)};6` }, '378;6']) {
      expect(hintedCheck('1.33 ref', hint as CheckHint, 'hotkey'), JSON.stringify(hint)).toBeNull();
    }
    expect(hintedCheck('Team Captain, 1 ref', TC, 'hotkey')).toBeNull();
    expect(hintedCheck('Sold out', TC, 'hotkey')).toBeNull();
  });

  it('reads the price by the source: a bare whole number is a price for the hotkey, never for the watcher', () => {
    expect(hintedCheck('5', TC, 'hotkey')).toMatchObject({ form: 'hinted', price: { keys: 0, scrap: 45 } });
    expect(hintedCheck('5', TC, 'watch')).toBeNull();
    for (const source of SOURCES) expect(hintedCheck('2024', TC, source), source).toBeNull();
  });
});

describe("createLiveCheck with main's hint (F19 S2)", () => {
  it('checks a price-only text as the hinted item, priced from the copy, with the matched note', () => {
    const h = setup();
    const r = h.check('1.33 ref', TC);
    const d = h.detail('378;6');
    expect(r).toMatchObject({
      id: 1,
      status: 'item',
      source: 'hotkey',
      sku: '378;6',
      name: d.name,
      category: d.category,
      price: { keys: 0, scrapRaw: 12, valueScrap: 12, source: 'clipboard', observedAt: T0 },
      verdict: 'flip',
      checkedAt: T0,
    });
    expect(r.reason).toBe(checkHintedNote(d.name));
    expect(r.reason).toBe(`Price copied, matched to ${d.name}, ${CHECK_HINTED_NOTE_TAIL}`);
    expect(checkMatchedByHint(r)).toBe(true);
    // The same evaluation as checking the item with that price: only the reason says how it matched.
    const named = h.check('Team Captain, 1.33 ref');
    expect({ ...r, id: 0, reason: null }).toEqual({ ...named, id: 0, reason: null });
    // Kept like any item result (the handler pushes it as 'check.done').
    expect(h.lc.recent().map((x) => x.id)).toEqual([2, 1]);
  });

  it('reads every price form the spec lists, and a painted hinted copy', () => {
    const h = setup();
    expect(h.check('2 keys 5.11', TC)).toMatchObject({ status: 'item', sku: '378;6', price: { keys: 2, scrapRaw: 46, source: 'clipboard' }, verdict: 'over' });
    expect(h.check('1 key, 6 refined', TC)).toMatchObject({ status: 'item', price: { keys: 1, scrapRaw: 54 } });
    expect(h.check('  5  ', TC, 'hotkey')).toMatchObject({ status: 'item', source: 'hotkey', price: { keys: 0, scrapRaw: 45 } });
    expect(h.check('  1.33  ', TC, 'watch')).toMatchObject({ status: 'item', source: 'watch', price: { keys: 0, scrapRaw: 12 } });
    const painted = h.check('1 ref', { sku: `378;6;p${PAINT}` });
    expect(painted).toMatchObject({ status: 'item', sku: `378;6;p${PAINT}`, price: { source: 'clipboard', scrapRaw: 9 } });
    expect(painted.reason).toBe(checkHintedNote(painted.name!));
  });

  it('is not-item without a hint, exactly as before', () => {
    const h = setup();
    for (const t of ['1.33 ref', '2 keys 5.11', '5']) {
      const r = h.check(t);
      expect(r, t).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON, sku: null, price: null });
    }
    expect(parseCheckText('1.33 ref', stubResolve)).toEqual({ ok: false, status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    expect(h.lc.recent()).toEqual([]);
  });

  it('F19-PRIV-1: while armed, a number copied in another app reaches no result from the watcher (no item, kept or priced)', () => {
    const h = setup();
    for (const t of ['482913', '5551234567', '2026', '49', '1', '5k', '3s']) {
      const r = h.check(t, TC, 'watch');
      expect(r, t).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON, sku: null, price: null, verdict: null });
    }
    expect(h.lc.recent()).toEqual([]);
    // The check hotkey is the user asking: a short bare figure there is still the price they copied.
    expect(h.check('1', TC, 'hotkey')).toMatchObject({ status: 'item', sku: '378;6', price: { scrapRaw: 9, source: 'clipboard' } });
  });

  it('F19-HINT-BARE-NUMBER: a SteamID64, a year or an id is no item from any source, and no price is ever unsafe', () => {
    const h = setup();
    for (const source of SOURCES) {
      for (const t of [...NOT_PRICES, '76561198012345678 ref']) {
        expect(h.check(t, TC, source), `${source}: ${t}`).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON, sku: null, price: null });
      }
    }
    expect(h.lc.recent()).toEqual([]);
    const r = h.check('5000 keys', TC, 'watch');
    expect(r).toMatchObject({ status: 'item', price: { keys: 5000, scrapRaw: 0 } });
    expect(Number.isSafeInteger(r.price!.valueScrap)).toBe(true);
  });

  it('ignores the hint when the text names an item: the text wins', () => {
    const h = setup();
    const priced = h.check('Rocket Launcher, 1 ref', TC);
    expect(priced).toMatchObject({ status: 'item', sku: '205;6', price: { scrapRaw: 9, source: 'clipboard' } });
    expect(checkMatchedByHint(priced)).toBe(false);
    expect(h.check('Rocket Launcher', TC)).toMatchObject({ status: 'item', sku: '205;6', reason: null });
    expect(h.check('205;6', TC)).toMatchObject({ status: 'item', sku: '205;6', reason: null });
    expect(h.check('Rocket Launcher\n1.33 ref', TC)).toMatchObject({ status: 'item', sku: '205;6', price: { scrapRaw: 12 } });
  });

  it('leaves refusals, scrap.tf links and other non-prices as they are, and ignores an invalid hint', () => {
    const h = setup();
    expect(h.check('<b>1 ref</b>', TC)).toMatchObject({ status: 'refused', reason: CHECK_REFUSALS.markup });
    expect(h.check('https://scrap.tf/buy/hats', TC)).toMatchObject({ status: 'not-item', reason: CHECK_SCRAPTF_LINK_REASON });
    expect(h.check('nothing here', TC)).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    expect(h.check('0 ref', TC)).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    expect(h.check('1.33 ref\n1.22 ref', TC)).toMatchObject({ status: 'not-item' });
    for (const hint of [{ sku: 'not a sku' }, { sku: '' }, { sku: 378 }] as unknown as CheckHint[]) {
      expect(h.check('1.33 ref', hint), JSON.stringify(hint)).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    }
    // A hinted SKU nothing is known about is no item either.
    expect(h.check('1.33 ref', { sku: '31999;6' })).toMatchObject({ status: 'not-item', reason: CHECK_NOT_ITEM_REASON });
    expect(h.lc.recent()).toEqual([]);
  });

  it('needs no item names: works while the schema loads, which still explains a price without a hint', () => {
    const h = setup({ loaded: false });
    expect(h.check('1.33 ref', TC)).toMatchObject({ status: 'item', sku: '378;6', price: { source: 'clipboard' } });
    expect(h.check('1.33 ref')).toMatchObject({ status: 'not-item', reason: CHECK_SCHEMA_LOADING_REASON });
    expect(h.check('1.33 ref', { sku: '31999;6' })).toMatchObject({ status: 'not-item', reason: CHECK_SCHEMA_LOADING_REASON });
  });

  it('takes the copied price over the saved list and stored prices, with the list only for pays and stock', () => {
    const h = setup();
    const row: ScraptfListStored = { sku: '378;6', name: 'Team Captain', sellsKeys: 0, sellsScrap: 90, paysKeys: 0, paysScrap: 75, stock: 2, stockLimit: 5, batchId: 1, observedAt: T0 - 3 * MIN };
    h.repo.upsertScraptfList([row]);
    h.list.refresh();
    h.repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costScrap: 100, source: 'user', observedAt: T0 - MIN });
    const r = h.check('1.33 ref', TC);
    expect(r).toMatchObject({ price: { valueScrap: 12, source: 'clipboard' }, scraptfPaysScrap: 75, stock: 2, stockLimit: 5, listAt: T0 - 3 * MIN });
    expect(r.reason).toBe(checkHintedNote(r.name!));
  });

  it('never echoes, keeps or logs the text, and makes no request', () => {
    const h = setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const texts = ['  1.33   refined  ', '2 keys 5.11', '\t1 key, 6 refined\t'];
    const results = texts.map((t) => h.check(t, TC));
    expect(results.every((r) => r.status === 'item')).toBe(true);
    const kept = JSON.stringify([results, h.lc.recent(), h.log.lines]);
    for (const t of texts) expect(kept).not.toContain(t.trim());
    for (const piece of ['refined', '5.11', '1.33']) expect(kept).not.toContain(piece);
    expect(h.log.lines).toEqual([]);
    expect(h.requests()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
