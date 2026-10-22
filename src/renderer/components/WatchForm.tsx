// The watch form (0.8, G1/G3): this copy or any copy, a price ("Tell me when it costs at most"), a profit ("or makes
// at least") and "Tell me when it is back on sale". Saving writes the user's own watch list ('watches.upsert'); a hit
// is told only on a scrap.tf page the user reads or saves. Nothing is fetched or bought (R1, R4), and nothing here
// opens or loads a page. Used by the drawer's "scrap.tf watch" section and the Watch dialog. Rules: watchesModel.ts.

import { useEffect, useId, useRef, useState } from 'react';
import type { Scrap, ScraptfWatch } from '../../shared/types';
import { rpc } from '../api';
import { errorMessage, fmtMoney } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { WATCH_BOUNDARY_NOTE, watchFormInit, watchFormInput, watchNotifyNote, type WatchFormState } from '../watchesModel';
import { Field, Segmented, Toggle } from './Controls';
import { Icon } from './Icon';
import { PriceInput, type BareUnit } from './PriceInput';

function sanitizeUnit(v: unknown): BareUnit {
  return v === 'scrap' || v === 'keys' ? v : 'ref';
}

/** The form's item, copy and the watches it may edit; it saves through 'watches.upsert' only. */
export interface WatchFormProps {
  sku: string;
  name: string;
  /** The copy 'This copy' watches (a bank_stock special key, the drawer's copyKey); null: the SKU's own. */
  special: string | null;
  keyScrap: Scrap | null;
  /** Pay up to now, shown as a hint under the price; null: not known. */
  ceiling: Scrap | null;
  /** The item's watches of this copy and of every copy (watchesForCopy). */
  existing: { one: ScraptfWatch | null; any: ScraptfWatch | null };
  onSaved(w: ScraptfWatch): void;
  onCancel?(): void;
  autoFocus?: boolean;
}

/** Adds or edits the watch of the chosen scope; the button says 'Save watch' when that scope has one. */
export function WatchForm({ sku, name, special, keyScrap, ceiling, existing, onSaved, onCancel, autoFocus = false }: WatchFormProps) {
  const { toast, settings } = useApp();
  const uid = useId();
  const [unit, setUnit] = usePersistentState<BareUnit>('price.unit', 'ref', sanitizeUnit);
  // Opens on this copy's watch, else on an any-copy watch the item has, else blank on this copy.
  const [form, setForm] = useState<WatchFormState>(() => {
    const copies = existing.one === null && existing.any !== null ? 'any' : 'one';
    return watchFormInit(existing[copies], copies, unit);
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A second Enter before the first save answers would write twice.
  const savingRef = useRef(false);
  const current = existing[form.copies];
  // The scope's watch changed (saved here, or elsewhere): the fields show it.
  const stamp = current ? `${current.id}:${current.updatedAt}` : null;
  const shown = useRef(stamp);
  useEffect(() => {
    if (shown.current === stamp) return;
    shown.current = stamp;
    if (current) setForm(watchFormInit(current, form.copies, unit));
    // Only a new stamp re-reads the watch; typing never does.
  }, [stamp]);

  const set = <K extends keyof WatchFormState>(k: K, v: WatchFormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  };
  // Switching scope shows that scope's watch when it has one, else keeps what was typed.
  const changeCopies = (copies: 'one' | 'any') => {
    const w = existing[copies];
    shown.current = w ? `${w.id}:${w.updatedAt}` : null;
    setForm((f) => (w ? watchFormInit(w, copies, unit) : { ...f, copies }));
    setError(null);
  };

  const submit = async () => {
    if (savingRef.current) return;
    const r = watchFormInput(form, { sku, special, name, unit, keyScrap, ...(current ? { id: current.id } : {}) });
    if ('error' in r) {
      setError(r.error);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await rpc('watches.upsert', r.input);
      toast(`Watching ${saved.name}`, 'good');
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const note = watchNotifyNote(settings);
  return (
    <form
      className="watch-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void submit();
      }}
    >
      <Field label="Watch">
        <Segmented
          ariaLabel="Which copies to watch"
          value={form.copies}
          onChange={changeCopies}
          options={[
            { value: 'one', label: 'This copy', title: 'Only this copy (a sheen or a killstreaker aside)' },
            { value: 'any', label: 'Any copy', title: 'Every copy of this item, whatever its paint or extras' },
          ]}
        />
      </Field>
      <Field label="Tell me when it costs at most" htmlFor={`${uid}-price`} hint={ceiling !== null ? `Pay up to now: ${fmtMoney(ceiling, keyScrap)}` : undefined}>
        <PriceInput id={`${uid}-price`} compact autoFocus={autoFocus} text={form.price} onText={(t) => set('price', t)} unit={unit} onUnit={setUnit} keyScrap={keyScrap} placeholder="e.g. 1.33 or 2 keys 5.11" />
      </Field>
      <Field label="or makes at least (ref)" htmlFor={`${uid}-profit`}>
        <input
          id={`${uid}-profit`}
          className="input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. 1.33"
          value={form.profit}
          onChange={(e) => set('profit', e.target.value)}
        />
      </Field>
      <Toggle checked={form.onRestock} onChange={(on) => set('onRestock', on)} label="Tell me when it is back on sale" />
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={saving}>
          <Icon name="eye" size={14} /> {saving ? 'Saving…' : current ? 'Save watch' : 'Watch'}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      <p className="muted small watch-note">{WATCH_BOUNDARY_NOTE}</p>
      {note ? <p className="small tone-text-warn watch-note">{note}</p> : null}
    </form>
  );
}
