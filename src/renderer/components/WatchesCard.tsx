// "Your scrap.tf watches" on the Banks page (0.8, G1/G3): every watch (paused ones too) with its copy, targets and
// where it stands in the user's newest saves, a Paused tag, Pause/Resume and Remove (with Undo); the name opens the
// item's drawer on the watched copy. One local 'watches.list' read, refetched on 'watches.changed' and
// 'scraptf.banksChanged' (throttled, only while the window is shown). Nothing is fetched, opened or bought (R1, R4).
// Rules: watchesModel.ts and src/shared/watches.ts. Styles: styles/banks.css.

import type { Scrap, ScraptfWatchView } from '../../shared/types';
import { watchTargetsText } from '../../shared/watches';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { WATCHES_EMPTY, watchActionLabels, watchCopyText, watchesCountText, watchNowView } from '../watchesModel';
import { useWatchActions } from './WatchSection';

/** The Banks page's watch list: every watch, paused ones too; `onItem` opens the item on the watched copy (null: its own). */
export function WatchesCard({ keyScrap, now, onItem }: { keyScrap: Scrap | null; now: number; onItem(sku: string, copy: string | null): void }) {
  const q = useRpcQuery('watches.list', undefined);
  const reload = useThrottled(() => void q.reload(), 1000);
  useVisiblePush('watches.changed', reload);
  useVisiblePush('scraptf.banksChanged', reload);
  const actions = useWatchActions(reload);
  const list: readonly ScraptfWatchView[] = q.data ?? [];

  return (
    <section className="card watches-card" aria-labelledby="watches-head">
      <header className="watches-card-head">
        <h2 id="watches-head">Your scrap.tf watches</h2>
        {q.data ? <span className="muted small watches-count">{watchesCountText(list.length)}</span> : null}
      </header>
      {q.error && !q.data ? <p className="small tone-text-bad">Could not read your watches: {q.error}</p> : null}
      {q.data && list.length === 0 ? (
        <div className="watches-empty">
          <p className="watches-empty-title">{WATCHES_EMPTY.title}</p>
          <p className="muted small">{WATCHES_EMPTY.body}</p>
        </div>
      ) : null}
      {list.length ? (
        <ul className="plain-list watch-rows" aria-label="Your scrap.tf watches">
          {list.map((w) => {
            const at = watchNowView(w, keyScrap, now);
            const targets = watchTargetsText(w, keyScrap);
            const labels = watchActionLabels(w);
            return (
              <li key={w.id} className={`watch-row${w.enabled ? '' : ' paused'}`}>
                <button type="button" className="link-btn watch-name" title="Open its details" onClick={() => onItem(w.sku, w.specialKey === '' ? null : w.specialKey)}>
                  {w.name}
                </button>
                <span className="watch-row-text small">
                  <span className="watch-copy">{watchCopyText(w)}</span>
                  {targets ? <span className="watch-targets"> · {targets}</span> : null}
                  {' · '}
                  <span className={`watch-now tone-text-${at.tone}`} title={at.title}>
                    {at.text}
                  </span>
                </span>
                {w.enabled ? null : <span className="pill tone-muted watch-paused">Paused</span>}
                <span className="watch-row-actions">
                  <button type="button" className="btn small ghost" aria-label={labels.toggle} onClick={() => actions.toggle(w)}>
                    {w.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button type="button" className="btn small ghost" aria-label={labels.remove} onClick={() => actions.remove(w)}>
                    Remove
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
