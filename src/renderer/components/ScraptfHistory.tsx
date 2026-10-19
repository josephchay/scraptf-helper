// "scrap.tf history" block of the item drawer (F20, U1): the price on every save of the item's bank
// the user kept (a step chart with gaps where it was not listed), how long it has been listed, the
// 1 h / 24 h / 7 d / since-listed changes, stock now and its last change events (0.7.1, DM-6: price
// changes and stock moves listed apart), from 'scraptf.itemHistory'. Everything comes from pages the
// user saved (R10); nothing here loads scrap.tf (R1) or opens anything. Fetched lazily when the drawer opens and refetched on
// 'scraptf.changed' and 'prices.changed' (every import pushes it: a first save or an unchanged one
// writes no change event but still adds a point), throttled and only while the window is shown.
// Pure helpers: historyModel.ts. Styles: styles/scraptf-history.css (classes stf-hist-*).

import { useMemo, useState } from 'react';
import { SCRAPTF_BOUNDARY_SHORT } from '../../shared/boundaryText';
import type { Scrap, UnixMs } from '../../shared/types';
import { fmtSaveTime } from '../changesModel';
import { fmtMoney } from '../format';
import {
  HISTORY_EVENTS_SHOWN,
  HISTORY_REFRESH_MS,
  historyBankPath,
  historyChartLabel,
  historyChips,
  historyEventGroups,
  historyEventLines,
  historyListedLine,
  historyNote,
  historyNowText,
  historyReadout,
  historySeries,
  stepChartGeom,
} from '../historyModel';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { Icon } from './Icon';
import { StepSparkline } from './Sparkline';

export interface ScraptfHistoryProps {
  /** The drawer's SKU ('scraptf.itemHistory' { sku }; a painted SKU reads its own copy). */
  sku: string;
  /** The bank_stock special key of the copy, when the drawer was opened from a bank stock row; else the SKU's own. */
  special?: string | null;
  keyScrap: Scrap | null;
  now: UnixMs;
}

