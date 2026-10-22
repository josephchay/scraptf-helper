// F16 Live check, renderer side: the popup's wording (price line, sells line, verdict pill, Pay up to),
// the inputs its buttons send, its keys and auto-hide timer, and the Recent checks list. Pure; the
// checked text itself never reaches any of these (a CheckResult holds the resolved item only).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_HIDE_RESUME_MIN_MS,
  LIVE_CHECK_NOTE,
  checkActions,
  checkBoughtInput,
  checkBriefText,
  checkKey,
  checkPayUpTo,
  checkPopupKey,
  checkPriceLine,
  checkPriceSourceText,
  checkPriceText,
  checkQuickEntryParams,
  checkSaveButton,
  checkSaveInput,
  checkSellsLine,
  checkStockText,
  checkSummaryText,
  checkVerdictView,
  createCheckHideTimer,
  manualCheckProblem,
  mergeRecentChecks,
  recentCheckRow,
  recentChecksHint,
  sanitizeRecentOpen,
} from '../../src/renderer/checkModel';
import { fmtMoney } from '../../src/renderer/format';
import { mockCheckDemo } from '../../src/renderer/mockCheck';
import {
  blankCheckResult,
  CHECK_EXTRAS_NOTE,
  CHECK_FUZZY_NOTE,
  CHECK_HINT,
  CHECK_NOT_ITEM_REASON,
  CHECK_POPUP_HIDE_MS,
  CHECK_PRICE_TEXT_MAX,
  CHECK_RECENT_MAX,
  CHECK_REFUSALS,
} from '../../src/shared/check';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { CheckResult } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const K = 540; // 60 ref
const demo = (kind: 'flip' | 'over' | 'no-price' | 'not-item') => mockCheckDemo(kind, NOW, K, DEFAULT_SETTINGS);

function item(over: Partial<CheckResult> = {}): CheckResult {
  return { ...demo('flip'), ...over };
}

describe('line 1: the scrap.tf price', () => {
  it('shows the price as scrap.tf lists it, with its source and stock', () => {
    const r = demo('flip');
    expect(checkPriceText(r.price)).toBe('1 key 5.33 ref');
    const line = checkPriceLine(r, NOW);
    expect(line).toMatchObject({ price: '1 key 5.33 ref', source: 'copied', stock: '3/12', full: false, outOfStock: false });
    expect(line.pays).not.toBeNull();
    expect(line.title).toContain('from the text you copied');
    expect(line.title).toContain('Flip Desk never loads scrap.tf on its own.');
  });

  it('names the saved list with its age, a typed price as yours, an import with its age', () => {
    expect(checkPriceSourceText({ source: 'list', observedAt: NOW - 3 * 60_000 }, NOW)).toBe('saved list 3 min ago');
    expect(checkPriceSourceText({ source: 'typed', observedAt: NOW - 86_400_000 }, NOW)).toBe('your price');
    expect(checkPriceSourceText({ source: 'import', observedAt: NOW - 2 * 3_600_000 }, NOW)).toBe('imported page 2 h ago');
    expect(checkPriceSourceText({ source: 'clipboard', observedAt: NOW }, NOW)).toBe('copied');
    expect(checkPriceLine(demo('over'), NOW)).toMatchObject({ source: 'saved list 42 min ago', stock: '12/12', full: true });
  });

  it('reads stock without a limit, and none at all', () => {
    expect(checkStockText({ stock: 4, stockLimit: null })).toBe('stock 4');
    expect(checkStockText({ stock: null, stockLimit: 12 })).toBeNull();
    expect(checkPriceLine(item({ stock: 0, stockLimit: 12, price: null }), NOW)).toMatchObject({ price: null, source: null, outOfStock: true });
  });

  it('never invents a price', () => {
    expect(checkPriceText(null)).toBeNull();
    expect(checkPriceText({ keys: Number.NaN, scrapRaw: 12 })).toBe('1.33 ref');
    const line = checkPriceLine(demo('no-price'), NOW);
    expect(line.price).toBeNull();
    expect(line.title).toMatch(/^No scrap\.tf price/);
  });
});

