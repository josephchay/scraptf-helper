// Live log (#/log): the opportunity events of today, and from F20 (U3) a second tab, "scrap.tf changes"
// (#/log/changes): every change between two saves of a scrap.tf bank page the user made, newest first,
// with the live backpack.tf side and a Flip pill ('scraptf.changes'). The changes come only from pages
// the user saved (R10); nothing here loads scrap.tf (R1) or opens a page. Helpers: eventFeed.ts (events)
// and changesModel.ts (changes); the feed's styles are in styles/scraptf-history.css (stf-feed-*).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Category, OpportunityEvent, OpportunityEventKind, Scrap, ScraptfChangeEvent, UnixMs } from '../../shared/types';
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/types';
import { SCRAPTF_CHANGES_EXPORT_MAX } from '../../shared/scraptfHistory';
import { rpc, saveCsv } from '../api';
import {
  CHANGES_MAX_KEPT,
  CHANGES_PAGE,
  CHANGES_PREF_KEY,
  CHANGES_REFRESH_MS,
  CHANGES_REVALUE_MS,
  CHANGES_SHOWN,
  CHANGE_BANK_OPTIONS,
  CHANGE_KIND_OPTIONS,
  DEFAULT_CHANGES_VIEW,
  LOG_TABS,
  changeRowView,
  changesEmptyText,
  changesExportQuery,
  changesViewKey,
  createChangesFeed,
  logTabOf,
  logTabPath,
  sanitizeChangesView,
  type ChangesFeed,
  type ChangesFeedState,
  type ChangesView,
} from '../changesModel';
import { ChipGroup, Tabs } from '../components/Controls';
import { EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { useItemMenu } from '../components/ItemMenu';
import { ItemName, Money } from '../components/ItemName';
import { DASH, EVENT_KIND_LABELS, confidenceLevelOf, errorMessage, fmtAgo, fmtDateTime, fmtInt, fmtTime } from '../format';
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
  const { segments, navigate } = useApp();
  const tab = logTabOf(segments);
  return (
    <div className="page log-page">
      <Tabs ariaLabel="Live log" value={tab} tabs={LOG_TABS} onChange={(t) => navigate(logTabPath(t))} />
      {tab === 'changes' ? <ScraptfChangesView /> : <OppEventsView />}
    </div>
  );
}

/** The opportunity events (the log as it was before F20). */
function OppEventsView() {
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
    <>
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
                    menu.open({ sku: e.sku, name: e.name, category: e.category }, { x: ev.clientX, y: ev.clientY });
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
    </>
  );
}

// ---------------------------------------------------------------------------
// scrap.tf changes (F20 U3)
// ---------------------------------------------------------------------------

const EMPTY_FEED: ChangesFeedState = { events: [], loading: true, loadingOlder: false, hasMore: false, error: null, stale: false };

type MenuPoint = { x: number; y: number };

/**
 * 'scraptf.changes' for the view, kept current: an import that wrote changes pushes 'scraptf.changed',
 * read at most once per CHANGES_REFRESH_MS and only while the window is shown (one catch-up when shown).
 * Reads never overlap and an answer to a view the user has left is dropped (createChangesFeed). The
 * `shown` rows' Sells for, Pay up to and Flip are valued again on 'market.changed', at most once per
 * CHANGES_REVALUE_MS and only while shown: the service values an event when it is read.
 */
function useChangesFeed(view: ChangesView, shown: number, onOlderError: (message: string) => void): { state: ChangesFeedState; older(): void; retry(): void } {
  const [state, setState] = useState<ChangesFeedState>(EMPTY_FEED);
  const feed = useRef<ChangesFeed | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const errRef = useRef(onOlderError);
  errRef.current = onOlderError;
  // Created in an effect, so StrictMode's mount, unmount, mount ends with a live feed, and an unmount
  // drops whatever is still in flight.
  useEffect(() => {
    const f = createChangesFeed((q) => rpc('scraptf.changes', q), setState, { onOlderError: (m) => errRef.current(m) });
    feed.current = f;
    f.load(viewRef.current);
    return () => {
      f.dispose();
      feed.current = null;
    };
  }, []);
  const key = changesViewKey(view);
  const loadedKey = useRef(key);
  useEffect(() => {
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    feed.current?.load(viewRef.current);
  }, [key]);
  const refreshSoon = useThrottled(() => feed.current?.refresh(), CHANGES_REFRESH_MS);
  useVisiblePush('scraptf.changed', refreshSoon);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const revalueSoon = useThrottled(() => feed.current?.revalue(shownRef.current), CHANGES_REVALUE_MS);
  useVisiblePush('market.changed', revalueSoon);
  return { state, older: () => feed.current?.older(), retry: () => feed.current?.load(viewRef.current) };
}

