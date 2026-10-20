import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GroupBy, OppListResult, OppQuery, Opportunity } from '../../shared/types';
import { CATEGORIES, CATEGORY_LABELS, PROFIT_TIER_LABELS } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import { CheckList, Popover, Segmented } from '../components/Controls';
import { Banner, EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { useItemMenu } from '../components/ItemMenu';
import { Money } from '../components/ItemName';
import { OppTable } from '../components/OppTable';
import { SetupChecklist } from '../components/SetupChecklist';
import { INPUT_KIND_LABELS, STATUS_LABELS, errorMessage, fmtInt } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useDebounced, useNow } from '../hooks/useTimers';
import { FEED_OFF_UPDATES } from '../marketModel';
import { firstPriceText } from '../scraptfListModel';
import { scraptfWindowOn } from '../scraptfWindowModel';
import {
  DEFAULT_FILTERS,
  GROUP_BY_LABELS,
  GROUP_PAGE,
  INPUT_ORDER,
  OPP_MAX_SEARCH_CHARS,
  STATUS_ORDER,
  TIER_ORDER,
  activeFilterCount,
  defaultDir,
  emptyListReason,
  exportQuery,
  filtersToQuery,
  isSearchShortcut,
  flattenGroups,
  groupKeyOf,
  groupOpportunities,
  groupPageQuery,
  mergeLoadedRows,
  sanitizeFilters,
  sortOpportunities,
  type EmptyListReason,
  type OppFilters,
  type SortDir,
  type SortKey,
} from '../oppModel';

/** The service caps one response; the table virtualises whatever it receives. */
const ROW_LIMIT = 5000;

const GROUPS: readonly GroupBy[] = ['category', 'tier', 'confidence', 'input'];
const SORTS: readonly SortKey[] = ['profit', 'margin', 'confidence', 'updated', 'name'];

const CONFIDENCE_STEPS = [
  { value: 0, label: 'Any' },
  { value: 45, label: 'Medium+' },
  { value: 70, label: 'High' },
] as const;

function sanitizeGroupBy(v: unknown): GroupBy {
  return GROUPS.includes(v as GroupBy) ? (v as GroupBy) : 'category';
}

function sanitizeSort(v: unknown): { sort: SortKey; dir: SortDir } {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const sort = SORTS.includes(o['sort'] as SortKey) ? (o['sort'] as SortKey) : 'profit';
  const dir = o['dir'] === 'asc' || o['dir'] === 'desc' ? o['dir'] : defaultDir(sort);
  return { sort, dir };
}

function sanitizeCollapsed(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof v !== 'object' || v === null) return out;
  for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(arr)) out[k] = arr.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

const NO_COUNTS: Readonly<Record<string, number>> = Object.freeze({});
const NO_ROWS: Readonly<Record<string, Opportunity[]>> = Object.freeze({});

/**
 * "Load more" under a group the first page could not fill. `want` is how many
 * extra rows the user asked for per group under this query; they are refetched
 * whenever the first page reloads, so they stay as current as the rest.
 */
