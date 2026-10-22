import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { Opportunity, Scrap } from '../../shared/types';
import { INPUT_KIND_LABELS, STATUS_LABELS, flagInfo, fmtAge, fmtAgo, fmtDateTime, fmtInt, fmtKeysDecimal, fmtKeysMetal, fmtMoney, fmtPct, fmtRefOnly } from '../format';
import {
  REVENUE_ORDER_TITLES,
  copyLabelOf,
  indexOfRow,
  isMenuKeyEcho,
  menuAnchorRect,
  moveCursor,
  nextGroupPageSize,
  payUpToTitle,
  revenueOrderOf,
  singleExitTitleOf,
  type DisplayRow,
  type SortDir,
  type SortKey,
  type UseOrder,
} from '../oppModel';
import { noRevenueTextOf } from '../quickModel';
import { Icon } from './Icon';
import { isContextMenuKey, menuPointForRect } from './ItemMenu';
import { ItemName, Money } from './ItemName';
import { ConfidenceBadge, OnlineDot, UnverifiedOrderMark } from './Pills';
import { Tip } from './Tip';
// 0.8 cycles (T7): the Wait / Buy now tag.
import { timingBadge } from '../timingModel';

export const ROW_HEIGHT = { comfortable: 38, compact: 30 } as const;

interface Props {
  rows: DisplayRow[];
  keyScrap: Scrap | null;
  now: number;
  staleMs: number;
  density: 'comfortable' | 'compact';
  /** Settings.profit.useOrder: which order revenue, profit and the Buyer column come from. */
  useOrder: UseOrder;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (o: Opportunity) => void;
  onToggleGroup: (key: string) => void;
  /** "Load more" under a group whose count exceeds its loaded rows. */
  onLoadMore?: (key: string) => void;
  loadingMore?: ReadonlySet<string>;
  sort: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  /** Right-click, Shift+F10 or the ContextMenu key on an opportunity row (the F9 item menu). */
  onContextMenu?: (o: Opportunity, at: { x: number; y: number }) => void;
}

const SORTABLE: { key: SortKey; label: string; cls: string; title: string }[] = [
  { key: 'name', label: 'Item', cls: 'c-item', title: 'Sort by name' },
  { key: 'profit', label: 'Profit', cls: 'c-profit num', title: 'Sort by profit' },
  { key: 'margin', label: 'Margin', cls: 'c-margin num', title: 'Sort by margin' },
  { key: 'confidence', label: 'Confidence', cls: 'c-conf', title: 'Sort by confidence' },
  { key: 'updated', label: 'Updated', cls: 'c-updated num', title: 'Sort by last change' },
];