describe('line 2: what it sells for', () => {
  it('names the revenue, the buyer, bot or human, online, and the buyer count', () => {
    // 0.7.4: presence is judged at `now` (the popup passes the check time); the demo order is 4 min old.
    const s = checkSellsLine(demo('flip'), NOW);
    expect(s).toMatchObject({ buyer: 'Demo Trading Bot', kind: 'bot', online: true, seen: null, count: '6 buyers' });
    expect(s.revenue).toBe('1 key 22.00 ref');
    expect(s.title).toMatch(/^Best .* conservative .* instant/);
    expect(checkSellsLine(demo('over'), NOW)).toMatchObject({ kind: 'human', count: '2 buyers' });
  });

  it('0.7.4 (F23): says when an order past 2 h was last seen instead of a stale online flag', () => {
    const later = checkSellsLine(demo('flip'), NOW + 5 * 24 * 3_600_000);
    expect(later).toMatchObject({ kind: 'bot', online: null, seen: 'last seen 5 d ago' });
    expect(later.seenAt).toBe(NOW - 4 * 60_000);
    // Exactly 2 h after the order's event it still counts as recent.
    expect(checkSellsLine(demo('flip'), NOW - 4 * 60_000 + 2 * 3_600_000)).toMatchObject({ online: true, seen: null });
  });

  it('says so when nobody buys', () => {
    expect(checkSellsLine(item({ revenue: null }))).toMatchObject({ revenue: null, buyer: null, kind: null, count: '0 buyers' });
  });
});

describe('verdict pill and Pay up to', () => {
  it('flip: profit and margin', () => {
    const r = demo('flip');
    const v = checkVerdictView(r)!;
    expect(v.tone).toBe('good');
    expect(v.text).toMatch(/^Flip \+.* \(\d+(\.\d)?%\)$/);
  });

  it('over: by how much the price is above Pay up to', () => {
    const r = demo('over');
    const v = checkVerdictView(r)!;
    expect(v.tone).toBe('bad');
    const over = r.price!.valueScrap - r.revenue!.maxCostScrap!;
    expect(over).toBeGreaterThan(0);
    expect(v.text).toBe(`Over by ${fmtMoney(over, K)}`);
    // No ceiling at all: no price clears the thresholds.
    expect(checkVerdictView(item({ verdict: 'over', revenue: { ...r.revenue!, maxCostScrap: null } }))!.text).toBe('Not profitable');
  });

  it('no buyers, no price, and nothing for a non-item', () => {
    expect(checkVerdictView(item({ verdict: 'no-buyers' }))).toMatchObject({ tone: 'muted', text: 'No buyers' });
    expect(checkVerdictView(demo('no-price'))).toMatchObject({ tone: 'info', text: 'No scrap.tf price' });
    expect(checkVerdictView(demo('not-item'))).toBeNull();
  });

  it('Pay up to is always shown, and leads when there is no price', () => {
    expect(checkPayUpTo(demo('flip'))).toMatchObject({ prominent: false });
    expect(checkPayUpTo(demo('flip')).text).not.toBe('—');
    expect(checkPayUpTo(demo('no-price'))).toMatchObject({ prominent: true });
    expect(checkPayUpTo(item({ revenue: null })).text).toBe('—');
  });
});

describe('summary', () => {
  it('reads an item without quoting anything copied', () => {
    const s = checkSummaryText(demo('flip'), NOW);
    expect(s).toMatch(/^Team Captain: Flip \+/);
    expect(s).toContain('scrap.tf 1 key 5.33 ref (copied).');
    expect(s).toContain('Pay up to ');
    expect(s.endsWith('.')).toBe(true);
    // An item's notes come last, whole (the popup shows two lines of them).
    const note = 'Closest match only: check that this is the item you copied.';
    expect(checkSummaryText({ ...demo('flip'), reason: note }, NOW)).toBe(`${s} ${note}`);
  });

  it('the brief line beside the pill names the item, the price and Pay up to', () => {
    expect(checkBriefText(demo('flip'), NOW)).toBe(`Team Captain · scrap.tf 1 key 5.33 ref (copied) · Pay up to ${checkPayUpTo(demo('flip')).text}`);
    expect(checkBriefText(demo('no-price'), NOW)).toMatch(/^Texas Ten Gallon · no scrap\.tf price · Pay up to /);
    expect(checkBriefText(demo('not-item'), NOW)).toBe(checkSummaryText(demo('not-item'), NOW));
  });

  it('gives a non-item its reason and the hint', () => {
    expect(checkSummaryText(demo('not-item'), NOW)).toBe(`${CHECK_NOT_ITEM_REASON} ${CHECK_HINT}.`);
    expect(checkSummaryText(blankCheckResult('refused', CHECK_REFUSALS.list, 'hotkey', NOW), NOW)).toBe(`${CHECK_REFUSALS.list}. ${CHECK_HINT}.`);
  });
});