/** Every change between two of the user's saves of a bank page, newest first (F20 U3). */
function ScraptfChangesView() {
  const { openItem, keyScrap, toast } = useApp();
  const [view, setView] = usePersistentState<ChangesView>(CHANGES_PREF_KEY, DEFAULT_CHANGES_VIEW, sanitizeChangesView);
  // The rows rendered, per view: a new filter starts again at CHANGES_SHOWN.
  const viewKey = changesViewKey(view);
  const [shownMax, setShownMax] = useState({ key: viewKey, n: CHANGES_SHOWN });
  const maxRows = shownMax.key === viewKey ? shownMax.n : CHANGES_SHOWN;
  const { state, older, retry } = useChangesFeed(view, maxRows, (m) => toast(`Could not load older changes: ${m}`, 'bad'));
  // Only the rows' hover titles read the time ("5 min ago"): once a minute re-renders them all.
  const now = useNow(60_000);
  const rows = state.events.length > maxRows ? state.events.slice(0, maxRows) : state.events;
  const hidden = state.events.length - rows.length;
  const loadOlder = () => {
    // What "Load older" brings shows at once.
    setShownMax({ key: viewKey, n: Math.max(maxRows, state.events.length + CHANGES_PAGE) });
    older();
  };
  const menu = useItemMenu();
  // Through a ref, so the memoised rows keep a stable handler.
  const menuRef = useRef(menu.open);
  menuRef.current = menu.open;
  const onMenu = useCallback((e: ScraptfChangeEvent, at: MenuPoint) => menuRef.current({ sku: e.sku, name: e.name, bank: e.bank }, at), []);
  const empty = changesEmptyText(view);

  const exportCsv = async () => {
    try {
      const r = await saveCsv(() => rpc('opps.exportCsv', { kind: 'scraptfChanges', scraptfChanges: changesExportQuery(view) }));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    }
  };

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="scrap.tf change filters">
        <select className="input select" aria-label="Bank" value={view.bank} onChange={(e) => setView((v) => sanitizeChangesView({ ...v, bank: e.target.value }))}>
          {CHANGE_BANK_OPTIONS.map((o) => (
            <option key={o.value || 'all'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChipGroup ariaLabel="Change kinds" values={view.kinds} options={CHANGE_KIND_OPTIONS} onChange={(kinds) => setView((v) => sanitizeChangesView({ ...v, kinds }))} />
        <div className="toolbar-spacer" />
        {state.stale ? <span className="tone-text-bad small">refresh failed</span> : null}
        <button
          type="button"
          className="btn small"
          disabled={state.loading || state.events.length === 0}
          title="Saves every change matching the bank and kinds, newest first"
          onClick={() => void exportCsv()}
        >
          <Icon name="download" size={14} /> Export CSV
        </button>
      </div>

      {state.error ? <ErrorBanner message={`Could not load the scrap.tf changes: ${state.error}`} onRetry={retry} /> : null}

      <div className="log-scroll stf-feed-scroll">
        {state.loading ? (
          <LoadingBlock label="Loading scrap.tf changes…" />
        ) : state.events.length === 0 ? (
          state.error ? null : (
            <EmptyState
              icon="banks"
              title={empty.title}
              actions={
                empty.filtered ? (
                  <button type="button" className="btn" onClick={() => setView({ ...DEFAULT_CHANGES_VIEW, kinds: [] })}>
                    Show every change
                  </button>
                ) : undefined
              }
            >
              {empty.body}
            </EmptyState>
          )
        ) : (
          <table className="table log-table stf-feed-table">
            <thead>
              <tr>
                <th className="c-time stf-feed-time">Saved</th>
                <th className="stf-feed-bank">Bank</th>
                <th className="c-kind stf-feed-kind">Change</th>
                <th>Item</th>
                <th className="num stf-feed-price">scrap.tf price</th>
                <th className="num stf-feed-sells">Sells for</th>
                <th className="num stf-feed-pay">Pay up to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <ChangeRow key={e.id} e={e} keyScrap={keyScrap} now={now} onOpen={openItem} onMenu={onMenu} />
              ))}
            </tbody>
          </table>
        )}
        {!state.loading && state.events.length > 0 ? (
          <div className="load-more">
            {hidden > 0 ? (
              <button type="button" className="btn small" onClick={() => setShownMax({ key: viewKey, n: maxRows + CHANGES_SHOWN })}>
                Show {fmtInt(Math.min(hidden, CHANGES_SHOWN))} more
              </button>
            ) : state.hasMore && state.events.length < CHANGES_MAX_KEPT ? (
              <button type="button" className="btn small" disabled={state.loadingOlder} onClick={loadOlder}>
                {state.loadingOlder ? 'Loading…' : 'Load older changes'}
              </button>
            ) : state.hasMore ? (
              <span className="muted small">
                This tab keeps the newest {fmtInt(CHANGES_MAX_KEPT)} changes. Export CSV has up to {fmtInt(SCRAPTF_CHANGES_EXPORT_MAX)}.
              </span>
            ) : (
              <span className="muted small">That is every change kept: changes are kept for 90 days.</span>
            )}
          </div>
        ) : null}
      </div>
      <p className="hint-line muted small">
        Each change is between two of your saves of a scrap.tf page; what happened between them is unknown. Sells for and Pay up to are live (read again within{' '}
        {Math.round(CHANGES_REVALUE_MS / 1000)} s when backpack.tf buyers move). Click a change for the item;
        right-click it, or press <kbd>Shift</kbd>+<kbd>F10</kbd> on its item, for item actions. Updates when you save a page.
      </p>
      {menu.element}
    </>
  );
}

