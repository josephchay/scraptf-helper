// scrap.tf bank stock (F17, route #/banks/<bank>/stock): every item on one scrap.tf bank page as the
// user's newest save of it shows it, what changed since their previous save (new, gone, cheaper,
// pricier) and each item's backpack.tf side, from 'scraptf.bankStock'. F20 adds how long each item has
// been listed across the user's saves and its price since (Listed, Since listed, two chips). Everything on it comes from
// pages the user saved with their own browser into the opt-in watch folder (R10); "Open in browser"
// hands the static page to links.open (openOrCopy). Flip Desk never loads scrap.tf on its own (R1): no
// fetch, nothing polled. Pure helpers live in bankStockModel.ts, styles in styles/bank-stock.css
// (classes bs-*). 0.7.1: with the opt-in scrap.tf window on, "Open in Flip Desk window"
// ('scraptfWindow.open' with the bank's static SCRAPTF_BANKS page, on a click only) sits by Open, which
// follows openLinksInWindow (F21-9); #/banks/<bank>/stock/<flips|new> (the toolbar's Show flips, F21-2)
// opens the page on that chip once; Record buy books the row's exact copy at its price (ACT-11).

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { bankStockDefaultDir } from '../../shared/bankStock';
import { SCRAPTF_BOUNDARY_SHORT } from '../../shared/boundaryText';
import { scraptfBankInfo } from '../../shared/links';
import type { BankStockQuery, BankStockResult, BankStockRow, BankStockSort, Scrap, ScraptfBank, ScraptfListStatus, UnixMs } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import {
  BANK_STOCK_PAGE,
  BANK_STOCK_REFRESH_MS,
  BANK_STOCK_SNAPSHOT_NOTE,
  BANK_STOCK_PICKER_SORTS,
  BANK_STOCK_SORT_LABELS,
  DEFAULT_BANK_STOCK_VIEW,
  bankStockBuyCopy,
  bankStockBuyer,
  bankStockChangeTag,
  bankStockChips,
  bankStockEmptyReason,
  bankStockExportQuery,
  bankStockExtrasTitle,
  bankStockFilterEmpty,
  bankStockFilterUnavailable,
  bankStockHeader,
  bankStockKeyAction,
  bankStockLastSeen,
  bankStockListedCell,
  bankStockLoadingMore,
  bankStockMore,
  bankStockOlderPages,
  bankStockPayTitle,
  bankStockPrefKey,
  bankStockPriceTitle,
  bankStockQueryKey,
  bankStockQueryOf,
  bankStockSellsTitle,
  bankStockSinceListedCell,
  bankStockSortChange,
  bankStockStockCell,
  bankStockVerdictPill,
  createBankStockLoader,
  sanitizeBankStockView,
  type BankStockEmptyReason,
  type BankStockHeaderView,
  type BankStockLoader,
  type BankStockView,
} from '../bankStockModel';
import { bankStockPath, bankStockRouteFilter, banksPath } from '../banksModel';
import { openOrCopy } from '../components/ExternalLink';
import { Banner, EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { isContextMenuKey, menuPointForRect, useItemMenu } from '../components/ItemMenu';
import { ItemName, Money } from '../components/ItemName';
import { ROW_HEIGHT } from '../components/OppTable';
import { ConfidenceBadge, OnlineDot } from '../components/Pills';
import { SaveModeChoice, SetupNoteView, copyFolderPath, useScraptfListStatus, useWatchFolderPicker } from '../components/ScraptfListCard';
import { DASH, errorMessage, fmtInt } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useDebounced, useNow } from '../hooks/useTimers';
import { SAVE_MODE } from '../importModel';
import { anchoredScrollTop } from '../marketModel';
import { isMenuKeyEcho, isSearchShortcut, menuAnchorRect, moveCursor } from '../oppModel';
import { listBoundaryNote, listSetupNote, listSetupState } from '../scraptfListModel';
import { bankWindowView, OPEN_IN_WINDOW_LABEL, windowOpenFailedText, windowOpenTitle, type BankWindowView } from '../scraptfWindowModel';

type MenuPoint = { x: number; y: number };

const IMPORT_OFF_TIP = 'Turn on saved-page import first: a page you save is not read while it is off.';

interface BankStockAnswer {
  result: BankStockResult;
  /** The query it answers: its filter decides the Gone columns, its search the empty text. */
  query: BankStockQuery;
}

/**
 * 'scraptf.bankStock' for `query`, kept current: a bank import or prune pushes 'scraptf.banksChanged'
 * and a buy order moving pushes 'market.changed' (the mock pushes each at once), so reads are throttled
 * to one per BANK_STOCK_REFRESH_MS, none while the window is hidden (one catch-up when shown). Reads
 * never overlap and an answer to an older query is dropped (createBankStockLoader).
 */
