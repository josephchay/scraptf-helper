// Shopping list (feature F1): every tracked SKU with a "pay up to" ceiling,
// grouped by scrap.tf bank page. The user browses scrap.tf in their own
// browser with this list; Flip Desk never loads scrap.tf on its own (R1, R10). The
// bank page links only go to links.open, which hands them to the user's browser.
// 0.7.1 (ACT-9): Your price says how old it is, and a stale one is not counted as a flip.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { SCRAPTF_BOUNDARY_SHORT } from '../../shared/boundaryText';
import type { Category, Scrap, ShoppingRow } from '../../shared/types';
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import { CheckoutGuard } from '../components/CheckoutGuard';
import { CheckList, Popover } from '../components/Controls';
import { openOrCopy } from '../components/ExternalLink';
import { Banner, EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { isContextMenuKey, menuPointForRect, useItemMenu } from '../components/ItemMenu';
import { ItemName, Money } from '../components/ItemName';
import { ROW_HEIGHT } from '../components/OppTable';
import { ConfidenceBadge, OnlineDot } from '../components/Pills';
import { errorMessage, flagInfo, fmtAge, fmtDateTime, fmtInt, fmtMoney } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useDebounced, useNow } from '../hooks/useTimers';
import { indexOfRow, isMenuKeyEcho, isSearchShortcut, menuAnchorRect, moveCursor } from '../oppModel';
import {
  MAX_SEARCH_CHARS,
  MIN_CEILING_PRESETS,
  activeShoppingFilterCount,
  bankPageOf,
  bankPageText,
  buyerKindLabel,
  countUnderCeiling,
  defaultShoppingFilters,
  emptyShoppingReason,
  flattenShoppingGroups,
  groupShoppingRows,
  readMinCeiling,
  sanitizeCollapsedCategories,
  sanitizeShoppingFilters,
  sellsForTitle,
  shoppingExportQuery,
  shoppingQuery,
  thresholdSummary,
  yourPriceAge,
  yourPriceTitle,
  yourPriceTone,
  type EmptyShoppingReason,
  type ShoppingDisplayRow,
  type ShoppingFilters,
} from '../shoppingModel';

/** The service caps one response; the table virtualises whatever it receives. */
const ROW_LIMIT = 5000;

type MenuPoint = { x: number; y: number };

