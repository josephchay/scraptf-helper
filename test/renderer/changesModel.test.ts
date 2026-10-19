// F20 U3: the scrap.tf change feed's pure helpers (changesModel.ts): the Live log's tabs and route, the
// remembered bank and kind filters and their 'scraptf.changes' query, merging and paging by id, the
// feed's reads (createChangesFeed: one refresh at a time, a stale view's answer dropped, "Load older"
// up to the cap), and the words of one change ("1.33 → 1.22 ref (−8 %)", the Flip pill). Pure; nothing
// here touches the network or scrap.tf, and no change ever yields a URL.

import { describe, expect, it, vi } from 'vitest';
import {
  CHANGE_BANK_OPTIONS,
  CHANGE_KIND_LABELS,
  CHANGE_KIND_OPTIONS,
  CHANGES_MAX_KEPT,
  CHANGES_PAGE,
  DEFAULT_CHANGES_VIEW,
  LOG_CHANGES_ROUTE,
  LOG_TABS,
  changeBankText,
  changePctText,
  changePriceText,
  changeRowView,
  changeStockText,
  changeSummary,
  changesEmptyText,
  changesExportQuery,
  changesFilterCount,
  changesQueryOf,
  changesViewKey,
  createChangesFeed,
  fetchChangesAfter,
  fmtSaveTime,
  fromToText,
  logTabOf,
  logTabPath,
  mergeChanges,
  mergeChangesTrimmed,
  olderChangesLimit,
  sanitizeChangesView,
  type ChangesFeedState,
} from '../../src/renderer/changesModel';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import { SCRAPTF_CHANGES_DEFAULT_LIMIT } from '../../src/shared/scraptfHistory';
import { SCRAPTF_BANK_IDS, SCRAPTF_CHANGE_KINDS } from '../../src/shared/types';
import type { ScraptfChangeEvent, ScraptfChangesQuery } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const K = 568;

function ev(over: Partial<ScraptfChangeEvent> = {}): ScraptfChangeEvent {
  return {
    id: 1,
    at: NOW - 3 * HOUR,
    bank: 'hats',
    page: '/buy/hats',
    sku: '378;6',
    specialKey: '',
    name: 'Team Captain',
    kind: 'cheaper',
    fromKeys: 0,
    fromScrap: 12,
    toKeys: 0,
    toScrap: 11,
    fromStock: 5,
    toStock: 3,
    batchId: 1001,
    key: '378;6|',
    hasExtras: false,
    fromValueScrap: 12,
    toValueScrap: 11,
    deltaScrap: -1,
    pct: -1 / 12,
    revenueScrap: 18,
    maxCostScrap: 13,
    flip: true,
    ...over,
  };
}

describe('the Live log tabs', () => {
  it('#/log shows the opportunity events, #/log/changes the scrap.tf changes', () => {
    expect(LOG_TABS.map((t) => [t.value, t.label])).toEqual([
      ['events', 'Opportunity events'],
      ['changes', 'scrap.tf changes'],
    ]);
    expect(logTabOf(['log'])).toBe('events');
    expect(logTabOf(['log', 'changes'])).toBe('changes');
    expect(logTabOf(['log', 'nope'])).toBe('events');
    expect(logTabOf(['market', 'changes'])).toBe('events');
    expect(logTabPath('changes')).toBe(LOG_CHANGES_ROUTE);
    expect(LOG_CHANGES_ROUTE).toBe('log/changes');
    expect(logTabPath('events')).toBe('log');
  });
});