export function ScraptfHistory({ sku, special, keyScrap, now }: ScraptfHistoryProps) {
  const q = useRpcQuery('scraptf.itemHistory', special !== undefined && special !== null ? { sku, special } : { sku });
  const reload = useThrottled(() => void q.reload(), HISTORY_REFRESH_MS);
  useVisiblePush('scraptf.changed', reload);
  useVisiblePush('prices.changed', reload);
  const [allEvents, setAllEvents] = useState(false);
  const [allStock, setAllStock] = useState(false);

  const h = q.data;
  const key = h?.keyPrice?.valueScrap ?? keyScrap;
  const series = useMemo(() => (h ? historySeries(h.points) : []), [h]);
  const geom = useMemo(() => stepChartGeom(series), [series]);
  // historySeries sorts; the readout needs the point behind each index.
  const sorted = useMemo(() => (h ? [...h.points].filter((p) => Number.isFinite(p.at)).sort((a, b) => a.at - b.at) : []), [h]);
  const path = historyBankPath(h);
  const note = h ? historyNote(h) : null;
  const groups = useMemo(() => historyEventGroups(h?.events ?? []), [h]);

  let body;
  if (q.loading && !h) {
    body = <p className="muted small">Reading your saves…</p>;
  } else if (!h) {
    body = (
      <p className="small tone-text-bad" role="status">
        Could not read your scrap.tf history{q.error ? `: ${q.error}` : '.'}{' '}
        <button type="button" className="link-btn" onClick={() => void q.reload()}>
          Try again
        </button>
      </p>
    );
  } else if (h.bank === null) {
    body = (
      <div className="stf-hist-empty">
        <p className="stf-hist-empty-title">{note?.title}</p>
        <p className="muted small">{note?.body}</p>
      </div>
    );
  } else {
    const listed = historyListedLine(h, now);
    const current = historyNowText(h, key);
    const chips = historyChips(h, key);
    const lines = historyEventLines(groups.price, key, now, allEvents ? groups.price.length : HISTORY_EVENTS_SHOWN, h.bank);
    const stockLines = historyEventLines(groups.stock, key, now, allStock ? groups.stock.length : HISTORY_EVENTS_SHOWN, h.bank);
    body = (
      <>
        {listed ? (
          <p className={`stf-hist-listed tone-${listed.tone}`} title={listed.title}>
            <Icon name="clock" size={13} />
            <span>{listed.text}</span>
          </p>
        ) : null}
        {current ? (
          <p className={`stf-hist-now small${current.tone === 'muted' ? ' muted' : ''}`} title={current.title}>
            {current.text}
          </p>
        ) : null}
        <div className="stf-hist-chips" role="list" aria-label="Price change on scrap.tf">
          {chips.map((c) => (
            <span key={c.id} role="listitem" className={`stf-hist-chip tone-${c.tone}`} title={c.title}>
              <span className="stf-hist-chip-label">{c.label}</span>
              <span className="stf-hist-chip-value">{c.text}</span>
            </span>
          ))}
        </div>
        {geom ? (
          <StepSparkline
            geom={geom}
            ariaLabel={historyChartLabel(geom, sorted.length, key)}
            readout={(i) => <span className={i === null ? 'muted' : undefined}>{historyReadout(sorted[i ?? sorted.length - 1], key)}</span>}
            axis={
              <>
                <span>{fmtSaveTime(geom.t0)}</span>
                <span>{geom.lo === geom.hi ? fmtMoney(geom.lo, key) : `${fmtMoney(geom.lo, key)} – ${fmtMoney(geom.hi, key)}`}</span>
                <span>{fmtSaveTime(geom.t1)}</span>
              </>
            }
          />
        ) : null}
        {note ? <p className="muted small">{note.body}</p> : null}
        {lines.length ? (
          <>
            <h4 className="stf-hist-sub">Changes between your saves</h4>
            <ul className="plain-list stf-hist-events">
              {lines.map((l) => (
                <li key={l.id} className="stf-hist-event">
                  <span className="stf-hist-when num muted" title={l.whenTitle}>
                    {l.when}
                  </span>
                  <span className={`pill tone-${l.tone} stf-hist-kind`} title={l.kindTitle}>
                    {l.kind}
                  </span>
                  <span className={`stf-hist-what${l.priceTone === 'good' || l.priceTone === 'bad' ? ` tone-text-${l.priceTone}` : ''}`} title={l.priceTitle}>
                    {l.bank ? <span className="stf-hist-bank muted">{l.bank} · </span> : null}
                    {l.text}
                  </span>
                </li>
              ))}
            </ul>
            {groups.price.length > HISTORY_EVENTS_SHOWN ? (
              <button type="button" className="link-btn small" onClick={() => setAllEvents((v) => !v)}>
                {allEvents ? 'Show fewer' : `Show all ${groups.price.length}`}
              </button>
            ) : null}
          </>
        ) : null}
        {stockLines.length ? (
          <>
            <h4 className="stf-hist-sub" title="Same price in two saves, another stock count: kept apart so they never push a price change out of view.">
              Stock moves
            </h4>
            <ul className="plain-list stf-hist-events stf-hist-stock">
              {stockLines.map((l) => (
                <li key={l.id} className="stf-hist-event">
                  <span className="stf-hist-when num muted" title={l.whenTitle}>
                    {l.when}
                  </span>
                  <span className="stf-hist-what muted" title={l.priceTitle}>
                    {l.bank ? <span className="stf-hist-bank">{l.bank} · </span> : null}
                    {l.text}
                  </span>
                </li>
              ))}
            </ul>
            {groups.stock.length > HISTORY_EVENTS_SHOWN ? (
              <button type="button" className="link-btn small" onClick={() => setAllStock((v) => !v)}>
                {allStock ? 'Show fewer' : `Show all ${groups.stock.length}`}
              </button>
            ) : null}
          </>
        ) : null}
      </>
    );
  }

  return (
    <section className="drawer-section stf-hist" aria-labelledby="sec-stf-hist">
      <div className="section-head">
        <h3 id="sec-stf-hist">scrap.tf history</h3>
        {path ? <span className="bank-path mono small">{path}</span> : null}
        {q.reloading && h ? <span className="muted small">updating…</span> : null}
      </div>
      {body}
      <p className="muted small stf-hist-note">From the pages you saved: one point per save, and nothing is known between two saves. {SCRAPTF_BOUNDARY_SHORT}</p>
    </section>
  );
}