describe('actions', () => {
  it('Save price: a copied or listed price only', () => {
    expect(checkActions(demo('flip')).save.enabled).toBe(true);
    expect(checkActions(demo('over')).save.enabled).toBe(true);
    expect(checkActions(item({ price: { ...demo('flip').price!, source: 'typed' } })).save).toMatchObject({ enabled: false, title: 'This is already your saved price.' });
    expect(checkActions(item({ price: { ...demo('flip').price!, source: 'import' } })).save.enabled).toBe(false);
    expect(checkActions(demo('no-price')).save.enabled).toBe(false);
  });

  it('Bought it needs a price; Details and Quick entry need an item', () => {
    const np = checkActions(demo('no-price'));
    expect(np.bought.enabled).toBe(false);
    expect(np.details.enabled).toBe(true);
    expect(np.quick.enabled).toBe(true);
    const none = checkActions(demo('not-item'));
    expect([none.save, none.bought, none.details, none.quick].every((a) => !a.enabled)).toBe(true);
    expect(checkActions(null).details.enabled).toBe(false);
  });

  it('saves the checked price as a typed price, dated when it was seen, with the live check note', () => {
    expect(checkSaveInput(demo('flip'), NOW)).toEqual({ sku: '378;6', name: 'Team Captain', costKeys: 1, costScrap: 48, source: 'user', observedAt: NOW, note: LIVE_CHECK_NOTE });
    // A list price keeps the list's date, as the drawer's "Use as my price" does.
    expect(checkSaveInput(demo('over'), NOW)).toMatchObject({ sku: '1118;6', costKeys: 0, costScrap: demo('over').price!.scrapRaw, observedAt: NOW - 42 * 60_000 });
    // A future time is capped at now.
    expect(checkSaveInput(item({ price: { ...demo('flip').price!, observedAt: NOW + 60_000 } }), NOW)!.observedAt).toBe(NOW);
    expect(checkSaveInput(demo('no-price'), NOW)).toBeNull();
    expect(checkSaveInput(demo('not-item'), NOW)).toBeNull();
  });

  it('records a scrap.tf buy at the checked price, keys and metal as listed', () => {
    expect(checkBoughtInput(demo('flip'))).toEqual({ side: 'buy', venue: 'scrap.tf', sku: '378;6', name: 'Team Captain', keys: 1, scrap: 48, note: LIVE_CHECK_NOTE });
    expect(checkBoughtInput(demo('no-price'))).toBeNull();
    expect(checkBoughtInput(null)).toBeNull();
  });

  it('opens quick entry with the SKU and the price as text its field reads', () => {
    expect(checkQuickEntryParams(demo('flip'))).toEqual({ sku: '378;6', price: '1 key 5.33 ref' });
    expect(checkQuickEntryParams(demo('no-price'))).toEqual({ sku: '94;6' });
    expect(checkQuickEntryParams(demo('not-item'))).toBeNull();
    // Within main's limit for the price text ('app.showQuickEntry'), even for a big price.
    const big = checkQuickEntryParams(item({ price: { ...demo('flip').price!, keys: 123_456.25, scrapRaw: 9 * 99_999 + 8 } }))!;
    expect(big.price).toBe('123456.25 keys 99999.88 ref');
    expect(big.price!.length).toBeLessThanOrEqual(CHECK_PRICE_TEXT_MAX);
  });

  it("shows a painted or spelled copy's price (CHECK_EXTRAS_NOTE) but never records or prefills it for the plain item", () => {
    const typed = { ...demo('flip').price!, source: 'typed' as const };
    expect(checkActions(item({ price: typed })).bought.enabled).toBe(true);
    for (const reason of [CHECK_EXTRAS_NOTE, `${CHECK_FUZZY_NOTE} ${CHECK_EXTRAS_NOTE}`]) {
      const r = item({ price: typed, reason });
      expect(checkActions(r).bought).toMatchObject({ enabled: false, title: expect.stringMatching(/copy with extras/) });
      expect(checkBoughtInput(r)).toBeNull();
      expect(checkQuickEntryParams(r)).toEqual({ sku: '378;6' });
      expect(checkActions(r).quick).toEqual({ enabled: true, title: 'Open Quick entry with this item' });
      // Still on screen, saying whose price it is (the popup also shows the reason).
      expect(checkPriceLine(r, NOW)).toMatchObject({ price: checkPriceText(typed), title: expect.stringContaining(CHECK_EXTRAS_NOTE) });
    }
  });

  it('Save price writes once per result', () => {
    expect(checkSaveButton(null, 1)).toEqual({ label: 'Save price', disabled: false, done: false });
    expect(checkSaveButton({ id: 1, status: 'saving' }, 1)).toMatchObject({ label: 'Saving…', disabled: true });
    expect(checkSaveButton({ id: 1, status: 'done' }, 1)).toMatchObject({ label: 'Saved', disabled: true, done: true });
    // Another result starts fresh.
    expect(checkSaveButton({ id: 1, status: 'done' }, 2).disabled).toBe(false);
  });
});

