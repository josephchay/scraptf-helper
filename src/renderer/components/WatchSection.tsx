// "scrap.tf watch" in the item drawer (0.8, G1/G3): the item's watches (this copy, any copy) with their targets and
// where each stands in the user's newest saves, Pause/Resume and Remove (with Undo), then the watch form. One local
// 'watches.list' read for the item, refetched on 'watches.changed' and 'scraptf.banksChanged' (throttled, only while
// the window is shown). A watch is checked only on the scrap.tf pages the user reads or saves; nothing is fetched,
// opened or bought (R1, R4). Rules: watchesModel.ts and src/shared/watches.ts. Styles: styles/drawer-extra.css.

import { useMemo, useRef } from 'react';
import type { ItemDetail, Scrap, ScraptfWatch, ScraptfWatchView } from '../../shared/types';
import { watchTargetsText } from '../../shared/watches';
import { rpc } from '../api';
import { errorMessage } from '../format';
import { useApp } from '../hooks/appContext';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { watchActionLabels, watchCopyText, watchesForCopy, watchNowView, watchRemovedText, watchUndoInput } from '../watchesModel';
import { WatchForm } from './WatchForm';

/** Pause/Resume and Remove (with Undo) of one watch; shared by the drawer section and the Banks page's list. */
export function useWatchActions(reload: () => void): { toggle(w: ScraptfWatch): void; remove(w: ScraptfWatch): void } {
  const { toast } = useApp();
  // One write per watch at a time: a double click would pause and resume at once.
  const busy = useRef(new Set<number>());
  return useMemo(
    () => ({
      toggle: (w: ScraptfWatch) => {
        if (busy.current.has(w.id)) return;
        busy.current.add(w.id);
        rpc('watches.upsert', { id: w.id, sku: w.sku, enabled: !w.enabled })
          .then((saved) => toast(saved.enabled ? `Watching ${saved.name} again` : `Paused watching ${saved.name}`, 'info'))
          .catch((e: unknown) => toast(`Could not change the watch: ${errorMessage(e)}`, 'bad'))
          .finally(() => {
            busy.current.delete(w.id);
            reload();
          });
      },
      remove: (w: ScraptfWatch) => {
        if (busy.current.has(w.id)) return;
        busy.current.add(w.id);
        rpc('watches.delete', { id: w.id })
          .then(() => {
            // The same watch back (its id and times), so a same-price read does not tell it again.
            const undo = () => {
              rpc('watches.restore', watchUndoInput(w))
                .then((back) => toast(`Watching ${back.name} again`, 'info'))
                .catch((e: unknown) => toast(`Could not undo: ${errorMessage(e)}`, 'bad'))
                .finally(reload);
            };
            toast(watchRemovedText(w), 'good', { action: { label: 'Undo', onClick: undo } });
          })
          .catch((e: unknown) => toast(`Could not remove the watch: ${errorMessage(e)}`, 'bad'))
          .finally(() => {
            busy.current.delete(w.id);
            reload();
          });
      },
    }),
    [toast, reload],
  );
}

/** The drawer's section. `copyKey`: the copy the drawer was opened on (its bank_stock special key), else null. */
export function WatchSection({ d, copyKey, keyScrap, now, ceiling }: { d: ItemDetail; copyKey: string | null; keyScrap: Scrap | null; now: number; ceiling: Scrap | null }) {
  const q = useRpcQuery('watches.list', { sku: d.sku });
  const reload = useThrottled(() => void q.reload(), 1000);
  useVisiblePush('watches.changed', reload);
  useVisiblePush('scraptf.banksChanged', reload);
  const actions = useWatchActions(reload);
  const list: readonly ScraptfWatchView[] = q.data ?? [];
  const existing = useMemo(() => watchesForCopy(list, d.sku, copyKey), [list, d.sku, copyKey]);

  return (
    <section className="drawer-section watch-section" aria-labelledby="sec-watch">
      <h3 id="sec-watch">scrap.tf watch</h3>
      {q.error && !q.data ? <p className="small tone-text-bad">Could not read your watches: {q.error}</p> : null}
      {list.length ? (
        <ul className="plain-list watch-lines" aria-label="Your watches of this item">
          {list.map((w) => {
            const at = watchNowView(w, keyScrap, now);
            const targets = watchTargetsText(w, keyScrap);
            const labels = watchActionLabels(w);
            return (
              <li key={w.id} className={`watch-line${w.enabled ? '' : ' paused'}`}>
                <span className="watch-line-text small">
                  <span className="watch-copy">{watchCopyText(w)}</span>
                  {targets ? <span className="watch-targets"> · {targets}</span> : null}
                  {' · '}
                  <span className={`watch-now tone-text-${at.tone}`} title={at.title}>
                    {at.text}
                  </span>
                  {w.enabled ? null : <span className="pill tone-muted watch-paused">Paused</span>}
                </span>
                <span className="watch-line-actions">
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
      {/* Once the list is read, so the form opens on the scope a watch already has (an edit, not a second add). */}
      {q.data !== undefined || q.error ? (
        <WatchForm sku={d.sku} name={d.name} special={copyKey} keyScrap={keyScrap} ceiling={ceiling} existing={existing} onSaved={() => reload()} />
      ) : (
        <p className="muted small">Reading your watches…</p>
      )}
    </section>
  );
}
