import { useMemo, useState } from 'react';
import type { HistoryPoint, Scrap } from '../../shared/types';
import { fmtDate, fmtMoney } from '../format';

const W = 360;
const H = 90;
const PAD = { l: 4, r: 4, t: 8, b: 8 };

/** Buy/sell price history as a small inline SVG with a hover readout. */
export function Sparkline({ history, keyScrap }: { history: HistoryPoint[]; keyScrap: Scrap | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = useMemo(() => [...history].filter((p) => p.buyScrap !== null || p.sellScrap !== null).sort((a, b) => a.t - b.t), [history]);

  const geom = useMemo(() => {
    if (pts.length < 2) return null;
    const vals = pts.flatMap((p) => [p.buyScrap, p.sellScrap]).filter((v): v is number => v !== null);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const t0 = pts[0]!.t;
    const t1 = pts[pts.length - 1]!.t;
    const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const line = (key: 'buyScrap' | 'sellScrap') => {
      let d = '';
      let pen = false;
      for (const p of pts) {
        const v = p[key];
        if (v === null) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    return { lo, hi, x, y, buy: line('buyScrap'), sell: line('sellScrap'), t0, t1 };
  }, [pts]);

  if (!geom) {
    return <div className="spark-empty muted">Not enough price history yet.</div>;
  }

  const h = hover !== null ? pts[hover] : null;
  const last = pts[pts.length - 1]!;

  return (
    <figure className="spark">
      <div className="spark-readout">
        {h ? (
          <>
            <span className="muted">{fmtDate(h.t * 1000)}</span>
            <span>
              <span className="legend-swatch buy" /> buy {fmtMoney(h.buyScrap, keyScrap)}
            </span>
            <span>
              <span className="legend-swatch sell" /> sell {fmtMoney(h.sellScrap, keyScrap)}
            </span>
          </>
        ) : (
          <>
            <span>
              <span className="legend-swatch buy" /> PriceDB buy {fmtMoney(last.buyScrap, keyScrap)}
            </span>
            <span>
              <span className="legend-swatch sell" /> sell {fmtMoney(last.sellScrap, keyScrap)}
            </span>
          </>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="spark-svg"
        role="img"
        aria-label={`Price history from ${fmtDate(geom.t0 * 1000)} to ${fmtDate(geom.t1 * 1000)}, between ${fmtMoney(geom.lo, keyScrap)} and ${fmtMoney(geom.hi, keyScrap)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const fx = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          let bestD = Infinity;
          pts.forEach((p, i) => {
            const d = Math.abs(geom.x(p.t) - fx);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          });
          setHover(best);
        }}
      >
        <line x1={PAD.l} x2={W - PAD.r} y1={geom.y(geom.hi)} y2={geom.y(geom.hi)} className="spark-grid" />
        <line x1={PAD.l} x2={W - PAD.r} y1={geom.y(geom.lo)} y2={geom.y(geom.lo)} className="spark-grid" />
        <path d={geom.sell} className="spark-sell" vectorEffect="non-scaling-stroke" />
        <path d={geom.buy} className="spark-buy" vectorEffect="non-scaling-stroke" />
        {h ? <line x1={geom.x(h.t)} x2={geom.x(h.t)} y1={PAD.t} y2={H - PAD.b} className="spark-cursor" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <figcaption className="spark-axis muted">
        <span>{fmtDate(geom.t0 * 1000)}</span>
        <span>
          {fmtMoney(geom.lo, keyScrap)} – {fmtMoney(geom.hi, keyScrap)}
        </span>
        <span>{fmtDate(geom.t1 * 1000)}</span>
      </figcaption>
    </figure>
  );
}
