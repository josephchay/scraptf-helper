import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Opportunity, Scrap } from '../../shared/types';
import { INPUT_KIND_LABELS, STATUS_LABELS, fmtAge, fmtDateTime, fmtKeysDecimal, fmtKeysMetal, fmtMoney, fmtPct, fmtRefOnly } from '../format';
import { REVENUE_ORDER_TITLES, indexOfRow, moveCursor, revenueOrderOf, type DisplayRow, type SortDir, type SortKey, type UseOrder } from '../oppModel';
import { Icon } from './Icon';
import { ItemName, Money } from './ItemName';
import { ConfidenceBadge, OnlineDot } from './Pills';
import { Tip } from './Tip';

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
  sort: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
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

/** Virtualised, grouped opportunities grid with keyboard navigation (j/k, arrows, Enter). */
export function OppTable({ rows, keyScrap, now, staleMs, density, useOrder, selectedId, onSelect, onOpen, onToggleGroup, sort, dir, onSort }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  // Only the first visible row is state, so scrolling within a row costs no render.
  const [firstRow, setFirstRow] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [headH, setHeadH] = useState(34);
  const raf = useRef(0);
  const keyboardMove = useRef(false);
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

  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
      const idx = indexOfRow(rows, selectedId);
      const row = idx >= 0 ? rows[idx] : undefined;
      const go = (n: number) => {
        e.preventDefault();
        keyboardMove.current = true;
        onSelect(rows[n]?.id ?? null);
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
          else onOpen(row.opp);
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
    [rows, selectedId, onSelect, onOpen, onToggleGroup, pageSize],
  );

  return (
    <div
      className={`opp-scroll density-${density}`}
      ref={scroller}
      onScroll={onScroll}
      tabIndex={0}
      role="grid"
      aria-label="Opportunities. Use j and k or the arrow keys to move, Enter to open."
      aria-rowcount={rows.length + 1}
      aria-activedescendant={selectedIndex >= 0 ? `opprow-${selectedIndex}` : undefined}
      onKeyDown={onKey}
      onFocus={() => {
        if (selectedIndex < 0 && rows.length) onSelect(rows[0]!.id);
      }}
    >
      <div className="opp-row opp-head" role="row" ref={header}>
        <SortHeader k="name" sort={sort} dir={dir} onSort={onSort} />
        <div role="columnheader" className="c-cost num">
          Cost
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
          ) : (
            <OppRow key={r.id} opp={r.opp} index={index} rowH={rowH} selected={r.id === selectedId} keyScrap={keyScrap} now={now} staleMs={staleMs} useOrder={useOrder} onSelect={onSelect} onOpen={onOpen} />
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
        <span className="group-total">
          <span className="muted">total</span> <Money scrap={g.totalProfitScrap} keyScrap={keyScrap} tone="profit" signed />
        </span>
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
}) {
  const inputAge = now - o.inputObservedAt;
  const stale = o.inputKind !== 'rule' && inputAge > staleMs;
  // The buyer behind the revenue shown, not always the conservative one.
  const order = revenueOrderOf(o, useOrder);
  const style = rowStyle(index, rowH);
  return (
    <div
      id={`opprow-${index}`}
      role="row"
      aria-selected={selected}
      className={`opp-row opp-item status-${o.status}${selected ? ' selected' : ''}`}
      style={style}
      onClick={() => {
        onSelect(o.key);
        onOpen(o);
      }}
    >
      <div role="gridcell" className="c-item">
        <span className={`status-dot tone-${STATUS_TONE[o.status]}`} title={STATUS_LABELS[o.status]} aria-label={STATUS_LABELS[o.status]} role="img" />
        <ItemName sku={o.sku} name={o.name} maxTags={3} />
        {o.flags.includes('unusual-risk') ? (
          <span className="tone-text-bad risk-icon" title="Unusual risk: get a background check before trading">
            <Icon name="warning" size={13} />
          </span>
        ) : null}
      </div>
      <div role="gridcell" className="c-cost num">
        <Money scrap={o.costScrap} keyScrap={keyScrap} title={o.costKeys ? `Entered as ${fmtKeysMetal(o.costKeys, o.costScrapRaw)} (${fmtRefOnly(o.costScrap)} at the current key price)` : undefined} />
      </div>
      <div role="gridcell" className="c-rev num">
        <Tip
          content={() => (
            <dl className="kv tight">
              <dt>Conservative</dt>
              <dd>{fmtMoney(o.consScrap, keyScrap)}</dd>
              <dt>Best</dt>
              <dd>
                {fmtMoney(o.bestScrap, keyScrap)}
                {o.flags.includes('outlier-best') ? ' (outlier)' : ''}
              </dd>
              <dt>Instant (bot)</dt>
              <dd>{fmtMoney(o.instantScrap, keyScrap)}</dd>
            </dl>
          )}
        >
          <Money scrap={o.revenueScrap} keyScrap={keyScrap} />
        </Tip>
      </div>
      <div role="gridcell" className="c-profit num">
        <Money
          scrap={o.profitScrap}
          keyScrap={keyScrap}
          tone="profit"
          signed
          title={o.profitScrap !== null ? `${fmtRefOnly(o.profitScrap)} · ${fmtKeysDecimal(o.profitScrap, keyScrap)}` : 'No eligible buy orders'}
        />
      </div>
      <div role="gridcell" className={`c-margin num${o.margin !== null && o.margin < 0 ? ' tone-text-bad' : ''}`}>
        {fmtPct(o.margin)}
      </div>
      <div role="gridcell" className="c-conf">
        <ConfidenceBadge score={o.confidence} level={o.confidenceLevel} reasons={o.reasons} />
      </div>
      <div role="gridcell" className="c-buyers num">
        {o.buyerCount}
      </div>
      <div role="gridcell" className="c-btype">
        {order ? (
          <span className="buyer-type" title={order.userName ?? undefined}>
            <OnlineDot online={order.online} />
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
