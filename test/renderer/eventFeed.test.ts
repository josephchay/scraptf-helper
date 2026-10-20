import { describe, expect, it } from 'vitest';
import { MAX_KEPT_EVENTS, eventsExportQuery, fetchEventsAfter, mergeEvents, olderPageLimit } from '../../src/renderer/eventFeed';
import { MARKET_MAX_SEARCH_CHARS, marketSearchTokens } from '../../src/shared/market';
import { eventMatches } from '../../src/shared/opportunityEvents';
import type { OpportunityEvent } from '../../src/shared/types';

function ev(id: number, ts = 1_000): OpportunityEvent {
  return { id, key: `k${id}`, sku: '378;6', name: 'Team Captain', category: 'hats', kind: 'appeared', profitScrap: 1, costScrap: 1, revenueScrap: 2, confidence: 50, summary: '', ts };
}

/** Same answer shape as repo.listEvents: id < beforeId, newest first, LIMIT. */
function store(events: OpportunityEvent[]) {
  const calls: (number | undefined)[] = [];
  const fetchPage = (limit: number) => async (beforeId: number | undefined) => {
    calls.push(beforeId);
    return events
      .filter((e) => beforeId === undefined || e.id < beforeId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  };
  return { calls, fetchPage };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('mergeEvents', () => {
  it('dedupes by id, newest first, capped', () => {
    expect(mergeEvents([ev(1), ev(3)], [ev(3), ev(2)]).map((e) => e.id)).toEqual([3, 2, 1]);
    expect(mergeEvents([ev(1), ev(2), ev(3)], [], 2).map((e) => e.id)).toEqual([3, 2]);
  });
});

describe('"Load older events" at the in-memory cap', () => {
  it('requests nothing once the list is full, because the merge would drop the whole page again', () => {
    const full = range(1_001, 1_000 + MAX_KEPT_EVENTS).reverse().map((id) => ev(id));
    const olderPage = range(701, 1_000).reverse().map((id) => ev(id));
    // What the page did before: merge a full page into a full list. Nothing changes, so the
    // next click asks for the same page again.
    const merged = mergeEvents(full, olderPage);
    expect(merged.at(-1)!.id).toBe(full.at(-1)!.id);
    expect(olderPageLimit(full.length, 300)).toBe(0);
  });

  it('asks only for what still fits, so every fetched event is kept', () => {
    expect(olderPageLimit(0, 300)).toBe(300);
    expect(olderPageLimit(MAX_KEPT_EVENTS - 100, 300)).toBe(100);
    expect(olderPageLimit(MAX_KEPT_EVENTS + 5, 300)).toBe(0);
    const kept = range(201, 500).reverse().map((id) => ev(id));
    const limit = olderPageLimit(kept.length, 300, 400);
    expect(limit).toBe(100);
    const older = range(1, 200).reverse().slice(0, limit).map((id) => ev(id));
    const merged = mergeEvents(kept, older, 400);
    expect(merged).toHaveLength(400);
    expect(merged.at(-1)!.id).toBe(older.at(-1)!.id);
  });
});

describe('fetchEventsAfter (live log)', () => {
  it('returns every event added since the last fetch even when more than one page arrived', async () => {
    // The log showed up to id 100; one engine run then wrote 350 events with the same timestamp.
    const s = store(range(1, 450).map((id) => ev(id, id <= 100 ? 500 : 1_000)));
    const { fresh, complete } = await fetchEventsAfter(s.fetchPage(200), 100, 200);
    expect(complete).toBe(true);
    expect(fresh).toHaveLength(350);
    expect(fresh.map((e) => e.id)).toEqual(range(101, 450).reverse());
    // Paged back by id: newest page, then before the oldest id of that page.
    expect(s.calls).toEqual([undefined, 251]);
  });

  it('stops after one page when the known event is in it', async () => {
    const s = store(range(1, 120).map((id) => ev(id)));
    const { fresh, complete } = await fetchEventsAfter(s.fetchPage(300), 110, 300);
    expect(complete).toBe(true);
    expect(fresh.map((e) => e.id)).toEqual(range(111, 120).reverse());
    expect(s.calls).toEqual([undefined]);
  });

  it('returns nothing when no new events exist', async () => {
    const s = store(range(1, 50).map((id) => ev(id)));
    expect(await fetchEventsAfter(s.fetchPage(300), 50, 300)).toEqual({ fresh: [], complete: true });
  });

  it('reports an incomplete batch when more arrived than the log keeps, so the list is replaced instead of left with a hole', async () => {
    const s = store(range(1, 1_000).map((id) => ev(id)));
    const { fresh, complete } = await fetchEventsAfter(s.fetchPage(100), 10, 100, 300);
    expect(complete).toBe(false);
    expect(fresh.map((e) => e.id)).toEqual(range(701, 1_000).reverse());
    expect(s.calls).toHaveLength(3);
  });

  it('treats an exactly full last page as complete once the next page is empty', async () => {
    const s = store(range(1, 200).map((id) => ev(id)));
    const { fresh, complete } = await fetchEventsAfter(s.fetchPage(100), 0, 100);
    expect(complete).toBe(true);
    expect(fresh).toHaveLength(200);
    expect(s.calls).toEqual([undefined, 101, 1]);
  });
});

// Audit xcontract-2 (0.7.3): Export CSV on the events view sends the view's filters, and the page and the
// service match category and search with one predicate.
describe('eventsExportQuery and eventMatches (events export)', () => {
  it('leaves out what does not filter, dedupes the kinds, and cuts the search at 200 characters before trimming', () => {
    expect(eventsExportQuery([], '', '')).toEqual({});
    expect(eventsExportQuery([], '', '   ')).toEqual({});
    expect(eventsExportQuery(['notified', 'gone', 'notified'], 'unusuals', '  burning  team ')).toEqual({ kinds: ['notified', 'gone'], category: 'unusuals', search: 'burning  team' });
    const long = eventsExportQuery([], '', `${'x'.repeat(199)} tail`).search!;
    expect(long).toBe('x'.repeat(199));
    expect(long.length).toBeLessThanOrEqual(MARKET_MAX_SEARCH_CHARS);
  });

  it('matches the category and every search word, any case, across name, SKU and summary', () => {
    const e = { ...ev(1), category: 'unusuals' as const, name: 'Burning Flames Team Captain', sku: '378;5;u13', summary: 'desktop notification: new buyer' };
    expect(eventMatches(e, '', [])).toBe(true);
    expect(eventMatches(e, undefined, [])).toBe(true);
    expect(eventMatches(e, 'unusuals', marketSearchTokens('BURNING team'))).toBe(true);
    expect(eventMatches(e, 'hats', [])).toBe(false);
    expect(eventMatches(e, '', marketSearchTokens('u13 buyer'))).toBe(true);
    expect(eventMatches(e, '', marketSearchTokens('burning sunbeams'))).toBe(false);
  });
});
