import { useMemo, useState, type ReactNode } from 'react';
import type { HistoryPoint, Scrap } from '../../shared/types';
import { fmtDate, fmtMoney } from '../format';
import { STEP_BOX, nearestStep, type StepGeom } from '../historyModel';

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
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    // 0.7.3: pad only the y scale for a flat series (as stepChartGeom does); lo/hi stay the real range shown.
    const flat = hi === lo;
    const yLo = flat ? lo - 1 : lo;
    const yHi = flat ? hi + 1 : hi;
    const t0 = pts[0]!.t;
    const t1 = pts[pts.length - 1]!.t;
    const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD.t - PAD.b);
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
    return { lo, hi, yLo, yHi, x, y, buy: line('buyScrap'), sell: line('sellScrap'), t0, t1 };
  }, [pts]);

  if (!geom) {
    return <div className="spark-empty muted">Not enough price history yet.</div>;
  }

  const h = hover !== null ? pts[hover] : null;
  const last = pts[pts.length - 1]!;
  const flat = geom.lo === geom.hi;
  const range = flat ? `at ${fmtMoney(geom.lo, keyScrap)}` : `between ${fmtMoney(geom.lo, keyScrap)} and ${fmtMoney(geom.hi, keyScrap)}`;

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
        aria-label={`Price history from ${fmtDate(geom.t0 * 1000)} to ${fmtDate(geom.t1 * 1000)}, ${range}`}
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
        <line x1={PAD.l} x2={W - PAD.r} y1={geom.y(geom.yHi)} y2={geom.y(geom.yHi)} className="spark-grid" />
        <line x1={PAD.l} x2={W - PAD.r} y1={geom.y(geom.yLo)} y2={geom.y(geom.yLo)} className="spark-grid" />
        <path d={geom.sell} className="spark-sell" vectorEffect="non-scaling-stroke" />
        <path d={geom.buy} className="spark-buy" vectorEffect="non-scaling-stroke" />
        {h ? <line x1={geom.x(h.t)} x2={geom.x(h.t)} y1={PAD.t} y2={H - PAD.b} className="spark-cursor" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <figcaption className="spark-axis muted">
        <span>{fmtDate(geom.t0 * 1000)}</span>
        <span>{flat ? fmtMoney(geom.lo, keyScrap) : `${fmtMoney(geom.lo, keyScrap)} – ${fmtMoney(geom.hi, keyScrap)}`}</span>
        <span>{fmtDate(geom.t1 * 1000)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * F20: a step chart of one price per save (historyModel.stepChartGeom): the price is held until the
 * next save, a save that did not list the item on sale breaks the line and leaves a tick on the
 * baseline, and each save on sale is a dot. Hovering picks the nearest save for `readout`. Dots are
 * zero-length round-capped strokes, so they stay round while the SVG stretches to the drawer.
 */
export function StepSparkline({ geom, ariaLabel, readout, axis }: { geom: StepGeom; ariaLabel: string; readout: (i: number | null) => ReactNode; axis?: ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const { w, h, padY } = STEP_BOX;
  const dots = geom.dots.map((p) => `M${p.x.toFixed(1)},${p.y.toFixed(1)}h0`).join('');
  const gaps = geom.gaps.map((g) => `M${g.x.toFixed(1)},${h - padY + 1}v6`).join('');
  const active = hover !== null ? geom.dots.find((p) => p.i === hover) : undefined;
  return (
    <figure className="spark stf-hist-chart">
      <div className="spark-readout" aria-live="off">
        {readout(hover)}
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="spark-svg stf-hist-svg"
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width <= 0) return;
          setHover(nearestStep(geom.xs, ((e.clientX - r.left) / r.width) * w));
        }}
      >
        <line x1={0} x2={w} y1={h - padY} y2={h - padY} className="spark-grid" />
        <path d={geom.path} className="stf-hist-step" vectorEffect="non-scaling-stroke" />
        {gaps ? <path d={gaps} className="stf-hist-gap" vectorEffect="non-scaling-stroke" /> : null}
        <path d={dots} className="stf-hist-dot" vectorEffect="non-scaling-stroke" />
        {hover !== null && geom.xs[hover] !== undefined ? (
          <line x1={geom.xs[hover]} x2={geom.xs[hover]} y1={padY / 2} y2={h - padY / 2} className="spark-cursor" vectorEffect="non-scaling-stroke" />
        ) : null}
        {active ? <path d={`M${active.x.toFixed(1)},${active.y.toFixed(1)}h0`} className="stf-hist-dot active" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {axis ? <figcaption className="spark-axis muted">{axis}</figcaption> : null}
    </figure>
  );
}