describe('the view, remembered', () => {
  it('reads anything from storage back as a valid view, kinds in the shared order', () => {
    for (const bad of [null, undefined, 3, 'x', [], { bank: 'moon', kinds: 'new' }, { kinds: [1, null, 'sold'] }]) {
      expect(sanitizeChangesView(bad), JSON.stringify(bad)).toEqual(DEFAULT_CHANGES_VIEW);
    }
    expect(sanitizeChangesView({ bank: 'unusuals', kinds: ['gone', 'new', 'gone', 'x'] })).toEqual({ bank: 'unusuals', kinds: ['new', 'gone'] });
    // Every kind ticked stays ticked; the query leaves such a filter out.
    const all = sanitizeChangesView({ kinds: [...SCRAPTF_CHANGE_KINDS].reverse() });
    expect(all.kinds).toEqual([...SCRAPTF_CHANGE_KINDS]);
    expect(changesQueryOf(all)).not.toHaveProperty('kinds');
    expect(changesFilterCount(all)).toBe(0);
  });

  it("builds 'scraptf.changes' params: bank and kinds only when set, beforeId for older pages, limit clamped", () => {
    expect(changesQueryOf(DEFAULT_CHANGES_VIEW)).toEqual({ limit: CHANGES_PAGE });
    expect(CHANGES_PAGE).toBe(SCRAPTF_CHANGES_DEFAULT_LIMIT);
    expect(changesQueryOf({ bank: 'hats', kinds: ['pricier', 'cheaper'] }, 812, 50)).toEqual({ bank: 'hats', kinds: ['cheaper', 'pricier'], beforeId: 812, limit: 50 });
    expect(changesQueryOf(DEFAULT_CHANGES_VIEW, 0).beforeId).toBeUndefined();
    expect(changesQueryOf(DEFAULT_CHANGES_VIEW, undefined, 9999).limit).toBe(500);
    expect(changesQueryOf(DEFAULT_CHANGES_VIEW, undefined, 0).limit).toBe(1);
    expect(changesQueryOf(DEFAULT_CHANGES_VIEW, undefined, Number.NaN).limit).toBe(CHANGES_PAGE);
    // The CSV drops paging; the view key ignores it too.
    expect(changesExportQuery({ bank: 'list', kinds: ['gone'] })).toEqual({ bank: 'list', kinds: ['gone'] });
    expect(changesViewKey({ bank: 'list', kinds: ['gone'] })).toBe(JSON.stringify({ bank: 'list', kinds: ['gone'] }));
    expect(changesFilterCount({ bank: 'hats', kinds: ['new'] })).toBe(2);
  });

  it('offers every bank by its SCRAPTF_BANKS label and every kind with its help', () => {
    expect(CHANGE_BANK_OPTIONS[0]).toEqual({ value: '', label: 'Every bank' });
    expect(CHANGE_BANK_OPTIONS.slice(1).map((o) => o.value)).toEqual([...SCRAPTF_BANK_IDS]);
    expect(CHANGE_BANK_OPTIONS.slice(1).map((o) => o.label)).toEqual(SCRAPTF_BANKS.map((b) => b.label));
    expect(CHANGE_KIND_OPTIONS.map((o) => o.value)).toEqual([...SCRAPTF_CHANGE_KINDS]);
    expect(CHANGE_KIND_OPTIONS.map((o) => o.label)).toEqual(['New', 'Gone', 'Cheaper', 'Pricier', 'Restocked', 'Stock']);
    for (const o of CHANGE_KIND_OPTIONS) expect(o.title.length).toBeGreaterThan(20);
    expect(changeBankText('hats')).toEqual({ label: 'Hats', path: 'scrap.tf/buy/hats' });
    expect(changeBankText('list')).toEqual({ label: 'All items', path: 'scrap.tf/items' });
    expect(changeBankText('moon' as never)).toEqual({ label: 'moon', path: 'moon' });
  });
});