function useBankStock(query: BankStockQuery): { answer: BankStockAnswer | null; error: string | null; busy: boolean; refresh: () => void; refreshSoon: () => void } {
  const [answer, setAnswer] = useState<BankStockAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loader = useRef<BankStockLoader | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  // Created in an effect, so StrictMode's mount, unmount, mount ends with a live loader, and an
  // unmount drops whatever is still in flight.
  useEffect(() => {
    const l = createBankStockLoader((q) => rpc('scraptf.bankStock', q), {
      data: (result, q) => {
        setAnswer({ result, query: q });
        setError(null);
      },
      error: setError,
      busy: setBusy,
    });
    loader.current = l;
    l.load(queryRef.current);
    return () => {
      l.dispose();
      loader.current = null;
    };
  }, []);
  const key = JSON.stringify(query);
  const loadedKey = useRef(key);
  useEffect(() => {
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    loader.current?.load(queryRef.current);
  }, [key]);
  const refresh = useCallback(() => loader.current?.refresh(), []);
  const refreshSoon = useThrottled(refresh, BANK_STOCK_REFRESH_MS);
  useVisiblePush('scraptf.banksChanged', refreshSoon);
  useVisiblePush('market.changed', refreshSoon);
  return { answer, error, busy, refresh, refreshSoon };
}