function SortHeader({ k, sort, dir, onSort }: { k: SortKey; sort: SortKey; dir: SortDir; onSort: (k: SortKey) => void }) {
  const def = SORTABLE.find((s) => s.key === k)!;
  const active = sort === k;
  return (
    <div role="columnheader" className={def.cls} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`sort-btn${active ? ' active' : ''}`} onClick={() => onSort(k)} title={def.title}>
        {def.label}
        {active ? <Icon name={dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} /> : null}
      </button>
    </div>
  );
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** Virtualised, grouped opportunities grid with keyboard navigation (j/k, arrows, Enter). */
export function OppTable({
  rows,
  keyScrap,
  now,
  staleMs,
  density,
  useOrder,
  selectedId,
  onSelect,
  onOpen,
  onToggleGroup,
  onLoadMore,
  loadingMore = NO_KEYS,
  sort,
  dir,
  onSort,
  onContextMenu,
}: Props) {
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

  // Opened from the keyboard: anchored to the cursor's row.
  const menuForRow = useCallback(
    (idx: number): boolean => {
      const row = rows[idx];
      if (row?.type !== 'opp' || !onContextMenu) return false;
      const box = document.getElementById(`opprow-${idx}`)?.getBoundingClientRect();
      onContextMenu(row.opp, menuPointForRect(menuAnchorRect(box, scroller.current?.getBoundingClientRect(), headH)));
      return true;
    },
    [rows, onContextMenu, headH],
  );

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
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
          if (row.type === 'group') onToggleGroup(row.group.key);
          else if (row.type === 'more') {
            if (!row.capped && !loadingMore.has(row.groupKey)) onLoadMore?.(row.groupKey);
          } else onOpen(row.opp);
          break;
        case 'ArrowLeft':
          if (!row) return;
          e.preventDefault();
          if (row.type === 'group') {
            if (!row.collapsed) onToggleGroup(row.group.key);
          } else {
            keyboardMove.current = true;
            onSelect(`group:${row.groupKey}`);
          }
          break;
        case 'ArrowRight':
          if (row?.type === 'group' && row.collapsed) {
            e.preventDefault();
            onToggleGroup(row.group.key);
          }
          break;
      }
    },
    [rows, selectedId, onSelect, onOpen, onToggleGroup, onLoadMore, loadingMore, pageSize, menuForRow],
  );

  // A keyboard-generated contextmenu lands on the focused grid itself; rows handle the mouse.
  const onGridMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !onContextMenu) return;
    e.preventDefault();
    if (isMenuKeyEcho(menuKeyAt.current, Date.now())) return;
    menuForRow(indexOfRow(rows, selectedId));
  };

  return (
    <div
      className={`opp-scroll density-${density}`}
      ref={scroller}
      onScroll={onScroll}
      tabIndex={0}
      role="grid"
      aria-label="Opportunities. Use j and k or the arrow keys to move, Enter to open, Shift+F10 for item actions."
      aria-rowcount={rows.length + 1}
      aria-activedescendant={selectedIndex >= 0 ? `opprow-${selectedIndex}` : undefined}
      onKeyDown={onKey}
      onContextMenu={onGridMenu}
      onFocus={() => {
        if (selectedIndex < 0 && rows.length) onSelect(rows[0]!.id);
      }}
    >
      {/* 0.7.3: only a window of rows is in the DOM, so each says where it sits (as in the Live market). */}
      <div className="opp-row opp-head" role="row" aria-rowindex={1} ref={header}>
        <SortHeader k="name" sort={sort} dir={dir} onSort={onSort} />
        <div role="columnheader" className="c-cost num">
          Cost
        </div>
        <div role="columnheader" className="c-pay num" title="Pay up to: the highest scrap.tf price that still clears your profit thresholds against this revenue">
          Pay up to
        </div>
        <div role="columnheader" className="c-rev num" title={REVENUE_ORDER_TITLES[useOrder]}>
          Revenue
        </div>
        <SortHeader k="profit" sort={sort} dir={dir} onSort={onSort} />
        <SortHeader k="margin" sort={sort} dir={dir} onSort={onSort} />
        <SortHeader k="confidence" sort={sort} dir={dir} onSort={onSort} />
        <div role="columnheader" className="c-buyers num" title="Distinct buyers with eligible orders">
          Buyers
        </div>
        <div role="columnheader" className="c-btype">
          Buyer
        </div>
        <div role="columnheader" className="c-input num" title="Age of your scrap.tf price">
          Input
        </div>
        <SortHeader k="updated" sort={sort} dir={dir} onSort={onSort} />
      </div>
      <div className="opp-body" role="rowgroup" style={{ height: rows.length * rowH }}>
        {rows.slice(start, end).map((r, i) => {
          const index = start + i;
          return r.type === 'group' ? (
            <GroupRow key={r.id} row={r} index={index} rowH={rowH} selected={r.id === selectedId} keyScrap={keyScrap} onSelect={onSelect} onToggle={onToggleGroup} />
          ) : r.type === 'more' ? (
            <MoreRow key={r.id} row={r} index={index} rowH={rowH} selected={r.id === selectedId} loading={loadingMore.has(r.groupKey)} onSelect={onSelect} onLoadMore={onLoadMore} />
          ) : (
            <OppRow
              key={r.id}
              opp={r.opp}
              index={index}
              rowH={rowH}
              selected={r.id === selectedId}
              keyScrap={keyScrap}
              now={now}
              staleMs={staleMs}
              useOrder={useOrder}
              onSelect={onSelect}
              onOpen={onOpen}
              onMenu={onContextMenu}
            />
          );
        })}
      </div>
    </div>
  );
}