describe('merging and paging by id', () => {
  it('merges newest first, a later copy of an id wins, at most the cap', () => {
    const a = [ev({ id: 3 }), ev({ id: 1 })];
    const b = [ev({ id: 2 }), ev({ id: 3, revenueScrap: 99 })];
    const m = mergeChanges(a, b);
    expect(m.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(m[0]!.revenueScrap).toBe(99);
    expect(mergeChanges(a, b, 2).map((e) => e.id)).toEqual([3, 2]);
    expect(olderChangesLimit(0)).toBe(CHANGES_PAGE);
    expect(olderChangesLimit(CHANGES_MAX_KEPT - 30)).toBe(30);
    expect(olderChangesLimit(CHANGES_MAX_KEPT)).toBe(0);
  });

  it('fetches every change above a known id, paging back, and says when there were too many', async () => {
    const all = Array.from({ length: 25 }, (_, i) => ({ id: 25 - i }));
    const page = (beforeId: number | undefined) => Promise.resolve(all.filter((e) => beforeId === undefined || e.id < beforeId).slice(0, 10));
    const r = await fetchChangesAfter(page, 7, 10, 100);
    expect(r.complete).toBe(true);
    expect(r.fresh.map((e) => e.id)).toEqual(Array.from({ length: 18 }, (_, i) => 25 - i));
    // What the pages held, the known ones of the last page included (valued again when merged).
    expect(r.read.map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    const none = await fetchChangesAfter(page, 25, 10, 100);
    expect(none.fresh).toEqual([]);
    expect(none.complete).toBe(true);
    expect(none.read).toHaveLength(10);
    const over = await fetchChangesAfter(page, 0, 10, 20);
    expect(over.complete).toBe(false);
    expect(over.fresh).toHaveLength(20);
    expect(over.read).toEqual(over.fresh);
  });
});

describe('createChangesFeed', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  function harness(opts: { page?: number; maxKept?: number } = {}) {
    const calls: { q: ScraptfChangesQuery; d: ReturnType<typeof deferred<ScraptfChangeEvent[]>> }[] = [];
    const states: ChangesFeedState[] = [];
    const olderError = vi.fn();
    const feed = createChangesFeed(
      (q) => {
        const d = deferred<ScraptfChangeEvent[]>();
        calls.push({ q, d });
        return d.promise;
      },
      (s) => states.push(s),
      { ...opts, onOlderError: olderError },
    );
    return { feed, calls, states, last: () => states[states.length - 1]!, olderError };
  }
  const ids = (s: ChangesFeedState) => s.events.map((e) => e.id);

  it('reads the newest page of the view, then "Load older" before the oldest one shown', async () => {
    const t = harness({ page: 3 });
    t.feed.load({ bank: 'hats', kinds: [] });
    expect(t.last()).toMatchObject({ loading: true, events: [] });
    expect(t.calls[0]!.q).toEqual({ bank: 'hats', limit: 3 });
    t.calls[0]!.d.resolve([ev({ id: 9 }), ev({ id: 8 }), ev({ id: 6 })]);
    await flush();
    expect(t.last()).toMatchObject({ loading: false, hasMore: true, error: null });
    expect(ids(t.last())).toEqual([9, 8, 6]);
    t.feed.older();
    expect(t.last().loadingOlder).toBe(true);
    expect(t.calls[1]!.q).toEqual({ bank: 'hats', beforeId: 6, limit: 3 });
    // A second click while it reads asks for nothing more.
    t.feed.older();
    expect(t.calls).toHaveLength(2);
    t.calls[1]!.d.resolve([ev({ id: 4 })]);
    await flush();
    expect(ids(t.last())).toEqual([9, 8, 6, 4]);
    expect(t.last()).toMatchObject({ loadingOlder: false, hasMore: false });
    t.feed.older();
    expect(t.calls).toHaveLength(2);
  });

  it('a refresh merges what arrived since the newest shown; a burst of pushes costs at most two reads', async () => {
    const t = harness({ page: 3 });
    t.feed.load(DEFAULT_CHANGES_VIEW);
    // Before the first answer the newest is on its way: nothing more to read.
    t.feed.refresh();
    expect(t.calls).toHaveLength(1);
    t.calls[0]!.d.resolve([ev({ id: 5 }), ev({ id: 4 })]);
    await flush();
    t.feed.refresh();
    t.feed.refresh();
    t.feed.refresh();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.q).toEqual({ limit: 3 });
    t.calls[1]!.d.resolve([ev({ id: 7 }), ev({ id: 6 }), ev({ id: 5, revenueScrap: 40 })]);
    await flush();
    expect(ids(t.last())).toEqual([7, 6, 5, 4]);
    // The newest page is valued again.
    expect(t.last().events[2]!.revenueScrap).toBe(40);
    // The burst's one trailing read.
    expect(t.calls).toHaveLength(3);
    t.calls[2]!.d.resolve([ev({ id: 7 }), ev({ id: 6 }), ev({ id: 5 })]);
    await flush();
    expect(t.calls).toHaveLength(3);
    expect(ids(t.last())).toEqual([7, 6, 5, 4]);
  });

  it('a refresh that finds more than the cap replaces the list, so it has no hole', async () => {
    const t = harness({ page: 2, maxKept: 4 });
    t.feed.load(DEFAULT_CHANGES_VIEW);
    t.calls[0]!.d.resolve([ev({ id: 2 }), ev({ id: 1 })]);
    await flush();
    t.feed.refresh();
    t.calls[1]!.d.resolve([ev({ id: 20 }), ev({ id: 19 })]);
    await flush();
    t.calls[2]!.d.resolve([ev({ id: 18 }), ev({ id: 17 })]);
    await flush();
    expect(ids(t.last())).toEqual([20, 19, 18, 17]);
    expect(t.last().hasMore).toBe(true);
  });

  // F20-UIPERF-3: the footer read "That is every change kept" although the cap had cut events off.
  it('a refresh that pushes the list past the cap leaves "Load older" possible: the oldest are still in the feed', async () => {
    const t = harness({ page: 2, maxKept: 4 });
    t.feed.load(DEFAULT_CHANGES_VIEW);
    t.calls[0]!.d.resolve([ev({ id: 3 }), ev({ id: 2 })]);
    await flush();
    t.feed.older();
    t.calls[1]!.d.resolve([ev({ id: 1 })]);
    await flush();
    // Paged back to the end of the feed.
    expect(ids(t.last())).toEqual([3, 2, 1]);
    expect(t.last().hasMore).toBe(false);
    t.feed.refresh();
    t.calls[2]!.d.resolve([ev({ id: 5 }), ev({ id: 4 })]);
    await flush();
    expect(t.calls[3]!.q).toEqual({ beforeId: 4, limit: 2 });
    t.calls[3]!.d.resolve([ev({ id: 3 }), ev({ id: 2 })]);
    await flush();
    // Event 1 fell off the list but not out of the feed.
    expect(ids(t.last())).toEqual([5, 4, 3, 2]);
    expect(t.last().hasMore).toBe(true);
  });

  it('a refresh that re-reads events already shown, and cuts nothing, keeps "That is every change kept"', async () => {
    const t = harness({ page: 2, maxKept: 10 });
    t.feed.load(DEFAULT_CHANGES_VIEW);
    t.calls[0]!.d.resolve([ev({ id: 3 }), ev({ id: 2 })]);
    await flush();
    t.feed.older();
    t.calls[1]!.d.resolve([ev({ id: 1 })]);
    await flush();
    t.feed.refresh();
    // The read holds the new event and one already shown (it is valued again): 5 read, 4 distinct.
    t.calls[2]!.d.resolve([ev({ id: 4 }), ev({ id: 3 })]);
    await flush();
    expect(ids(t.last())).toEqual([4, 3, 2, 1]);
    expect(t.last().hasMore).toBe(false);
  });

  it('"Load older" answered after a refresh that filled the list keeps older events reachable', async () => {
    const t = harness({ page: 2, maxKept: 4 });
    t.feed.load(DEFAULT_CHANGES_VIEW);
    t.calls[0]!.d.resolve([ev({ id: 4 }), ev({ id: 3 })]);
    await flush();
    t.feed.older();
    expect(t.calls[1]!.q).toEqual({ beforeId: 3, limit: 2 });
    // A refresh lands while "Load older" reads.
    t.feed.refresh();
    t.calls[2]!.d.resolve([ev({ id: 6 }), ev({ id: 5 })]);
    await flush();
    t.calls[3]!.d.resolve([ev({ id: 4 }), ev({ id: 3 })]);
    await flush();
    expect(ids(t.last())).toEqual([6, 5, 4, 3]);
    // The older page is the end of the feed, but merged over the full list the cap cuts it off.
    t.calls[1]!.d.resolve([ev({ id: 2 })]);
    await flush();
    expect(ids(t.last())).toEqual([6, 5, 4, 3]);
    expect(t.last()).toMatchObject({ loadingOlder: false, hasMore: true });
  });

  it('says whether a merge cut anything off, over distinct ids', () => {
    expect(mergeChangesTrimmed([ev({ id: 3 }), ev({ id: 2 })], [ev({ id: 4 }), ev({ id: 3 })], 3)).toMatchObject({ dropped: false });
    expect(mergeChangesTrimmed([ev({ id: 3 }), ev({ id: 2 })], [ev({ id: 4 }), ev({ id: 3 })], 3).list.map((e) => e.id)).toEqual([4, 3, 2]);
    const cut = mergeChangesTrimmed([ev({ id: 3 }), ev({ id: 2 })], [ev({ id: 5 }), ev({ id: 4 })], 3);
    expect(cut.list.map((e) => e.id)).toEqual([5, 4, 3]);
    expect(cut.dropped).toBe(true);
  });

  // F20-UIPERF-4: Sells for, Pay up to and Flip were fixed when an event was read.
  it('values the newest rows shown again in place, reading only ids up to the newest shown', async () => {
    const t = harness({ page: 3 });
    t.feed.load({ bank: 'hats', kinds: ['cheaper'] });
    t.calls[0]!.d.resolve([ev({ id: 9 }), ev({ id: 8 }), ev({ id: 6 })]);
    await flush();
    const before = t.last().events;
    t.feed.revalue(2);
    expect(t.calls[1]!.q).toEqual({ bank: 'hats', kinds: ['cheaper'], beforeId: 10, limit: 2 });
    // The buyers moved: 9 no longer a flip; 8 the same as it was.
    t.calls[1]!.d.resolve([ev({ id: 9, revenueScrap: 11, maxCostScrap: 9, flip: false }), ev({ id: 8 })]);
    await flush();
    const after = t.last().events;
    expect(ids(t.last())).toEqual([9, 8, 6]);
    expect(after[0]).toMatchObject({ id: 9, revenueScrap: 11, maxCostScrap: 9, flip: false });
    // An event whose values did not move keeps its object (its row stays memoised); one not read stays.
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(t.last()).toMatchObject({ hasMore: true, loading: false, loadingOlder: false });
    // Nothing moved: no new state at all.
    const states = t.states.length;
    t.feed.revalue(2);
    t.calls[2]!.d.resolve([after[0]!, after[1]!]);
    await flush();
    expect(t.states).toHaveLength(states);
  });

  it('a re-value never adds an event, reads at most the rows shown, pages by 500, and runs once more after a burst', async () => {
    const t = harness({ page: 500, maxKept: 2000 });
    t.feed.load(DEFAULT_CHANGES_VIEW);
    t.calls[0]!.d.resolve(Array.from({ length: 500 }, (_, i) => ev({ id: 1000 - i })));
    await flush();
    t.feed.older();
    t.calls[1]!.d.resolve(Array.from({ length: 200 }, (_, i) => ev({ id: 500 - i })));
    await flush();
    expect(t.last().events).toHaveLength(700);
    t.feed.revalue(650);
    t.feed.revalue(650);
    t.feed.revalue(9999);
    expect(t.calls).toHaveLength(3);
    expect(t.calls[2]!.q).toEqual({ beforeId: 1001, limit: 500 });
    t.calls[2]!.d.resolve(Array.from({ length: 500 }, (_, i) => ev({ id: 1000 - i, revenueScrap: 30 })));
    await flush();
    expect(t.calls[3]!.q).toEqual({ beforeId: 501, limit: 150 });
    // An id the list does not hold (written between two reads, say) is not added.
    t.calls[3]!.d.resolve([ev({ id: 2000, revenueScrap: 30 }), ...Array.from({ length: 150 }, (_, i) => ev({ id: 500 - i, revenueScrap: 30 }))]);
    await flush();
    const s = t.last();
    expect(s.events).toHaveLength(700);
    expect(s.events.some((e) => e.id === 2000)).toBe(false);
    expect(s.events.filter((e) => e.revenueScrap === 30)).toHaveLength(650);
    // The burst ran once more, for every row there is (9999 clamps to the 700 kept).
    expect(t.calls).toHaveLength(5);
    expect(t.calls[4]!.q).toEqual({ beforeId: 1001, limit: 500 });
  });

  it('a re-value of a view the user has left is dropped; a failed one keeps the values shown', async () => {
    const t = harness({ page: 2 });
    t.feed.load(DEFAULT_CHANGES_VIEW);
    t.feed.revalue(2);
    // Nothing to value before the first answer.
    expect(t.calls).toHaveLength(1);
    t.calls[0]!.d.resolve([ev({ id: 2 }), ev({ id: 1 })]);
    await flush();
    t.feed.revalue(2);
    t.feed.load({ bank: 'hats', kinds: [] });
    t.calls[1]!.d.resolve([ev({ id: 2, revenueScrap: 1 })]);
    t.calls[2]!.d.resolve([ev({ id: 7, bank: 'hats' })]);
    await flush();
    expect(t.last().events).toEqual([ev({ id: 7, bank: 'hats' })]);
    t.feed.revalue(5);
    expect(t.calls[3]!.q).toEqual({ bank: 'hats', beforeId: 8, limit: 1 });
    t.calls[3]!.d.reject(new Error('restarting'));
    await flush();
    expect(t.last()).toMatchObject({ events: [ev({ id: 7, bank: 'hats' })], stale: false, error: null });
    // The next move tries again.
    t.feed.revalue(5);
    expect(t.calls).toHaveLength(5);
  });

  it("drops an answer to a view the user has left, and anything after dispose", async () => {
    const t = harness();
    t.feed.load({ bank: 'hats', kinds: [] });
    t.feed.load({ bank: 'weapons', kinds: [] });
    t.calls[0]!.d.resolve([ev({ id: 1, bank: 'hats' })]);
    await flush();
    expect(t.last()).toMatchObject({ loading: true, events: [] });
    t.calls[1]!.d.resolve([ev({ id: 2, bank: 'weapons' })]);
    await flush();
    expect(ids(t.last())).toEqual([2]);
    const before = t.states.length;
    t.feed.refresh();
    t.feed.dispose();
    t.calls[2]!.d.resolve([ev({ id: 3 })]);
    await flush();
    expect(t.states).toHaveLength(before);
    t.feed.load(DEFAULT_CHANGES_VIEW);
    expect(t.calls).toHaveLength(3);
  });

  it('a failed first read says why; a failed refresh keeps the list and marks it stale; a failed "Load older" reports', async () => {
    const t = harness({ page: 1 });
    t.feed.load(DEFAULT_CHANGES_VIEW);
    t.calls[0]!.d.reject(new Error('The background service is restarting.'));
    await flush();
    expect(t.last()).toMatchObject({ loading: false, error: 'The background service is restarting.', events: [] });
    // A push after it reads the first page again (no paging back from id 0), and clears the error.
    t.feed.refresh();
    expect(t.calls[1]!.q).toEqual({ limit: 1 });
    expect(t.last()).toMatchObject({ loading: true, error: null });
    t.calls[1]!.d.resolve([ev({ id: 4 })]);
    await flush();
    expect(t.calls).toHaveLength(2);
    expect(t.last()).toMatchObject({ loading: false, error: null, hasMore: true });
    t.feed.refresh();
    t.calls[2]!.d.reject(new Error('x'));
    await flush();
    expect(t.last()).toMatchObject({ stale: true });
    expect(ids(t.last())).toEqual([4]);
    t.feed.older();
    t.calls[3]!.d.reject(new Error('no'));
    await flush();
    expect(t.olderError).toHaveBeenCalledWith('no');
    expect(t.last()).toMatchObject({ loadingOlder: false });
    expect(ids(t.last())).toEqual([4]);
  });

  it('reports a call that throws at once', async () => {
    const states: ChangesFeedState[] = [];
    const feed = createChangesFeed(
      () => {
        throw new Error('bridge missing');
      },
      (s) => states.push(s),
    );
    feed.load(DEFAULT_CHANGES_VIEW);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(states[states.length - 1]).toMatchObject({ loading: false, error: 'bridge missing' });
  });
});