export function BankStockPage({ bank }: { bank: ScraptfBank }) {
  const { keyScrap: statusKey, settings, navigate, openItem, toast, itemSku, segments } = useApp();
  // Keyed per bank (App remounts this page per bank), so each bank keeps its own view.
  const [view, setView] = usePersistentState<BankStockView>(bankStockPrefKey(bank), DEFAULT_BANK_STOCK_VIEW, sanitizeBankStockView);
  // F21-2: #/banks/<bank>/stock/<flips|new> (Show flips in the scrap.tf window) opens the page on that chip,
  // with no search hiding its rows, while rendering (so the first read already asks for it), once per
  // navigation; the route then goes back to #/banks/<bank>/stock, so the next Show flips applies again.
  const routeFilter = bankStockRouteFilter(segments);
  const routeKey = routeFilter === null ? null : `${bank}/${routeFilter}`;
  const [appliedRoute, setAppliedRoute] = useState<string | null>(null);
  // The view the last landing set; kept once the route is gone.
  const [routedView, setRoutedView] = useState<BankStockView | null>(null);
  if (routeKey !== appliedRoute) {
    setAppliedRoute(routeKey);
    if (routeFilter !== null) {
      const next: BankStockView = { ...view, filter: routeFilter, search: '' };
      setView(next);
      setRoutedView(next);
    }
  }
  useEffect(() => {
    const stockRoute = bankStockPath(bank);
    if (routeKey !== null && stockRoute) replaceRoute(stockRoute);
  }, [routeKey, bank]);
  const typedSearch = useDebounced(view.search, 200);
  // Until the user types, a landing's cleared search counts at once: the debounced value still holds the
  // remembered one, and would reach the first read (or the read after a first-save fallback to All).
  const search = routedView !== null && view.search === routedView.search ? view.search : typedSearch;
  const settled = useMemo<BankStockView>(() => ({ filter: view.filter, sort: view.sort, dir: view.dir, search }), [view.filter, view.sort, view.dir, search]);
  const queryKey = bankStockQueryKey(bankStockQueryOf(bank, settled));
  // "Load more" grows the page size of this query only; a new filter, search or order starts at one page.
  const [paging, setPaging] = useState<{ key: string; limit: number }>({ key: queryKey, limit: BANK_STOCK_PAGE });
  const limit = paging.key === queryKey ? paging.limit : BANK_STOCK_PAGE;
  const query = useMemo(() => bankStockQueryOf(bank, settled, limit), [bank, settled, limit]);
  const stock = useBankStock(query);
  const list = useScraptfListStatus();
  const folder = useWatchFolderPicker();
  const now = useNow(15_000);
  const menu = useItemMenu();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const result = stock.answer?.result ?? null;
  const keyScrap = result?.keyPrice?.valueScrap ?? statusKey;

  // Verdicts and Pay up to follow settings.profit and the key price, which the service reads per call.
  const refreshKey = settings ? JSON.stringify([settings.profit, statusKey]) : null;
  const seenRefreshKey = useRef(refreshKey);
  const refreshSoon = stock.refreshSoon;
  useEffect(() => {
    const before = seenRefreshKey.current;
    seenRefreshKey.current = refreshKey;
    if (before !== null && before !== refreshKey) refreshSoon();
  }, [refreshKey, refreshSoon]);

  // A change filter remembered from an earlier visit, on a bank now down to one save: back to All.
  useEffect(() => {
    if (bankStockFilterUnavailable(view.filter, result)) setView((v) => ({ ...v, filter: 'all' }));
  }, [result, view.filter, setView]);

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

  // Through refs, so the memoised rows keep stable handlers.
  const menuRef = useRef(menu.open);
  menuRef.current = menu.open;
  const onOpen = useCallback((r: BankStockRow) => openItem(r.sku), [openItem]);
  // ACT-11: Record buy books this row's exact copy (a painted one as painted) at the price the save showed.
  const onMenu = useCallback(
    (r: BankStockRow, at: MenuPoint) => menuRef.current({ sku: r.sku, name: r.name, category: r.category, bank, copy: bankStockBuyCopy(r, bank) }, at),
    [bank],
  );

  const info = scraptfBankInfo(bank);
  const scraptfWindow = bankWindowView(settings);
  // F21-9: worded for openLinksInWindow (bankStockHeader), so main may show it in the user's scrap.tf window.
  const openPage = () => {
    if (info) void openOrCopy(info.url, toast, { allowWindow: true });
  };
  // The bank's static page, on a click only: main loads it in the window for the user.
  const openInWindow = () => {
    if (!info) return;
    rpc('scraptfWindow.open', { start: info.url }).catch((e: unknown) => toast(windowOpenFailedText(errorMessage(e)), 'bad'));
  };

  const exportCsv = async () => {
    try {
      // What the table shows, including text typed in the last moment.
      const r = await saveCsv(() => rpc('opps.exportCsv', { kind: 'bankStock', bankStock: bankStockExportQuery(bank, view) }));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    }
  };

  return (
    <div className="page bank-stock-page">
      <BankStockPageView
        bank={bank}
        result={result}
        answered={stock.answer?.query ?? null}
        error={stock.error}
        busy={stock.busy}
        loadingMore={bankStockLoadingMore(stock.busy, stock.answer?.query ?? null, queryKey, limit)}
        status={list.status}
        view={view}
        now={now}
        keyScrap={keyScrap}
        density={settings?.ui.density ?? 'comfortable'}
        selectedKey={selectedKey}
        picking={folder.picking}
        searchRef={searchRef}
        scraptfWindow={scraptfWindow}
        onView={(patch) => setView((v) => ({ ...v, ...patch }))}
        onRetry={stock.refresh}
        onOpenPage={openPage}
        onOpenInWindow={openInWindow}
        onBack={() => navigate(banksPath(bank))}
        onGoImport={() => navigate('import')}
        onPickFolder={folder.pick}
        onCopyPath={(path) => copyFolderPath(path, toast)}
        onExport={() => void exportCsv()}
        onLoadMore={(next) => setPaging({ key: queryKey, limit: next })}
        onSelect={setSelectedKey}
        onOpen={onOpen}
        onMenu={onMenu}
      />
      <p className="hint-line muted small">
        Keyboard: <kbd>j</kbd>/<kbd>k</kbd> or arrows to move, <kbd>Enter</kbd> to open, <kbd>Shift</kbd>+<kbd>F10</kbd> or right-click for item actions, <kbd>/</kbd> to search.
        Buying is up to you: the app never trades.
      </p>
      {menu.element}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page without its data hooks
// ---------------------------------------------------------------------------

export interface BankStockPageViewProps {
  bank: ScraptfBank;
  /** null until the first 'scraptf.bankStock' answer. */
  result: BankStockResult | null;
  /** The query `result` answers (its filter, search and order); null with it. */
  answered: Pick<BankStockQuery, 'filter' | 'search' | 'sort' | 'dir'> | null;
  error: string | null;
  /** A read is in flight ("updating…"): a background refresh or a page size asked for. */
  busy: boolean;
  /** "Load more" is what is in flight (bankStockLoadingMore): only then is its button "Loading…". */
  loadingMore?: boolean;
  /** The watch folder's state ('scraptf.listStatus', as the banks page reads it); null until read. */
  status: ScraptfListStatus | null;
  view: BankStockView;
  now: UnixMs;
  keyScrap: Scrap | null;
  density: 'comfortable' | 'compact';
  selectedKey: string | null;
  /** The folder dialog is open. */
  picking: boolean;
  searchRef?: RefObject<HTMLInputElement | null>;
  /** UX-5: the user's opt-in scrap.tf window (bankWindowView); null or absent while it is off. */
  scraptfWindow?: BankWindowView | null;
  onView(patch: Partial<BankStockView>): void;
  onRetry(): void;
  /** Hands the bank's static SCRAPTF_BANKS page to links.open (the browser, or the window by openLinksInWindow). */
  onOpenPage(): void;
  /** UX-5: "Open in Flip Desk window" (shown only with `scraptfWindow`). */
  onOpenInWindow?(): void;
  onBack(): void;
  onGoImport(): void;
  onPickFolder(): void;
  onCopyPath(path: string): void;
  onExport(): void;
  onLoadMore(limit: number): void;
  onSelect(key: string | null): void;
  onOpen(row: BankStockRow): void;
  onMenu(row: BankStockRow, at: MenuPoint): void;
}

/** Exported for the render tests only. */
export function BankStockPageView(p: BankStockPageViewProps) {
  const w = p.scraptfWindow ?? null;
  const head = bankStockHeader(p.bank, p.result, p.now, w?.linksHere === true);
  const chips = bankStockChips(p.result);
  const importOff = p.status ? !p.status.importEnabled : false;
  const r = p.result;
  const answeredFilter = p.answered?.filter ?? 'all';
  // A change filter remembered from an earlier visit, answered for a bank with one save: the page is
  // going back to All, so its empty answer ("Nothing new since your previous save") is not shown.
  const dropping = r !== null && bankStockFilterUnavailable(answeredFilter, r);
  const empty = r && !dropping ? bankStockEmptyReason(r, { filter: answeredFilter, search: p.answered?.search ?? '' }, importOff) : null;
  const more = r && !dropping ? bankStockMore(r.rows.length, r.total) : null;
  if (!head) return <ErrorBanner message="Not a scrap.tf page this app knows." />;
  return (
    <>
      <BankStockHeader head={head} {...p} importOff={importOff} />
      {head.firstSave ? (
        <Banner tone="info" icon="info">
          First save of this page: save it again later to see what changed. Until then nothing is new, gone or repriced, and the change filters wait.
        </Banner>
      ) : null}

      <div className="toolbar" role="toolbar" aria-label="Bank stock">
        <div className="search-box">
          <Icon name="search" size={14} />
          <input
            ref={p.searchRef}
            type="search"
            className="input"
            placeholder="Search this page's items or SKUs  ( / )"
            aria-label={`Search ${head.path}`}
            maxLength={200}
            value={p.view.search}
            onChange={(e) => p.onView({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') p.onView({ search: '' });
            }}
          />
        </div>
        <SortPicker sort={p.view.sort} dir={p.view.dir} onChange={p.onView} />
        <div className="toolbar-spacer" />
        {p.busy && r ? <span className="muted small">updating…</span> : null}
        {p.error && r ? (
          <span className="tone-text-bad small" title={p.error}>
            refresh failed
          </span>
        ) : null}
        <button type="button" className="btn small" onClick={p.onExport} disabled={!r || r.savedAt === null || r.total === 0} title="Saves every item matching the filter and search, in this order">
          <Icon name="download" size={14} /> Export CSV
        </button>
      </div>

      <div className="chip-group bs-filters" role="group" aria-label="Show these items">
        {chips.map((c) => {
          const on = p.view.filter === c.filter;
          return (
            <button
              key={c.filter}
              type="button"
              className={`chip bs-chip tone-${c.tone}${on ? ' on' : ''}`}
              aria-pressed={on}
              disabled={c.disabled}
              title={c.title}
              onClick={() => p.onView({ filter: c.filter })}
            >
              <span className="status-dot" aria-hidden="true" />
              {c.label}
              <span className="chip-count">{c.count}</span>
            </button>
          );
        })}
      </div>

      {p.error && !r ? <ErrorBanner message={`Could not read your saves of ${head.path}: ${p.error}`} onRetry={p.onRetry} /> : null}

      {p.error && !r ? null : (
        <div className="table-region bs-region">
          {!r || dropping ? (
            <LoadingBlock label={`Reading your saves of ${head.path}…`} />
          ) : empty ? (
            <StockEmpty
              reason={empty}
              head={head}
              filter={answeredFilter}
              folder={p.status?.watchFolder ?? null}
              importOff={importOff}
              scraptfWindow={w}
              onView={p.onView}
              onOpenPage={p.onOpenPage}
              onOpenInWindow={p.onOpenInWindow}
              onGoImport={p.onGoImport}
            />
          ) : (
            <BankStockTable
              rows={r.rows}
              dataKey={JSON.stringify([answeredFilter, p.answered?.search ?? '', p.answered?.sort ?? null, p.answered?.dir ?? null])}
              gone={answeredFilter === 'gone'}
              previousSavedAt={r.previousSavedAt}
              keyScrap={p.keyScrap}
              now={p.now}
              density={p.density}
              selectedKey={p.selectedKey}
              sort={p.view.sort}
              dir={p.view.dir}
              onSort={(s) => p.onView(bankStockSortChange(p.view, s))}
              onSelect={p.onSelect}
              onOpen={p.onOpen}
              onMenu={p.onMenu}
            />
          )}
        </div>
      )}
      {more && !empty ? (
        <div className="bs-more" title={more.title}>
          <span className="muted small">{more.text}</span>
          {more.next !== null ? (
            <button type="button" className="btn ghost small" disabled={p.loadingMore === true} onClick={() => p.onLoadMore(more.next!)}>
              {p.loadingMore ? 'Loading…' : `Load ${fmtInt(more.next - (r?.rows.length ?? 0))} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Bank name and saves, what to fix before a save is read, Open in browser with the save tip, and the boundary. */
function BankStockHeader(p: BankStockPageViewProps & { head: BankStockHeaderView; importOff: boolean }) {
  const h = p.head;
  const w = p.scraptfWindow ?? null;
  const older = bankStockOlderPages(p.result, p.now);
  // Until (or unless) the list status is read, nothing is assumed off.
  const setup = p.status ? listSetupState(p.status, w !== null) : null;
  const note = setup ? listSetupNote(setup, 'banks', p.status?.watchError ?? null) : null;
  const folder = setup === 'ready' ? (p.status?.watchFolder ?? null) : null;
  return (
    <section className={`card bs-head tone-${h.freshness.tone}`} aria-labelledby="bs-title">
      <button type="button" className="link-btn small bs-back" onClick={p.onBack} title="Back to every scrap.tf page you save">
        <Icon name="banks" size={13} /> All scrap.tf banks
      </button>
      <div className="bs-title-row">
        <h2 id="bs-title" className="bs-title">
          {h.title}
        </h2>
        <span className="bank-path mono">{h.path}</span>
        {/* Until the first answer nothing is known: no "Never saved" flash while the saves are read. */}
        {p.result ? (
          <span className={`pill bank-fresh tone-${h.freshness.tone}`} title={h.freshness.title}>
            <span className="status-dot" aria-hidden="true" />
            {h.freshness.label}
          </span>
        ) : null}
      </div>
      {p.result || !p.error ? (
        <p className="bs-saved">
          <span title={h.saved.title || undefined}>{h.saved.text}</span>
          {h.previous ? (
            <>
              {' · '}
              <span className={h.firstSave ? 'muted' : undefined} title={h.previous.title}>
                {h.previous.text}
              </span>
            </>
          ) : null}
          {/* DM-5: pages saved long before the bank's newest page are left out of the counts. */}
          {older ? (
            <>
              {' · '}
              <span className="muted" title={older.title}>
                {older.text}
              </span>
            </>
          ) : null}
        </p>
      ) : null}
      {note ? <SetupNoteView note={note} picking={p.picking} onGoImport={p.onGoImport} onPickFolder={p.onPickFolder} /> : null}
      <div className="bank-open">
        <OpenButtons head={h} importOff={p.importOff} scraptfWindow={w} onOpenPage={p.onOpenPage} onOpenInWindow={p.onOpenInWindow} />
        {/* F18: one page, so the whole save tip: which save type, and why. */}
        <span className="bank-tip muted small">
          {w ? (
            <>
              In the Flip Desk window it is {w.readOnLoad ? 'read as it loads' : 'read when you press Read page now'}; or save it with <kbd>Ctrl</kbd>+<kbd>S</kbd> into your watch folder and{' '}
              <SaveModeChoice alt={p.bank !== 'list'} />.
            </>
          ) : (
            <>
              Save it with <kbd>Ctrl</kbd>+<kbd>S</kbd> into your watch folder and <SaveModeChoice alt={p.bank !== 'list'} />; it updates here within seconds.
            </>
          )}
        </span>
      </div>
      {folder ? (
        <p className="banks-folder">
          <Icon name="folder" size={13} />
          <span>Save into</span>
          <span className="sl-path mono" title={folder}>
            {folder}
          </span>
          <button type="button" className="btn ghost small" onClick={() => p.onCopyPath(folder)} title="Copy the folder path, to paste into your browser's save dialog">
            <Icon name="copy" size={13} /> Copy path
          </button>
        </p>
      ) : null}
      <p className="sl-boundary">
        <Icon name="shield" size={13} />
        <span>
          {listBoundaryNote(w !== null)} {BANK_STOCK_SNAPSHOT_NOTE}
        </span>
      </p>
    </section>
  );
}

function SortPicker({ sort, dir, onChange }: { sort: BankStockSort; dir: 'asc' | 'desc'; onChange: (patch: Partial<BankStockView>) => void }) {
  return (
    <div className="bs-sort">
      <label className="muted small" htmlFor="bs-sort">
        Sort
      </label>
      <select
        id="bs-sort"
        className="input select small"
        value={sort}
        onChange={(e) => {
          const s = e.target.value as BankStockSort;
          onChange({ sort: s, dir: bankStockDefaultDir(s) });
        }}
      >
        {BANK_STOCK_PICKER_SORTS.map((s) => (
          <option key={s} value={s}>
            {BANK_STOCK_SORT_LABELS[s]}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="icon-btn"
        aria-label={dir === 'asc' ? 'Ascending; switch to descending' : 'Descending; switch to ascending'}
        title={dir === 'asc' ? 'Ascending' : 'Descending'}
        onClick={() => onChange({ dir: dir === 'asc' ? 'desc' : 'asc' })}
      >
        <Icon name={dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={14} />
      </button>
    </div>
  );
}

/**
 * Open in browser, and with the opt-in scrap.tf window on "Open in Flip Desk window" (UX-5). When main
 * sends Flip Desk's scrap.tf links to the window anyway (linksHere), the browser button goes, as on the
 * banks cards. Both are clicks only; the page is always the bank's static SCRAPTF_BANKS one.
 */
function OpenButtons({
  head: h,
  importOff,
  scraptfWindow: w,
  primary = h.freshness.tone !== 'good',
  onOpenPage,
  onOpenInWindow,
}: {
  head: BankStockHeaderView;
  importOff: boolean;
  scraptfWindow: BankWindowView | null;
  primary?: boolean;
  onOpenPage(): void;
  onOpenInWindow?(): void;
}) {
  return (
    <>
      {w?.linksHere ? null : (
        <button
          type="button"
          className={`btn small${primary && !w ? ' primary' : ''}`}
          disabled={importOff}
          title={importOff ? IMPORT_OFF_TIP : h.openTitle}
          aria-label={`Open in browser: ${h.path}`}
          onClick={onOpenPage}
        >
          <Icon name="external" size={13} /> Open in browser
        </button>
      )}
      {w ? (
        <button
          type="button"
          className={`btn small bank-open-window${primary ? ' primary' : ''}`}
          disabled={importOff}
          title={importOff ? IMPORT_OFF_TIP : windowOpenTitle(h.path, w.readOnLoad)}
          aria-label={`${OPEN_IN_WINDOW_LABEL}: ${h.path}`}
          onClick={() => onOpenInWindow?.()}
        >
          <Icon name="window" size={13} /> {OPEN_IN_WINDOW_LABEL}
        </button>
      ) : null}
    </>
  );
}

/** Why the table is empty, with the one thing to do about it. */
function StockEmpty({
  reason,
  head,
  filter,
  folder,
  importOff,
  scraptfWindow = null,
  onView,
  onOpenPage,
  onOpenInWindow,
  onGoImport,
}: {
  reason: BankStockEmptyReason;
  head: BankStockHeaderView;
  filter: BankStockView['filter'];
  folder: string | null;
  importOff: boolean;
  scraptfWindow?: BankWindowView | null;
  onView(patch: Partial<BankStockView>): void;
  onOpenPage(): void;
  onOpenInWindow?(): void;
  onGoImport(): void;
}) {
  switch (reason) {
    case 'import-off':
      return (
        <EmptyState
          icon="import"
          title="Saved-page import is off"
          actions={
            <button type="button" className="btn primary" onClick={onGoImport}>
              Open Import
            </button>
          }
        >
          A page you save is not read while it is off. Turn it on (it asks you to acknowledge scrap.tf&apos;s terms first), then save {head.path} as <strong>{SAVE_MODE}</strong> into your watch folder.
        </EmptyState>
      );
    case 'never-saved':
      return (
        <EmptyState
          icon="banks"
          title={`No save of ${head.path} yet`}
          actions={<OpenButtons head={head} importOff={importOff} scraptfWindow={scraptfWindow} primary onOpenPage={onOpenPage} onOpenInWindow={onOpenInWindow} />}
        >
          {scraptfWindow ? (
            <ol className="bs-steps">
              <li>
                Open {head.path} in the Flip Desk window and browse it yourself. {scraptfWindow.readOnLoad ? 'It is read as it loads' : 'Press Read page now there to read it'}, and every item on it shows up here.
              </li>
              <li>
                Or open it in your own browser, press <kbd>Ctrl</kbd>+<kbd>S</kbd>, <SaveModeChoice alt={head.bank !== 'list'} />, and save it into your watch folder
                {folder ? <span className="mono"> ({folder})</span> : null}.
              </li>
              <li>Read or save it again later to see what is new, gone or repriced. {SCRAPTF_BOUNDARY_SHORT}</li>
            </ol>
          ) : (
            <ol className="bs-steps">
              <li>Open {head.path} in your own browser. {SCRAPTF_BOUNDARY_SHORT}</li>
              <li>
                Press <kbd>Ctrl</kbd>+<kbd>S</kbd>, <SaveModeChoice alt={head.bank !== 'list'} />, and save it into your watch folder{folder ? <span className="mono"> ({folder})</span> : null}.
              </li>
              <li>Every item on it shows up here within seconds. Save it again later to see what is new, gone or repriced.</li>
            </ol>
          )}
        </EmptyState>
      );
    case 'search':
      return (
        <EmptyState
          icon="filter"
          title="Nothing here matches the search"
          actions={
            <button type="button" className="btn" onClick={() => onView({ search: '' })}>
              Clear search
            </button>
          }
        >
          The counts on the chips still cover the whole page.
        </EmptyState>
      );
    case 'filter':
    case 'nothing-on-sale': {
      const t = bankStockFilterEmpty(reason === 'filter' ? filter : 'all');
      return (
        <EmptyState
          icon={reason === 'filter' ? 'filter' : 'banks'}
          title={t.title}
          actions={
            reason === 'filter' ? (
              <button type="button" className="btn" onClick={() => onView({ filter: 'all' })}>
                Show all
              </button>
            ) : undefined
          }
        >
          {t.body}
        </EmptyState>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

interface HeadDef {
  sort: BankStockSort | null;
  label: string;
  /** The Gone view's label and hover, when they differ. */
  gone?: { label: string; title: string };
  cls: string;
  title: string;
}

const HEAD: readonly HeadDef[] = [
  { sort: 'name', label: 'Item', cls: 'bs-item', title: 'Sort by name. New, extras and price changes since your previous save follow the name.' },
  {
    sort: 'cost',
    label: 'scrap.tf price',
    gone: { label: 'Last price', title: "Sort by the price in your previous save, the last one it was on sale in, at today's key price" },
    cls: 'bs-price num',
    title: "Sort by scrap.tf's price in your newest save, at today's key price",
  },
  {
    sort: null,
    label: 'Stock',
    gone: { label: 'Last seen', title: 'When your previous save, the last one it was on sale in, was made' },
    cls: 'bs-stock num',
    title: 'Stock in your newest save; "5 → 3" when your previous save showed another count',
  },
  // F20: from the run of your saves listing it on sale. The Gone view hides both (bank-stock.css).
  { sort: 'listed', label: 'Listed', cls: 'bs-listed num', title: 'Sort by how long every one of your saves of the page has listed it on sale (longest first)' },
  { sort: 'sinceListed', label: 'Since listed', cls: 'bs-since num', title: 'Sort by its price change since your saves began listing it (the biggest drop first)' },
  { sort: null, label: 'Sells for', cls: 'bs-sells', title: 'The backpack.tf buy order your settings sell to, and who placed it' },
  { sort: 'payUpTo', label: 'Pay up to', cls: 'bs-pay num', title: 'Sort by ceiling: the highest scrap.tf price that still clears your profit thresholds' },
  { sort: 'profit', label: 'Verdict', cls: 'bs-verdict', title: "Sort by profit at scrap.tf's price" },
  { sort: null, label: 'Confidence', cls: 'bs-conf', title: 'Buy-side confidence: buyers and reference prices only' },
];

function HeadCell({ def, gone, sort, dir, onSort }: { def: HeadDef; gone: boolean; sort: BankStockSort; dir: 'asc' | 'desc'; onSort: (s: BankStockSort) => void }) {
  const label = gone && def.gone ? def.gone.label : def.label;
  const title = gone && def.gone ? def.gone.title : def.title;
  if (!def.sort) {
    return (
      <div role="columnheader" className={def.cls} title={title}>
        {label}
      </div>
    );
  }
  const key = def.sort;
  const active = sort === key;
  return (
    <div role="columnheader" className={def.cls} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`sort-btn${active ? ' active' : ''}`} onClick={() => onSort(key)} title={title}>
        {label}
        {active ? <Icon name={dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} /> : null}
      </button>
    </div>
  );
}

export interface BankStockTableProps {
  rows: readonly BankStockRow[];
  /** The filter, search and order the rows answer: a new one scrolls back to the top. */
  dataKey: string;
  /** The Gone view: last price and last seen instead of price and stock. */
  gone: boolean;
  previousSavedAt: UnixMs | null;
  keyScrap: Scrap | null;
  now: UnixMs;
  density: 'comfortable' | 'compact';
  selectedKey: string | null;
  sort: BankStockSort;
  dir: 'asc' | 'desc';
  onSort: (s: BankStockSort) => void;
  onSelect: (key: string | null) => void;
  onOpen: (r: BankStockRow) => void;
  onMenu: (r: BankStockRow, at: MenuPoint) => void;
}

/**
 * The bank's rows (up to 2,000), virtualised like the Live market and with its keyboard model; rows
 * are keyed by `key` (SKU and extras), so a plain and a painted copy are two rows. Exported for tests.
 */
export function BankStockTable({ rows, dataKey, gone, previousSavedAt, keyScrap, now, density, selectedKey, sort, dir, onSort, onSelect, onOpen, onMenu }: BankStockTableProps) {
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
  const hasPrevious = previousSavedAt !== null;

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
    // A scroll after a keyboard move means the cursor is no longer followed.
    keyboardMove.current = false;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setFirstRow(Math.floor((scroller.current?.scrollTop ?? 0) / rowH)));
  };

  // A live refresh keeps what you were reading in place (profit order moves with the buyers); a new
  // filter, search or order starts at the top.
  const shown = useRef<{ key: string; ids: string[] }>({ key: dataKey, ids: [] });
  useLayoutEffect(() => {
    const el = scroller.current;
    const prev = shown.current;
    const ids = rows.map((r) => r.key);
    shown.current = { key: dataKey, ids };
    if (!el) return;
    if (prev.key !== dataKey) {
      if (el.scrollTop !== 0) el.scrollTop = 0;
      setFirstRow(0);
      return;
    }
    const top = anchoredScrollTop(prev.ids, ids, el.scrollTop, rowH, Math.ceil(Math.max(0, el.clientHeight - headH) / rowH));
    if (top !== el.scrollTop) {
      el.scrollTop = top;
      setFirstRow(Math.floor(el.scrollTop / rowH));
    }
    // rowH and headH are read at refresh time; a density change alone is not a refresh.
  }, [rows, dataKey]);

  const selectedIndex = selectedKey === null ? -1 : rows.findIndex((r) => r.key === selectedKey);

  // Keep the keyboard cursor visible; mouse selection and live re-sorting never scroll to it.
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

  // Opened from the keyboard: anchored to the cursor's row.
  const menuForRow = (idx: number): boolean => {
    const row = rows[idx];
    if (!row) return false;
    const box = document.getElementById(`bsrow-${idx}`)?.getBoundingClientRect();
    onMenu(row, menuPointForRect(menuAnchorRect(box, scroller.current?.getBoundingClientRect(), headH)));
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
    const go = (n: number) => {
      e.preventDefault();
      const key = rows[n]?.key ?? null;
      // k on the first row, j on the last: nothing moves, and no stale flag may scroll later.
      if (key === selectedKey) return;
      keyboardMove.current = true;
      onSelect(key);
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
    if (row && bankStockKeyAction(e) === 'open') {
      e.preventDefault();
      onOpen(row);
    }
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
      className={`opp-scroll bs-scroll density-${density}${gone ? ' bs-gone' : ''}`}
      ref={scroller}
      onScroll={onScroll}
      tabIndex={0}
      role="grid"
      aria-label="Bank stock. Use j and k or the arrow keys to move, Enter to open, Shift+F10 for item actions."
      aria-rowcount={rows.length + 1}
      aria-activedescendant={selectedIndex >= 0 ? `bsrow-${selectedIndex}` : undefined}
      onKeyDown={onKey}
      onContextMenu={onGridMenu}
      onFocus={(e) => {
        if (e.target === e.currentTarget && selectedIndex < 0 && rows.length) onSelect(rows[0]!.key);
      }}
    >
      <div className="opp-row opp-head" role="row" aria-rowindex={1} ref={header}>
        {HEAD.map((d) => (
          <HeadCell key={d.cls} def={d} gone={gone} sort={sort} dir={dir} onSort={onSort} />
        ))}
      </div>
      <div className="opp-body" role="rowgroup" style={{ height: rows.length * rowH }}>
        {rows.slice(start, end).map((r, i) => {
          const index = start + i;
          return (
            <StockRow
              key={r.key}
              row={r}
              index={index}
              rowH={rowH}
              selected={r.key === selectedKey}
              gone={gone}
              hasPrevious={hasPrevious}
              previousSavedAt={previousSavedAt}
              keyScrap={keyScrap}
              now={now}
              onSelect={onSelect}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          );
        })}
      </div>
    </div>
  );
}

function rowStyle(index: number, rowH: number): CSSProperties {
  return { transform: `translateY(${index * rowH}px)`, height: rowH };
}

const StockRow = memo(function StockRow({
  row: r,
  index,
  rowH,
  selected,
  gone,
  hasPrevious,
  previousSavedAt,
  keyScrap,
  now,
  onSelect,
  onOpen,
  onMenu,
}: {
  row: BankStockRow;
  index: number;
  rowH: number;
  selected: boolean;
  gone: boolean;
  hasPrevious: boolean;
  previousSavedAt: UnixMs | null;
  keyScrap: Scrap | null;
  now: UnixMs;
  onSelect: (key: string) => void;
  onOpen: (r: BankStockRow) => void;
  onMenu: (r: BankStockRow, at: MenuPoint) => void;
}) {
  const order = r.revenueOrder;
  const buyer = bankStockBuyer(r);
  const change = bankStockChangeTag(r, keyScrap, previousSavedAt, now);
  const pill = bankStockVerdictPill(r, keyScrap);
  const priceTitle = bankStockPriceTitle(r, keyScrap);
  const payTitle = bankStockPayTitle(r, keyScrap);
  const stock = gone ? null : bankStockStockCell(r, hasPrevious);
  const seen = gone ? bankStockLastSeen(r, previousSavedAt, now) : null;
  const listed = bankStockListedCell(r, now);
  const since = bankStockSinceListedCell(r, keyScrap);
  return (
    <div
      id={`bsrow-${index}`}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      className={`opp-row opp-item bs-row verdict-${r.verdict}${r.change ? ` change-${r.change}` : ''}${selected ? ' selected' : ''}`}
      style={rowStyle(index, rowH)}
      onClick={() => {
        onSelect(r.key);
        onOpen(r);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(r.key);
        onMenu(r, { x: e.clientX, y: e.clientY });
      }}
    >
      <div role="gridcell" className="bs-item">
        <ItemName sku={r.sku} name={r.name} maxTags={2} />
        {change?.kind === 'new' ? (
          <span className="pill tone-good bs-new" title={change.title}>
            New
          </span>
        ) : change && change.kind !== 'gone' ? (
          <span className={`bs-was tone-text-${change.tone}`} title={change.title}>
            {change.text}
          </span>
        ) : null}
        {r.hasExtras ? (
          <span className="bs-extras" title={bankStockExtrasTitle(r.key)}>
            extras
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="bs-price num" title={priceTitle}>
        <Money scrap={r.costScrap} keyScrap={keyScrap} title={priceTitle} />
      </div>
      {seen ? (
        <div role="gridcell" className="bs-stock num muted" title={seen.title}>
          {seen.text}
        </div>
      ) : (
        <div role="gridcell" className={`bs-stock num${stock?.muted ? ' muted' : ''}`} title={stock?.title}>
          {stock?.text ?? DASH}
        </div>
      )}
      <div role="gridcell" className={`bs-listed num${listed.muted ? ' muted' : ''}${listed.long ? ' long' : ''}`} title={listed.title}>
        {listed.text}
      </div>
      <div role="gridcell" className={`bs-since num${since.tone === 'good' || since.tone === 'bad' ? ` tone-text-${since.tone}` : ' muted'}`} title={since.title}>
        {since.text}
      </div>
      <div role="gridcell" className="bs-sells" title={bankStockSellsTitle(r, keyScrap)}>
        {r.revenueScrap !== null ? <Money scrap={r.revenueScrap} keyScrap={keyScrap} /> : <span className="muted">{DASH}</span>}
        {order ? (
          <span className="buyer-type">
            <OnlineDot online={order.online} />
            <Icon name={order.isBot ? 'bolt' : 'user'} size={12} title={order.isBot ? 'Bot' : 'Human'} />
          </span>
        ) : null}
        {buyer ? <span className="buyer-name muted">{buyer}</span> : null}
      </div>
      <div role="gridcell" className="bs-pay num" title={payTitle}>
        {r.maxCostScrap !== null ? <Money scrap={r.maxCostScrap} keyScrap={keyScrap} title={payTitle} /> : <span className="muted">{DASH}</span>}
      </div>
      <div role="gridcell" className="bs-verdict">
        <span className={`pill verdict-pill tone-${pill.tone}`} title={pill.title}>
          {pill.text}
        </span>
      </div>
      <div role="gridcell" className="bs-conf">
        {r.confidence !== null && r.confidenceLevel !== null ? <ConfidenceBadge score={r.confidence} level={r.confidenceLevel} compact /> : <span className="muted">{DASH}</span>}
      </div>
    </div>
  );
});

/**
 * Swaps the current route without a history entry (as the Live market does for its one-shot routes), so
 * Back skips #/banks/<bank>/stock/<chip>; hashchange tells the route hook (replaceState fires none).
 */
function replaceRoute(path: string): void {
  try {
    window.history.replaceState(window.history.state, '', `#/${path}`);
    window.dispatchEvent(new Event('hashchange'));
  } catch {
    // The chip is already applied; only the address stays as it was.
  }
}