const ChangeRow = memo(function ChangeRow({
  e,
  keyScrap,
  now,
  onOpen,
  onMenu,
}: {
  e: ScraptfChangeEvent;
  keyScrap: Scrap | null;
  now: UnixMs;
  onOpen: (sku: string) => void;
  onMenu: (e: ScraptfChangeEvent, at: MenuPoint) => void;
}) {
  const v = changeRowView(e, keyScrap, now);
  const priceTone = v.price.tone === 'good' || v.price.tone === 'bad' ? ` tone-text-${v.price.tone}` : '';
  return (
    <tr
      className={`stf-feed-row kind-${e.kind}${v.flip ? ' flip' : ''}`}
      // The drawer opens by base SKU: Sells for and Pay up to are read for it.
      onClick={() => onOpen(e.sku)}
      onContextMenu={(ev) => {
        // Right-click, or Shift+F10 / the ContextMenu key on the focused item button (the menu places a
        // keyboard event's 0,0 next to that button).
        ev.preventDefault();
        onMenu(e, { x: ev.clientX, y: ev.clientY });
      }}
    >
      <td className="c-time stf-feed-time num" title={v.timeTitle}>
        {v.time}
      </td>
      <td className="stf-feed-bank" title={v.bank.path}>
        {v.bank.label}
      </td>
      <td className="c-kind">
        <span className={`pill tone-${v.kind.tone}`} title={v.kind.title}>
          {v.kind.label}
        </span>
      </td>
      <td>
        <div className="cell-clip stf-feed-item">
          <button
            type="button"
            className="row-link"
            onClick={(ev) => {
              ev.stopPropagation();
              onOpen(e.sku);
            }}
          >
            <ItemName sku={e.sku} name={e.name} maxTags={2} />
          </button>
          {v.extrasTitle ? (
            <span className="bs-extras" title={v.extrasTitle}>
              extras
            </span>
          ) : null}
        </div>
      </td>
      <td className="num stf-feed-price">
        <span className={`money${priceTone}`} title={v.price.title}>
          {v.price.text}
        </span>
        {v.stock ? <div className="muted small">{v.stock}</div> : null}
      </td>
      <td className="num stf-feed-sells" title={v.sellsTitle}>
        {v.sellsScrap !== null ? <Money scrap={v.sellsScrap} keyScrap={keyScrap} /> : <span className="muted">{DASH}</span>}
      </td>
      <td className="num stf-feed-pay" title={v.payTitle}>
        {v.payScrap !== null ? <Money scrap={v.payScrap} keyScrap={keyScrap} /> : <span className="muted">{DASH}</span>}
        {v.flip ? (
          <span className="pill tone-good stf-feed-flip" title={v.flip.title}>
            {v.flip.text}
          </span>
        ) : null}
      </td>
    </tr>
  );
});
