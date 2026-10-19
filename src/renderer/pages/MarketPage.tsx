// Live market (F10): every item with eligible backpack.tf buyers in the local
// book, plus every item you priced, compared live. The rows come from the
// service's market index, which only reads the book the websocket already
// fills, so this page adds no network traffic. The scrap.tf side is only what
// you typed or saved (R1, R10): the app never visits scrap.tf. The coverage
// strip (F13) shows when you last saved each scrap.tf page; a chip opens its card
// on the scrap.tf banks page (F15), which hands the address to your own browser.
// The scrap.tf price list (F14) is the card on top plus the "scrap.tf pays" and
// Stock columns, all from the scrap.tf/items page the user saved themselves. A
// bank card's "See all" lands here (#/market/bank/<bank>), filtered to its
// categories and Not checked. The Recent checks panel (F16 Live check) lists
// what the check hotkey, the opt-in clipboard watcher or its own box found;
// only results reach it, never the copied text. F17: a "New" badge marks items
// new on scrap.tf since the user's previous save of a bank page, and the Source
// popover's "New on scrap.tf" keeps only those (both from saved pages, R10).
// F19: each row's scrap.tf button (or o) arms the Live check, copies the name and
// hands the item's static bank page to the user's browser through main's allowlist;
// a header button opens the bank page while the market shows one bank. A price
// copied there comes back through the check hotkey or watcher. Nothing here loads scrap.tf.

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { CHECK_HINT, CHECK_MAX_CHARS, CHECK_PRIVACY_SENTENCE } from '../../shared/check';
import { marketUpdatedAt, MARKET_MAX_SEARCH_CHARS, MARKET_SORTS } from '../../shared/market';
import type { CheckResult, MarketListResult, MarketRow, MarketSort, MarketStats, Scrap, UnixMs } from '../../shared/types';
import { CATEGORIES, CATEGORY_LABELS, MARKET_SOURCES, MARKET_VERDICTS } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import { banksPath } from '../banksModel';
import { checkKey, checkPayUpTo, checkSummaryText, manualCheckProblem, mergeRecentChecks, recentCheckRow, recentChecksHint, sanitizeRecentOpen } from '../checkModel';
import { CheckList, Popover } from '../components/Controls';
import { openOrCopy } from '../components/ExternalLink';
import { Banner, EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { isContextMenuKey, menuPointForRect, openOnScraptf, useItemMenu } from '../components/ItemMenu';
import { ItemName, Money } from '../components/ItemName';
import { ROW_HEIGHT } from '../components/OppTable';
import { ConfidenceBadge, ItemTagChip, OnlineDot, StatePill, TonePill } from '../components/Pills';
import { ScraptfListCard } from '../components/ScraptfListCard';
import { CheckVerdictPill } from './CheckPopup';
import { DASH, categoryLabel, errorMessage, flagInfo, fmtAge, fmtDateTime, fmtInt, fmtMoney, itemTags, qualityClass, qualityName, qualityOf } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { createHiddenPushGate, usePush, useThrottled } from '../hooks/useRpc';
import { useDebounced, useDocumentVisible, useInterval, useNow } from '../hooks/useTimers';
import {
  BOUNDARY_NOTE,
  DEFAULT_MARKET_SORT,
  FLASH_MS,
  LISTED_ON_SCRAPTF_HINT,
  LISTED_ON_SCRAPTF_LABEL,
  LISTED_ON_SCRAPTF_TITLE,
  MARKET_SCRAPTF_KEY,
  MAX_MIN_BUYERS,
  MIN_BUYER_STEPS,
  NEW_ON_SCRAPTF_HINT,
  NEW_ON_SCRAPTF_LABEL,
  NEW_ON_SCRAPTF_TITLE,
  SORT_LABELS,
  SOURCE_HINTS,
  SOURCE_LABELS,
  VERDICT_HELP,
  VERDICT_LABELS,
  VERDICT_TONES,
  activeMarketFilterCount,
  addPulse,
  anchoredScrollTop,
  buildPercent,
  coverageChips,
  createMarketWindow,
  defaultMarketDir,
  defaultMarketFilters,
  emptyFiltersText,
  emptyMarketReason,
  indexStateText,
  lastChangeText,
  liveRateText,
  marketBankLink,
  marketDisplayRows,
  marketErrorText,
  marketExportQuery,
  marketListParams,
  marketLiveState,
  marketPayTitle,
  marketPollMs,
  marketRouteIntent,
  marketScraptfButton,
  marketSellsForTitle,
  marketSourceCount,
  marketWindowQuery,
  nextPageRequest,
  pulseRate,
  readMinBuyers,
  readMinPrice,
  sanitizeMarketFilters,
  sanitizeMarketSort,
  scraptfNewBadge,
  scraptfSideText,
  toggleMarketSort,
  toggleVerdict,
  verdictPill,
  waitingText,
  yourPriceCell,
  type EmptyMarketReason,
  type FlashDir,
  type MarketDisplayRow,
  type MarketFilters,
  type MarketSortState,
  type MarketWindow,
  type MarketWindowBusy,
  type MarketWindowData,
  type MarketWindowQuery,
  type Pulse,
  type SortDir,
} from '../marketModel';
import { indexOfRow, isMenuKeyEcho, isSearchShortcut, menuAnchorRect, moveCursor } from '../oppModel';
import { allItemsChip, listPaysCell, listStockCell } from '../scraptfListModel';
import { scraptfLinksInWindow } from '../scraptfWindowModel';
import { MIN_CEILING_PRESETS, readMinCeiling } from '../shoppingModel';

type MenuPoint = { x: number; y: number };

export interface FlashState {
  seq: number;
  dirs: ReadonlyMap<string, FlashDir>;
}

const NO_DIRS: ReadonlyMap<string, FlashDir> = new Map();

/**
 * 'market.list' as a window that grows by pages of 200 and is refreshed as a whole (the request
 * logic and its races live in createMarketWindow). Rows a live refresh moved are kept for the flash.
 * A minimum in keys is converted with `keyScrap` at each request, so a key price move is not a new query.
 */
function useMarketWindow(query: MarketWindowQuery, keyScrap: Scrap | null, onLoadMoreError: (text: string) => void) {
  const key = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const keyRef = useRef(keyScrap);
  keyRef.current = keyScrap;
  const [data, setData] = useState<MarketWindowData | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<MarketWindowBusy>(null);
  const [flash, setFlash] = useState<FlashState>({ seq: 0, dirs: NO_DIRS });
  const onMoreError = useRef(onLoadMoreError);
  onMoreError.current = onLoadMoreError;
  const win = useRef<MarketWindow<MarketWindowQuery> | null>(null);

  // Created in an effect, so StrictMode's mount, unmount, mount ends with a live controller, and an
  // unmount drops whatever is still in flight.
  useEffect(() => {
    const w = createMarketWindow<MarketWindowQuery>((q) => rpc('market.list', marketListParams(q, keyRef.current)), {
      data: (d, dirs) => {
        setData(d);
        setError(null);
        if (dirs.size) setFlash((f) => ({ seq: f.seq + 1, dirs }));
      },
      error: setError,
      moreError: (text) => onMoreError.current(text),
      busy: setBusy,
    });
    win.current = w;
    w.setQuery(queryRef.current);
    return () => {
      w.dispose();
      win.current = null;
    };
  }, []);

  // Filters or sort changed: back to the first page of the new order.
  useEffect(() => {
    win.current?.setQuery(queryRef.current);
  }, [key]);

  const refresh = useCallback(() => win.current?.refresh(), []);
  const loadMore = useCallback(() => win.current?.loadMore(), []);
  const hold = useCallback((on: boolean) => win.current?.hold(on), []);

  // The CSS animation runs once per class change; clearing it keeps rows that scroll back into view still.
  useEffect(() => {
    if (!flash.dirs.size) return;
    const t = setTimeout(() => setFlash((f) => (f.seq === flash.seq ? { seq: f.seq, dirs: NO_DIRS } : f)), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  return {
    data,
    error,
    loading: data === undefined && error === null,
    reloading: busy === 'reload',
    loadingMore: busy === 'more',
    flash,
    refresh,
    loadMore,
    hold,
  };
}

export function MarketPage() {
  const { keyScrap: statusKey, settings, status, openItem, navigate, toast, updateSettings, itemSku, segments } = useApp();
  const [filters, setFilters] = usePersistentState<MarketFilters>('market.filters', defaultMarketFilters(), sanitizeMarketFilters);
  const [sort, setSort] = usePersistentState<MarketSortState>('market.sort', { ...DEFAULT_MARKET_SORT }, sanitizeMarketSort);
  // F15: a bank card's "See all" (#/market/bank/<bank>) sets its filters while rendering, so the first
  // market.list already asks for them, then the route goes back to #/market (Back returns to the banks).
  const intent = marketRouteIntent(segments);
  const intentKey = intent?.key ?? null;
  const [appliedIntent, setAppliedIntent] = useState<string | null>(null);
  // The filters object the last "See all" set; kept once the route is gone.
  const [routeFilters, setRouteFilters] = useState<MarketFilters | null>(null);
  if (intentKey !== appliedIntent) {
    setAppliedIntent(intentKey);
    if (intent) {
      setFilters(intent.filters);
      setSort(intent.sort);
      setRouteFilters(intent.filters);
    }
  }
  useEffect(() => {
    if (intentKey !== null) replaceRoute('market');
  }, [intentKey]);
  const [noteDismissed, setNoteDismissed] = usePersistentState<boolean>('market.boundaryNoteDismissed', false, (v) => v === true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const pulses = useRef<Pulse[]>([]);
  const lastPushAt = useRef<UnixMs | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(5000);
  const visible = useDocumentVisible();
  const menu = useItemMenu();

  const typedSearch = useDebounced(filters.search, 200);
  // Typing "10 ref" passes through unparseable text; only a settled value reaches the query.
  const typedMin = useDebounced(filters.minCeiling, 300);
  // Until the user changes a filter, a "See all" route's own (empty) search and minimum count at once:
  // the debounced values still hold the saved ones it replaced, and would reach the first market.list.
  const routed = routeFilters !== null && filters === routeFilters;
  const search = routed ? filters.search : typedSearch;
  const minText = routed ? filters.minCeiling : typedMin;
  // Kept in keys and scrap: "1 key" must not become a new query (top of the list, Freeze
  // bypassed) each time the key price moves. Each request converts it with the current key price.
  const minPrice = useMemo(() => readMinPrice(minText), [minText]);
  const query = useMemo(() => marketWindowQuery({ ...filters, search }, minPrice, sort), [filters, search, minPrice, sort]);

  const toastRef = useRef(toast);
  toastRef.current = toast;
  const win = useMarketWindow(query, statusKey, (text) => toastRef.current(text, 'bad'));

  // Live: refetch the loaded window at most every 2 s, only while the window is shown (a dashboard
  // closed to the tray stays mounted) and not while frozen, which counts the updates instead.
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  // A trailing call already scheduled when Freeze is pressed must not re-sort the rows after all.
  const refresh = useThrottled(() => {
    if (!frozenRef.current) win.refresh();
  }, 2000);
  const [gate] = useState(createHiddenPushGate);
  const onLiveChange = (changed: number) => {
    if (frozenRef.current) {
      setWaiting((n) => n + Math.max(1, changed));
      return;
    }
    if (gate.push(document.visibilityState !== 'hidden')) refresh();
  };
  usePush('market.changed', (p) => {
    const t = Date.now();
    pulses.current = addPulse(pulses.current, { at: t, changed: p.changed }, t);
    lastPushAt.current = Number.isFinite(p.at) ? p.at : t;
    onLiveChange(p.changed);
  });
  // Your own prices and rules move verdicts without any book change.
  usePush('prices.changed', () => onLiveChange(1));
  // F14: the list's columns, its filter and the "All items" chip are read per request; a purge or a
  // list save that moved no price pushes only this.
  usePush('scraptf.listChanged', () => onLiveChange(1));
  useEffect(() => {
    if (visible && !frozenRef.current && gate.shown()) refresh();
  }, [visible, gate, refresh]);

  // A minimum in keys moves with the key price: re-read the window in place (throttled, and not while frozen).
  const keyedMin = (minPrice?.keys ?? 0) > 0;
  const lastStatusKey = useRef(statusKey);
  useEffect(() => {
    if (lastStatusKey.current === statusKey) return;
    lastStatusKey.current = statusKey;
    if (keyedMin) refresh();
  }, [statusKey, keyedMin, refresh]);

  const result = win.data?.result;
  // The first build's progress moves between pushes, and a failed rebuild's retry (H1) pushes
  // nothing when it fails again: poll the local index (IPC only) while either lasts.
  const pollMs = marketPollMs(result?.stats);
  useInterval(
    () => {
      if (document.visibilityState !== 'hidden') refresh();
    },
    pollMs ?? 0,
    pollMs !== null && !frozen,
  );

  // Any full refresh shows everything that was waiting.
  const fetchedAt = win.data?.fetchedAt;
  useEffect(() => setWaiting(0), [fetchedAt]);

  const toggleFreeze = () => {
    if (!frozen) {
      setFrozen(true);
      frozenRef.current = true;
      // Also drops a refresh the window already queued or has in flight: nothing re-sorts after Freeze.
      win.hold(true);
      return;
    }
    setFrozen(false);
    frozenRef.current = false;
    win.hold(false);
    // Not throttled, and it waits for a page being loaded instead of dropping it.
    win.refresh();
  };

  const onOpen = useCallback((r: MarketRow) => openItem(r.sku), [openItem]);
  // F9 item menu. Through a ref, so the memoised rows keep a stable handler.
  const openMenuRef = useRef(menu.open);
  openMenuRef.current = menu.open;
  const onRowMenu = useCallback((r: MarketRow, at: MenuPoint) => openMenuRef.current({ sku: r.sku, name: r.name, category: r.category }, at), []);
  // F19: a row's scrap.tf button or its o key: arm, copy the name, open the static bank page. Through
  // refs, so the memoised rows keep a stable handler.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const scraptfBusy = useRef(false);
  const onScraptf = useCallback((r: MarketRow) => {
    // A second press while the first is still on its way would open the page twice.
    if (scraptfBusy.current) return;
    const b = marketScraptfButton(r, Date.now());
    // Set only once nothing synchronous can throw, and always cleared: a stuck flag would end the button.
    scraptfBusy.current = true;
    void openOnScraptf(b.url, b.name, (text, tone) => toastRef.current(text, tone), { sku: r.sku, settings: settingsRef.current })
      .catch(() => toastRef.current('Could not open scrap.tf. Try again, or use Open on scrap.tf in the item details.', 'bad'))
      .finally(() => {
        scraptfBusy.current = false;
      });
  }, []);
  // F21: main sends these static pages to the user's scrap.tf window when they chose that; the words follow.
  const scraptfInWindow = scraptfLinksInWindow(settings);
  // U2: the one bank the category filter covers (a bank card's "See all" included).
  const bankLink = marketBankLink(filters.categories, scraptfInWindow);
  const loadMore = win.loadMore;

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

  const set = <K extends keyof MarketFilters>(k: K, v: MarketFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const resetFilters = () => setFilters(defaultMarketFilters());
  const onSort = useCallback((k: MarketSort) => setSort((s) => toggleMarketSort(s, k)), [setSort]);

  const exportCsv = async () => {
    try {
      // Exactly what the table shows (filters and sort, including text typed in the last moment), every
      // row, with the minimum converted as the table's own requests convert it.
      const q = marketExportQuery(marketListParams(marketWindowQuery(filters, readMinPrice(filters.minCeiling), sort), statusKey));
      const r = await saveCsv(() => rpc('opps.exportCsv', { kind: 'market', market: q }));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    }
  };

  const keyScrap = result?.keyPrice?.valueScrap ?? statusKey;
  const rows = useMemo(() => marketDisplayRows(result?.rows ?? [], result?.total ?? 0), [result]);
  const total = result?.total ?? 0;
  const loaded = result?.rows.length ?? 0;
  const paused = status?.networkPaused ?? settings?.networkPaused ?? false;
  const feedOff = settings ? !settings.liveFeed.enabled : status?.feed === 'off';
  const filterCount = activeMarketFilterCount(filters);
  const sourceCount = marketSourceCount(filters);
  const minShown = readMinCeiling(filters.minCeiling, statusKey);
  const lastAt = newest(result?.stats.lastChangeAt ?? null, lastPushAt.current);
  // Pushes arrive between the 5 s ticks: the strip's clock is at least the newest one seen, so
  // the rate counts it and "Last change" never reads "in 5 s".
  const stripNow = Math.max(now, pulses.current[pulses.current.length - 1]?.at ?? 0, lastAt ?? 0);

  return (
    <div className="page market-page">
      {/* The page note below already states the boundary; the card repeats it only once that is dismissed. */}
      <ScraptfListCard placement="market" boundaryNote={noteDismissed} />
      <MarketStrip
        live={marketLiveState(status?.feed, paused, feedOff)}
        lastAt={lastAt}
        rate={liveRateText(pulseRate(pulses.current, stripNow))}
        stats={result?.stats ?? null}
        scraptf={result?.scraptf ?? null}
        now={stripNow}
        onImport={() => navigate('import')}
      />
      {noteDismissed ? null : (
        <div className="market-note" role="note">
          <Icon name="shield" size={14} />
          <span className="market-note-text">{BOUNDARY_NOTE}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss this note" title="Dismiss" onClick={() => setNoteDismissed(true)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {/* F16: what the live check hotkey, the clipboard watcher or the box inside found lately. */}
      <RecentChecks />

      <div className="toolbar" role="toolbar" aria-label="Filters">
        <div className="search-box">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            type="search"
            className="input"
            placeholder="Search items or SKUs  ( / )"
            aria-label="Search the live market"
            maxLength={MARKET_MAX_SEARCH_CHARS}
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
        <Popover label={<>Source{sourceCount ? <span className="count">{sourceCount}</span> : null}</>} active={sourceCount > 0}>
          <CheckList values={filters.sources} options={MARKET_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s], hint: SOURCE_HINTS[s] }))} onChange={(v) => set('sources', v)} />
          {/* F14: here rather than in the toolbar, which already fills a 1280 px window. */}
          <div className="market-list-filter">
            <label className="check-row" title="Only items on your saved scrap.tf/items list: the items scrap.tf trades, with what it pays and its stock">
              <input type="checkbox" checked={filters.onScraptfList} onChange={() => set('onScraptfList', !filters.onScraptfList)} />
              <span>On scrap.tf&apos;s list</span>
              <span className="muted small">your saved scrap.tf/items</span>
            </label>
            {/* F17: new in the newest save of a bank page (MarketQuery.newOnScraptf), from pages you saved. */}
            <label className="check-row" title={NEW_ON_SCRAPTF_TITLE}>
              <input type="checkbox" checked={filters.newOnScraptf} onChange={() => set('newOnScraptf', !filters.newOnScraptf)} />
              <span>{NEW_ON_SCRAPTF_LABEL}</span>
              <span className="muted small">{NEW_ON_SCRAPTF_HINT}</span>
            </label>
            {/* F20: listed for at least a day across your saves (MarketQuery.listedOnScraptf). */}
            <label className="check-row" title={LISTED_ON_SCRAPTF_TITLE}>
              <input type="checkbox" checked={filters.listedOnScraptf} onChange={() => set('listedOnScraptf', !filters.listedOnScraptf)} />
              <span>{LISTED_ON_SCRAPTF_LABEL}</span>
              <span className="muted small">{LISTED_ON_SCRAPTF_HINT}</span>
            </label>
          </div>
        </Popover>
        <Popover
          label={<>Pay up to{minShown.scrap !== null ? <span className="count">≥ {fmtMoney(minShown.scrap, keyScrap)}</span> : minShown.error ? <span className="count">?</span> : null}</>}
          active={filters.minCeiling.trim() !== ''}
        >
          <div className="popover-body">
            <div className="field">
              <label className="field-label" htmlFor="market-min-ceiling">
                Only items I can pay at least
              </label>
              <input
                id="market-min-ceiling"
                className={`input${minShown.error ? ' invalid' : ''}`}
                type="text"
                placeholder="e.g. 2 ref or 1 key"
                maxLength={40}
                aria-invalid={minShown.error ? true : undefined}
                aria-describedby="market-min-ceiling-hint"
                value={filters.minCeiling}
                onChange={(e) => set('minCeiling', e.target.value)}
              />
              <span id="market-min-ceiling-hint" className={minShown.error ? 'field-error' : 'field-hint'}>
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
        <Popover label={<>Buyers{filters.minBuyers > 0 ? <span className="count">≥ {fmtInt(filters.minBuyers)}</span> : null}</>} active={filters.minBuyers > 0}>
          <div className="popover-body">
            <div className="field">
              <label className="field-label" htmlFor="market-min-buyers">
                At least this many buyers
              </label>
              <input
                id="market-min-buyers"
                className="input"
                type="number"
                min={0}
                max={MAX_MIN_BUYERS}
                step={1}
                placeholder="Any"
                value={filters.minBuyers > 0 ? filters.minBuyers : ''}
                onChange={(e) => set('minBuyers', readMinBuyers(e.target.value))}
              />
              <span className="field-hint">Distinct buyers with eligible orders. More buyers means a sale is less likely to fall through.</span>
            </div>
            <div className="chip-group" role="group" aria-label="Quick picks">
              {MIN_BUYER_STEPS.map((n) => (
                <button key={n} type="button" className={`chip${filters.minBuyers === n ? ' on' : ''}`} aria-pressed={filters.minBuyers === n} onClick={() => set('minBuyers', n)}>
                  {n === 0 ? 'Any' : `${n}+`}
                </button>
              ))}
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
        <div className="toolbar-spacer" />
        <SortPicker value={sort} onChange={setSort} />
      </div>

      <div className="chip-group market-verdicts" role="group" aria-label="Verdict filter: show only these">
        {MARKET_VERDICTS.map((v) => {
          const on = filters.verdicts.includes(v);
          const count = result?.counts[v];
          return (
            <button
              key={v}
              type="button"
              className={`chip verdict-chip tone-${VERDICT_TONES[v]}${on ? ' on' : ''}`}
              aria-pressed={on}
              title={VERDICT_HELP[v]}
              onClick={() => set('verdicts', toggleVerdict(filters.verdicts, v))}
            >
              <span className="status-dot" aria-hidden="true" />
              {VERDICT_LABELS[v]}
              <span className="chip-count">{count === undefined ? '…' : fmtInt(count)}</span>
            </button>
          );
        })}
        {filters.verdicts.length ? (
          <button type="button" className="link-btn small" onClick={() => set('verdicts', [])}>
            Every verdict
          </button>
        ) : null}
      </div>

      <div className="summary-bar">
        <div className="summary-stats">
          {result ? (
            <>
              <span>
                <strong className="num">{fmtInt(total)}</strong> {total === 1 ? 'item' : 'items'}
                {loaded < total ? <span className="muted"> (showing {fmtInt(loaded)})</span> : null}
              </span>
              <span className="sep" aria-hidden="true" />
              <span title="Items whose latest typed or saved scrap.tf price is at or under Pay up to (with the filters above, any verdict)">
                <strong className="num tone-text-good">{fmtInt(result.counts.flip)}</strong> {result.counts.flip === 1 ? 'flip' : 'flips'} at your prices
              </span>
            </>
          ) : (
            <span className="muted">Loading…</span>
          )}
          {win.reloading && result ? <span className="muted small"> · updating</span> : null}
          {win.error && result ? (
            <span className="tone-text-bad small" title={win.error}>
              {' '}
              · refresh failed
            </span>
          ) : null}
        </div>
        <div className="summary-actions">
          {bankLink ? (
            <button type="button" className="btn small market-bank-link" title={bankLink.title} aria-label={bankLink.ariaLabel} onClick={() => void openOrCopy(bankLink.url, toast, { allowWindow: true })}>
              {bankLink.text}
              <span aria-hidden="true"> ↗</span>
            </button>
          ) : null}
          {frozen ? (
            <span className={`market-waiting small${waiting > 0 ? ' has-waiting' : ''}`} title="Live changes held back while frozen; unfreeze to apply them">
              {waitingText(waiting)}
            </span>
          ) : null}
          <button
            type="button"
            className={`btn small${frozen ? ' active' : ''}`}
            aria-pressed={frozen}
            onClick={toggleFreeze}
            title={frozen ? 'Unfreeze: apply the waiting updates and follow the feed again' : 'Stop live re-sorting while you read; updates are counted and applied when you unfreeze'}
          >
            <Icon name="freeze" size={14} /> {frozen ? 'Frozen' : 'Freeze'}
          </button>
          <button type="button" className="btn small" onClick={() => void exportCsv()} title="Saves every item matching these filters, in this order">
            <Icon name="download" size={14} /> Export CSV
          </button>
        </div>
      </div>

      {result && total > 0 && paused ? (
        <Banner tone="warn" icon="pause">
          Network is paused, so buy orders and the market are not updating.{' '}
          <button type="button" className="link-btn" onClick={() => void updateSettings({ networkPaused: false })}>
            Resume network
          </button>
        </Banner>
      ) : result && total > 0 && feedOff ? (
        <Banner tone="info" icon="feed">
          The live feed is off, so the market only changes when you refresh items by hand.{' '}
          <button type="button" className="link-btn" onClick={() => void updateSettings({ liveFeed: { enabled: true } })}>
            Turn on live feed
          </button>
        </Banner>
      ) : null}

      {win.error && !result ? <ErrorBanner message={`Could not load the live market: ${win.error}`} onRetry={win.refresh} /> : null}

      {win.error && !result ? null : (
        <div className="table-region">
          {win.loading || !result ? (
            <LoadingBlock label="Loading the live market…" />
          ) : total === 0 ? (
            <NoRows
              reason={emptyMarketReason({ filters, stats: result.stats, paused, feedOff, knownItems: result.scraptf.typed + result.scraptf.pages })}
              stats={result.stats}
              filtered={filterCount > 0}
              filtersText={emptyFiltersText(filters)}
              onReset={resetFilters}
            />
          ) : (
            <MarketTable
              rows={rows}
              dataKey={win.data?.key ?? ''}
              keyScrap={keyScrap}
              now={now}
              density={settings?.ui.density ?? 'comfortable'}
              selectedId={selectedId}
              flash={win.flash}
              sort={sort}
              loadingMore={win.loadingMore}
              frozen={frozen}
              onSelect={setSelectedId}
              onOpen={onOpen}
              onMenu={onRowMenu}
              onScraptf={onScraptf}
              scraptfInWindow={scraptfInWindow}
              onLoadMore={loadMore}
              onSort={onSort}
            />
          )}
        </div>
      )}
      <p className="hint-line muted small">
        Keyboard: <kbd>j</kbd>/<kbd>k</kbd> or arrows to move, <kbd>Enter</kbd> to open, <kbd>{MARKET_SCRAPTF_KEY}</kbd> to open it on scrap.tf (copies the name),{' '}
        <kbd>Shift</kbd>+<kbd>F10</kbd> or right-click for item actions, <kbd>/</kbd> to search. Freeze holds the order while you read.{' '}
        <button type="button" className="link-btn" onClick={() => navigate('settings')}>
          Change thresholds
        </button>
      </p>
      {menu.element}
    </div>
  );
}

/**
 * Swaps the current route without a history entry, so Back skips a one-shot route like
 * #/market/bank/<bank>; hashchange tells the route hook (replaceState fires none).
 */
function replaceRoute(path: string): void {
  try {
    window.history.replaceState(window.history.state, '', `#/${path}`);
    window.dispatchEvent(new Event('hashchange'));
  } catch {
    // The filters are already applied; only the address stays as it was.
  }
}

function newest(a: UnixMs | null, b: UnixMs | null): UnixMs | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

// ---------------------------------------------------------------------------
// Recent checks (F16 Live check)
// ---------------------------------------------------------------------------

/**
 * The live check's recent results: the service's in-memory ring ('check.recent': results only, never
 * the copied text), kept live by 'check.done', plus a box to check pasted text without the hotkey
 * ('check.text', source 'manual'). Collapsed by default; the choice is remembered. Local IPC only:
 * nothing here reads the clipboard or contacts scrap.tf (R1). Exported for the render tests.
 */
export function RecentChecks() {
  const { openItem, settings } = useApp();
  const [open, setOpen] = usePersistentState<boolean>('market.recentChecksOpen', false, sanitizeRecentOpen);
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The pasted text lives in this field only: never stored, logged or kept once it was an item.
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<{ result: CheckResult | null; error: string | null } | null>(null);
  const busyRef = useRef(false);
  const now = useNow(open ? 15_000 : 60_000);
  const ids = useId();
  const bodyId = `${ids}-body`;
  const inputId = `${ids}-text`;

  const load = useCallback(() => {
    rpc('check.recent')
      .then((r) => {
        setChecks((cur) => mergeRecentChecks(cur, r));
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(errorMessage(e)));
  }, []);
  // On mount (the count shows while collapsed) and on each opening, to catch up.
  useEffect(() => {
    load();
  }, [load, open]);
  // A manual check is both returned and pushed; mergeRecentChecks keeps it once.
  usePush('check.done', (r) => setChecks((cur) => mergeRecentChecks(cur, [r])));

  const runCheck = async () => {
    if (busyRef.current) return;
    const problem = manualCheckProblem(text);
    if (problem) {
      setManual({ result: null, error: problem });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const sent = text;
    try {
      const r = await rpc('check.text', { text: sent, source: 'manual' });
      setManual({ result: r, error: null });
      if (r.status === 'item') {
        setChecks((cur) => mergeRecentChecks(cur, [r]));
        // Only what was checked: text typed while the check ran stays.
        setText((cur) => (cur === sent ? '' : cur));
      }
    } catch (e) {
      setManual({ result: null, error: errorMessage(e) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const watchOn = settings?.check?.watchClipboard ?? false;
  // Main's watcher does not poll while the network-paused switch (a setting) is on, so the header must not say it is on.
  const watchPaused = watchOn && (settings?.networkPaused ?? false);
  const hint = recentChecksHint(settings?.check?.hotkey ?? '', watchOn && !watchPaused);
  const latest = manual?.result?.status === 'item' ? checkKey(manual.result) : null;
  // A check lands between ticks: the clock is at least its time, so it never reads "in 11 s".
  const shownNow = Math.max(now, checks[0]?.checkedAt ?? 0, manual?.result?.checkedAt ?? 0);
  return (
    <section className="card recent-checks" aria-labelledby={`${ids}-title`}>
      <div className="rc-head">
        <h2 className="rc-title" id={`${ids}-title`}>
          {/* aria-controls only while the body is rendered: it must name an element that exists. */}
          <button type="button" className="rc-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
            Recent checks
            <span className="count">
              <span className="sr-only">, </span>
              {fmtInt(checks.length)}
            </span>
          </button>
        </h2>
        <span className="rc-hint muted small" title={hint}>
          {hint}
        </span>
        {watchOn ? (
          <TonePill tone={watchPaused ? 'warn' : 'info'} title={watchPaused ? `Paused while the network is paused. ${CHECK_PRIVACY_SENTENCE}` : CHECK_PRIVACY_SENTENCE}>
            {watchPaused ? 'Clipboard check paused' : 'Clipboard check on'}
          </TonePill>
        ) : null}
      </div>
      {open ? (
        <div id={bodyId} className="rc-body">
          <form
            className="rc-form"
            onSubmit={(e) => {
              e.preventDefault();
              void runCheck();
            }}
          >
            <label className="sr-only" htmlFor={inputId}>
              Item or scrap.tf/items row to check
            </label>
            <textarea
              id={inputId}
              className="input rc-input"
              rows={1}
              maxLength={CHECK_MAX_CHARS}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste an item name or a scrap.tf/items row"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter checks; Shift+Enter keeps a line break (a name, then its price).
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void runCheck();
                } else if (e.key === 'Escape' && text) {
                  e.preventDefault();
                  setText('');
                }
              }}
            />
            <button type="submit" className="btn small primary" disabled={busy}>
              {busy ? 'Checking…' : 'Check'}
            </button>
          </form>
          {manual ? <ManualCheckLine manual={manual} now={shownNow} onOpen={openItem} /> : null}
          {loadError ? (
            <div className="tone-text-bad small" role="alert">
              Could not load recent checks: {loadError}{' '}
              <button type="button" className="link-btn" onClick={load}>
                Retry
              </button>
            </div>
          ) : null}
          {checks.length ? (
            <ul className="rc-list" aria-label="Recent checks, newest first">
              {checks.map((r) => (
                <RecentCheckItem key={checkKey(r)} result={r} now={shownNow} highlight={checkKey(r) === latest} onOpen={openItem} />
              ))}
            </ul>
          ) : (
            <p className="muted small">No checks yet. They stay in memory only, until the app closes.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ManualCheckLine({ manual, now, onOpen }: { manual: { result: CheckResult | null; error: string | null }; now: UnixMs; onOpen: (sku: string) => void }) {
  const r = manual.result;
  if (!r) {
    return (
      <p className="rc-result tone-text-bad small" role="alert">
        {manual.error}
      </p>
    );
  }
  if (r.status !== 'item' || !r.sku) {
    return (
      <p className="rc-result small" role="status">
        <Icon name={r.status === 'refused' ? 'warning' : 'info'} size={13} />
        <span>{r.reason}</span>
        <span className="muted">{CHECK_HINT}.</span>
      </p>
    );
  }
  const sku = r.sku;
  return (
    <p className="rc-result small" role="status" title={checkSummaryText(r, now)}>
      <ItemName sku={sku} name={r.name ?? sku} maxTags={1} />
      <CheckVerdictPill result={r} />
      <span className="muted">
        Pay up to <span className="money">{checkPayUpTo(r).text}</span>
      </span>
      <button type="button" className="link-btn" onClick={() => onOpen(sku)}>
        Open
      </button>
    </p>
  );
}

function RecentCheckItem({ result, now, highlight, onOpen }: { result: CheckResult; now: UnixMs; highlight: boolean; onOpen: (sku: string) => void }) {
  const row = recentCheckRow(result, now);
  return (
    <li>
      <button type="button" className={`rc-row${highlight ? ' just-checked' : ''}`} title={row.title} onClick={() => onOpen(row.sku)}>
        <span className="rc-time">{row.ago}</span>
        <span className="rc-item">
          <ItemName sku={row.sku} name={row.name} maxTags={1} />
        </span>
        <span className="rc-price">
          {row.price ? (
            <>
              <span className="money">{row.price}</span> <span className="muted small">{row.priceSource}</span>
            </>
          ) : (
            <span className="muted">no scrap.tf price</span>
          )}
        </span>
        <span className="rc-verdict">
          <CheckVerdictPill result={result} />
        </span>
        <span className="rc-pay">
          Pay up to <span className="money">{row.payUpTo}</span>
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Header strip
// ---------------------------------------------------------------------------

/** The header strip: live state, rate, the index (or its H1 error), the scrap.tf side and the F13 chips. Exported for the render tests only. */
export function MarketStrip({
  live,
  lastAt,
  rate,
  stats,
  scraptf,
  now,
  onImport,
}: {
  live: ReturnType<typeof marketLiveState>;
  lastAt: UnixMs | null;
  rate: { text: string; title: string };
  stats: MarketStats | null;
  scraptf: MarketListResult['scraptf'] | null;
  now: number;
  onImport: () => void;
}) {
  const index = stats ? indexStateText(stats, now) : null;
  const side = scraptf ? scraptfSideText(scraptf, now) : null;
  return (
    <section className="market-strip" aria-label="Live market status">
      <div className="market-strip-row">
        <StatePill state={live.state} label={live.label} title={live.title} />
        <span className="muted small" title={lastAt !== null ? fmtDateTime(lastAt) : undefined}>
          {lastChangeText(lastAt, now)}
        </span>
        <span className="sep" aria-hidden="true" />
        <span className="small" title={rate.title}>
          {rate.text}
        </span>
        <span className="sep" aria-hidden="true" />
        {index && stats && index.error ? (
          <IndexError stats={stats} title={index.title} />
        ) : index ? (
          <span className={`market-index small${index.building ? ' building' : ''}`} title={index.title}>
            {index.percent !== null ? <BuildBar percent={index.percent} /> : <Icon name="market" size={13} />}
            {index.text}
          </span>
        ) : (
          <span className="muted small">Index…</span>
        )}
      </div>
      <div className="market-strip-row market-side">
        <Icon name="tag" size={13} />
        <span className="small">{side ? side.text : 'Your scrap.tf data: …'}</span>
        <button type="button" className="link-btn small" onClick={onImport} title="Import pages you saved from scrap.tf, or set up the folder watch so they appear within seconds">
          {side?.watch === 'import-off' ? 'Set up Import' : 'Import'}
        </button>
      </div>
      <CoverageStrip scraptf={scraptf} now={now} />
    </section>
  );
}

/** H1: the rebuild could not read the local database. Its own 1 s clock, so only this line re-renders for the countdown. */
function IndexError({ stats, title }: { stats: MarketStats; title: string }) {
  const now = useNow(1000);
  return (
    <span className="market-index error small" title={title}>
      <Icon name="warning" size={13} />
      {marketErrorText(stats, now)}
    </span>
  );
}

/**
 * F13: one chip per scrap.tf bank page, coloured by how recently you saved it, after F14's "All items"
 * chip for the whole scrap.tf/items price list. A click opens that page's card on the scrap.tf banks
 * page (F15), where Open in browser hands it to your own browser; nothing here opens or fetches it.
 * Hidden while import is off. Exported for the render tests only.
 */
export function CoverageStrip({ scraptf, now }: { scraptf: MarketListResult['scraptf'] | null; now: number }) {
  const { navigate } = useApp();
  const all = allItemsChip(scraptf, now);
  const chips = [...(all ? [all] : []), ...coverageChips(scraptf, now)];
  if (!chips.length) return null;
  return (
    <div className="market-strip-row market-coverage" role="group" aria-label="scrap.tf pages you saved">
      <span className="muted small">Saved pages</span>
      {chips.map((c) => (
        <button
          key={`${c.kind}:${c.label}`}
          type="button"
          className={`chip coverage-chip tone-${c.tone}${c.kind === 'list' ? ' coverage-all' : ''}`}
          title={c.title}
          aria-label={c.ariaLabel}
          onClick={() => navigate(banksPath(c.bank))}
        >
          <span className="status-dot" aria-hidden="true" />
          <span className="coverage-label">{c.label}</span>
          <span className="coverage-status">{c.status}</span>
        </button>
      ))}
    </div>
  );
}

function BuildBar({ percent }: { percent: number }) {
  return (
    <span className="market-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Market index build">
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

function SortPicker({ value, onChange }: { value: MarketSortState; onChange: (v: MarketSortState) => void }) {
  const flip: SortDir = value.dir === 'asc' ? 'desc' : 'asc';
  return (
    <div className="market-sort">
      <label className="muted small" htmlFor="market-sort">
        Sort
      </label>
      <select
        id="market-sort"
        className="input select small"
        value={value.sort}
        onChange={(e) => {
          const sort = e.target.value as MarketSort;
          onChange({ sort, dir: defaultMarketDir(sort) });
        }}
      >
        {MARKET_SORTS.map((s) => (
          <option key={s} value={s}>
            {SORT_LABELS[s]}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="icon-btn"
        aria-label={value.dir === 'asc' ? 'Ascending; switch to descending' : 'Descending; switch to ascending'}
        title={value.dir === 'asc' ? 'Ascending' : 'Descending'}
        onClick={() => onChange({ sort: value.sort, dir: flip })}
      >
        <Icon name={value.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

function NoRows({ reason, stats, filtered, filtersText, onReset }: { reason: EmptyMarketReason; stats: MarketStats; filtered: boolean; filtersText: string; onReset: () => void }) {
  const { navigate, updateSettings, toast } = useApp();
  const openQuick = () => rpc('app.showQuickEntry').catch(() => toast('Could not open quick entry.', 'bad'));
  const settingsBtn = (
    <button type="button" className="btn ghost" onClick={() => navigate('settings')}>
      Open Settings
    </button>
  );
  switch (reason) {
    case 'error':
      return (
        // The service retries by itself (30 s doubling to 10 min); there is nothing to click.
        <EmptyState icon="warning" title="The market could not be built">
          <IndexErrorText stats={stats} />
        </EmptyState>
      );
    case 'building': {
      const pct = buildPercent(stats.progress);
      return (
        <EmptyState
          icon="clock"
          title={`Building the market: ${pct} %`}
          actions={
            filtered ? (
              <button type="button" className="btn" onClick={onReset}>
                Reset filters
              </button>
            ) : undefined
          }
        >
          <BuildBar percent={pct} />
          <p>
            Reading the buy orders the live feed already collected into one table. Nothing is downloaded for this; rows appear as it goes.
            {filtered ? ' Your filters may hide the items read so far.' : ''}
          </p>
        </EmptyState>
      );
    }
    case 'paused':
      return (
        <EmptyState
          icon="pause"
          title="The network is paused"
          actions={
            <>
              <button type="button" className="btn primary" onClick={() => void updateSettings({ networkPaused: false })}>
                Resume network
              </button>
              {settingsBtn}
            </>
          }
        >
          No buy orders arrive while the network is paused, so the market has nothing to compare. Items you priced still show once buyers are known.
        </EmptyState>
      );
    case 'feed-off':
      return (
        <EmptyState
          icon="feed"
          title="The live feed is off"
          actions={
            <>
              <button type="button" className="btn primary" onClick={() => void updateSettings({ liveFeed: { enabled: true } })}>
                Turn on live feed
              </button>
              {settingsBtn}
            </>
          }
        >
          The market is built from backpack.tf&apos;s live buy-order feed. Without it, only items you refresh by hand get buyers.
        </EmptyState>
      );
    case 'filters':
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
          {filtersText}
        </EmptyState>
      );
    case 'nothing-yet':
      return (
        <EmptyState
          icon="market"
          title="Waiting for buy orders"
          actions={
            <>
              <button type="button" className="btn primary" onClick={() => void openQuick()}>
                <Icon name="quick" size={14} /> Quick entry
              </button>
              <button type="button" className="btn ghost" onClick={() => navigate('import')}>
                Import a saved page
              </button>
              {filtered ? (
                <button type="button" className="btn ghost" onClick={onReset}>
                  Reset filters
                </button>
              ) : null}
            </>
          }
        >
          The market fills as the backpack.tf live feed reports buy orders; after a fresh start that takes a few minutes. Items you have a scrap.tf price for show up even
          without buyers.
        </EmptyState>
      );
  }
}

/** The empty state's H1 text, with its own 1 s countdown. */
function IndexErrorText({ stats }: { stats: MarketStats }) {
  const now = useNow(1000);
  return (
    // The countdown ticks every second: not something to announce each time.
    <p aria-live="off">
      {marketErrorText(stats, now)} The market is read from the buy orders already stored on this computer; nothing is downloaded for it. Rows appear once a read succeeds.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Virtual table
// ---------------------------------------------------------------------------

interface HeadDef {
  sort: MarketSort | null;
  label: string;
  cls: string;
  title: string;
}

const HEAD: readonly HeadDef[] = [
  { sort: 'name', label: 'Item', cls: 'm-item', title: 'Sort by name. Hover a name for its SKU.' },
  { sort: null, label: 'Category', cls: 'm-cat', title: 'scrap.tf bank category' },
  { sort: 'revenue', label: 'Sells for', cls: 'm-sells', title: 'Sort by revenue: the buy order your settings use, and who placed it' },
  { sort: 'buyers', label: 'Buyers', cls: 'm-buyers num', title: 'Sort by distinct buyers with eligible orders' },
  { sort: 'ceiling', label: 'Pay up to', cls: 'm-pay num', title: 'Sort by ceiling: the highest scrap.tf price that still clears your profit thresholds' },
  { sort: null, label: 'Your scrap.tf price', cls: 'm-yours num', title: 'Your latest typed or saved scrap.tf price, its source and age; a rule estimate in italics' },
  {
    sort: null,
    label: 'scrap.tf pays',
    cls: 'm-list num',
    title: "What scrap.tf's bank pays you for it, from your saved scrap.tf/items list (as of that save). Dimmed when scrap.tf is full or the list is over a day old.",
  },
  { sort: null, label: 'Stock', cls: 'm-stock num', title: "scrap.tf's stock of its limit, from your saved scrap.tf/items list. Full: it will not buy more right now." },
  { sort: 'profit', label: 'Verdict', cls: 'm-verdict', title: 'Sort by profit at your price' },
  { sort: null, label: 'Confidence', cls: 'm-conf', title: 'Buy-side confidence: buyers and reference prices only' },
  { sort: 'updated', label: 'Updated', cls: 'm-updated num', title: 'Sort by the last order change or your last price' },
];

function HeadCell({ def, sort, onSort }: { def: HeadDef; sort: MarketSortState; onSort: (k: MarketSort) => void }) {
  if (!def.sort) {
    return (
      <div role="columnheader" className={def.cls} title={def.title}>
        {def.label}
      </div>
    );
  }
  const key = def.sort;
  const active = sort.sort === key;
  return (
    <div role="columnheader" className={def.cls} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`sort-btn${active ? ' active' : ''}`} onClick={() => onSort(key)} title={def.title}>
        {def.label}
        {active ? <Icon name={sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} /> : null}
      </button>
    </div>
  );
}

export interface MarketTableProps {
  rows: MarketDisplayRow[];
  /** The query the rows answer: a new one scrolls back to the top. */
  dataKey: string;
  keyScrap: Scrap | null;
  now: number;
  density: 'comfortable' | 'compact';
  selectedId: string | null;
  flash: FlashState;
  sort: MarketSortState;
  loadingMore: boolean;
  /** Freeze: nothing is loaded, not even by scrolling to the end, until the user unfreezes. */
  frozen: boolean;
  onSelect: (id: string | null) => void;
  onOpen: (r: MarketRow) => void;
  onMenu: (r: MarketRow, at: MenuPoint) => void;
  /** F19: a row's scrap.tf button or the o key. Without it the rows show no button. */
  onScraptf?: (r: MarketRow) => void;
  /** F21: the button's words for the user's scrap.tf window (main opens it there); default the browser. */
  scraptfInWindow?: boolean;
  onLoadMore: () => void;
  onSort: (k: MarketSort) => void;
}

/**
 * Virtualised market grid with the opportunities table's keyboard model; rows are keyed by SKU.
 * Exported for the render tests only.
 */
export function MarketTable({
  rows,
  dataKey,
  keyScrap,
  now,
  density,
  selectedId,
  flash,
  sort,
  loadingMore,
  frozen,
  onSelect,
  onOpen,
  onMenu,
  onScraptf,
  scraptfInWindow = false,
  onLoadMore,
  onSort,
}: MarketTableProps) {
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
    // A scroll after a keyboard move means the cursor is no longer being followed; a stale flag
    // would let the next live re-sort jump the view back to the selected row.
    keyboardMove.current = false;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setFirstRow(Math.floor((scroller.current?.scrollTop ?? 0) / rowH)));
  };

  // Infinite scroll remembers which "Load more" row it already triggered (see below).
  const autoLoadedAt = useRef(-1);

  // A live refresh keeps what you were reading in place; a new query starts at the top.
  const shown = useRef<{ key: string; ids: string[] }>({ key: dataKey, ids: [] });
  useLayoutEffect(() => {
    const el = scroller.current;
    const prev = shown.current;
    const ids = rows.map((r) => r.id);
    shown.current = { key: dataKey, ids };
    if (!el) return;
    if (prev.key !== dataKey) {
      autoLoadedAt.current = -1;
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

  const selectedIndex = indexOfRow(rows, selectedId);

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

  // Infinite scroll: the next page loads once the "Load more" row comes near; a failure leaves the
  // button. Not while frozen: the rows shown are held, and a read now would come from the live order.
  const last = rows[rows.length - 1];
  const moreIndex = last?.type === 'more' && !last.capped ? rows.length - 1 : -1;
  useEffect(() => {
    if (frozen || moreIndex < 0 || loadingMore || end <= moreIndex || autoLoadedAt.current === moreIndex) return;
    autoLoadedAt.current = moreIndex;
    onLoadMore();
  }, [frozen, moreIndex, end, loadingMore, onLoadMore]);

  // Opened from the keyboard: anchored to the cursor's row.
  const menuForRow = (idx: number): boolean => {
    const row = rows[idx];
    if (row?.type !== 'item') return false;
    const box = document.getElementById(`mktrow-${idx}`)?.getBoundingClientRect();
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
      // k on the first row, j on the last: nothing moves and no effect would clear the flag, so a
      // later live re-sort would scroll back to the selected row.
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
        if (row.type === 'item') onOpen(row.row);
        else if (!row.capped && !loadingMore && !frozen) onLoadMore();
        break;
      case MARKET_SCRAPTF_KEY:
        if (row?.type !== 'item' || !onScraptf) return;
        e.preventDefault();
        // A held key repeats: one press, one browser tab.
        if (!e.repeat) onScraptf(row.row);
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
      className={`opp-scroll market-scroll density-${density}`}
      ref={scroller}
      onScroll={onScroll}
      tabIndex={0}
      role="grid"
      aria-label={`Live market. Use j and k or the arrow keys to move, Enter to open${onScraptf ? `, ${MARKET_SCRAPTF_KEY} to open the item on scrap.tf and copy its name` : ''}, Shift+F10 for item actions.`}
      aria-rowcount={rows.length + 1}
      aria-activedescendant={selectedIndex >= 0 ? `mktrow-${selectedIndex}` : undefined}
      onKeyDown={onKey}
      onContextMenu={onGridMenu}
      onFocus={() => {
        if (selectedIndex < 0 && rows.length) onSelect(rows[0]!.id);
      }}
    >
      <div className="opp-row opp-head" role="row" aria-rowindex={1} ref={header}>
        {HEAD.map((d) => (
          <HeadCell key={d.cls} def={d} sort={sort} onSort={onSort} />
        ))}
      </div>
      <div className="opp-body" role="rowgroup" style={{ height: rows.length * rowH }}>
        {rows.slice(start, end).map((r, i) => {
          const index = start + i;
          const selected = r.id === selectedId;
          if (r.type === 'more')
            return <MoreRow key={r.id} row={r} index={index} rowH={rowH} selected={selected} loading={loadingMore} frozen={frozen} onSelect={onSelect} onLoadMore={onLoadMore} />;
          const dir = flash.dirs.get(r.id) ?? null;
          return (
            <ItemRow
              key={r.id}
              row={r.row}
              index={index}
              rowH={rowH}
              selected={selected}
              keyScrap={keyScrap}
              now={now}
              flash={dir}
              // Only flashing rows see the parity, so a flash re-renders just them.
              flashOdd={dir !== null && flash.seq % 2 === 1}
              onSelect={onSelect}
              onOpen={onOpen}
              onMenu={onMenu}
              onScraptf={onScraptf}
              scraptfInWindow={scraptfInWindow}
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

const MoreRow = memo(function MoreRow({
  row,
  index,
  rowH,
  selected,
  loading,
  frozen,
  onSelect,
  onLoadMore,
}: {
  row: Extract<MarketDisplayRow, { type: 'more' }>;
  index: number;
  rowH: number;
  selected: boolean;
  loading: boolean;
  frozen: boolean;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}) {
  const next = nextPageRequest(row.shown, row.total);
  return (
    <div id={`mktrow-${index}`} role="row" aria-rowindex={index + 2} aria-selected={selected} className={`opp-row opp-more${selected ? ' selected' : ''}`} style={rowStyle(index, rowH)} onClick={() => onSelect(row.id)}>
      <div role="gridcell" className="more-cell">
        {row.capped || !next ? (
          <span className="muted small">
            Showing the first {fmtInt(row.shown)} of {fmtInt(row.total)}. Narrow the filters, or Export CSV for every item.
          </span>
        ) : frozen ? (
          <span className="muted small" title="Freeze holds the rows shown; more rows would come from the live order">
            Showing {fmtInt(row.shown)} of {fmtInt(row.total)}. Unfreeze to load more.
          </span>
        ) : (
          <>
            <span className="muted small">
              Showing {fmtInt(row.shown)} of {fmtInt(row.total)}
            </span>
            <button
              type="button"
              className="btn ghost small"
              tabIndex={-1}
              disabled={loading}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(row.id);
                onLoadMore();
              }}
            >
              {loading ? 'Loading…' : `Load ${fmtInt(next.limit)} more`}
            </button>
          </>
        )}
      </div>
    </div>
  );
});

/** Name in its quality colour with attribute tags; the tooltip adds the SKU (the drawer and the CSV use it). */
function MarketItemName({ sku, name }: { sku: string; name: string }) {
  const q = qualityOf(sku);
  const tags = itemTags(sku, name);
  const shown = tags.slice(0, 3);
  return (
    <span className="item-name-wrap">
      <span className={`item-name ${qualityClass(q)}`} title={`${name} (${qualityName(q)})\nSKU ${sku}`}>
        {name}
      </span>
      {shown.length ? (
        <span className="item-tags">
          {shown.map((t) => (
            <ItemTagChip key={t.kind} tag={t} />
          ))}
          {tags.length > shown.length ? (
            <span className="item-tag" title={tags.slice(shown.length).map((t) => t.title).join(', ')}>
              +{tags.length - shown.length}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

const ItemRow = memo(function ItemRow({
  row: r,
  index,
  rowH,
  selected,
  keyScrap,
  now,
  flash,
  flashOdd,
  onSelect,
  onOpen,
  onMenu,
  onScraptf,
  scraptfInWindow = false,
}: {
  row: MarketRow;
  index: number;
  rowH: number;
  selected: boolean;
  keyScrap: Scrap | null;
  now: number;
  flash: FlashDir | null;
  /** Alternates the animation name, so a row that changes again restarts its flash. */
  flashOdd: boolean;
  onSelect: (id: string) => void;
  onOpen: (r: MarketRow) => void;
  onMenu: (r: MarketRow, at: MenuPoint) => void;
  onScraptf?: ((r: MarketRow) => void) | undefined;
  scraptfInWindow?: boolean;
}) {
  const order = r.revenueOrder;
  const pill = verdictPill(r, keyScrap);
  const yours = yourPriceCell(r, keyScrap, now);
  const pays = listPaysCell(r, keyScrap, now);
  const stock = listStockCell(r, now);
  const updated = marketUpdatedAt(r);
  // F17: new on scrap.tf since the previous save of a bank page (MarketRow.scraptfNewAt).
  const fresh = scraptfNewBadge(r, now);
  // F19: the bank page to look for it on, in the Item cell (the grid's column budget is test-pinned).
  const stf = onScraptf ? marketScraptfButton(r, now, scraptfInWindow) : null;
  // Flags that should stop a purchase get an icon; the drawer explains every flag.
  const bad = r.flags.map(flagInfo).filter((f) => f.tone === 'bad');
  const flashCls = flash ? ` flash-${flash} flash-${flashOdd ? 'b' : 'a'}` : '';
  return (
    <div
      id={`mktrow-${index}`}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      className={`opp-row opp-item market-row verdict-${r.verdict}${selected ? ' selected' : ''}${flashCls}`}
      style={rowStyle(index, rowH)}
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
      <div role="gridcell" className="m-item">
        <MarketItemName sku={r.sku} name={r.name} />
        {fresh ? (
          <span className={`pill market-new tone-${fresh.tone}`} title={fresh.title}>
            {fresh.text}
            <span className="sr-only"> on scrap.tf</span>
          </span>
        ) : null}
        {bad.length ? (
          <span className="tone-text-bad risk-icon" title={bad.map((f) => `${f.label}: ${f.help}`).join('\n')}>
            <Icon name="warning" size={13} />
          </span>
        ) : null}
        {stf && onScraptf ? (
          <button
            type="button"
            className={`m-stf${stf.seen ? ' seen' : ''}`}
            // Out of the Tab order (keyboard users press o), and a click leaves the focus on the grid,
            // so j/k and o go on working.
            tabIndex={-1}
            title={stf.title}
            aria-label={stf.ariaLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              // Not the row's click: that opens the drawer.
              e.stopPropagation();
              onSelect(r.sku);
              onScraptf(r);
            }}
          >
            <Icon name="external" size={12} />
            <span className="m-stf-label">{stf.label}</span>
          </button>
        ) : null}
      </div>
      <div role="gridcell" className="m-cat muted" title={categoryLabel(r.category)}>
        {categoryLabel(r.category)}
      </div>
      <div role="gridcell" className="m-sells" title={marketSellsForTitle(r, keyScrap)}>
        <Money scrap={r.revenueScrap} keyScrap={keyScrap} />
        {order ? (
          <span className="buyer-type">
            <OnlineDot online={order.online} />
            <Icon name={order.isBot ? 'bolt' : 'user'} size={12} title={order.isBot ? 'Bot' : 'Human'} />
          </span>
        ) : null}
        {order ? <span className="buyer-name muted">{order.userName || (order.isBot ? 'Bot' : 'Human')}</span> : null}
      </div>
      <div role="gridcell" className={`m-buyers num${r.buyerCount === 0 ? ' muted' : ''}`}>
        {fmtInt(r.buyerCount)}
      </div>
      <div role="gridcell" className="m-pay num">
        {flash ? <Icon name={flash === 'up' ? 'arrowUp' : 'arrowDown'} size={11} className={`flash-arrow tone-text-${flash === 'up' ? 'good' : 'bad'}`} title={flash === 'up' ? 'Went up' : 'Went down'} /> : null}
        <Money scrap={r.maxCostScrap} keyScrap={keyScrap} title={marketPayTitle(r, keyScrap)} />
      </div>
      <div role="gridcell" className={`m-yours num${yours.tone ? ` tone-text-${yours.tone}` : ''}`} title={yours.title}>
        {yours.kind === 'none' ? (
          <span className="muted">{DASH}</span>
        ) : (
          <>
            {yours.badge ? (
              <span className={`src-badge src-${yours.badge}`}>
                {yours.badge}
                {yours.age ? <span className="src-age"> {yours.age}</span> : null}
              </span>
            ) : null}
            {yours.stock ? <span className="src-stock muted">{yours.stock}</span> : null}
            <span className={yours.kind === 'rule' ? 'rule-est' : undefined}>
              <Money scrap={yours.scrap} keyScrap={keyScrap} title={yours.title} />
            </span>
          </>
        )}
      </div>
      <div role="gridcell" className={`m-list num${pays.dim ? ' list-dim' : ''}`} title={pays.title}>
        {pays.scrap === null ? <span className="muted">{DASH}</span> : <Money scrap={pays.scrap} keyScrap={keyScrap} title={pays.title} />}
        {/* Shown only where the narrowest layout hides the Stock column (market.css). */}
        {pays.full ? <span className="pill tone-warn list-full list-full-inline">Full</span> : null}
      </div>
      <div role="gridcell" className={`m-stock num${stock.dim ? ' list-dim' : ''}${stock.out ? ' list-out' : ''}`} title={stock.title}>
        <span className={stock.text === DASH ? 'muted' : 'list-stock'}>{stock.text}</span>
        {stock.full ? <span className="pill tone-warn list-full">Full</span> : null}
      </div>
      <div role="gridcell" className="m-verdict">
        <span className={`pill verdict-pill tone-${pill.tone}`} title={pill.title}>
          {pill.text}
        </span>
      </div>
      <div role="gridcell" className="m-conf">
        <ConfidenceBadge score={r.confidence} level={r.confidenceLevel} compact />
      </div>
      <div role="gridcell" className="m-updated num muted" title={updated !== null ? fmtDateTime(updated) : undefined}>
        {updated === null ? DASH : fmtAge(now - updated)}
      </div>
    </div>
  );
});
