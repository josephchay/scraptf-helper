// "scrap.tf history" block of the item drawer (F20, U1): the price on every save of the item's bank
// the user kept (a step chart with gaps where it was not listed), how long it has been listed, the
// 1 h / 24 h / 7 d / since-listed changes, stock now and its last change events (0.7.1, DM-6: price
// changes and stock moves listed apart), from 'scraptf.itemHistory'. Everything comes from pages the
// user saved (R10); nothing here loads scrap.tf (R1) or opens anything. Fetched lazily when the drawer opens and refetched on
// 'scraptf.changed' and 'prices.changed' (every import pushes it: a first save or an unchanged one
// writes no change event but still adds a point), throttled and only while the window is shown.
// 0.8 (T5, LC-3): the Cycles block: the buy-timing verdict (Wait / Buy now / Over / No buyers / Not enough data,
// with its n and the save it rests on), a tick under each save that showed a drop, and each listing run of the
// copy. A history without `timing` / `cycles` (an older service) renders as before.
// Pure helpers: historyModel.ts and timingModel.ts. Styles: styles/scraptf-history.css (classes stf-hist-*).

import { useMemo, useState } from 'react';
import { SCRAPTF_BOUNDARY_SHORT } from '../../shared/boundaryText';
import type { Scrap, UnixMs } from '../../shared/types';
import { fmtSaveTime } from '../changesModel';
import { fmtMoney } from '../format';
import {
  HISTORY_EVENTS_SHOWN,
  HISTORY_REFRESH_MS,
  HISTORY_RUNS_SHOWN,
  STEP_BOX,
  historyBankPath,
  historyChartLabel,
  historyChips,
  historyEventGroups,
  historyEventLines,
  historyListedLine,
  historyNote,
  historyNowText,
  historyReadout,
  historyRunLines,
  historySeries,
  historyTimingView,
  stepChartGeom,
  type HistoryUnsavedLook,
} from '../historyModel';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { Icon } from './Icon';
import { StepSparkline } from './Sparkline';
import { CheckoutGuard } from './CheckoutGuard';
import { timingGuardShown } from '../checkoutGuardModel';
import { scraptfLowLine } from '../bookHistoryModel';

export interface ScraptfHistoryProps {
  /** The drawer's SKU ('scraptf.itemHistory' { sku }; a painted SKU reads its own copy). */
  sku: string;
  /** The bank_stock special key of the copy, when the drawer was opened from a bank stock row; else the SKU's own. */
  special?: string | null;
  keyScrap: Scrap | null;
  now: UnixMs;
  /** 0.7.4 (F65): a newer look of the page that stored no save (the drawer's unsavedLookOf): no "Now" from an older save. */
  unsaved?: HistoryUnsavedLook | null;
}

export function ScraptfHistory({ sku, special, keyScrap, now, unsaved }: ScraptfHistoryProps) {
  const q = useRpcQuery('scraptf.itemHistory', special !== undefined && special !== null ? { sku, special } : { sku });
  const reload = useThrottled(() => void q.reload(), HISTORY_REFRESH_MS);
  useVisiblePush('scraptf.changed', reload);
  useVisiblePush('prices.changed', reload);
  const [allEvents, setAllEvents] = useState(false);
  const [allStock, setAllStock] = useState(false);
  const [allRuns, setAllRuns] = useState(false);

  const h = q.data;
  const key = h?.keyPrice?.valueScrap ?? keyScrap;
  const series = useMemo(() => (h ? historySeries(h.points) : []), [h]);
  // 0.8 (T5): a tick under each save that showed a drop; without cycles, no marks (0.7.4's chart).
  const dropAts = h?.cycles?.dropAts;
  const geom = useMemo(() => stepChartGeom(series, STEP_BOX, dropAts ? { downAts: dropAts } : {}), [series, dropAts]);
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
    const current = historyNowText(h, key, unsaved);
    // 0.9 (history): the copy's lowest price on sale in the bank's saves, with when and since when.
    const low = scraptfLowLine(h, key);
    const chips = historyChips(h, key, unsaved);
    const lines = historyEventLines(groups.price, key, now, allEvents ? groups.price.length : HISTORY_EVENTS_SHOWN, h.bank);
    const stockLines = historyEventLines(groups.stock, key, now, allStock ? groups.stock.length : HISTORY_EVENTS_SHOWN, h.bank);
    const timing = historyTimingView(h.timing, h, key, now);
    const runs = historyRunLines(h.cycles, h, key, now);
    const runLines = runs ? (allRuns ? runs.lines : runs.lines.slice(0, HISTORY_RUNS_SHOWN)) : [];
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
        {low ? (
          <p className={`stf-hist-now small ${low.tone === 'muted' ? 'muted' : `tone-text-${low.tone}`}`} title={low.title}>
            {low.text}
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
        {timing ? (
          <div className="stf-hist-timing" role="group" aria-label="Buy timing">
            <span className={`pill tone-${timing.pill.tone} stf-hist-timing-pill`} title={timing.pill.title}>
              {timing.pill.text}
            </span>
            {timing.lines.map((l, i) => (
              <p key={i} className="small">
                {l}
              </p>
            ))}
            <p className="muted small">{timing.note}</p>
          </div>
        ) : null}
        {/* 0.9 (#9): under a Buy now verdict, what to know before joining the queue (a sibling, never inside the timing block). */}
        {timingGuardShown(h.timing) ? <CheckoutGuard variant="list" /> : null}
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
        {runs ? (
          <>
            <h4 className="stf-hist-sub" title={runs.title}>
              {runs.head}
            </h4>
            <ul className="plain-list stf-hist-runs">
              {runLines.map((l) => (
                <li key={l.key} className={`stf-hist-run small${l.tone === 'muted' ? ' muted' : l.tone === 'warn' ? ' tone-text-warn' : ''}`} title={l.title}>
                  {l.text}
                </li>
              ))}
            </ul>
            {runs.lines.length > HISTORY_RUNS_SHOWN ? (
              <button type="button" className="link-btn small" onClick={() => setAllRuns((v) => !v)}>
                {allRuns ? 'Show fewer' : `Show all ${runs.lines.length}`}
              </button>
            ) : null}
          </>
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