function useGroupPages(data: OppListResult | undefined, query: OppQuery, groupBy: GroupBy, toast: (text: string, tone?: 'bad') => void) {
  const queryKey = JSON.stringify(query);
  const [want, setWant] = useState<{ query: string; by: Readonly<Record<string, number>> }>({ query: queryKey, by: NO_COUNTS });
  const [got, setGot] = useState<{ query: string; by: Readonly<Record<string, number>>; rows: Readonly<Record<string, Opportunity[]>> }>({
    query: queryKey,
    by: NO_COUNTS,
    rows: NO_ROWS,
  });
  // A new query (filters, sort, grouping) starts from its first page again.
  useEffect(() => {
    setWant((w) => (w.query === queryKey ? w : { query: queryKey, by: NO_COUNTS }));
  }, [queryKey]);
  const wanted = want.query === queryKey ? want.by : NO_COUNTS;
  const loaded = got.query === queryKey ? got : null;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  useEffect(() => {
    const keys = Object.keys(wanted);
    if (!data || keys.length === 0) return;
    const firstPage = groupOpportunities(data.rows, groupBy, data.groups);
    let alive = true;
    Promise.all(
      keys.map(async (key): Promise<[string, Opportunity[]]> => {
        const q = groupPageQuery(query, groupBy, key, firstPage, wanted[key] ?? 0);
        if (!q) return [key, []];
        const r = await rpc('opps.list', q);
        return [key, r.rows.filter((o) => groupKeyOf(o, groupBy) === key)];
      }),
    )
      .then((pairs) => {
        if (alive) setGot({ query: queryKey, by: wanted, rows: Object.fromEntries(pairs) });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const done = loadedRef.current?.by ?? NO_COUNTS;
        // A failed refresh keeps the rows shown; a failed "Load more" says so and re-arms the button.
        if (keys.some((k) => (wanted[k] ?? 0) > (done[k] ?? 0))) {
          toast(`Could not load more opportunities: ${errorMessage(e)}`, 'bad');
          setWant({ query: queryKey, by: done });
        }
      });
    return () => {
      alive = false;
    };
    // query and groupBy are part of queryKey, which `wanted` follows.
  }, [data, wanted]);

  const loading = useMemo(() => new Set(Object.keys(wanted).filter((k) => (wanted[k] ?? 0) > (loaded?.by[k] ?? 0))), [wanted, loaded]);
  const loadMore = useCallback(
    (key: string) =>
      setWant((w) => {
        const by = w.query === queryKey ? w.by : NO_COUNTS;
        return { query: queryKey, by: { ...by, [key]: (by[key] ?? 0) + GROUP_PAGE } };
      }),
    [queryKey],
  );
  // Only groups asked for under this query (rows of an earlier visit to it are not refreshed).
  const rows = useMemo(() => {
    if (!loaded) return NO_ROWS;
    const out: Record<string, Opportunity[]> = {};
    for (const k of Object.keys(wanted)) if (loaded.rows[k]) out[k] = loaded.rows[k];
    return out;
  }, [loaded, wanted]);
  return { rows, loading, loadMore };
}

