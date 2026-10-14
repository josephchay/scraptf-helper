import { describe, expect, it } from 'vitest';
import { fetchEventsAfter, mergeEvents } from '../../src/renderer/eventFeed';
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
