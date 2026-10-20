// Holdings (F11): what you still hold from the journal's open FIFO lots, priced
// live against the backpack.tf buyers in the local book, with who to sell to,
// or scrap.tf when the user's saved scrap.tf/items list pays more (F14).
// Reads 'holdings.list' only (no request of its own); the buyer's profile opens
// in the user's browser through 'links.open'. Recording a sale writes only the
// user's journal. Nothing here trades, offers or contacts scrap.tf (R1, R4).

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { HoldingRow, HoldingsResult, ProfitSettings, Scrap } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import { openOrCopy } from '../components/ExternalLink';
import { Banner, EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { isContextMenuKey, menuPointForRect, useItemMenu } from '../components/ItemMenu';
import { ItemName, Money } from '../components/ItemName';
import { ROW_HEIGHT } from '../components/OppTable';
import { ConfidenceBadge, OnlineDot } from '../components/Pills';
import { useRecordTrade } from '../components/RecordTradeDialog';
import { DASH, errorMessage, flagInfo, fmtAge, fmtDateTime, fmtInt } from '../format';
import {
  HOLDINGS_MAX_SEARCH_CHARS,
  HOLDING_FLASH_MS,
  HOLDING_STATUS_LABELS,
  HOLDING_STATUS_TONES,
  buyerName,
  buyerProfileUrl,
  costTitle,
  diffHoldingsFlash,
  emptyHoldingsReason,
  heldForText,
  heldForTitle,
  holdingExitView,
  holdingKeyAction,
  holdingStatusTitle,
  holdingsQuery,
  holdingsSnapshot,
  noBuyerProfileText,
  plTitle,
  plTone,
  profitNowTitle,
  recordSaleInit,
  recordSaleTitle,
  sanitizeHoldingsSearch,
  scraptfExitLapseAt,
  scraptfLapseDelay,
  unitsText,
  worthTitle,
  type HoldingFlash,
  type HoldingsSnapshot,
} from '../holdingsModel';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useDebounced, useDocumentVisible, useNow } from '../hooks/useTimers';
import { FEED_OFF_UPDATES } from '../marketModel';
import { isMenuKeyEcho, isSearchShortcut, menuAnchorRect, moveCursor } from '../oppModel';

type MenuPoint = { x: number; y: number };

export interface HoldingsFlashState {
  seq: number;
  dirs: ReadonlyMap<string, HoldingFlash>;
}

const NO_DIRS: ReadonlyMap<string, HoldingFlash> = new Map();

