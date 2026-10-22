// "Your holding & trades" in the item drawer (0.8, H7): what you hold of this SKU with its advice and the reasons
// it rests on, the open lots, the exit prices Flip Desk recorded while it ran (a step chart with gaps where nothing
// was recorded), your typical hold and your closed trades of it, all from one local 'holdings.detail' read (the
// journal, the stored exit runs and the same book). It opens nothing, links nothing and writes nothing (R4): the
// advice is text, and Record sale stays the drawer's own button. Refetched on 'journal.changed' (300 ms) and on
// 'market.changed', 'scraptf.listChanged' and 'prices.changed' (2 s), throttled and only while the window is shown.
// Pure helpers: holdingDetailModel.ts and holdingsModel.ts. Styles: styles/holdings.css (holding-*). 0.9 (#1): with the
// user's 7-day Trade lock each locked lot says when it becomes tradable; with Not sure (answered) a unit bought in the
// last 7 days gets a dated caution. Both from the user's own setting; nothing reads the Steam account.

import { useMemo, useState } from 'react';
import { tradeLockModeOf } from '../../shared/holdingAdvice';
import type { Scrap } from '../../shared/types';
import { fmtSaveTime } from '../changesModel';
import { fmtAge, fmtInt, fmtMoney } from '../format';
import {
  closedTradeLines,
  holdingChartGeom,
  holdingChartLabel,
  holdingChartReadout,
  holdingChartSeries,
  holdingLotLines,
  holdingSectionTitle,
  recordedSinceText,
  typicalHoldLine,
} from '../holdingDetailModel';
import { ADVICE_FOOTER, ADVICE_LABELS, ADVICE_TONES, adviceReasonText, adviceTitle, tradeLockCautionOn, tradeLockDrawerCaution } from '../holdingsModel';
import { useApp } from '../hooks/appContext';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { StepSparkline } from './Sparkline';

/** Closed trades listed before "Show all". */
export const HOLDING_TRADES_SHOWN = 10;

export function HoldingSection({ sku, keyScrap, now }: { sku: string; keyScrap: Scrap | null; now: number }) {
  const q = useRpcQuery('holdings.detail', { sku });
  const reloadSoon = useThrottled(() => void q.reload(), 300);
  const reload = useThrottled(() => void q.reload(), 2000);
  useVisiblePush('journal.changed', reloadSoon);
  useVisiblePush('market.changed', reload);
  useVisiblePush('scraptf.listChanged', reload);
  useVisiblePush('prices.changed', reload);
  const [allTrades, setAllTrades] = useState(false);
  // 0.9 (#1): the user's Trade lock answer (only '7d' dates the lots; an answered Not sure adds the drawer's caution).
  const { settings } = useApp();
  const lockMode = tradeLockModeOf(settings);
  const cautionOn = tradeLockCautionOn(settings);

  const d = q.data;
  const key = d?.keyScrap ?? keyScrap;
  const series = useMemo(() => (d ? holdingChartSeries(d.marks, key) : []), [d, key]);
  const geom = useMemo(() => holdingChartGeom(series), [series]);
  const title = holdingSectionTitle(d);
  // Nothing while loading, and no section for an item with nothing held, traded or recorded.
  if (!d || !title) return null;

  const row = d.row;
  const advice = row?.advice ?? null;
  const lots = holdingLotLines(d.lots, key, now, lockMode);
  const caution = row && cautionOn ? tradeLockDrawerCaution(row.heldSince, now) : null;
  const since = recordedSinceText(d);
  const typical = typicalHoldLine(d.typicalHold);
  const trades = closedTradeLines(d.closed, key);
  const shownTrades = allTrades ? trades : trades.slice(0, HOLDING_TRADES_SHOWN);

  return (
    <section className="drawer-section holding-section" aria-labelledby="sec-holding">
      <h3 id="sec-holding">{title}</h3>
      {row ? (
        <>
          <p className="holding-now">
            <span>
              You hold {fmtInt(row.qty)} · held {row.heldSince > 0 ? fmtAge(now - row.heldSince) : '?'}
            </span>
            {advice ? (
              <span className={`pill advice-pill tone-${ADVICE_TONES[advice.kind]}`} title={adviceTitle(advice, key, now)}>
                {ADVICE_LABELS[advice.kind]}
              </span>
            ) : null}
          </p>
          {advice ? (
            <>
              <ul className="plain-list holding-reasons small">
                {advice.reasons.map((r, i) => (
                  <li key={`${r.code}-${i}`}>{adviceReasonText(r, key, now)}</li>
                ))}
              </ul>
              <p className="muted small">{ADVICE_FOOTER}</p>
            </>
          ) : null}
          {row && lockMode === 'unknown' && caution ? <p className="muted small holding-lock-caution">{caution}</p> : null}
        </>
      ) : null}
      {lots.length ? (
        <ul className="plain-list holding-lots small" aria-label="Open lots, oldest first">
          {lots.map((l, i) => (
            <li key={d.lots[i]?.id ?? i}>{l}</li>
          ))}
        </ul>
      ) : null}
      {geom ? (
        <StepSparkline
          geom={geom}
          ariaLabel={holdingChartLabel(geom, d.marks.length, key)}
          readout={(i) => <span className={i === null ? 'muted' : undefined}>{holdingChartReadout(series[i ?? series.length - 1], key)}</span>}
          axis={
            <>
              <span>{fmtSaveTime(geom.t0)}</span>
              <span>{geom.lo === geom.hi ? fmtMoney(geom.lo, key) : `${fmtMoney(geom.lo, key)} – ${fmtMoney(geom.hi, key)}`}</span>
              <span>{fmtSaveTime(geom.t1)}</span>
            </>
          }
        />
      ) : null}
      {since ? <p className="muted small holding-since">{since}</p> : null}
      {typical ? <p className="small holding-typical">{typical}</p> : null}
      {trades.length ? (
        <>
          <h4 className="holding-sub">Your closed trades</h4>
          <ul className="plain-list holding-trades small">
            {shownTrades.map((t, i) => (
              <li key={d.closed[i]?.sellId ?? i} className={t.tone ? `tone-text-${t.tone}` : undefined}>
                {t.text}
              </li>
            ))}
          </ul>
          {trades.length > HOLDING_TRADES_SHOWN ? (
            <button type="button" className="link-btn small" onClick={() => setAllTrades((v) => !v)}>
              {allTrades ? 'Show fewer' : `Show all ${fmtInt(trades.length)}`}
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