const GroupRow = memo(function GroupRow({
  row,
  index,
  rowH,
  selected,
  keyScrap,
  onSelect,
  onToggle,
}: {
  row: Extract<DisplayRow, { type: 'group' }>;
  index: number;
  rowH: number;
  selected: boolean;
  keyScrap: Scrap | null;
  onSelect: (id: string) => void;
  onToggle: (key: string) => void;
}) {
  const g = row.group;
  const style = rowStyle(index, rowH);
  return (
    <div
      id={`opprow-${index}`}
      role="row"
      aria-rowindex={index + 2}
      aria-expanded={!row.collapsed}
      aria-selected={selected}
      className={`opp-row opp-group${selected ? ' selected' : ''}`}
      style={style}
      onClick={() => {
        onSelect(row.id);
        onToggle(g.key);
      }}
    >
      <div role="gridcell" className="group-cell">
        <Icon name={row.collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
        <span className="group-label">{g.label}</span>
        <span className="count-badge" title={g.rows.length < g.count ? `${g.rows.length} loaded of ${g.count}` : undefined}>
          {g.count}
        </span>
        {/* 0.7.4 (F27, F33; R27): copies of an item sharing one buyer count once, at the best copy the filters show. */}
        <span className="group-total" title="Summed profit; copies of an item that sell to the same buy order count once, at the best copy shown.">
          <span className="muted">total</span> <Money scrap={g.totalProfitScrap} keyScrap={keyScrap} tone="profit" signed />
        </span>
      </div>
    </div>
  );
});

const MoreRow = memo(function MoreRow({
  row,
  index,
  rowH,
  selected,
  loading,
  onSelect,
  onLoadMore,
}: {
  row: Extract<DisplayRow, { type: 'more' }>;
  index: number;
  rowH: number;
  selected: boolean;
  loading: boolean;
  onSelect: (id: string) => void;
  onLoadMore?: (key: string) => void;
}) {
  const g = row.group;
  const shown = `Showing ${fmtInt(g.rows.length)} of ${fmtInt(g.count)}`;
  return (
    <div id={`opprow-${index}`} role="row" aria-rowindex={index + 2} aria-selected={selected} className={`opp-row opp-more${selected ? ' selected' : ''}`} style={rowStyle(index, rowH)} onClick={() => onSelect(row.id)}>
      <div role="gridcell" className="more-cell">
        {row.capped ? (
          <span className="muted small">{shown}, the most one group shows. Narrow the filters, or Export CSV for every row.</span>
        ) : (
          <>
            <span className="muted small">{shown}</span>
            <button
              type="button"
              className="btn ghost small"
              // 0.7.3: out of the Tab order (Enter on the More row loads), and a click leaves the focus
              // on the grid, so j/k and Enter go on working.
              tabIndex={-1}
              disabled={loading || !onLoadMore}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(row.id);
                onLoadMore?.(g.key);
              }}
            >
              {loading ? 'Loading…' : `Load ${fmtInt(nextGroupPageSize(g))} more`}
            </button>
          </>
        )}
      </div>
    </div>
  );
});

function rowStyle(index: number, rowH: number): CSSProperties {
  return { transform: `translateY(${index * rowH}px)`, height: rowH };
}

const STATUS_TONE: Record<Opportunity['status'], string> = {
  profitable: 'good',
  'below-threshold': 'warn',
  unprofitable: 'bad',
  'no-buyers': 'muted',
};