export function OpportunitiesPage() {
  const { keyScrap: statusKey, settings, status, secrets, openItem, navigate, toast, updateSettings, itemSku } = useApp();
  const [filters, setFilters] = usePersistentState<OppFilters>('opps.filters', { ...DEFAULT_FILTERS, status: [...DEFAULT_FILTERS.status] }, sanitizeFilters);
  const [groupBy, setGroupBy] = usePersistentState<GroupBy>('opps.groupBy', 'category', sanitizeGroupBy);
  const [sort, setSort] = usePersistentState<{ sort: SortKey; dir: SortDir }>('opps.sort', { sort: 'profit', dir: 'desc' }, sanitizeSort);
  const [collapsedBy, setCollapsedBy] = usePersistentState<Record<string, string[]>>('opps.collapsed', {}, sanitizeCollapsed);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(5000);

  const search = useDebounced(filters.search, 200);
  const query = useMemo(
    () => filtersToQuery({ ...filters, search }, { sort: sort.sort, dir: sort.dir, groupBy, limit: ROW_LIMIT }),
    [filters, search, sort, groupBy],
  );
  const list = useRpcQuery('opps.list', query);
  const reload = useThrottled(() => void list.reload(), 1500);
  // Closed to the tray the page stays mounted: skip reloads while hidden and
  // catch up once when it is shown again.
  useVisiblePush('opps.changed', reload);
  const more = useGroupPages(list.data, query, groupBy, toast);

  const keyScrap = list.data?.keyPrice?.valueScrap ?? statusKey;
  const collapsed = useMemo(() => new Set(collapsedBy[groupBy] ?? []), [collapsedBy, groupBy]);
  const loadedRows = useMemo(() => mergeLoadedRows(list.data?.rows ?? [], more.rows), [list.data, more.rows]);
  const sorted = useMemo(() => sortOpportunities(loadedRows, sort.sort, sort.dir), [loadedRows, sort]);
  const groups = useMemo(() => groupOpportunities(sorted, groupBy, list.data?.groups), [sorted, groupBy, list.data]);
  const rows = useMemo(() => flattenGroups(groups, collapsed), [groups, collapsed]);
  const filterCount = activeFilterCount(filters);

  const totals = useMemo(() => {
    let profit = 0;
    let profitable = 0;
    for (const o of sorted) {
      if (o.status === 'profitable' && o.profitScrap !== null) {
        profit += o.profitScrap;
        profitable++;
      }
    }
    return { profit, profitable };
  }, [sorted]);

  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsedBy((prev) => {
        const cur = new Set(prev[groupBy] ?? []);
        if (cur.has(key)) cur.delete(key);
        else cur.add(key);
        return { ...prev, [groupBy]: [...cur] };
      }),
    [groupBy, setCollapsedBy],
  );

  const setAllCollapsed = (on: boolean) => setCollapsedBy((prev) => ({ ...prev, [groupBy]: on ? groups.map((g) => g.key) : [] }));

  const onSort = useCallback(
    (k: SortKey) => setSort((s) => (s.sort === k ? { sort: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { sort: k, dir: defaultDir(k) })),
    [setSort],
  );

  const onOpen = useCallback((o: Opportunity) => openItem(o.sku), [openItem]);

  // F9 item menu. Through a ref, so the memoised rows keep a stable handler.
  const menu = useItemMenu();
  const openMenuRef = useRef(menu.open);
  openMenuRef.current = menu.open;
  const onRowMenu = useCallback((o: Opportunity, at: { x: number; y: number }) => openMenuRef.current({ sku: o.sku, name: o.name, category: o.category }, at), []);

  // "/" focuses the search box from anywhere on the page, but not from inside the item drawer.
  const drawerOpen = useRef(false);
  drawerOpen.current = itemSku !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e, e.target as HTMLElement | null, drawerOpen.current)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = <K extends keyof OppFilters>(k: K, v: OppFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const resetFilters = () => setFilters({ ...DEFAULT_FILTERS, status: [...DEFAULT_FILTERS.status] });

  const exportCsv = async () => {
    try {
      // Exactly what the list shows (filters and sort, including a search typed in the last moment), every page.
      const q = exportQuery(filtersToQuery(filters, { sort: sort.sort, dir: sort.dir, groupBy, limit: ROW_LIMIT }));
      const r = await saveCsv(() => rpc('opps.exportCsv', { kind: 'opportunities', query: q }));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    }
  };

  const total = list.data?.total ?? 0;
  const loaded = list.data ? loadedRows.length : 0;
  const feedOff = settings ? !settings.liveFeed.enabled : status?.feed === 'off';
  const paused = status?.networkPaused ?? false;
  // Refreshing an item needs the access token; the API key alone does not help.
  const noToken = secrets ? !secrets.bptfAccessToken : false;

  return (
    <div className="page opps-page">
      <SetupChecklist />

      <div className="toolbar" role="toolbar" aria-label="Filters">
        <div className="search-box">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            className="input"
            placeholder="Search items or SKUs  ( / )"
            aria-label="Search opportunities"
            maxLength={OPP_MAX_SEARCH_CHARS}
            value={filters.search}
            onChange={(e) => set('search', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') set('search', '');
            }}
          />
        </div>
        <Popover label={<>Category{filters.categories.length ? <span className="count">{filters.categories.length}</span> : null}</>} active={filters.categories.length > 0}>
          <CheckList values={filters.categories} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} onChange={(v) => set('categories', v)} />
        </Popover>
        <Popover label={<>Tier{filters.tiers.length ? <span className="count">{filters.tiers.length}</span> : null}</>} active={filters.tiers.length > 0}>
          <CheckList values={filters.tiers} options={TIER_ORDER.map((t) => ({ value: t, label: PROFIT_TIER_LABELS[t] }))} onChange={(v) => set('tiers', v)} />
        </Popover>
        <Popover label={<>Confidence{filters.minConfidence > 0 ? <span className="count">≥{filters.minConfidence}</span> : null}</>} active={filters.minConfidence > 0}>
          <div className="popover-body">
            <Segmented ariaLabel="Minimum confidence" value={CONFIDENCE_STEPS.some((s) => s.value === filters.minConfidence) ? filters.minConfidence : -1} options={CONFIDENCE_STEPS.map((s) => ({ value: s.value, label: s.label }))} onChange={(v) => set('minConfidence', v)} />
            <label className="range-row">
              <span className="muted small">Minimum score</span>
              <input type="range" min={0} max={100} step={5} value={filters.minConfidence} onChange={(e) => set('minConfidence', Number(e.target.value))} aria-label="Minimum confidence score" />
              <span className="num">{filters.minConfidence}</span>
            </label>
          </div>
        </Popover>
        <Popover label={<>Input{filters.inputKinds.length ? <span className="count">{filters.inputKinds.length}</span> : null}</>} active={filters.inputKinds.length > 0}>
          <CheckList values={filters.inputKinds} options={INPUT_ORDER.map((k) => ({ value: k, label: INPUT_KIND_LABELS[k] }))} onChange={(v) => set('inputKinds', v)} />
        </Popover>
        <Popover label={<>Status<span className="count">{filters.status.length || 'all'}</span></>} active={filters.status.join() !== DEFAULT_FILTERS.status.join()}>
          <CheckList values={filters.status} options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} onChange={(v) => set('status', v)} />
        </Popover>
        {filterCount > 0 ? (
          <button type="button" className="btn ghost small" onClick={resetFilters}>
            Reset
          </button>
        ) : null}
        <div className="toolbar-spacer" />
        <Segmented ariaLabel="Group by" value={groupBy} options={GROUPS.map((g) => ({ value: g, label: GROUP_BY_LABELS[g] }))} onChange={setGroupBy} small />
      </div>

      <div className="summary-bar">
        <div className="summary-stats" aria-live="polite">
          {list.data ? (
            <>
              <span>
                <strong className="num">{fmtInt(total)}</strong> {total === 1 ? 'match' : 'matches'}
                {loaded < total ? <span className="muted"> (showing {fmtInt(loaded)})</span> : null}
              </span>
              <span className="sep" aria-hidden="true" />
              <span>
                <strong className="num">{fmtInt(totals.profitable)}</strong> profitable, together <Money scrap={totals.profit} keyScrap={keyScrap} tone="profit" signed />
              </span>
            </>
          ) : (
            <span className="muted">Loading…</span>
          )}
          {/* 0.7.3: visual only; this is a live region and the live feed reloads it every 1.5 s. */}
          {list.reloading && list.data ? <span className="muted small" aria-hidden="true"> · updating</span> : null}
        </div>
        <div className="summary-actions">
          <button type="button" className="btn ghost small" onClick={() => setAllCollapsed(false)} title="Expand all groups">
            <Icon name="expand" size={14} /> Expand
          </button>
          <button type="button" className="btn ghost small" onClick={() => setAllCollapsed(true)} title="Collapse all groups">
            <Icon name="collapse" size={14} /> Collapse
          </button>
          <button type="button" className="btn small" onClick={() => void exportCsv()} title="Saves every opportunity matching these filters, in this order">
            <Icon name="download" size={14} /> Export CSV
          </button>
        </div>
      </div>

      {paused ? (
        <Banner tone="warn" icon="pause">
          Network is paused, so prices are not updating. <button type="button" className="link-btn" onClick={() => void updateSettings({ networkPaused: false })}>Resume network</button>
        </Banner>
      ) : null}

      {list.error && !list.data ? <ErrorBanner message={`Could not load opportunities: ${list.error}`} onRetry={() => void list.reload()} /> : null}

      <div className="table-region">
        {list.loading && !list.data ? (
          <LoadingBlock label="Loading opportunities…" />
        ) : total === 0 && list.data ? (
          <NoResults
            reason={emptyListReason(filters, status?.counts.opportunities)}
            hiddenCount={status?.counts.opportunities ?? 0}
            feedOff={feedOff}
            paused={paused}
            noToken={noToken}
            onReset={resetFilters}
            onAllStatuses={() => set('status', [])}
          />
        ) : (
          <OppTable
            rows={rows}
            keyScrap={keyScrap}
            now={now}
            staleMs={settings?.profit.inputStaleMs ?? 2 * 3_600_000}
            useOrder={settings?.profit.useOrder ?? 'conservative'}
            density={settings?.ui.density ?? 'comfortable'}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={onOpen}
            onToggleGroup={toggleGroup}
            onLoadMore={more.loadMore}
            loadingMore={more.loading}
            sort={sort.sort}
            dir={sort.dir}
            onSort={onSort}
            onContextMenu={onRowMenu}
          />
        )}
      </div>
      <p className="hint-line muted small">
        Keyboard: <kbd>j</kbd>/<kbd>k</kbd> or arrows to move, <kbd>Enter</kbd> to open, <kbd>←</kbd>/<kbd>→</kbd> to fold groups, <kbd>Shift</kbd>+<kbd>F10</kbd> or right-click for item actions, <kbd>/</kbd> to search. Profit uses the{' '}
        {settings?.profit.useOrder ?? 'conservative'} order.{' '}
        <button type="button" className="link-btn" onClick={() => navigate('settings')}>
          Change thresholds
        </button>
      </p>
      {menu.element}
    </div>
  );
}

