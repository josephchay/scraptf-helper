import type { ReactNode } from 'react';
import type { ConfidenceLevel, ConnState } from '../../shared/types';
import { CONFIDENCE_LABELS, CONN_STATE_LABELS, connTone, flagInfo, type ItemTag, type Tone } from '../format';
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

export function OnlineDot({ online }: { online: boolean | null }) {
  const label = online === true ? 'Online' : online === false ? 'Offline' : 'Online status unknown';
  return <span className={`online-dot ${online === true ? 'on' : online === false ? 'off' : 'unknown'}`} title={label} aria-label={label} role="img" />;
}
