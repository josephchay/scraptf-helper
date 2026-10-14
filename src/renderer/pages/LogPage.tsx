import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Category, OpportunityEvent, OpportunityEventKind } from '../../shared/types';
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import { ChipGroup } from '../components/Controls';
import { EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { useItemMenu } from '../components/ItemMenu';
import { ItemName, Money } from '../components/ItemName';
import { EVENT_KIND_LABELS, confidenceLevelOf, errorMessage, fmtAgo, fmtDateTime, fmtInt, fmtTime } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useNow } from '../hooks/useTimers';
import { MAX_KEPT_EVENTS, fetchEventsAfter, mergeEvents, olderPageLimit } from '../eventFeed';

const PAGE = 300;
const KINDS: readonly OpportunityEventKind[] = ['appeared', 'changed', 'gone', 'notified'];
const KIND_TONE: Record<OpportunityEventKind, string> = { appeared: 'good', changed: 'info', gone: 'muted', notified: 'accent' };

function sanitizeKinds(v: unknown): OpportunityEventKind[] {
  return Array.isArray(v) ? v.filter((k): k is OpportunityEventKind => KINDS.includes(k as OpportunityEventKind)) : [];
}

export function LogPage() {
  const { openItem, keyScrap, toast } = useApp();
  const [kinds, setKinds] = usePersistentState<OpportunityEventKind[]>('log.kinds', [], sanitizeKinds);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<Category | ''>('');
  const [events, setEvents] = useState<OpportunityEvent[]>([]);
  const [pending, setPending] = useState<OpportunityEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [visible, setVisible] = useState(200);
  const scroller = useRef<HTMLDivElement>(null);
  const newest = useRef<OpportunityEvent | null>(null);
  const holding = paused || !atTop;
  const holdingRef = useRef(holding);
  holdingRef.current = holding;
  const now = useNow(5000);
  const menu = useItemMenu();
  const kindsParam = kinds.length ? kinds : undefined;
  const kindsKey = kinds.join(',');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPending([]);
    rpc('opps.events', { limit: PAGE, kinds: kindsParam })
      .then((list) => {
        if (!alive) return;
        const sorted = mergeEvents([], list);
        setEvents(sorted);
        newest.current = sorted[0] ?? null;
        setHasMore(list.length >= PAGE);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // kindsKey captures the filter; kindsParam is derived from it.
  }, [kindsKey]);

  const fetchNew = useCallback(async () => {
    const known = newest.current?.id ?? 0;
    try {
      // Pages back by id until it reaches what is already shown: one engine run
      // can append far more events than a single page holds.
      const { fresh, complete } = await fetchEventsAfter(
        (beforeId) => rpc('opps.events', { limit: PAGE, kinds: kindsParam, ...(beforeId !== undefined ? { beforeId } : {}) }),
        known,
        PAGE,
      );
      const top = fresh[0];
      if (!top) return;
      if (!newest.current || top.id > newest.current.id) newest.current = top;
      if (!complete) {
        // More new events than the log keeps: restart from the newest so the
        // list has no hole; "Load older" continues from there.
        setPending([]);
        setEvents(fresh);
        setHasMore(true);
        return;
      }
      if (holdingRef.current) setPending((p) => mergeEvents(p, fresh));
      else setEvents((ev) => mergeEvents(ev, fresh));
    } catch {
      // The next push retries.
    }
  }, [kindsKey]);

  const throttledFetch = useThrottled(() => void fetchNew(), 1000);
  // Hidden in the tray, one catch-up when shown replaces a page request per second.
  useVisiblePush('opps.changed', throttledFetch);

  const flushPending = () => {
    setEvents((ev) => mergeEvents(ev, pending));
    setPending([]);
    if (scroller.current) scroller.current.scrollTop = 0;
    setAtTop(true);
  };

  useEffect(() => {
    if (!holding && pending.length) {
      setEvents((ev) => mergeEvents(ev, pending));
      setPending([]);
    }
  }, [holding, pending]);

  const olderLimit = olderPageLimit(events.length, PAGE);
  const loadOlder = async () => {
    const oldest = events[events.length - 1];
    if (!oldest || olderLimit === 0) return;
    setLoadingOlder(true);
    try {
      const list = await rpc('opps.events', { limit: olderLimit, kinds: kindsParam, beforeId: oldest.id });
      setEvents((ev) => mergeEvents(ev, list));
      setHasMore(list.length >= olderLimit);
      setVisible((v) => v + PAGE);
    } catch (e) {
      toast(`Could not load older events: ${errorMessage(e)}`, 'bad');
    } finally {
      setLoadingOlder(false);
    }
  };

  const filtered = useMemo(() => {
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    return events.filter(
      (e) => (!category || e.category === category) && tokens.every((t) => `${e.name} ${e.sku} ${e.summary}`.toLowerCase().includes(t)),
    );
  }, [events, search, category]);
  const shown = filtered.slice(0, visible);

  const exportCsv = async () => {
    try {
      const r = await saveCsv(() => rpc('opps.exportCsv', { kind: 'events' }));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    }
  };

  return (
    <div className="page log-page">
      <div className="toolbar" role="toolbar" aria-label="Log filters">
        <div className="search-box">
          <Icon name="search" size={14} />
          <input type="search" className="input" placeholder="Filter by item or text" aria-label="Filter events" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <ChipGroup ariaLabel="Event kinds" values={kinds} options={KINDS.map((k) => ({ value: k, label: EVENT_KIND_LABELS[k] }))} onChange={setKinds} />
        <select className="input select" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as Category | '')}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <div className="toolbar-spacer" />
        <button type="button" className={`btn small${paused ? ' active' : ''}`} aria-pressed={paused} onClick={() => setPaused((p) => !p)} title="Hold new events so the list stops moving">
          <Icon name={paused ? 'play' : 'pause'} size={14} /> {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="btn small" onClick={() => void exportCsv()}>
          <Icon name="download" size={14} /> Export CSV
        </button>
      </div>

      {pending.length ? (
        <button type="button" className="new-events" onClick={flushPending}>
          <Icon name="arrowUp" size={14} /> {pending.length} new {pending.length === 1 ? 'event' : 'events'}, show
        </button>
      ) : null}

      {error ? <ErrorBanner message={`Could not load the log: ${error}`} /> : null}

      <div
        className="log-scroll"
        ref={scroller}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop < 8;
          if (top !== atTop) setAtTop(top);
        }}
      >
        {loading ? (
          <LoadingBlock label="Loading events…" />
        ) : shown.length === 0 ? (
          <EmptyState icon="log" title={events.length ? 'No events match these filters' : 'No events yet'}>
            {events.length
              ? 'Clear the filters to see everything.'
              : 'Events appear when an opportunity appears, changes, goes away or triggers a notification. They stream in as buy orders change.'}
          </EmptyState>
        ) : (
          <table className="table log-table">
            <thead>
              <tr>
                <th className="c-time">Time</th>
                <th className="c-kind">Event</th>
                <th>Item</th>
                <th>What changed</th>
                <th className="num">Profit</th>
                <th className="num">Conf.</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr
                  key={e.id}
                  className={`kind-${e.kind}`}
                  onContextMenu={(ev) => {
                    // Right-click, or Shift+F10 / the ContextMenu key on the focused item button
                    // (the menu places a keyboard event's 0,0 next to that button).
                    ev.preventDefault();
                    menu.open({ sku: e.sku, name: e.name }, { x: ev.clientX, y: ev.clientY });
                  }}
                >
                  <td className="c-time num" title={`${fmtDateTime(e.ts)} (${fmtAgo(e.ts, now)})`}>
                    {fmtTime(e.ts)}
                  </td>
                  <td className="c-kind">
                    <span className={`pill tone-${KIND_TONE[e.kind]}`}>{EVENT_KIND_LABELS[e.kind]}</span>
                  </td>
                  <td>
                    <div className="cell-clip">
                      <button type="button" className="row-link" onClick={() => openItem(e.sku)}>
                        <ItemName sku={e.sku} name={e.name} maxTags={2} />
                      </button>
                    </div>
                  </td>
                  <td className="summary-cell">{e.summary}</td>
                  <td className="num">
                    <Money scrap={e.profitScrap} keyScrap={keyScrap} tone="profit" signed />
                  </td>
                  <td className="num">
                    <span className={`conf-num conf-${confidenceLevelOf(e.confidence)}`}>{e.confidence}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && (filtered.length > visible || hasMore) ? (
          <div className="load-more">
            {filtered.length > visible ? (
              <button type="button" className="btn small" onClick={() => setVisible((v) => v + 200)}>
                Show more
              </button>
            ) : olderLimit === 0 ? (
              <span className="muted small">
                The live log keeps the newest {fmtInt(MAX_KEPT_EVENTS)} events. Older ones are in the daily opportunities-YYYY-MM-DD.jsonl files in the logs folder (Settings, This
                installation).
              </span>
            ) : (
              <button type="button" className="btn small" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? 'Loading…' : 'Load older events'}
              </button>
            )}
          </div>
        ) : null}
      </div>
      <p className="hint-line muted small">
        {holding ? (paused ? 'Paused: new events are held until you resume.' : 'Scrolled down: new events are held so the list does not jump.') : 'Live: new events appear at the top.'} Right-click
        an event, or press <kbd>Shift</kbd>+<kbd>F10</kbd> on its item, for item actions.
      </p>
      {menu.element}
    </div>
  );
}
