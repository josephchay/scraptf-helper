import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GroupBy, Opportunity } from '../../shared/types';
import { CATEGORIES, CATEGORY_LABELS, PROFIT_TIER_LABELS } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import { CheckList, Popover, Segmented } from '../components/Controls';
import { Banner, EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { Money } from '../components/ItemName';
import { OppTable } from '../components/OppTable';
import { SetupChecklist } from '../components/SetupChecklist';
import { INPUT_KIND_LABELS, STATUS_LABELS, errorMessage, fmtInt } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { usePush, useRpcQuery, useThrottled } from '../hooks/useRpc';
import { useDebounced, useDocumentVisible, useNow } from '../hooks/useTimers';
import {
  DEFAULT_FILTERS,
  GROUP_BY_LABELS,
  INPUT_ORDER,
  STATUS_ORDER,
  TIER_ORDER,
  activeFilterCount,
  defaultDir,
  exportQuery,
  filtersToQuery,
  isSearchShortcut,
  flattenGroups,
  groupOpportunities,
  sanitizeFilters,
  sortOpportunities,
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
  const visible = useDocumentVisible();
  const missedPush = useRef(false);
  usePush('opps.changed', () => {
    if (document.visibilityState === 'hidden') missedPush.current = true;
    else reload();
  });
  useEffect(() => {
    if (visible && missedPush.current) {
      missedPush.current = false;
      reload();
    }
  }, [visible, reload]);

  const keyScrap = list.data?.keyPrice?.valueScrap ?? statusKey;
  const collapsed = useMemo(() => new Set(collapsedBy[groupBy] ?? []), [collapsedBy, groupBy]);
  const sorted = useMemo(() => sortOpportunities(list.data?.rows ?? [], sort.sort, sort.dir), [list.data, sort]);
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
  const loaded = list.data?.rows.length ?? 0;
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
          {list.reloading && list.data ? <span className="muted small"> · updating</span> : null}
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
          <NoResults filterCount={filterCount} feedOff={feedOff} paused={paused} noToken={noToken} onReset={resetFilters} onAllStatuses={() => set('status', [])} />
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
            sort={sort.sort}
            dir={sort.dir}
            onSort={onSort}
          />
        )}
      </div>
      <p className="hint-line muted small">
        Keyboard: <kbd>j</kbd>/<kbd>k</kbd> or arrows to move, <kbd>Enter</kbd> to open, <kbd>←</kbd>/<kbd>→</kbd> to fold groups, <kbd>/</kbd> to search. Profit uses the{' '}
        {settings?.profit.useOrder ?? 'conservative'} order.{' '}
        <button type="button" className="link-btn" onClick={() => navigate('settings')}>
          Change thresholds
        </button>
      </p>
    </div>
  );
}

function NoResults({
  filterCount,
  feedOff,
  paused,
  noToken,
  onReset,
  onAllStatuses,
}: {
  filterCount: number;
  feedOff: boolean;
  paused: boolean;
  noToken: boolean;
  onReset: () => void;
  onAllStatuses: () => void;
}) {
  const { navigate, updateSettings, toast, dataVersion } = useApp();
  const [counts, setCounts] = useState<{ prices: number; rules: number } | null>(null);
  const [tick, setTick] = useState(0);
  const bump = useThrottled(() => setTick((t) => t + 1), 3000);
  usePush('opps.changed', bump);

  useEffect(() => {
    let alive = true;
    Promise.all([rpc('prices.list', {}), rpc('rules.list')])
      .then(([p, r]) => {
        if (alive) setCounts({ prices: p.length, rules: r.filter((x) => x.enabled).length });
      })
      .catch(() => {
        if (alive) setCounts({ prices: 0, rules: 0 });
      });
    return () => {
      alive = false;
    };
  }, [dataVersion, tick]);

  const openQuick = () => rpc('app.showQuickEntry').catch(() => toast('Could not open quick entry.', 'bad'));

  if (counts && counts.prices === 0 && counts.rules === 0) {
    return (
      <EmptyState
        icon="tag"
        title="Add the scrap.tf prices you want to check"
        actions={
          <>
            <button type="button" className="btn primary" onClick={() => void openQuick()}>
              <Icon name="quick" size={14} /> Quick entry
            </button>
            <button type="button" className="btn" onClick={() => navigate('prices')}>
              Open price sheet
            </button>
            <button type="button" className="btn ghost" onClick={() => navigate('import')}>
              Import a saved page
            </button>
          </>
        }
      >
        Browse scrap.tf in your own browser and type the prices you see (or add a rule such as &quot;unique craftable hats cost 1.77 ref&quot;). The app compares them with live backpack.tf buy orders and lists what is profitable here.
      </EmptyState>
    );
  }
  if (paused) {
    return (
      <EmptyState icon="pause" title="The network is paused" actions={<button type="button" className="btn primary" onClick={() => void updateSettings({ networkPaused: false })}>Resume network</button>}>
        No buy orders are arriving while the network is paused.
      </EmptyState>
    );
  }
  if (feedOff) {
    return (
      <EmptyState icon="feed" title="The live feed is off" actions={<button type="button" className="btn primary" onClick={() => void updateSettings({ liveFeed: { enabled: true } })}>Turn on live feed</button>}>
        Buy orders come from backpack.tf&apos;s live feed. Without it, only items you refresh by hand get buy orders.
        {noToken ? ' Refreshing by hand needs a backpack.tf access token (Settings).' : ''}
      </EmptyState>
    );
  }
  if (filterCount > 0) {
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

