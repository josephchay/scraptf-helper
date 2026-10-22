import type { ReactNode } from 'react';
import { orderSeenRecently } from '../../shared/buyerSeen';
import type { ConfidenceLevel, ConnState, OrderSummary } from '../../shared/types';
import { CONFIDENCE_LABELS, CONN_STATE_LABELS, connTone, flagInfo, fmtAge, type ItemTag, type Tone } from '../format';
import { Icon } from './Icon';
import { Tip } from './Tip';

export function StatePill({ state, label, title }: { state: ConnState; label?: string; title?: string }) {
  const tone = connTone(state);
  return (
    <span className={`pill tone-${tone}`} title={title}>
      <span className={`dot${state === 'live' ? ' pulse' : ''}`} aria-hidden="true" />
      {label ?? CONN_STATE_LABELS[state] ?? state}
    </span>
  );
}

export function TonePill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ConfidenceBadge({
  score,
  level,
  reasons,
  compact = false,
}: {
  score: number;
  level: ConfidenceLevel;
  reasons?: string[];
  compact?: boolean;
}) {
  const badge = (
    <span className={`conf conf-${level}`} aria-label={`Confidence ${CONFIDENCE_LABELS[level]}, score ${score}`}>
      <span className="conf-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(4, Math.min(100, score))}%` }} />
      </span>
      {compact ? null : <span className="conf-label">{CONFIDENCE_LABELS[level]}</span>}
      <span className="conf-score">{score}</span>
    </span>
  );
  if (!reasons?.length) return badge;
  return (
    <Tip
      wide
      content={() => (
        <div className="reasons">
          <div className="reasons-title">
            Confidence {score}/100 ({CONFIDENCE_LABELS[level]})
          </div>
          <ul>
            {reasons.map((r, i) => {
              const m = /^([+-−]?\d+)\s+(.*)$/.exec(r);
              const delta = m ? Number(m[1]!.replace('−', '-')) : null;
              return (
                <li key={i}>
                  {m ? (
                    <>
                      <span className={`delta ${delta !== null && delta > 0 ? 'pos' : delta !== null && delta < 0 ? 'neg' : 'zero'}`}>{m[1]}</span>
                      <span>{m[2]}</span>
                    </>
                  ) : (
                    <span>{r}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    >
      {badge}
    </Tip>
  );
}

export function FlagChip({ flag }: { flag: string }) {
  const info = flagInfo(flag);
  return (
    <Tip content={info.help}>
      <span className={`chip-flag tone-${info.tone}`} tabIndex={0}>
        {info.label}
      </span>
    </Tip>
  );
}

export function FlagList({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <span className="flag-list">
      {flags.map((f) => (
        <FlagChip key={f} flag={f} />
      ))}
    </span>
  );
}

export function ItemTagChip({ tag }: { tag: ItemTag }) {
  return (
    <span className={`item-tag tag-${tag.kind}`} title={tag.title}>
      {tag.color ? <span className="swatch" style={{ background: tag.color }} aria-hidden="true" /> : null}
      {tag.label}
    </span>
  );
}

/**
 * The buyer's presence. 0.7.4 (F23, F63): with `seenAt` (the order's lastEventAt), a flag from an event
 * older than ORDER_CONFIRMED_MS (2 h) before `now` (default: the render time) shows as unknown, titled
 * with what it was and when: the flag is as old as that event and nothing refreshes it.
 */
export function OnlineDot({ online, seenAt, now }: { online: boolean | null; seenAt?: number | null; now?: number }) {
  const at = typeof now === 'number' ? now : Date.now();
  const stale = typeof seenAt === 'number' && !orderSeenRecently(seenAt, at);
  const shown = stale ? null : online;
  const ago = stale && Number.isFinite(seenAt) ? fmtAge(at - seenAt) : null;
  const label = ago
    ? `${online === true ? 'Online' : online === false ? 'Offline' : 'Online status unknown'} when last seen, ${ago} ago; not confirmed since`
    : shown === true
      ? 'Online'
      : shown === false
        ? 'Offline'
        : 'Online status unknown';
  return <span className={`online-dot ${shown === true ? 'on' : shown === false ? 'off' : 'unknown'}`} title={label} aria-label={label} role="img" />;
}

/**
 * 0.7.4 (F63): the revenue order nobody has confirmed for 24 h ('unverified'): a warn clock titled with its
 * age (with `label`, the age in words too), so a days-old exit does not read as a live bid. Nothing for
 * any other order.
 */
export function UnverifiedOrderMark({ order, now, label = false }: { order: Pick<OrderSummary, 'flags' | 'lastEventAt'> | null | undefined; now: number; label?: boolean }) {
  if (!order || !order.flags.includes('unverified')) return null;
  const ago = Number.isFinite(order.lastEventAt) ? fmtAge(now - order.lastEventAt) : null;
  const title = `${ago ? `Revenue order last seen ${ago} ago` : 'Revenue order not seen recently'}: it may have been filled or removed while the live feed was off. Use Refresh from backpack.tf in the item panel to confirm.`;
  return (
    <span className="tone-text-warn unverified-order" title={title} aria-label={label ? undefined : title} role={label ? undefined : 'img'}>
      <Icon name="clock" size={12} />
      {label ? ` order last seen ${ago ?? 'long'} ago, may be gone` : null}
    </span>
  );
}