describe('the words of one change', () => {
  it('percentages: whole from 1 %, one decimal below, a true minus sign', () => {
    expect(changePctText(-1 / 12)).toBe('\u22128 %');
    expect(changePctText(0.05)).toBe('+5 %');
    expect(changePctText(-0.004)).toBe('\u22120.4 %');
    expect(changePctText(0.0001)).toBe('0 %');
    expect(changePctText(0)).toBe('0 %');
    expect(changePctText(null)).toBeNull();
    expect(changePctText(Number.NaN)).toBeNull();
  });

  it('"1.33 → 1.22 ref (−8 %)": the unit once for refined, full prices with keys', () => {
    expect(fromToText(12, 11, K)).toBe('1.33 → 1.22 ref');
    expect(fromToText(K + 9, K, K)).toBe('1 key 1.00 ref → 1 key');
    const p = changePriceText(ev(), K);
    expect(p).toMatchObject({ text: '1.33 → 1.22 ref (\u22128 %)', tone: 'good' });
    expect(p.title).toContain('cheaper by 0.11 ref');
    expect(changePriceText(ev({ kind: 'pricier', fromValueScrap: 20, toValueScrap: 21, deltaScrap: 1, pct: 0.05 }), K)).toMatchObject({ text: '2.22 → 2.33 ref (+5 %)', tone: 'bad' });
    expect(changePriceText(ev({ kind: 'new', fromValueScrap: null, deltaScrap: null, pct: null }), K)).toMatchObject({ text: '1.22 ref', tone: 'muted' });
    expect(changePriceText(ev({ kind: 'gone', toValueScrap: null, deltaScrap: null, pct: null }), K).text).toBe('was 1.33 ref');
    // Gone but still listed sold out at a price: that is its last price, not a current one.
    expect(changePriceText(ev({ kind: 'gone', toValueScrap: 12, toStock: 0, deltaScrap: 0, pct: 0 }), K)).toMatchObject({ text: 'was 1.33 ref', tone: 'muted' });
    expect(changePriceText(ev({ kind: 'gone', fromValueScrap: null, toValueScrap: null, deltaScrap: null, pct: null }), K).text).toBe('—');
    expect(changePriceText(ev({ kind: 'stock', toValueScrap: 12, deltaScrap: 0, pct: 0 }), K).text).toBe('1.33 ref');
    expect(changePriceText(ev({ fromValueScrap: null, toValueScrap: null, deltaScrap: null, pct: null }), K).text).toBe('—');
  });

  it('stock: "stock 5 → 3", "3 in stock", a gone row sold out, or nothing', () => {
    expect(changeStockText(ev())).toBe('stock 5 → 3');
    expect(changeStockText(ev({ kind: 'new', fromStock: null, toStock: 3 }))).toBe('3 in stock');
    expect(changeStockText(ev({ kind: 'gone', fromStock: 2, toStock: 0 }))).toBe('stock 2 → 0');
    expect(changeStockText(ev({ kind: 'gone', fromStock: null, toStock: 0 }))).toBe('sold out');
    expect(changeStockText(ev({ kind: 'gone', fromStock: 2, toStock: null }))).toBeNull();
    expect(changeStockText(ev({ kind: 'cheaper', fromStock: null, toStock: null }))).toBeNull();
    expect(changeSummary(ev(), K)).toBe('Cheaper: 1.33 → 1.22 ref (\u22128 %), stock 5 → 3');
    expect(changeSummary(ev({ kind: 'stock', toValueScrap: 12, deltaScrap: 0, pct: 0 }), K)).toBe('Stock: stock 5 → 3, 1.33 ref');
    expect(CHANGE_KIND_LABELS.restocked).toBe('Restocked');
  });

  it('a feed row: the save time, the bank from SCRAPTF_BANKS, the live side and the Flip pill', () => {
    const v = changeRowView(ev(), K, NOW);
    expect(v.time).toBe(fmtSaveTime(NOW - 3 * HOUR));
    expect(v.time).toMatch(/^Oct 1[45] \d\d:\d\d$/);
    expect(v.timeTitle).toContain('Your save of scrap.tf/buy/hats:');
    expect(v.timeTitle).toContain('(3 h ago), compared with your previous save of that page.');
    expect(v.bank).toEqual({ label: 'Hats', path: 'scrap.tf/buy/hats' });
    expect(v.kind).toMatchObject({ label: 'Cheaper', tone: 'good' });
    expect(v.sellsScrap).toBe(18);
    expect(v.payScrap).toBe(13);
    expect(v.flip!.text).toBe('Flip');
    expect(v.flip!.title).toContain('1.22 ref is 0.22 ref under Pay up to (1.44 ref)');
    expect(v.flip!.title).toContain('Check scrap.tf still has it: this is from your save 3 h ago.');
    expect(v.extrasTitle).toBeNull();
    // A sub-page of the list is named, as text only.
    expect(changeRowView(ev({ bank: 'list', page: '/items/2' }), K, NOW).timeTitle).toContain('Your save of scrap.tf/items (page /items/2):');
    expect(changeRowView(ev({ page: 'body-id-not-a-path' }), K, NOW).timeTitle).not.toContain('page body');
    // Not a flip: no pill, whatever the service's flag.
    expect(changeRowView(ev({ flip: false }), K, NOW).flip).toBeNull();
    expect(changeRowView(ev({ maxCostScrap: null, flip: true }), K, NOW).flip).toBeNull();
    const extras = changeRowView(ev({ hasExtras: true, specialKey: '[1,[],[],null,null,false,false]' }), K, NOW);
    expect(extras.extrasTitle).toContain('Sells for and Pay up to are for a clean copy');
    expect(extras.flip!.title).toContain('Judged as a clean copy.');
    const none = changeRowView(ev({ revenueScrap: null, maxCostScrap: null, flip: false }), K, NOW);
    expect(none.payTitle).toBe('No eligible buy orders, so there is no ceiling.');
    // Nothing in a row is a URL.
    expect(JSON.stringify(v)).not.toMatch(/https?:/);
  });

  it('the empty list says why', () => {
    expect(changesEmptyText(DEFAULT_CHANGES_VIEW)).toMatchObject({ title: 'No scrap.tf changes yet', filtered: false });
    expect(changesEmptyText(DEFAULT_CHANGES_VIEW).body).toContain('The app never visits scrap.tf.');
    const f = changesEmptyText({ bank: 'hats', kinds: ['gone'] });
    expect(f).toMatchObject({ title: 'No changes match these filters', filtered: true });
    expect(f.body).toBe('Nothing of these kinds changed on scrap.tf/buy/hats between your saves. Show every change to see the rest.');
    expect(changesEmptyText({ bank: '', kinds: ['gone'] }).body).toMatch(/^None of your saves changed in these ways\./);
  });
});
