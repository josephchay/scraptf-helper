import { useRef, useState } from 'react';
import { positionCostAt } from '../../shared/holdings';
import type { JournalEntry, JournalSide } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import { ConfirmButton, Field, Segmented } from '../components/Controls';
import { EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ItemName, Money } from '../components/ItemName';
import { ItemPicker, type ItemPickerHandle, type PickedItem } from '../components/ItemPicker';
import { PriceInput, readPrice, type BareUnit } from '../components/PriceInput';
import { errorMessage, fmtDateTime, fmtInt, fmtKeysMetal, fmtMoney, fromDateTimeLocal, toDateTimeLocal } from '../format';
import { useApp } from '../hooks/appContext';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useInterval } from '../hooks/useTimers';
import { FUTURE_SLACK_MS, undoneText } from '../recordTradeModel';

const VENUES = ['scrap.tf', 'backpack.tf', 'marketplace.tf', 'Steam Community Market', 'Direct trade'];

export function JournalPage() {
  const { keyScrap, toast, openItem, navigate } = useApp();
  const list = useRpcQuery('journal.list', { limit: 2000 });
  const summary = useRpcQuery('journal.summary', undefined);

  const after = () => {
    void list.reload();
    void summary.reload();
  };
  // Every journal write pushes 'journal.changed', this page's own (Log a trade, Delete) included, so
  // the push is the one refresh: calling after() as well would read the whole journal twice.
  const reload = useThrottled(after, 300);
  useVisiblePush('journal.changed', reload);

  const remove = async (e: JournalEntry) => {
    try {
      await rpc('journal.delete', { id: e.id });
    } catch (err) {
      toast(errorMessage(err), 'bad');
    }
  };

  const exportCsv = async () => {
    try {
      const r = await saveCsv(() => rpc('journal.exportCsv'));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (err) {
      toast(`Export failed: ${errorMessage(err)}`, 'bad');
    }
  };

  const s = summary.data;
  // Held lots at today's key price, as Holdings values them: the stored costScrap uses each buy's own
  // key price, and split at today's it read "1 key 58.00 ref" for a lot bought for 2 keys.
  const open = (s?.open ?? []).map((p) => ({ ...p, costNow: positionCostAt(p, keyScrap) })).sort((a, b) => b.costNow - a.costNow || a.sku.localeCompare(b.sku));
  const openCost = open.reduce((t, p) => t + p.costNow, 0);
  const openQty = open.reduce((t, p) => t + p.qty, 0);

  return (
    <div className="page journal-page">
      <div className="stat-row">
        <div className="stat card">
          <div className="stat-label">Realised profit (FIFO)</div>
          <div className="stat-value">{s ? <Money scrap={s.realizedProfitScrap} keyScrap={keyScrap} tone="profit" signed /> : '—'}</div>
        </div>
        <div className="stat card">
          <div className="stat-label">Completed flips</div>
          <div className="stat-value num">{s ? fmtInt(s.realizedTrades) : '—'}</div>
        </div>
        <div className="stat card">
          <div className="stat-label">Holding</div>
          <div className="stat-value">
            {s ? (
              <>
                <span className="num">{fmtInt(openQty)}</span> <span className="muted small">items, cost</span> <Money scrap={openCost} keyScrap={keyScrap} />
              </>
            ) : (
              '—'
            )}
          </div>
        </div>
        <div className="stat-actions">
          <button type="button" className="btn small" onClick={() => void exportCsv()}>
            <Icon name="download" size={14} /> Export CSV
          </button>
        </div>
      </div>

      <div className="split">
        <section className="card form-card" aria-labelledby="journal-form-title">
          <h2 id="journal-form-title">Log a trade</h2>
          <p className="muted small">A manual record of what you bought and sold. Sells are matched to the oldest buy of the same item.</p>
          <JournalForm />
        </section>

        <section className="card table-card" aria-labelledby="journal-list-title">
          <h2 id="journal-list-title">
            Trades <span className="count-badge">{list.data?.length ?? 0}</span>
          </h2>
          {list.error ? <ErrorBanner message={list.error} onRetry={() => void list.reload()} /> : null}
          {list.loading ? (
            <LoadingBlock />
          ) : list.error && !list.data ? null : !list.data?.length ? (
            <EmptyState icon="journal" title="No trades logged" compact>
              Log a buy when you buy on scrap.tf and a sell when a buyer takes it. Profit is worked out first-in, first-out.
            </EmptyState>
          ) : (
            <div className="table-wrap tall">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Side</th>
                    <th>Item</th>
                    <th>Venue</th>
                    <th className="num">Price</th>
                    <th className="actions-col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((e) => (
                    <tr key={e.id}>
                      <td className="date-cell small">{fmtDateTime(e.ts)}</td>
                      <td>
                        <span className={`pill tone-${e.side === 'buy' ? 'info' : 'good'}`}>{e.side === 'buy' ? 'Buy' : 'Sell'}</span>
                      </td>
                      <td>
                        <button type="button" className="row-link" onClick={() => openItem(e.sku)}>
                          <ItemName sku={e.sku} name={e.name} maxTags={2} />
                        </button>
                        {e.note ? <div className="muted small">{e.note}</div> : null}
                      </td>
                      <td>{e.venue}</td>
                      <td className="num">
                        <span className="money">{fmtKeysMetal(e.keys, e.scrap)}</span>
                        {e.keys ? <div className="muted small">key at {fmtMoney(e.keyPriceScrap, null)}</div> : null}
                      </td>
                      <td className="actions-col">
                        <ConfirmButton className="icon-btn" ariaLabel={`Delete trade ${e.id}`} title="Delete" confirmLabel="Delete?" onConfirm={() => void remove(e)}>
                          <Icon name="trash" size={14} />
                        </ConfirmButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {s && (s.bySku.length || s.open.length) ? (
        <div className="split even">
          <section className="card" aria-labelledby="by-item-title">
            <h2 id="by-item-title">Profit by item</h2>
            {s.bySku.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Flips</th>
                    <th className="num">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {[...s.bySku]
                    .sort((a, b) => b.realizedProfitScrap - a.realizedProfitScrap)
                    .map((r) => (
                      <tr key={r.sku}>
                        <td>
                          <ItemName sku={r.sku} name={r.name} maxTags={2} />
                        </td>
                        <td className="num">{r.trades}</td>
                        <td className="num">
                          <Money scrap={r.realizedProfitScrap} keyScrap={keyScrap} tone="profit" signed />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small">No completed flips yet.</p>
            )}
          </section>
          <section className="card" aria-labelledby="open-title">
            {/* The link sits beside the heading, not in it, so the section is named "Still holding" only. */}
            <div className="section-head">
              <h2 id="open-title">Still holding</h2>
              {s.open.length ? (
                <button type="button" className="link-btn small journal-holdings-link" onClick={() => navigate('holdings')} title="What each held item sells for now, and to whom">
                  Live prices on Holdings
                </button>
              ) : null}
            </div>
            {s.open.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((p) => (
                    <tr key={p.sku}>
                      <td>
                        <button type="button" className="row-link" onClick={() => openItem(p.sku)}>
                          <ItemName sku={p.sku} name={p.name} maxTags={2} />
                        </button>
                      </td>
                      <td className="num">{p.qty}</td>
                      <td className="num">
                        <Money scrap={p.costNow} keyScrap={keyScrap} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small">Nothing held.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function JournalForm() {
  const { keyScrap, toast } = useApp();
  const [side, setSide] = useState<JournalSide>('buy');
  const [venue, setVenue] = useState('scrap.tf');
  const [item, setItem] = useState<PickedItem | null>(null);
  const [text, setText] = useState('');
  const [unit, setUnit] = useState<BareUnit>('ref');
  // When follows the clock until the user edits it (null = untouched): the page can stay mounted for
  // hours, and a trade logged with When untouched is dated when it is logged, not when the page opened.
  // The clock holds still while the field has focus, so a segment being typed is not reset under the user.
  const [whenEdited, setWhenEdited] = useState<string | null>(null);
  const [whenFocused, setWhenFocused] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  useInterval(() => setClock(Date.now()), 30_000, whenEdited === null && !whenFocused);
  const when = whenEdited ?? toDateTimeLocal(clock);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const picker = useRef<ItemPickerHandle>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setError(null);
    const it = item ?? (await picker.current?.resolvePending()) ?? null;
    if (!it) {
      setError('Pick an item.');
      return;
    }
    const parsed = readPrice(text, unit);
    if (!parsed) {
      setError('Enter the price, for example 1.33 or 2 keys 5.11.');
      return;
    }
    if (!venue.trim()) {
      setError('Enter where the trade happened.');
      return;
    }
    const now = Date.now();
    // Untouched (or cleared) is the moment of logging, to the millisecond; a typed When is a backfill.
    const ts = (whenEdited === null ? null : fromDateTimeLocal(whenEdited)) ?? now;
    // As the Record trade dialog: further ahead is a typo (a year like 2062), and a scrap.tf buy dated
    // then would mute the item's Profit toasts until that date.
    if (ts > now + FUTURE_SLACK_MS) {
      setError('That date is in the future.');
      return;
    }
    setSaving(true);
    try {
      const e = await rpc('journal.add', {
        side,
        venue: venue.trim(),
        sku: it.sku,
        name: it.name,
        keys: parsed.keys,
        scrap: parsed.scrap,
        ts,
        note: note.trim() || null,
      });
      // Undo deletes the row again; the 'journal.changed' push refreshes this page and Holdings.
      const undo = () => {
        rpc('journal.delete', { id: e.id })
          .then(() => toast(undoneText(e), 'info'))
          .catch((err: unknown) => toast(`Could not undo: ${errorMessage(err)}`, 'bad'));
      };
      toast(`Logged ${e.side} of ${e.name}`, 'good', { action: { label: 'Undo', onClick: undo } });
      setItem(null);
      setText('');
      setNote('');
      setWhenEdited(null);
      setClock(Date.now());
      picker.current?.focus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="form-grid journal-form"
      // The future-date check is submit's own (with its slack and role=alert), not the browser's bubble on max.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Side">
        <Segmented
          ariaLabel="Buy or sell"
          value={side}
          onChange={(v) => {
            setSide(v);
            if (v === 'sell' && venue === 'scrap.tf') setVenue('backpack.tf');
            if (v === 'buy' && venue === 'backpack.tf') setVenue('scrap.tf');
          }}
          options={[
            { value: 'buy', label: 'Bought' },
            { value: 'sell', label: 'Sold' },
          ]}
        />
      </Field>
      <Field label="Item" htmlFor="jf-item">
        <ItemPicker ref={picker} id="jf-item" value={item} onChange={setItem} onEnterPicked={() => priceRef.current?.focus()} />
      </Field>
      <Field label="Price" htmlFor="jf-price">
        <PriceInput ref={priceRef} id="jf-price" text={text} onText={setText} unit={unit} onUnit={setUnit} keyScrap={keyScrap} />
      </Field>
      <Field label="Venue" htmlFor="jf-venue">
          <input id="jf-venue" className="input" list="jf-venues" value={venue} maxLength={60} onChange={(e) => setVenue(e.target.value)} />
          <datalist id="jf-venues">
            {VENUES.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>
        <Field label="When" htmlFor="jf-when">
          <input
            id="jf-when"
            className="input"
            type="datetime-local"
            value={when}
            max={toDateTimeLocal(Date.now())}
            onChange={(e) => setWhenEdited(e.target.value)}
            onFocus={() => setWhenFocused(true)}
            onBlur={() => {
              setWhenFocused(false);
              setClock(Date.now());
            }}
          />
        </Field>
      <Field label="Note (optional)" htmlFor="jf-note">
        <input id="jf-note" className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={saving}>
          <Icon name="plus" size={14} /> Log {side === 'buy' ? 'buy' : 'sell'}
        </button>
        <span className="muted small">Keys are valued at today&apos;s key price for FIFO.</span>
      </div>
    </form>
  );
}
