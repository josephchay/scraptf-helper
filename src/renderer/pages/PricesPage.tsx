import { useMemo, useRef, useState } from 'react';
import type { ScrapPrice } from '../../shared/types';
import { rpc } from '../api';
import { ConfirmButton, Field, Tabs } from '../components/Controls';
import { EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ItemName } from '../components/ItemName';
import { ItemPicker, type ItemPickerHandle, type PickedItem } from '../components/ItemPicker';
import { PriceInput, readPrice, type BareUnit } from '../components/PriceInput';
import { errorMessage, fmtAge, fmtDateTime, fmtKeysMetal, fmtMoney } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { usePush, useRpcQuery, useThrottled } from '../hooks/useRpc';
import { useDebounced, useNow } from '../hooks/useTimers';
import { RulesPanel } from './RulesPanel';

function sanitizeUnit(v: unknown): BareUnit {
  return v === 'scrap' || v === 'keys' ? v : 'ref';
}

export function PricesPage() {
  const { segments, navigate } = useApp();
  const tab = segments[1] === 'rules' ? 'rules' : 'prices';
  return (
    <div className="page prices-page">
      <Tabs
        ariaLabel="Price sheet"
        value={tab}
        tabs={[
          { value: 'prices', label: 'Prices' },
          { value: 'rules', label: 'Rules' },
        ]}
        onChange={(t) => navigate(t === 'rules' ? 'prices/rules' : 'prices')}
      />
      {tab === 'prices' ? <PriceSheet /> : <RulesPanel />}
    </div>
  );
}

type SortCol = 'name' | 'price' | 'age';