const OppRow = memo(function OppRow({
  opp: o,
  index,
  rowH,
  selected,
  keyScrap,
  now,
  staleMs,
  useOrder,
  onSelect,
  onOpen,
  onMenu,
}: {
  opp: Opportunity;
  index: number;
  rowH: number;
  selected: boolean;
  keyScrap: Scrap | null;
  now: number;
  staleMs: number;
  useOrder: UseOrder;
  onSelect: (id: string) => void;
  onOpen: (o: Opportunity) => void;
  onMenu?: (o: Opportunity, at: { x: number; y: number }) => void;
}) {
  const inputAge = now - o.inputObservedAt;
  const stale = o.inputKind !== 'rule' && inputAge > staleMs;
  // The buyer behind the revenue shown, not always the conservative one.
  const order = revenueOrderOf(o, useOrder);
  // 0.7.4 (F63): an exit nobody has confirmed for 24 h; the row stays, marked (and is never toasted).
  const unverified = order?.flags.includes('unverified') === true;
  // 0.7.3: no profit with buyers says why none is usable (noRevenueTextOf), not "No eligible buy orders".
  const noProfitTitle = o.profitScrap !== null ? undefined : o.buyerCount > 0 ? noRevenueTextOf(o) : 'No eligible buy orders';
  const copy = copyLabelOf(o);
  // The hover names the bank price judged, which can differ from the row's own input price.
  const badge = timingBadge(o.timing, now, keyScrap);
  // 0.7.4 (F27, F33): another copy sells to this row's buyer for as much or more; the totals count that order once.
  const shared = o.flags.includes('shared-buyer');
  // 0.8 (PC-2): only the revenue order's buyer makes the flip; the Buyers cell is marked and its hover says why.
  const thin = o.flags.includes('single-exit');
  const style = rowStyle(index, rowH);
  return (
    <div
      id={`opprow-${index}`}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      className={`opp-row opp-item status-${o.status}${selected ? ' selected' : ''}`}
      style={style}
      onClick={() => {
        onSelect(o.key);
        onOpen(o);
      }}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(o.key);
              onMenu(o, { x: e.clientX, y: e.clientY });
            }
          : undefined
      }
    >
      <div role="gridcell" className="c-item">
        <span className={`status-dot tone-${STATUS_TONE[o.status]}`} title={STATUS_LABELS[o.status]} aria-label={STATUS_LABELS[o.status]} role="img" />
        <ItemName sku={o.sku} name={o.name} maxTags={3} />
        {/* 0.7.4 (F66): which copy this row prices (a painted hat, a kit's sheen and killstreaker). */}
        {copy ? (
          <span className="item-tag copy-tag" title={copy.title}>
            {copy.text}
          </span>
        ) : null}
        {/* 0.8 (T7): the buy timing of the scrap.tf copy an 'import' row prices (Wait / Buy now only). */}
        {badge ? (
          <span className={`pill tone-${badge.tone} timing-badge`} title={badge.title}>
            {badge.text}
          </span>
        ) : null}
        {o.flags.includes('unusual-risk') ? (
          <span className="tone-text-bad risk-icon" title="Unusual risk: get a background check before trading">
            <Icon name="warning" size={13} />
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="c-cost num">
        <Money scrap={o.costScrap} keyScrap={keyScrap} title={o.costKeys ? `Entered as ${fmtKeysMetal(o.costKeys, o.costScrapRaw)} (${fmtRefOnly(o.costScrap)} at the current key price)` : undefined} />
      </div>
      <div role="gridcell" className="c-pay num">
        <Money scrap={o.maxCostScrap} keyScrap={keyScrap} title={payUpToTitle(o, keyScrap)} />
      </div>
      <div role="gridcell" className={`c-rev num${unverified ? ' tone-text-warn' : ''}`}>
        <Tip
          content={() => (
            <dl className="kv tight">
              <dt>Conservative</dt>
              <dd>{fmtMoney(o.consScrap, keyScrap)}</dd>
              <dt>Best</dt>
              <dd>
                {fmtMoney(o.bestScrap, keyScrap)}
                {o.flags.includes('outlier-best') ? ' (outlier)' : ''}
                {o.bestOrder?.flags.includes('unverified') && o.bestOrder.listingId !== order?.listingId ? ' (unverified)' : ''}
              </dd>
              <dt>Instant (bot)</dt>
              <dd>{fmtMoney(o.instantScrap, keyScrap)}</dd>
              {unverified && order ? (
                <>
                  <dt>Order seen</dt>
                  <dd>{fmtAgo(order.lastEventAt, now)}, may be gone</dd>
                </>
              ) : null}
            </dl>
          )}
        >
          <span>
            {/* 0.7.4 (F63): a revenue order nobody has confirmed for 24 h is marked, not shown as a live bid. */}
            {unverified ? <UnverifiedOrderMark order={order} now={now} /> : null}
            <Money scrap={o.revenueScrap} keyScrap={keyScrap} />
          </span>
        </Tip>
      </div>
      <div role="gridcell" className={`c-profit num${shared ? ' muted' : ''}`}>
        <Money
          scrap={o.profitScrap}
          keyScrap={keyScrap}
          tone="profit"
          signed
          title={
            o.profitScrap !== null
              ? `${fmtRefOnly(o.profitScrap)} · ${fmtKeysDecimal(o.profitScrap, keyScrap)}${shared ? `. ${flagInfo('shared-buyer').help}` : ''}`
              : noProfitTitle
          }
        />
      </div>
      <div role="gridcell" className={`c-margin num${o.margin !== null && o.margin < 0 ? ' tone-text-bad' : ''}`}>
        {fmtPct(o.margin)}
      </div>
      <div role="gridcell" className="c-conf">
        <ConfidenceBadge score={o.confidence} level={o.confidenceLevel} reasons={o.reasons} />
      </div>
      <div role="gridcell" className={`c-buyers num${thin ? ' tone-text-warn' : ''}`} title={singleExitTitleOf(o)}>
        {o.buyerCount}
      </div>
      <div role="gridcell" className="c-btype">
        {order ? (
          <span className="buyer-type" title={order.userName ?? undefined}>
            <OnlineDot online={order.online} seenAt={order.lastEventAt} now={now} />
            {order.isBot ? (
              <>
                <Icon name="bolt" size={12} /> Bot
              </>
            ) : (
              <>
                <Icon name="user" size={12} /> Human
              </>
            )}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </div>
      <div role="gridcell" className={`c-input num${stale ? ' tone-text-warn' : ''}`} title={`${INPUT_KIND_LABELS[o.inputKind]}, observed ${fmtDateTime(o.inputObservedAt)}${stale ? ' (stale)' : ''}`}>
        {o.inputKind === 'rule' ? <span className="input-kind">rule</span> : null}
        {stale ? <Icon name="clock" size={12} /> : null}
        {fmtAge(inputAge)}
      </div>
      <div role="gridcell" className="c-updated num muted" title={fmtDateTime(o.updatedAt)}>
        {fmtAge(now - o.updatedAt)}
      </div>
    </div>
  );
});