describe('keys', () => {
  const k = (key: string, over: Record<string, unknown> = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...over });

  it('Enter saves, B records the buy, D opens details, Esc hides', () => {
    expect(checkPopupKey(k('Enter'), { tagName: 'BODY' })).toBe('save');
    expect(checkPopupKey(k('b'), null)).toBe('bought');
    expect(checkPopupKey(k('B'), null)).toBe('bought');
    expect(checkPopupKey(k('d'), { tagName: 'DIV' })).toBe('details');
    expect(checkPopupKey(k('Escape'), { tagName: 'BUTTON' })).toBe('hide');
    expect(checkPopupKey(k('x'), null)).toBeNull();
  });

  it('leaves a focused button its own Enter, text fields their typing, and chords alone', () => {
    expect(checkPopupKey(k('Enter'), { tagName: 'BUTTON' })).toBeNull();
    expect(checkPopupKey(k('Enter'), { tagName: 'a' })).toBeNull();
    expect(checkPopupKey(k('b'), { tagName: 'INPUT' })).toBeNull();
    expect(checkPopupKey(k('d'), { tagName: 'DIV', isContentEditable: true })).toBeNull();
    expect(checkPopupKey(k('b', { ctrlKey: true }), null)).toBeNull();
    expect(checkPopupKey(k('d', { altKey: true }), null)).toBeNull();
    expect(checkPopupKey(k('Enter', { repeat: true }), null)).toBeNull();
    expect(checkPopupKey(k('Escape', { defaultPrevented: true }), null)).toBeNull();
    expect(checkPopupKey(k('b', { isComposing: true }), null)).toBeNull();
  });
});