function PriceSheet() {
  const { keyScrap, settings, openItem, toast, bumpData } = useApp();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const list = useRpcQuery('prices.list', dq.trim() ? { q: dq.trim() } : {});
  // Saves from the quick-entry window and imports change the sheet behind this page.
  const reloadSoon = useThrottled(() => void list.reload(), 1000);
  usePush('prices.changed', reloadSoon);
  const [editing, setEditing] = useState<ScrapPrice | null>(null);
  const [sort, setSort] = useState<{ col: SortCol; asc: boolean }>({ col: 'age', asc: true });
  const now = useNow(10_000);
  const staleMs = settings?.profit.inputStaleMs ?? 2 * 3_600_000;

  const rows = useMemo(() => {
    const k = keyScrap ?? 0;
    const value = (p: ScrapPrice) => Math.round(p.costKeys * k) + p.costScrap;
    const arr = [...(list.data ?? [])];
    arr.sort((a, b) => {
      const d = sort.col === 'name' ? a.name.localeCompare(b.name) : sort.col === 'price' ? value(a) - value(b) : b.observedAt - a.observedAt;
      return sort.asc ? d : -d;
    });
    return arr;
  }, [list.data, sort, keyScrap]);

  const after = () => {
    void list.reload();
    bumpData();
  };

  const reconfirm = async (p: ScrapPrice) => {
    try {
      await rpc('prices.upsert', { id: p.id, sku: p.sku, name: p.name, costKeys: p.costKeys, costScrap: p.costScrap, source: p.source, observedAt: Date.now() });
      toast(`Marked ${p.name} as seen now`, 'good');
      after();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const remove = async (p: ScrapPrice) => {
    try {
      await rpc('prices.delete', { id: p.id });
      toast(`Deleted ${p.name}`, 'info');
      if (editing?.id === p.id) setEditing(null);
      after();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const header = (col: SortCol, label: string, cls?: string) => (
    <th className={cls} aria-sort={sort.col === col ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`sort-btn${sort.col === col ? ' active' : ''}`} onClick={() => setSort((s) => (s.col === col ? { col, asc: !s.asc } : { col, asc: true }))}>
        {label}
        {sort.col === col ? <Icon name={sort.asc ? 'arrowUp' : 'arrowDown'} size={12} /> : null}
      </button>
    </th>
  );

  return (
    <div className="stack">
      <section className="card form-card" aria-labelledby="price-form-title">
        <h2 id="price-form-title">{editing ? `Edit price #${editing.id}` : 'Add a scrap.tf price'}</h2>
        <p className="muted small">Type what you see on scrap.tf. The app never visits scrap.tf itself.</p>
        <PriceForm
          key={editing?.id ?? 'new'}
          editing={editing}
          onSaved={(p) => {
            toast(`${editing ? 'Updated' : 'Added'} ${p.name} at ${fmtKeysMetal(p.costKeys, p.costScrap)}`, 'good');
            setEditing(null);
            after();
          }}
          onCancel={editing ? () => setEditing(null) : undefined}
        />
      </section>

      <section className="card table-card" aria-labelledby="price-list-title">
        <div className="section-head">
          <h2 id="price-list-title">
            Your prices <span className="count-badge">{list.data?.length ?? 0}</span>
          </h2>
          <div className="search-box small">
            <Icon name="search" size={14} />
            <input type="search" className="input" placeholder="Filter" aria-label="Filter prices" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {list.error ? <ErrorBanner message={list.error} onRetry={() => void list.reload()} /> : null}
        {list.loading ? (
          <LoadingBlock />
        ) : rows.length === 0 ? (
          <EmptyState icon="tag" title={q ? 'No prices match' : 'No prices yet'} compact>
            {q ? 'Try a different filter.' : 'Add the first price with the form, the quick-entry window, or a price-sheet rule.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {header('name', 'Item')}
                  {header('price', 'Price', 'num')}
                  <th>Source</th>
                  {header('age', 'Seen', 'num')}
                  <th>Note</th>
                  <th className="actions-col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const age = now - p.observedAt;
                  const stale = age > staleMs;
                  return (
                    <tr key={p.id} className={editing?.id === p.id ? 'selected' : undefined}>
                      <td>
                        <div className="cell-clip">
                          <button type="button" className="row-link" onClick={() => openItem(p.sku)} title="Open item">
                            <ItemName sku={p.sku} name={p.name} maxTags={3} />
                          </button>
                          <div className="muted small ellipsis">
                            <code>{p.sku}</code>
                          </div>
                        </div>
                      </td>
                      <td className="num">
                        <span className="money">{fmtKeysMetal(p.costKeys, p.costScrap)}</span>
                        {p.costKeys && keyScrap ? <div className="muted small">{fmtMoney(Math.round(p.costKeys * keyScrap) + p.costScrap, null)}</div> : null}
                      </td>
                      <td>
                        {p.source === 'import' ? (
                          <span title={p.importBatch ? `Import batch ${p.importBatch}` : undefined}>
                            Imported{p.importBatch ? ` #${p.importBatch}` : ''}
                            {p.stock !== null ? <span className="muted small"> · stock {p.stock}</span> : null}
                          </span>
                        ) : (
                          'Typed'
                        )}
                      </td>
                      <td className={`num${stale ? ' tone-text-warn' : ''}`} title={`${fmtDateTime(p.observedAt)}${stale ? ' (stale: check scrap.tf again)' : ''}`}>
                        {stale ? <Icon name="clock" size={12} /> : null} {fmtAge(age)}
                      </td>
                      <td>
                        <div className="note-clip" title={p.note ?? undefined}>
                          {p.note ?? <span className="muted">—</span>}
                        </div>
                      </td>
                      <td className="actions-col">
                        <div className="row-actions">
                          <button type="button" className="icon-btn" title="Still this price (mark as seen now)" aria-label={`Mark ${p.name} as seen now`} onClick={() => void reconfirm(p)}>
                            <Icon name="check" size={14} />
                          </button>
                          <button type="button" className="icon-btn" title="Edit" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                            <Icon name="edit" size={14} />
                          </button>
                          <ConfirmButton className="icon-btn" ariaLabel={`Delete ${p.name}`} title="Delete" confirmLabel="Delete?" onConfirm={() => void remove(p)}>
                            <Icon name="trash" size={14} />
                          </ConfirmButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function PriceForm({
  editing,
  onSaved,
  onCancel,
}: {
  editing: ScrapPrice | null;
  onSaved: (p: ScrapPrice) => void;
  onCancel?: () => void;
}) {
  const { keyScrap } = useApp();
  const [item, setItem] = useState<PickedItem | null>(editing ? { sku: editing.sku, name: editing.name, category: 'other', match: 'exact' } : null);
  const [text, setText] = useState(editing ? fmtKeysMetal(editing.costKeys, editing.costScrap) : '');
  const [unit, setUnit] = usePersistentState<BareUnit>('price.unit', 'ref', sanitizeUnit);
  const [note, setNote] = useState(editing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const picker = useRef<ItemPickerHandle>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setError(null);
    const it = item ?? (await picker.current?.resolvePending()) ?? null;
    if (!it) {
      setError('Pick an item first.');
      picker.current?.focus();
      return;
    }
    const parsed = readPrice(text, unit);
    if (!parsed) {
      setError('Enter a price, for example 1.33 or 2 keys 5.11.');
      priceRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const saved = await rpc('prices.upsert', {
        ...(editing ? { id: editing.id } : {}),
        sku: it.sku,
        name: it.name,
        costKeys: parsed.keys,
        costScrap: parsed.scrap,
        source: editing?.source ?? 'user',
        observedAt: Date.now(),
        note: note.trim() || null,
      });
      onSaved(saved);
      if (!editing) {
        setItem(null);
        setText('');
        setNote('');
        picker.current?.focus();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="form-grid price-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Item" htmlFor="pf-item">
        <ItemPicker ref={picker} id="pf-item" value={item} onChange={setItem} onEnterPicked={() => priceRef.current?.focus()} />
      </Field>
      <Field label="scrap.tf price" htmlFor="pf-price">
        <PriceInput ref={priceRef} id="pf-price" text={text} onText={setText} unit={unit} onUnit={setUnit} keyScrap={keyScrap} />
      </Field>
      <Field label="Note (optional)" htmlFor="pf-note">
        <input id="pf-note" className="input" type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2 in stock" />
      </Field>
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={saving}>
          <Icon name={editing ? 'check' : 'plus'} size={14} /> {editing ? 'Save changes' : 'Add price'}
        </button>
        {onCancel ? (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <span className="muted small">Saved as seen now.</span>
      </div>
    </form>
  );
}