/** Rows whose profit now moved in the last answer flash once (as on the Live market). */
function useHoldingsFlash(rows: readonly HoldingRow[] | undefined): HoldingsFlashState {
  const [flash, setFlash] = useState<HoldingsFlashState>({ seq: 0, dirs: NO_DIRS });
  const snap = useRef<HoldingsSnapshot | null>(null);
  useEffect(() => {
    if (!rows) return;
    const dirs = diffHoldingsFlash(snap.current, rows);
    snap.current = holdingsSnapshot(rows);
    if (dirs.size) setFlash((f) => ({ seq: f.seq + 1, dirs }));
  }, [rows]);
  // The CSS animation runs once per class change; clearing it keeps re-rendered rows still.
  useEffect(() => {
    if (!flash.dirs.size) return;
    const t = setTimeout(() => setFlash((f) => (f.seq === flash.seq ? { seq: f.seq, dirs: NO_DIRS } : f)), HOLDING_FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);
  return flash;
}

/**
 * F14: a scrap.tf exit ends when its list row turns a day old, and nothing pushes that (the service
 * judges freshness per read), so status, profit and the totals would keep counting scrap.tf until some
 * unrelated push. Refetch once when the first scrap.tf exit among `rows` lapses, while the window is
 * shown (a hidden one catches up when shown). A lapse already refetched for is not chased again, so a
 * service that still answers 'scraptf' (another clock) cannot start a loop.
 */
export function useScraptfExitLapse(rows: readonly HoldingRow[] | undefined, reload: () => Promise<void>): void {
  const visible = useDocumentVisible();
  const lapseAt = useMemo(() => (rows ? scraptfExitLapseAt(rows) : null), [rows]);
  const done = useRef<number | null>(null);
  useEffect(() => {
    if (lapseAt === null || !visible || done.current === lapseAt) return;
    const now = Date.now();
    const delay = scraptfLapseDelay(lapseAt, now);
    // Cut short by the one-day cap: the answer re-arms this with the time left.
    const capped = lapseAt - now > delay;
    const t = setTimeout(() => {
      if (!capped) done.current = lapseAt;
      void reload();
    }, delay);
    return () => clearTimeout(t);
  }, [rows, lapseAt, visible, reload]);
}

export function HoldingsPage() {
  const { keyScrap: statusKey, settings, status, openItem, navigate, toast, updateSettings, itemSku } = useApp();
  const [searchText, setSearchText] = usePersistentState<string>('holdings.search', '', sanitizeHoldingsSearch);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(5000);
  const menu = useItemMenu();
  const trade = useRecordTrade();

  const search = useDebounced(searchText, 200);
  const query = useMemo(() => holdingsQuery(search), [search]);
  const list = useRpcQuery('holdings.list', query);
  // Live: a buy order moving re-prices a holding (market.changed, at most every 2 s); prices and
  // the journal (a recorded trade, its Undo, another window) change what is held. Closed to the
  // tray the page stays mounted, so pushes wait while it is hidden and catch up once when shown.
  const reload = useThrottled(() => void list.reload(), 2000);
  const reloadSoon = useThrottled(() => void list.reload(), 300);
  useVisiblePush('market.changed', reload);
  useVisiblePush('prices.changed', reload);
  useVisiblePush('journal.changed', reloadSoon);
  // F14: a saved scrap.tf list (or maintenance dropping old rows) moves scrap.tf exits without a
  // market or price push of its own.
  useVisiblePush('scraptf.listChanged', reload);
  // Status and Pay up to follow settings.profit and the blocklist, read by the service on each list;
  // main hands the service new settings before it tells this window, so a refetch sees them.
  const profitSettings = settings?.profit;
  const blocklist = settings?.blocklist;
  const settingsSeen = useRef(false);
  useEffect(() => {
    if (!profitSettings) return;
    if (settingsSeen.current) reloadSoon();
    settingsSeen.current = true;
  }, [profitSettings, blocklist, reloadSoon]);

  const data = list.data;
  useScraptfExitLapse(data?.rows, list.reload);
  const flash = useHoldingsFlash(data?.rows);
  const keyScrap = data?.keyPrice?.valueScrap ?? statusKey;
  const profit = settings?.profit ?? null;

  // Through refs, so the memoised rows keep stable handlers.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const menuRef = useRef(menu.open);
  menuRef.current = menu.open;
  const tradeRef = useRef(trade.open);
  tradeRef.current = trade.open;
  // The key price the rows are valued at: a scrap.tf exit's price is split into keys and metal at it.
  const keyRef = useRef(keyScrap);
  keyRef.current = keyScrap;
  const onOpen = useCallback((r: HoldingRow) => openItem(r.sku), [openItem]);
  const onMenu = useCallback((r: HoldingRow, at: MenuPoint) => menuRef.current({ sku: r.sku, name: r.name, category: r.category }, at), []);
  const onRecordSale = useCallback((r: HoldingRow) => tradeRef.current(recordSaleInit(r, keyRef.current, Date.now())), []);
  const onOpenBuyer = useCallback((r: HoldingRow) => {
    const url = buyerProfileUrl(r);
    // The b key reaches rows without a buyer too; say why nothing opens.
    if (url) void openOrCopy(url, toastRef.current);
    else toastRef.current(noBuyerProfileText(r), 'info');
  }, []);

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

  const exportCsv = async () => {
    try {
      // What the table shows, including text typed in the last moment.
      const r = await saveCsv(() => rpc('opps.exportCsv', { kind: 'holdings', holdings: holdingsQuery(searchText) }));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    }
  };

  const paused = status?.networkPaused ?? settings?.networkPaused ?? false;
  const feedOff = settings ? !settings.liveFeed.enabled : status?.feed === 'off';
  const held = (data?.totals.items ?? 0) > 0;
  const empty = data ? emptyHoldingsReason(data) : null;

  return (
    <div className="page holdings-page">
      <HoldingsTotals data={data ?? null} keyScrap={keyScrap} profit={profit} />

      <div className="toolbar" role="toolbar" aria-label="Holdings">
        <div className="search-box">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            className="input"
            placeholder="Search held items or SKUs  ( / )"
            aria-label="Search your holdings"
            maxLength={HOLDINGS_MAX_SEARCH_CHARS}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearchText('');
            }}
          />
        </div>
        <div className="toolbar-spacer" />
        {list.reloading && data ? <span className="muted small">updating…</span> : null}
        {list.error && data ? (
          <span className="tone-text-bad small" title={list.error}>
            refresh failed
          </span>
        ) : null}
        <button type="button" className="btn ghost small" onClick={() => navigate('journal')} title="Every trade you recorded, with realised profit">
          <Icon name="journal" size={14} /> Journal
        </button>
        <button type="button" className="btn small" onClick={() => void exportCsv()} disabled={!held} title="Saves every holding matching the search, in this order">
          <Icon name="download" size={14} /> Export CSV
        </button>
      </div>

      {held && paused ? (
        <Banner tone="warn" icon="pause">
          Network is paused, so buyers and sale prices are not updating.{' '}
          <button type="button" className="link-btn" onClick={() => void updateSettings({ networkPaused: false })}>
            Resume network
          </button>
        </Banner>
      ) : held && feedOff ? (
        <Banner tone="info" icon="feed">
          The live feed is off, so {FEED_OFF_UPDATES}.{' '}
          <button type="button" className="link-btn" onClick={() => void updateSettings({ liveFeed: { enabled: true } })}>
            Turn on live feed
          </button>
        </Banner>
      ) : null}

      {list.error && !data ? <ErrorBanner message={`Could not load your holdings: ${list.error}`} onRetry={() => void list.reload()} /> : null}

      {list.error && !data ? null : (
        <div className="table-region">
          {!data ? (
            <LoadingBlock label="Loading your holdings…" />
          ) : empty === 'nothing-held' ? (
            <NothingHeld />
          ) : empty === 'search' ? (
            <EmptyState
              icon="filter"
              title="Nothing you hold matches this search"
              actions={
                <button type="button" className="btn" onClick={() => setSearchText('')}>
                  Clear search
                </button>
              }
            >
              The totals above still count everything you hold.
            </EmptyState>
          ) : (
            <HoldingsTable
              rows={data.rows}
              keyScrap={keyScrap}
              now={now}
              density={settings?.ui.density ?? 'comfortable'}
              profit={profit}
              selectedId={selectedId}
              flash={flash}
              onSelect={setSelectedId}
              onOpen={onOpen}
              onMenu={onMenu}
              onRecordSale={onRecordSale}
              onOpenBuyer={onOpenBuyer}
            />
          )}
        </div>
      )}
      <p className="hint-line muted small">
        Keyboard: <kbd>j</kbd>/<kbd>k</kbd> or arrows to move, <kbd>Enter</kbd> to open, <kbd>s</kbd> to record a sale, <kbd>b</kbd> for the buyer&apos;s backpack.tf profile,{' '}
        <kbd>Shift</kbd>+<kbd>F10</kbd> or right-click for item actions, <kbd>/</kbd> to search. Selling is up to you: the app never sends offers.
      </p>
      {menu.element}
      {trade.element}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header totals and empty state
// ---------------------------------------------------------------------------

/** The header: totals over everything held, whatever the search (exported for tests). */
export function HoldingsTotals({ data, keyScrap, profit }: { data: HoldingsResult | null; keyScrap: Scrap | null; profit: ProfitSettings | null }) {
  const t = data?.totals ?? null;
  const tone = t ? plTone(t.profitNowScrap) : null;
  return (
    <section className="stat-row holdings-totals" aria-label="Totals over everything you hold">
      <div className="stat card">
        <div className="stat-label">Holding</div>
        <div className="stat-value">{t ? unitsText(t) : DASH}</div>
      </div>
      <div className="stat card">
        <div className="stat-label">Cost</div>
        <div className="stat-value">{t ? <Money scrap={t.costScrap} keyScrap={keyScrap} /> : DASH}</div>
      </div>
      <div className="stat card" title={t ? worthTitle(t, keyScrap) : undefined}>
        <div className="stat-label">Worth now</div>
        <div className="stat-value">{t ? <Money scrap={t.worthNowScrap} keyScrap={keyScrap} title={worthTitle(t, keyScrap)} /> : DASH}</div>
      </div>
      <div className={`stat card holdings-pl${tone ? ` tone-${tone}` : ''}`} title={t ? plTitle(t, keyScrap, profit) : undefined}>
        <div className="stat-label">Unrealised P/L</div>
        <div className="stat-value">{t ? <Money scrap={t.profitNowScrap} keyScrap={keyScrap} tone="profit" signed title={plTitle(t, keyScrap, profit)} /> : DASH}</div>
      </div>
      <div className={`stat card${t && t.sellable > 0 ? ' holdings-sellable tone-good' : ''}`} title="Items whose oldest unit clears your profit thresholds at its better exit: today's best buyer, or scrap.tf by your saved price list">
        <div className="stat-label">Sellable now</div>
        <div className="stat-value">
          {t ? (
            <>
              <span className={`num${t.sellable > 0 ? ' tone-text-good' : ''}`}>{fmtInt(t.sellable)}</span>{' '}
              <span className="muted small">of {fmtInt(t.items)}</span>
            </>
          ) : (
            DASH
          )}
        </div>
      </div>
    </section>
  );
}

/** How to get something onto this page (exported for tests). */
export function NothingHeld() {
  const { navigate, toast } = useApp();
  const openQuick = () => rpc('app.showQuickEntry').catch(() => toast('Could not open quick entry.', 'bad'));
  return (
    <EmptyState
      icon="holdings"
      title="Nothing held"
      actions={
        <>
          <button type="button" className="btn primary" onClick={() => navigate('journal')}>
            Open Journal
          </button>
          <button type="button" className="btn" onClick={() => void openQuick()}>
            Quick entry
          </button>
        </>
      }
    >
      When you buy an item on scrap.tf, record it (Quick entry → <em>Bought it</em>, the item panel → <em>Record buy</em>, or Journal), and it shows here with live
      buyers.
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface HoldingsTableProps {
  rows: readonly HoldingRow[];
  keyScrap: Scrap | null;
  now: number;
  density: 'comfortable' | 'compact';
  profit: ProfitSettings | null;
  selectedId: string | null;
  flash: HoldingsFlashState;
  onSelect: (sku: string | null) => void;
  onOpen: (r: HoldingRow) => void;
  onMenu: (r: HoldingRow, at: MenuPoint) => void;
  onRecordSale: (r: HoldingRow) => void;
  onOpenBuyer: (r: HoldingRow) => void;
}

const HEAD: readonly { cls: string; label: string; title?: string }[] = [
  { cls: 'h-item', label: 'Item' },
  { cls: 'h-qty num', label: 'Qty', title: 'Units still held (open buys not matched by a sale)' },
  { cls: 'h-cost num', label: 'Your cost', title: 'What the oldest unit cost you: the one a sale closes first (FIFO). Hover a cell for the total.' },
  { cls: 'h-held num', label: 'Held for', title: 'Since you bought the oldest unit' },
  { cls: 'h-sells', label: 'Sells now for', title: 'The better exit now: the buy order your settings sell to and who placed it, or scrap.tf when your saved price list pays more' },
  { cls: 'h-buyers num', label: 'Buyers', title: 'Distinct buyers with eligible orders' },
  { cls: 'h-profit', label: 'Profit now', title: 'Selling the oldest unit at the better exit now (that buyer, or scrap.tf), after friction' },
  { cls: 'h-conf', label: 'Confidence', title: 'How far the buy side can be trusted' },
  { cls: 'h-updated num', label: 'Updated', title: 'Last change to an eligible buy order' },
  { cls: 'h-actions', label: '' },
];

/** The held items, sell first, with the same keyboard model as the other grids (exported for tests). */
export function HoldingsTable({ rows, keyScrap, now, density, profit, selectedId, flash, onSelect, onOpen, onMenu, onRecordSale, onOpenBuyer }: HoldingsTableProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const keyboardMove = useRef(false);
  const menuKeyAt = useRef(0);
  const rowH = ROW_HEIGHT[density];
  const selectedIndex = rows.findIndex((r) => r.sku === selectedId);

  // Keep the keyboard cursor visible; mouse selection never scrolls.
  useEffect(() => {
    if (!keyboardMove.current || selectedIndex < 0) return;
    keyboardMove.current = false;
    const el = scroller.current;
    if (!el) return;
    const headH = header.current?.offsetHeight ?? 34;
    const top = selectedIndex * rowH;
    const visible = el.clientHeight - headH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + visible) el.scrollTop = top + rowH - visible;
  }, [selectedIndex, rowH]);

  // The dialog gives focus back to the grid, not to a row button the next re-render may replace.
  const recordSale = useCallback(
    (r: HoldingRow) => {
      scroller.current?.focus({ preventScroll: true });
      onRecordSale(r);
    },
    [onRecordSale],
  );

  const menuForRow = (idx: number): boolean => {
    const row = rows[idx];
    if (!row) return false;
    const box = document.getElementById(`holdrow-${idx}`)?.getBoundingClientRect();
    onMenu(row, menuPointForRect(menuAnchorRect(box, scroller.current?.getBoundingClientRect(), header.current?.offsetHeight ?? 34)));
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const idx = selectedIndex;
    const row = idx >= 0 ? rows[idx] : undefined;
    if (isContextMenuKey(e)) {
      if (menuForRow(idx)) {
        e.preventDefault();
        menuKeyAt.current = Date.now();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pageSize = Math.max(1, Math.floor(((scroller.current?.clientHeight ?? 600) - (header.current?.offsetHeight ?? 34)) / rowH) - 1);
    const go = (n: number) => {
      e.preventDefault();
      const id = rows[n]?.sku ?? null;
      if (id === selectedId) return;
      keyboardMove.current = true;
      onSelect(id);
    };
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        go(moveCursor(rows, idx, 1));
        return;
      case 'k':
      case 'ArrowUp':
        go(moveCursor(rows, idx, -1));
        return;
      case 'PageDown':
        go(moveCursor(rows, idx, pageSize));
        return;
      case 'PageUp':
        go(moveCursor(rows, idx, -pageSize));
        return;
      case 'Home':
        go(0);
        return;
      case 'End':
        go(rows.length - 1);
        return;
    }
    const action = row ? holdingKeyAction(e) : null;
    if (!row || !action) return;
    e.preventDefault();
    if (action === 'open') onOpen(row);
    else if (action === 'record-sale') onRecordSale(row);
    else onOpenBuyer(row);
  };

  // A keyboard-generated contextmenu lands on the focused grid itself; rows handle the mouse.
  const onGridMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (isMenuKeyEcho(menuKeyAt.current, Date.now())) return;
    menuForRow(selectedIndex);
  };

  return (
    <div
      className={`opp-scroll holdings-scroll density-${density}`}
      ref={scroller}
      tabIndex={0}
      role="grid"
      aria-label="Holdings. Use j and k or the arrow keys to move, Enter to open, s to record a sale, b for the buyer's profile, Shift+F10 for item actions."
      aria-rowcount={rows.length + 1}
      aria-activedescendant={selectedIndex >= 0 ? `holdrow-${selectedIndex}` : undefined}
      onKeyDown={onKey}
      onContextMenu={onGridMenu}
      onFocus={(e) => {
        if (e.target === e.currentTarget && selectedIndex < 0 && rows.length) onSelect(rows[0]!.sku);
      }}
    >
      <div className="opp-row opp-head" role="row" aria-rowindex={1} ref={header}>
        {HEAD.map((h) => (
          <div key={h.cls} role="columnheader" className={h.cls} title={h.title}>
            {h.label || <span className="sr-only">Actions</span>}
          </div>
        ))}
      </div>
      <div className="holdings-body" role="rowgroup">
        {rows.map((r, index) => {
          const dir = flash.dirs.get(r.sku) ?? null;
          return (
            <HoldingItemRow
              key={r.sku}
              row={r}
              index={index}
              rowH={rowH}
              selected={r.sku === selectedId}
              keyScrap={keyScrap}
              now={now}
              profit={profit}
              flash={dir}
              // Only flashing rows see the parity, so a flash re-renders just them.
              flashOdd={dir !== null && flash.seq % 2 === 1}
              onSelect={onSelect}
              onOpen={onOpen}
              onMenu={onMenu}
              onRecordSale={recordSale}
              onOpenBuyer={onOpenBuyer}
            />
          );
        })}
      </div>
    </div>
  );
}

const HoldingItemRow = memo(function HoldingItemRow({
  row: r,
  index,
  rowH,
  selected,
  keyScrap,
  now,
  profit,
  flash,
  flashOdd,
  onSelect,
  onOpen,
  onMenu,
  onRecordSale,
  onOpenBuyer,
}: {
  row: HoldingRow;
  index: number;
  rowH: number;
  selected: boolean;
  keyScrap: Scrap | null;
  now: number;
  profit: ProfitSettings | null;
  flash: HoldingFlash | null;
  /** Alternates the animation name, so a row that changes again restarts its flash. */
  flashOdd: boolean;
  onSelect: (sku: string) => void;
  onOpen: (r: HoldingRow) => void;
  onMenu: (r: HoldingRow, at: MenuPoint) => void;
  onRecordSale: (r: HoldingRow) => void;
  onOpenBuyer: (r: HoldingRow) => void;
}) {
  const order = r.revenueOrder;
  const profileUrl = buyerProfileUrl(r);
  // Flags that should stop a sale get an icon; the drawer explains every flag.
  const bad = r.flags.map(flagInfo).filter((f) => f.tone === 'bad');
  const cost = costTitle(r, keyScrap);
  const profitTitle = profitNowTitle(r, keyScrap, profit);
  // F14: the better exit (a buyer, or scrap.tf by the saved list) and what the other venue offers.
  const exit = holdingExitView(r, keyScrap, now);
  const flashCls = flash ? ` flash-${flash} flash-${flashOdd ? 'b' : 'a'}` : '';
  return (
    <div
      id={`holdrow-${index}`}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      className={`opp-row opp-item holding-row status-${r.status}${selected ? ' selected' : ''}${flashCls}`}
      style={{ height: rowH }}
      onClick={() => {
        onSelect(r.sku);
        onOpen(r);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(r.sku);
        onMenu(r, { x: e.clientX, y: e.clientY });
      }}
    >
      <div role="gridcell" className="h-item">
        <ItemName sku={r.sku} name={r.name} maxTags={3} />
        {bad.length ? (
          <span className="tone-text-bad risk-icon" title={bad.map((f) => `${f.label}: ${f.help}`).join('\n')}>
            <Icon name="warning" size={13} />
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="h-qty num">
        {fmtInt(r.qty)}
      </div>
      <div role="gridcell" className="h-cost num" title={cost}>
        <Money scrap={r.nextLotCostScrap} keyScrap={keyScrap} title={cost} />
      </div>
      <div role="gridcell" className="h-held num muted" title={heldForTitle(r)}>
        {heldForText(r, now)}
      </div>
      <div role="gridcell" className={`h-sells${exit.sub ? ' has-sub' : ''}`} title={exit.title}>
        <div className="h-sells-main">
          <Money scrap={exit.priceScrap} keyScrap={keyScrap} title={exit.title} />
          {exit.scraptf ? (
            <span className="pill tone-info exit-pill">scrap.tf</span>
          ) : (
            <>
              {order ? (
                <span className="buyer-type">
                  <OnlineDot online={order.online} />
                  <Icon name={order.isBot ? 'bolt' : 'user'} size={12} title={order.isBot ? 'Bot' : 'Human'} />
                </span>
              ) : null}
              {order && profileUrl ? (
                <button
                  type="button"
                  className="link-btn buyer-link"
                  // 0.7.3: out of the Tab order (keyboard users press b), and a click leaves the focus on
                  // the grid, so j/k, Enter, s and b go on working.
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  title={`Open ${buyerName(order)}'s backpack.tf profile in your browser (b). The app never trades for you.`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(r.sku);
                    onOpenBuyer(r);
                  }}
                >
                  <span className="buyer-name">{buyerName(order)}</span>
                  <Icon name="external" size={11} />
                </button>
              ) : order ? (
                <span className="buyer-name muted">{buyerName(order)}</span>
              ) : null}
            </>
          )}
        </div>
        {exit.sub ? <div className={`h-sells-sub${exit.sub.tone === 'warn' ? ' tone-text-warn' : ''}`}>{exit.sub.text}</div> : null}
      </div>
      <div role="gridcell" className={`h-buyers num${r.buyerCount === 0 ? ' muted' : ''}`}>
        {fmtInt(r.buyerCount)}
      </div>
      <div role="gridcell" className="h-profit" title={profitTitle}>
        {flash ? <Icon name={flash === 'up' ? 'arrowUp' : 'arrowDown'} size={11} className={`flash-arrow tone-text-${flash === 'up' ? 'good' : 'bad'}`} title={flash === 'up' ? 'Went up' : 'Went down'} /> : null}
        {r.profitNowScrap !== null ? <Money scrap={r.profitNowScrap} keyScrap={keyScrap} tone="profit" signed title={profitTitle} /> : null}
        <span className={`pill holding-pill tone-${HOLDING_STATUS_TONES[r.status]}`} title={holdingStatusTitle(r)}>
          {HOLDING_STATUS_LABELS[r.status]}
        </span>
      </div>
      <div role="gridcell" className="h-conf">
        {r.revenueScrap !== null ? <ConfidenceBadge score={r.confidence} level={r.confidenceLevel} compact /> : <span className="muted">{DASH}</span>}
      </div>
      <div role="gridcell" className="h-updated num muted" title={r.lastOrderChangeAt !== null ? fmtDateTime(r.lastOrderChangeAt) : undefined}>
        {r.lastOrderChangeAt === null ? DASH : fmtAge(now - r.lastOrderChangeAt)}
      </div>
      <div role="gridcell" className="h-actions">
        <button
          type="button"
          className={`btn small${r.status === 'sell' ? ' primary' : ''}`}
          tabIndex={-1}
          title={recordSaleTitle(r)}
          onClick={(e) => {
            e.stopPropagation();
            // Focus moves to the grid first (its onFocus may pick a row); this row is selected last.
            onRecordSale(r);
            onSelect(r.sku);
          }}
        >
          Record sale…
        </button>
      </div>
    </div>
  );
});
