// The item drawer's "Order book history" (0.9, RESEARCH #6/#7): one local 'item.bookHistory' read showing how long
// orders like the drawer's top buy orders stayed at their price while Flip Desk watched the live feed (order
// persistence, never a fill rate: an order ends for reasons nobody can see) and backpack.tf's recorded community price
// (accepted price suggestions, not sales). It opens, links and writes nothing (R4), and nothing is fetched: the service
// reads only its own tables. It refetches on 'market.changed', throttled to BOOK_HISTORY_REFRESH_MS, and only while
// the window is shown. Pure helpers: bookHistoryModel.ts. No styles of its own (existing classes only).

import { useMemo } from 'react';
import { COMMUNITY_NOTE } from '../../shared/communityHistory';
import { ORDER_PERSISTENCE_NOTE } from '../../shared/orderPersistence';
import type { OrderSummary, Scrap, UnixMs } from '../../shared/types';
import {
  BOOK_HISTORY_NOTHING_FOLLOWED,
  BOOK_HISTORY_REFRESH_MS,
  bookHistoryOrderIds,
  bookHistorySummaryText,
  bookHistorySummaryTitle,
  bookOrderWho,
  communityChartPoints,
  communityReadout,
  communitySinceText,
  orderPersistenceLine,
} from '../bookHistoryModel';
import type { Tone } from '../format';
import { stepChartGeom } from '../historyModel';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { StepSparkline } from './Sparkline';

/** A line's tone as a class: muted text is grey ('muted'), the others are coloured (tokens.css .tone-text-*). */
function toneClass(tone: Tone): string {
  return tone === 'muted' ? 'muted' : `tone-text-${tone}`;
}

export function BookHistorySection({ sku, orders, keyScrap, now }: { sku: string; orders: readonly OrderSummary[]; keyScrap: Scrap | null; now: UnixMs }) {
  const ids = useMemo(() => bookHistoryOrderIds(orders), [orders]);
  const q = useRpcQuery('item.bookHistory', { sku, orders: ids });
  const reload = useThrottled(() => void q.reload(), BOOK_HISTORY_REFRESH_MS);
  useVisiblePush('market.changed', reload);

  const h = q.data;
  const key = h?.keyScrap ?? keyScrap;
  const steps = h?.community.steps ?? [];
  const points = useMemo(() => (h ? communityChartPoints(h.community, key, now) : []), [h, key, now]);
  const geom = useMemo(() => stepChartGeom(points), [points]);

  // Nothing renders while the first read is loading.
  if (!h && q.loading) return null;

  let body;
  if (!h) {
    body = (
      <p className="small tone-text-bad" role="status">
        Could not read the order book history{q.error ? `: ${q.error}` : '.'}{' '}
        <button type="button" className="link-btn" onClick={() => void q.reload()}>
          Try again
        </button>
      </p>
    );
  } else {
    const summary = bookHistorySummaryText(h.summary);
    const summaryTitle = bookHistorySummaryTitle(h.summary);
    const since = communitySinceText(h.community);
    body = (
      <>
        <h4 className="small">How long buy orders stay</h4>
        {summary ? (
          <>
            <p className="muted small" title={summaryTitle ?? undefined}>
              {summary}
            </p>
            {h.orders.map((o) => {
              const line = orderPersistenceLine(o, bookOrderWho(o, orders), key);
              return (
                <p key={o.listingId} className={`small ${toneClass(line.tone)}`} title={line.title}>
                  {line.text}
                </p>
              );
            })}
            <p className="muted small">{ORDER_PERSISTENCE_NOTE}</p>
          </>
        ) : (
          <p className="muted small">{BOOK_HISTORY_NOTHING_FOLLOWED}</p>
        )}
        <h4 className="small">backpack.tf community price</h4>
        {since ? (
          <>
            {geom ? (
              <StepSparkline
                geom={geom}
                ariaLabel={since}
                readout={(i) => <span className={i === null ? 'muted' : undefined}>{communityReadout(steps[i === null ? steps.length - 1 : Math.min(i, steps.length - 1)], key)}</span>}
              />
            ) : null}
            <p className="muted small">
              {since} {COMMUNITY_NOTE}
            </p>
          </>
        ) : (
          <p className="muted small">No community price recorded yet. {COMMUNITY_NOTE}</p>
        )}
      </>
    );
  }

  return (
    <section className="drawer-section" aria-labelledby="sec-book-history">
      <h3 id="sec-book-history">Order book history</h3>
      {body}
    </section>
  );
}