describe('auto-hide timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides 10 s after a result', () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    const t = createCheckHideTimer(onHide);
    t.restart();
    vi.advanceTimersByTime(CHECK_POPUP_HIDE_MS - 1);
    expect(onHide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(t.armed()).toBe(false);
  });

  it('a new result restarts the countdown', () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    const t = createCheckHideTimer(onHide);
    t.restart();
    vi.advanceTimersByTime(8_000);
    t.restart();
    vi.advanceTimersByTime(8_000);
    expect(onHide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('waits while hovered or focused, then resumes with what was left (at least 3 s)', () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    const t = createCheckHideTimer(onHide);
    t.restart();
    vi.advanceTimersByTime(4_000);
    t.hold('hover', true);
    vi.advanceTimersByTime(60_000);
    expect(onHide).not.toHaveBeenCalled();
    t.hold('focus', true);
    t.hold('hover', false);
    vi.advanceTimersByTime(60_000);
    expect(onHide).not.toHaveBeenCalled();
    t.hold('focus', false);
    vi.advanceTimersByTime(5_999);
    expect(onHide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('never vanishes right under a pointer that just left', () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    const t = createCheckHideTimer(onHide);
    t.restart();
    vi.advanceTimersByTime(9_900);
    t.hold('toast', true);
    t.hold('toast', false);
    vi.advanceTimersByTime(CHECK_HIDE_RESUME_MIN_MS - 1);
    expect(onHide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('a result shown while held waits for the hold; stop drops everything', () => {
    vi.useFakeTimers();
    const onHide = vi.fn();
    const t = createCheckHideTimer(onHide);
    t.hold('hover', true);
    t.restart();
    vi.advanceTimersByTime(60_000);
    expect(onHide).not.toHaveBeenCalled();
    t.hold('hover', false);
    vi.advanceTimersByTime(CHECK_POPUP_HIDE_MS);
    expect(onHide).toHaveBeenCalledTimes(1);

    t.restart();
    t.stop();
    t.hold('hover', true);
    t.hold('hover', false);
    vi.advanceTimersByTime(60_000);
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});

describe('Recent checks', () => {
  const at = (id: number, checkedAt: number, over: Partial<CheckResult> = {}) => item({ id, checkedAt, ...over });

  it('keeps items only, each once, newest first, at most 30', () => {
    const a = at(1, NOW - 2_000);
    const b = at(2, NOW - 1_000);
    const merged = mergeRecentChecks([a], [b, a, demo('not-item'), blankCheckResult('refused', CHECK_REFUSALS.markup, 'hotkey', NOW)]);
    expect(merged.map((r) => r.id)).toEqual([2, 1]);
    const many = Array.from({ length: 40 }, (_, i) => at(i + 1, NOW + i));
    const capped = mergeRecentChecks([], many);
    expect(capped).toHaveLength(CHECK_RECENT_MAX);
    expect(capped[0]!.id).toBe(40);
  });

  it('a manual check is returned and pushed: one row', () => {
    const r = at(7, NOW);
    expect(mergeRecentChecks(mergeRecentChecks([], [r]), [{ ...r }])).toHaveLength(1);
  });

  it('a restarted service reuses ids: the time tells them apart', () => {
    const old = at(1, NOW - 60_000);
    const fresh = at(1, NOW);
    expect(checkKey(old)).not.toBe(checkKey(fresh));
    expect(mergeRecentChecks([old], [fresh]).map((r) => r.checkedAt)).toEqual([NOW, NOW - 60_000]);
  });

  it('a row: time, item, price and source, verdict, Pay up to', () => {
    const row = recentCheckRow(demo('over'), NOW + 3 * 60_000);
    expect(row).toMatchObject({ sku: '1118;6', name: 'Taunt: Conga', ago: '3 min ago', price: '12.66 ref', priceSource: 'saved list 45 min ago' });
    expect(row.verdict?.text).toMatch(/^Over by /);
    expect(row.title).toContain('by hotkey');
    expect(recentCheckRow(demo('no-price'), NOW)).toMatchObject({ price: null, priceSource: null });
  });

  it('collapsed unless the user opened it', () => {
    expect(sanitizeRecentOpen(true)).toBe(true);
    for (const v of [false, 'true', 1, null, undefined, {}]) expect(sanitizeRecentOpen(v)).toBe(false);
  });

  it('the manual box needs some text, and the header says how to check', () => {
    expect(manualCheckProblem('   ')).not.toBeNull();
    expect(manualCheckProblem('Team Captain')).toBeNull();
    expect(recentChecksHint('CommandOrControl+Alt+C', false)).toBe('Copy an item on scrap.tf and press Ctrl+Alt+C, or paste it here.');
    expect(recentChecksHint('', true)).toContain('clipboard check is on');
    expect(recentChecksHint('', false)).toContain('Settings → Live check');
  });
});