export function NoResults({
  reason,
  hiddenCount,
  feedOff,
  paused,
  noToken,
  onReset,
  onAllStatuses,
}: {
  reason: EmptyListReason;
  /** Opportunities in the database; with `reason` 'status-hidden' all of them are hidden by the status filter. */
  hiddenCount: number;
  feedOff: boolean;
  paused: boolean;
  noToken: boolean;
  onReset: () => void;
  onAllStatuses: () => void;
}) {
  const { navigate, updateSettings, toast, settings, status } = useApp();
  // 0.7.3: the service's own "no stored price and no enabled rule" test (computeStatus), re-pushed with
  // 'status.changed' after any price or rule write from any window; the setup checklist reads it too.
  // No re-read of the whole price sheet on every opps.changed.
  const firstPrice = status?.setupNeeded.includes('first-price') === true;

  const openQuick = () => rpc('app.showQuickEntry').catch(() => toast('Could not open quick entry.', 'bad'));

  if (firstPrice) {
    // UX-4: one save of scrap.tf/items (the Import page's price-list card) first; typing stays secondary.
    return (
      <EmptyState
        icon="tag"
        title="Add the scrap.tf prices you want to check"
        actions={
          <>
            <button type="button" className="btn primary" onClick={() => navigate('import')}>
              <Icon name="import" size={14} /> Save scrap.tf/items
            </button>
            <button type="button" className="btn" onClick={() => void openQuick()}>
              <Icon name="quick" size={14} /> Quick entry
            </button>
            <button type="button" className="btn ghost" onClick={() => navigate('prices')}>
              Open price sheet
            </button>
          </>
        }
      >
        {firstPriceText(scraptfWindowOn(settings))} Or type the prices you see (Quick entry), or add a rule such as &quot;unique craftable hats cost 1.77 ref&quot;. The app compares them with live
        backpack.tf buy orders and lists what is profitable here.
      </EmptyState>
    );
  }
  // 0.7.3: the pause or the feed is blamed only when no opportunity exists; otherwise the filters hide
  // them (as emptyMarketReason does on the Live market).
  if (paused && hiddenCount === 0) {
    return (
      <EmptyState icon="pause" title="The network is paused" actions={<button type="button" className="btn primary" onClick={() => void updateSettings({ networkPaused: false })}>Resume network</button>}>
        No buy orders are arriving while the network is paused.
      </EmptyState>
    );
  }
  if (feedOff && hiddenCount === 0) {
    return (
      <EmptyState icon="feed" title="The live feed is off" actions={<button type="button" className="btn primary" onClick={() => void updateSettings({ liveFeed: { enabled: true } })}>Turn on live feed</button>}>
        Buy orders come from backpack.tf&apos;s live feed. Without it, {FEED_OFF_UPDATES}.
        {noToken ? ' Refreshing an item needs that token too (Settings).' : ''}
      </EmptyState>
    );
  }
  if (reason === 'status-hidden') {
    return (
      <EmptyState
        icon="filter"
        title="Nothing is profitable right now"
        actions={
          <>
            <button type="button" className="btn" onClick={onAllStatuses}>
              Show every status
            </button>
            <button type="button" className="btn ghost" onClick={() => navigate('settings')}>
              Change thresholds
            </button>
          </>
        }
      >
        By default only profitable items are listed. {fmtInt(hiddenCount)} {hiddenCount === 1 ? 'opportunity is' : 'opportunities are'} below your thresholds,
        unprofitable or without buyers, and hidden.
        {feedOff ? ` The live feed is off, so ${FEED_OFF_UPDATES}.` : ''}
      </EmptyState>
    );
  }
  if (reason === 'filters') {
    return (
      <EmptyState
        icon="filter"
        title="Nothing matches these filters"
        actions={
          <>
            <button type="button" className="btn" onClick={onReset}>
              Reset filters
            </button>
            <button type="button" className="btn ghost" onClick={onAllStatuses}>
              Show every status
            </button>
          </>
        }
      >
        By default only profitable items are listed. Items below your thresholds, unprofitable ones and items with no buyers are hidden.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon="opps" title="Nothing to show yet" actions={noToken ? <button type="button" className="btn" onClick={() => navigate('settings')}>Add backpack.tf token</button> : undefined}>
      The engine re-checks your prices whenever a matching buy order changes. New buy orders can take a while to appear after start-up.
      {noToken ? ' Adding a backpack.tf access token lets you refresh an item on demand.' : ''}
    </EmptyState>
  );
}