export function ShoppingPage() {
  const { keyScrap: statusKey, settings, status, openItem, navigate, toast, updateSettings, itemSku } = useApp();
  const [filters, setFilters] = usePersistentState<ShoppingFilters>('shopping.filters', defaultShoppingFilters(), sanitizeShoppingFilters);
  const [collapsedList, setCollapsedList] = usePersistentState<Category[]>('shopping.collapsed', [], sanitizeCollapsedCategories);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(5000);
  const menu = useItemMenu();

  const search = useDebounced(filters.search, 200);
  // Typing "10 ref" passes through unparseable text; only a settled value reaches the query.
  const minText = useDebounced(filters.minCeiling, 300);
  const minCeiling = readMinCeiling(minText, statusKey);
  const query = useMemo(() => shoppingQuery({ ...filters, search }, minCeiling.scrap, { limit: ROW_LIMIT }), [filters, search, minCeiling.scrap]);
  const list = useRpcQuery('shopping.list', query);
  const reload = useThrottled(() => void list.reload(), 1500);
  // Ceilings follow buy orders, prices and thresholds, and each of those ends in an engine run.
  // Closed to the tray the page stays mounted: skip reloads while hidden, catch up once when shown.
  useVisiblePush('opps.changed', reload);

  const keyScrap = list.data?.keyPrice?.valueScrap ?? statusKey;
  const collapsed = useMemo(() => new Set<string>(collapsedList), [collapsedList]);
  const groups = useMemo(() => groupShoppingRows(list.data?.rows ?? [], list.data?.groups), [list.data]);
  const rows = useMemo(() => flattenShoppingGroups(groups, collapsed), [groups, collapsed]);
  const underCount = useMemo(() => countUnderCeiling(list.data?.rows ?? []), [list.data]);
  const filterCount = activeShoppingFilterCount(filters);

  const toggleGroup = useCallback(
    (key: Category) => setCollapsedList((prev) => (prev.includes(key) ? prev.filter((c) => c !== key) : [...prev, key])),
    [setCollapsedList],
  );
  const setAllCollapsed = (on: boolean) => setCollapsedList(on ? groups.map((g) => g.category) : []);

  const onOpen = useCallback((r: ShoppingRow) => openItem(r.sku), [openItem]);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const openBank = useCallback((url: string) => void openOrCopy(url, toastRef.current), []);
  // F9 item menu. Through a ref, so the memoised rows keep a stable handler.
  const openMenuRef = useRef(menu.open);
  openMenuRef.current = menu.open;
  const onRowMenu = useCallback((r: ShoppingRow, at: MenuPoint) => openMenuRef.current({ sku: r.sku, name: r.name, category: r.category }, at), []);

  // "/" focuses the search box from anywhere on the page, but not from inside the item drawer.
  const drawerOpen = useRef(false);
  drawerOpen.current = itemSku !== null;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isSearchShortcut(e, e.target as HTMLElement | null, drawerOpen.current)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = <K extends keyof ShoppingFilters>(k: K, v: ShoppingFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const resetFilters = () => setFilters(defaultShoppingFilters());

  const exportCsv = async () => {
    try {
      // Exactly what the list shows, including text typed in the last moment, with every row.
      const q = shoppingExportQuery(shoppingQuery(filters, readMinCeiling(filters.minCeiling, statusKey).scrap));
      const r = await saveCsv(() => rpc('opps.exportCsv', { kind: 'shopping', shopping: q }));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    }
  };

  const minShown = readMinCeiling(filters.minCeiling, statusKey);
  const total = list.data?.total ?? 0;
  const loaded = list.data?.rows.length ?? 0;
  const paused = status?.networkPaused ?? false;
  const feedOff = settings ? !settings.liveFeed.enabled : status?.feed === 'off';

  return (
    <div className="page shopping-page">
      <Banner tone="info" icon="cart">
        <strong>Browse scrap.tf yourself: anything priced at or under Pay up to is a flip.</strong>{' '}
        <span className="muted">
          Each ceiling is the most you can pay and still make {settings ? thresholdSummary(settings.profit, keyScrap) : 'your minimum profit'}, from live backpack.tf buy
          orders. {SCRAPTF_BOUNDARY_SHORT} The page links open in your browser.
        </span>{' '}
        <button type="button" className="link-btn" onClick={() => navigate('settings')}>
          Change thresholds
        </button>
      </Banner>
      {/* 0.9 (#9): the list suggests buying, so it says what to know before joining a bank's queue (text only). */}
      <CheckoutGuard variant="line" />

      <div className="toolbar" role="toolbar" aria-label="Filters">
        <div className="search-box">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            className="input"
            placeholder="Search items or SKUs  ( / )"
            aria-label="Search the shopping list"
            maxLength={MAX_SEARCH_CHARS}
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
        <Popover
          label={<>Pay up to{minShown.scrap !== null ? <span className="count">≥ {fmtMoney(minShown.scrap, keyScrap)}</span> : minShown.error ? <span className="count">?</span> : null}</>}
          active={filters.minCeiling.trim() !== ''}
        >
          <div className="popover-body">
            <div className="field">
              <label className="field-label" htmlFor="shop-min-ceiling">
                Only items I can pay at least
              </label>
              <input
                id="shop-min-ceiling"
                className={`input${minShown.error ? ' invalid' : ''}`}
                type="text"
                placeholder="e.g. 2 ref or 1 key"
                maxLength={40}
                aria-invalid={minShown.error ? true : undefined}
                aria-describedby="shop-min-ceiling-hint"
                value={filters.minCeiling}
                onChange={(e) => set('minCeiling', e.target.value)}
              />
              <span id="shop-min-ceiling-hint" className={minShown.error ? 'field-error' : 'field-hint'}>
                {minShown.error ?? (minShown.scrap !== null ? `${fmtMoney(minShown.scrap, keyScrap)} or more.` : 'Bare numbers are refined.')}
              </span>
            </div>
            <div className="chip-group" role="group" aria-label="Quick picks">
              {MIN_CEILING_PRESETS.map((p) => (
                <button key={p} type="button" className={`chip${filters.minCeiling.trim() === p ? ' on' : ''}`} aria-pressed={filters.minCeiling.trim() === p} onClick={() => set('minCeiling', p)}>
                  {p}
                </button>
              ))}
              <button type="button" className={`chip${filters.minCeiling.trim() === '' ? ' on' : ''}`} aria-pressed={filters.minCeiling.trim() === ''} onClick={() => set('minCeiling', '')}>
                Any
              </button>
            </div>
          </div>
        </Popover>
        <button
          type="button"
          className={`btn${filters.onlyBotBuyers ? ' active' : ''}`}
          aria-pressed={filters.onlyBotBuyers}
          onClick={() => set('onlyBotBuyers', !filters.onlyBotBuyers)}
          title="Only items whose buyer is a trading bot: those usually accept at once"
        >
          <Icon name="bolt" size={14} /> Bot buyers only
        </button>
        {filterCount > 0 ? (
          <button type="button" className="btn ghost small" onClick={resetFilters}>
            Reset
          </button>
        ) : null}
      </div>

      <div className="summary-bar">
        <div className="summary-stats" aria-live="polite">
          {list.data ? (
            <>
              <span>
                <strong className="num">{fmtInt(total)}</strong> {total === 1 ? 'item' : 'items'} with a ceiling
                {loaded < total ? <span className="muted"> (showing {fmtInt(loaded)})</span> : null}
              </span>
              <span className="sep" aria-hidden="true" />
              <span title="Items whose latest typed or imported scrap.tf price is at or under the ceiling and not stale (Settings → Profit thresholds → Price is stale after)">
                <strong className="num tone-text-good">{fmtInt(underCount)}</strong> already at or under it at your last price
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
          <button type="button" className="btn small" onClick={() => void exportCsv()} title="Saves every item matching these filters, with its ceiling and bank page">
            <Icon name="download" size={14} /> Export CSV
          </button>
        </div>
      </div>

      {paused ? (
        <Banner tone="warn" icon="pause">
          Network is paused, so buy orders and ceilings are not updating.{' '}
          <button type="button" className="link-btn" onClick={() => void updateSettings({ networkPaused: false })}>
            Resume network
          </button>
        </Banner>
      ) : null}

      {list.error && !list.data ? <ErrorBanner message={`Could not load the shopping list: ${list.error}`} onRetry={() => void list.reload()} /> : null}

      {list.error && !list.data ? null : (
        <div className="table-region">
          {list.loading && !list.data ? (
            <LoadingBlock label="Loading the shopping list…" />
          ) : list.data && total === 0 ? (
            <NoRows reason={emptyShoppingReason(filters)} feedOff={feedOff} onReset={resetFilters} />
          ) : (
            <ShoppingTable
              rows={rows}
              keyScrap={keyScrap}
              now={now}
              density={settings?.ui.density ?? 'comfortable'}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpen={onOpen}
              onToggleGroup={toggleGroup}
              onOpenBank={openBank}
              onMenu={onRowMenu}
            />
          )}
        </div>
      )}
      <p className="hint-line muted small">
        Keyboard: <kbd>j</kbd>/<kbd>k</kbd> or arrows to move, <kbd>Enter</kbd> to open, <kbd>←</kbd>/<kbd>→</kbd> to fold groups, <kbd>o</kbd> to open the group&apos;s scrap.tf
        page in your browser, <kbd>Shift</kbd>+<kbd>F10</kbd> or right-click for item actions, <kbd>/</kbd> to search.
      </p>
      {menu.element}
    </div>
  );
}

function NoRows({ reason, feedOff, onReset }: { reason: EmptyShoppingReason; feedOff: boolean; onReset: () => void }) {
  const { navigate, updateSettings } = useApp();
  if (reason === 'filters') {
    return (
      <EmptyState
        icon="filter"
        title="Nothing matches these filters"
        actions={
          <button type="button" className="btn" onClick={onReset}>
            Reset filters
          </button>
        }
      >
        Only items with a ceiling above zero are listed. Clear the search, lower the minimum, or show human buyers too.
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon="cart"
      title="No ceilings yet"
      actions={
        <>
          <button type="button" className="btn primary" onClick={() => navigate('prices')}>
            Open price sheet
          </button>
          <button type="button" className="btn" onClick={() => navigate('prices/rules')}>
            Add a rule
          </button>
          {feedOff ? (
            <button type="button" className="btn ghost" onClick={() => void updateSettings({ liveFeed: { enabled: true } })}>
              Turn on live feed
            </button>
          ) : null}
        </>
      }
    >
      The list holds the items you track (scrap.tf prices you typed or imported, and items your price-sheet rules match) that have live backpack.tf buy orders high
      enough to clear your thresholds. A rule such as &quot;unique craftable hats&quot; fills it with candidates to look for on scrap.tf.
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------
// Virtual table
// ---------------------------------------------------------------------------

interface TableProps {
  rows: ShoppingDisplayRow[];
  keyScrap: Scrap | null;
  now: number;
  density: 'comfortable' | 'compact';
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (r: ShoppingRow) => void;
  onToggleGroup: (key: Category) => void;
  onOpenBank: (url: string) => void;
  onMenu: (r: ShoppingRow, at: MenuPoint) => void;
}

/** Virtualised, grouped grid with the same keyboard model as the opportunities table. */
function ShoppingTable({ rows, keyScrap, now, density, selectedId, onSelect, onOpen, onToggleGroup, onOpenBank, onMenu }: TableProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  // Only the first visible row is state, so scrolling within a row costs no render.
  const [firstRow, setFirstRow] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [headH, setHeadH] = useState(34);
  const raf = useRef(0);
  const keyboardMove = useRef(false);
  const menuKeyAt = useRef(0);
  const rowH = ROW_HEIGHT[density];

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setViewH(el.clientHeight);
      setHeadH(header.current?.offsetHeight ?? 34);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setFirstRow(Math.floor((scroller.current?.scrollTop ?? 0) / rowH)));
  };

  const selectedIndex = indexOfRow(rows, selectedId);

  // Keep the keyboard cursor visible; mouse selection never scrolls.
  useEffect(() => {
    if (!keyboardMove.current || selectedIndex < 0) return;
    keyboardMove.current = false;
    const el = scroller.current;
    if (!el) return;
    const top = selectedIndex * rowH;
    const visible = el.clientHeight - headH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + visible) el.scrollTop = top + rowH - visible;
  }, [selectedIndex, rowH, headH]);

  useEffect(() => {
    setFirstRow(Math.floor((scroller.current?.scrollTop ?? 0) / rowH));
  }, [rowH]);

  const overscan = 10;
  const start = Math.max(0, firstRow - overscan);
  const end = Math.min(rows.length, firstRow + Math.ceil(viewH / rowH) + overscan);
  const pageSize = Math.max(1, Math.floor((viewH - headH) / rowH) - 1);

  // Opened from the keyboard: anchored to the cursor's item row.
  const menuForRow = (idx: number): boolean => {
    const row = rows[idx];
    if (row?.type !== 'item') return false;
    const box = document.getElementById(`shoprow-${idx}`)?.getBoundingClientRect();
    onMenu(row.row, menuPointForRect(menuAnchorRect(box, scroller.current?.getBoundingClientRect(), headH)));
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const idx = indexOfRow(rows, selectedId);
    const row = idx >= 0 ? rows[idx] : undefined;
    if (isContextMenuKey(e)) {
      if (menuForRow(idx)) {
        e.preventDefault();
        menuKeyAt.current = Date.now();
      }
      return;
    }
    const go = (n: number) => {
      e.preventDefault();
      const id = rows[n]?.id ?? null;
      // Nothing moves (k on the first row): no effect would clear the flag before a later re-sort.
      if (id === selectedId) return;
      keyboardMove.current = true;
      onSelect(id);
    };
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        go(moveCursor(rows, idx, 1));
        break;
      case 'k':
      case 'ArrowUp':
        go(moveCursor(rows, idx, -1));
        break;
      case 'PageDown':
        go(moveCursor(rows, idx, pageSize));
        break;
      case 'PageUp':
        go(moveCursor(rows, idx, -pageSize));
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(rows.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (!row) return;
        e.preventDefault();
        if (row.type === 'group') onToggleGroup(row.group.category);
        else if (row.type === 'item') onOpen(row.row);
        break;
      case 'o': {
        const url = bankPageOf(row);
        if (!url) return;
        e.preventDefault();
        onOpenBank(url);
        break;
      }
      case 'ArrowLeft':
        if (!row) return;
        e.preventDefault();
        if (row.type === 'group') {
          if (!row.collapsed) onToggleGroup(row.group.category);
        } else {
          keyboardMove.current = true;
          onSelect(`group:${row.groupKey}`);
        }
        break;
      case 'ArrowRight':
        if (row?.type === 'group' && row.collapsed) {
          e.preventDefault();
          onToggleGroup(row.group.category);
        }
        break;
    }
  };

  // A keyboard-generated contextmenu lands on the focused grid itself; rows handle the mouse.
  const onGridMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (isMenuKeyEcho(menuKeyAt.current, Date.now())) return;
    menuForRow(indexOfRow(rows, selectedId));
  };

  return (
    <div
      className={`opp-scroll shop-scroll density-${density}`}
      ref={scroller}
      onScroll={onScroll}
      tabIndex={0}
      role="grid"
      aria-label="Shopping list. Use j and k or the arrow keys to move, Enter to open, o for the scrap.tf page, Shift+F10 for item actions."
      aria-rowcount={rows.length + 1}
      aria-activedescendant={selectedIndex >= 0 ? `shoprow-${selectedIndex}` : undefined}
      onKeyDown={onKey}
      onContextMenu={onGridMenu}
      onFocus={() => {
        if (selectedIndex < 0 && rows.length) onSelect(rows[0]!.id);
      }}
    >
      {/* 0.7.3: only a window of rows is in the DOM, so each says where it sits (as in the Live market). */}
      <div className="opp-row opp-head" role="row" aria-rowindex={1} ref={header}>
        <div role="columnheader" className="s-item">
          Item
        </div>
        <div role="columnheader" className="s-pay num" title="The highest scrap.tf price that still clears your profit thresholds">
          Pay up to
        </div>
        <div role="columnheader" className="s-sells" title="Revenue from the buy order your settings use, and who placed it">
          Sells for
        </div>
        <div role="columnheader" className="s-conf">
          Confidence
        </div>
        <div role="columnheader" className="s-yours num" title="Your latest typed or imported scrap.tf price: green at or under the ceiling, red over it">
          Your price
        </div>
        <div role="columnheader" className="s-updated num" title="Last change">
          Updated
        </div>
      </div>
      <div className="opp-body" role="rowgroup" style={{ height: rows.length * rowH }}>
        {rows.slice(start, end).map((r, i) => {
          const index = start + i;
          const selected = r.id === selectedId;
          if (r.type === 'group') {
            return <GroupRow key={r.id} row={r} index={index} rowH={rowH} selected={selected} onSelect={onSelect} onToggle={onToggleGroup} onOpenBank={onOpenBank} />;
          }
          if (r.type === 'more') return <MoreRow key={r.id} row={r} index={index} rowH={rowH} selected={selected} onSelect={onSelect} />;
          return <ItemRow key={r.id} id={r.id} row={r.row} index={index} rowH={rowH} selected={selected} keyScrap={keyScrap} now={now} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} />;
        })}
      </div>
    </div>
  );
}

function rowStyle(index: number, rowH: number): CSSProperties {
  return { transform: `translateY(${index * rowH}px)`, height: rowH };
}

const GroupRow = memo(function GroupRow({
  row,
  index,
  rowH,
  selected,
  onSelect,
  onToggle,
  onOpenBank,
}: {
  row: Extract<ShoppingDisplayRow, { type: 'group' }>;
  index: number;
  rowH: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggle: (key: Category) => void;
  onOpenBank: (url: string) => void;
}) {
  const g = row.group;
  const page = bankPageText(g.bankPageUrl);
  return (
    <div
      id={`shoprow-${index}`}
      role="row"
      aria-rowindex={index + 2}
      aria-expanded={!row.collapsed}
      aria-selected={selected}
      className={`opp-row opp-group${selected ? ' selected' : ''}`}
      style={rowStyle(index, rowH)}
      onClick={() => {
        onSelect(row.id);
        onToggle(g.category);
      }}
    >
      <div role="gridcell" className="group-cell">
        <Icon name={row.collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
        <span className="group-label">{g.label}</span>
        <span className="count-badge" title={g.rows.length < g.count ? `${g.rows.length} loaded of ${g.count}` : undefined}>
          {g.count}
        </span>
        {g.mixedBanks ? (
          // 0.7.4 (F36): e.g. strange cosmetics are sold on /buy/hats, strange weapons on /buy/stranges.
          <span className="muted small shop-bank" title="These items are sold on more than one scrap.tf page; each row opens its own (o on a row).">
            on several pages
          </span>
        ) : (
          <button
            type="button"
            className="link-btn shop-bank"
            // 0.7.3: out of the Tab order (keyboard users press o), and a click leaves the focus on the
            // grid, so j/k, Enter and o go on working.
            tabIndex={-1}
            title={`Open ${page} in your browser (o). ${SCRAPTF_BOUNDARY_SHORT}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(row.id);
              onOpenBank(g.bankPageUrl);
            }}
          >
            {page}
            <Icon name="external" size={12} />
          </button>
        )}
      </div>
    </div>
  );
});

const MoreRow = memo(function MoreRow({
  row,
  index,
  rowH,
  selected,
  onSelect,
}: {
  row: Extract<ShoppingDisplayRow, { type: 'more' }>;
  index: number;
  rowH: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const g = row.group;
  return (
    <div id={`shoprow-${index}`} role="row" aria-rowindex={index + 2} aria-selected={selected} className={`opp-row opp-more${selected ? ' selected' : ''}`} style={rowStyle(index, rowH)} onClick={() => onSelect(row.id)}>
      <div role="gridcell" className="more-cell">
        <span className="muted small">
          Showing {fmtInt(g.rows.length)} of {fmtInt(g.count)}, the most one list shows. Narrow the filters, or Export CSV for every item.
        </span>
      </div>
    </div>
  );
});

const ItemRow = memo(function ItemRow({
  id,
  row: r,
  index,
  rowH,
  selected,
  keyScrap,
  now,
  onSelect,
  onOpen,
  onMenu,
}: {
  id: string;
  row: ShoppingRow;
  index: number;
  rowH: number;
  selected: boolean;
  keyScrap: Scrap | null;
  now: number;
  onSelect: (id: string) => void;
  onOpen: (r: ShoppingRow) => void;
  onMenu: (r: ShoppingRow, at: MenuPoint) => void;
}) {
  const order = r.revenueOrder;
  const tone = yourPriceTone(r);
  const age = yourPriceAge(r, now);
  // Flags that should stop a purchase get an icon; the drawer explains every flag.
  const bad = r.flags.map(flagInfo).filter((f) => f.tone === 'bad');
  return (
    <div
      id={`shoprow-${index}`}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      className={`opp-row opp-item${selected ? ' selected' : ''}`}
      style={rowStyle(index, rowH)}
      onClick={() => {
        onSelect(id);
        onOpen(r);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(id);
        onMenu(r, { x: e.clientX, y: e.clientY });
      }}
    >
      <div role="gridcell" className="s-item">
        <ItemName sku={r.sku} name={r.name} maxTags={3} />
        {bad.length ? (
          <span className="tone-text-bad risk-icon" title={bad.map((f) => `${f.label}: ${f.help}`).join('\n')}>
            <Icon name="warning" size={13} />
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="s-pay num">
        <Money scrap={r.maxCostScrap} keyScrap={keyScrap} title={`Pay up to ${fmtMoney(r.maxCostScrap, keyScrap)} on scrap.tf`} />
      </div>
      <div role="gridcell" className="s-sells" title={sellsForTitle(r, keyScrap)}>
        <Money scrap={r.revenueScrap} keyScrap={keyScrap} />
        {order ? (
          <span className="buyer-type">
            <OnlineDot online={order.online} seenAt={order.lastEventAt} />
            <Icon name={order.isBot ? 'bolt' : 'user'} size={12} /> {buyerKindLabel(order)}
          </span>
        ) : null}
        {order?.userName ? <span className="buyer-name muted">{order.userName}</span> : null}
      </div>
      <div role="gridcell" className="s-conf">
        <ConfidenceBadge score={r.confidence} level={r.confidenceLevel} />
      </div>
      <div role="gridcell" className={`s-yours num${tone ? ` tone-text-${tone}` : ''}`} title={yourPriceTitle(r, keyScrap)}>
        {r.knownCostScrap === null ? (
          <span className="input-kind">rule</span>
        ) : (
          <>
            {age?.stale ? null : <Icon name={tone === 'good' ? 'check' : 'warning'} size={12} />}
            <Money scrap={r.knownCostScrap} keyScrap={keyScrap} title={yourPriceTitle(r, keyScrap)} />
            {age ? <span className={`s-yours-age${age.stale ? ' tone-text-warn' : ' muted'}`}>{age.stale ? ` · stale, ${age.text}` : ` · ${age.text}`}</span> : null}
          </>
        )}
      </div>
      <div role="gridcell" className="s-updated num muted" title={fmtDateTime(r.updatedAt)}>
        {fmtAge(now - r.updatedAt)}
      </div>
    </div>
  );
});
