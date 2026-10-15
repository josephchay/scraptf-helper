// Recording a trade in one click (F12): a modal that writes one journal row
// ('journal.add') with a live comparison (a buy against the item's Pay up to, a
// sale against the next FIFO lot), then offers Undo in the confirmation toast
// ('journal.delete'). It only writes the user's own journal; nothing is bought,
// sold or offered (R4), and both lookups are local ('item.detail' without
// history, 'holdings.list').

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import type { HoldingRow, ItemDetail, JournalSide, OrderSummary, ProfitSettings, Scrap } from '../../shared/types';
import { rpc } from '../api';
import { errorMessage, fmtDateTime, fmtInt, fmtMoney, toDateTimeLocal } from '../format';
import { useApp, type ToastOptions, type ToastTone } from '../hooks/appContext';
import { inToastStack, modalHostOf } from '../itemMenuModel';
import {
  MAX_NOTE_CHARS,
  MAX_VENUE_CHARS,
  VENUE_SUGGESTIONS,
  afterDialogClose,
  buyComparison,
  checkTrade,
  compareTextClass,
  detailParams,
  dialogTitle,
  holdingFor,
  initialTradeForm,
  recordedText,
  sellComparison,
  tabbablesWithin,
  typedPrice,
  undoneText,
  venueForSide,
  type CompareTone,
  type RecordTradeInit,
  type TradeField,
  type TradeForm,
} from '../recordTradeModel';
import { trapFocusTarget } from './Drawer';
import { Field, Segmented } from './Controls';
import { Icon } from './Icon';
import { ItemName } from './ItemName';
import { OnlineDot } from './Pills';
import { PriceInput } from './PriceInput';

export type { RecordTradeInit } from '../recordTradeModel';

interface OpenState {
  seq: number;
  init: RecordTradeInit;
  /** Focus goes back here when the dialog closes. */
  opener: Element | null;
}

/** Render `element` once in the page; call open() from any entry point (row action, item menu, drawer). */
export function useRecordTrade(): { open(init: RecordTradeInit): void; element: ReactNode } {
  const [state, setState] = useState<OpenState | null>(null);
  const seq = useRef(0);
  const open = useCallback((init: RecordTradeInit) => {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    setState({ seq: ++seq.current, init, opener: active && active !== document.body ? active : null });
  }, []);
  // By seq: a save that lands after its dialog was dismissed (Esc while saving) must not close a newer one.
  const close = useCallback((which: number) => setState((s) => afterDialogClose(s, which)), []);
  const element = state ? <RecordTradeDialog key={state.seq} init={state.init} opener={state.opener} onClose={() => close(state.seq)} /> : null;
  // Stable while closed, so callers can list the hook's result as a dependency.
  return useMemo(() => ({ open, element }), [open, element]);
}

/** The dialog with the app's key price, thresholds and toasts. */
export function RecordTradeDialog({ init, opener = null, onClose }: { init: RecordTradeInit; opener?: Element | null; onClose: () => void }) {
  const { keyScrap, settings, toast } = useApp();
  return <RecordTradeForm init={init} opener={opener} onClose={onClose} keyScrap={keyScrap} profit={settings?.profit ?? null} toast={toast} />;
}

type Lookup<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

const stop = (e: SyntheticEvent) => e.stopPropagation();

export interface RecordTradeFormProps {
  init: RecordTradeInit;
  opener?: Element | null;
  onClose: () => void;
  keyScrap: Scrap | null;
  /** settings.profit; null until settings load (the comparison waits for it). */
  profit: ProfitSettings | null;
  toast: (text: string, tone?: ToastTone, opts?: ToastOptions) => number;
  /** For tests; the dialog reads the clock itself otherwise. */
  now?: () => number;
}

/** The modal itself (exported for tests): fields, live comparison, save with Undo, focus trap and Esc. */
export function RecordTradeForm({ init, opener = null, onClose, keyScrap, profit, toast, now = Date.now }: RecordTradeFormProps) {
  const uid = useId();
  const ids = { title: `${uid}-title`, venue: `${uid}-venue`, venues: `${uid}-venues`, price: `${uid}-price`, when: `${uid}-when`, note: `${uid}-note`, compare: `${uid}-compare` };
  const [form, setForm] = useState<TradeForm>(() => initialTradeForm(init, now()));
  const [error, setError] = useState<{ field: TradeField | 'save'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<Lookup<ItemDetail | null> | null>(null);
  const [held, setHeld] = useState<Lookup<HoldingRow | null> | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  // Inside the item drawer (aria-modal) the dialog must stay in it, or assistive tech treats it as inert.
  const [host] = useState<Element | null>(() => modalHostOf(opener) ?? (typeof document !== 'undefined' ? document.body : null));
  const alive = useRef(true);
  const inFlight = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const set = <K extends keyof TradeForm>(k: K, v: TradeForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (error && (error.field === 'save' || (k === 'text' ? 'price' : k) === error.field)) setError(null);
  };

  // Each lookup runs once, the first time its side is shown; both are local reads.
  const side = form.side;
  useEffect(() => {
    if (side !== 'buy' || detail !== null) return;
    setDetail({ status: 'loading' });
    rpc('item.detail', detailParams(init.sku))
      .then((d) => alive.current && setDetail({ status: 'ready', value: d }))
      .catch((e: unknown) => alive.current && setDetail({ status: 'error', message: errorMessage(e) }));
  }, [side, detail, init.sku]);
  useEffect(() => {
    if (side !== 'sell' || held !== null) return;
    setHeld({ status: 'loading' });
    rpc('holdings.list', { search: init.sku.trim().slice(0, 200) })
      .then((r) => alive.current && setHeld({ status: 'ready', value: holdingFor(r.rows, init.sku) }))
      .catch((e: unknown) => alive.current && setHeld({ status: 'error', message: errorMessage(e) }));
  }, [side, held, init.sku]);

  // Focus the price (selected, so typing replaces a prefill and Enter saves it); give focus back on close.
  useEffect(() => {
    alive.current = true;
    const el = priceRef.current ?? panel.current;
    el?.focus({ preventScroll: true });
    if (el && 'select' in el && typeof el.select === 'function') el.select();
    return () => {
      alive.current = false;
      const back = opener as HTMLElement | null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [opener]);

  const save = async () => {
    // A ref, not the state: two quick Ctrl+Enter presses land before a re-render.
    if (inFlight.current) return;
    const check = checkTrade(form, { sku: init.sku, name: init.name }, now());
    if (!check.ok) {
      setError({ field: check.field, text: check.error });
      if (check.field === 'price') priceRef.current?.focus();
      else document.getElementById(check.field === 'venue' ? ids.venue : ids.when)?.focus();
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const e = await rpc('journal.add', check.input);
      const undo = () => {
        rpc('journal.delete', { id: e.id })
          .then(() => toast(undoneText(e), 'info'))
          .catch((err: unknown) => toast(`Could not undo: ${errorMessage(err)}`, 'bad'));
      };
      toast(recordedText(e), 'good', { action: { label: 'Undo', onClick: undo } });
      onCloseRef.current();
    } catch (err) {
      inFlight.current = false;
      if (!alive.current) return;
      setError({ field: 'save', text: `Not saved: ${errorMessage(err)}` });
      setSaving(false);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;

  // Focus can leave the dialog while it is open: a toast's Undo or Dismiss (the stack sits above it)
  // takes it, and the toast then goes away, dropping it to <body>. The keys above only reach the
  // dialog's own tree, so without this Esc would close the drawer behind it instead (discarding the
  // trade), Ctrl+Enter would not save and Tab would walk the page behind the backdrop.
  useEffect(() => {
    const live = (): HTMLDivElement | null => {
      const el = panel.current;
      return el && document.contains(el) ? el : null;
    };
    const onFocusIn = (e: Event) => {
      const el = live();
      const t = e.target as Node | null;
      if (!el || !t || el.contains(t) || inToastStack(t)) return;
      (priceRef.current ?? el).focus({ preventScroll: true });
    };
    // Capture on the document runs before the drawer's window listener. Only while focus is outside
    // the dialog (on <body> or a toast): inside it, its own onKeyDown and the fields get every key.
    const onKey = (e: Event) => {
      const el = live();
      const active = document.activeElement;
      if (!el || (active && el.contains(active))) return;
      const k = e as globalThis.KeyboardEvent;
      const handled = k.key === 'Escape' || k.key === 'Tab' || (k.key === 'Enter' && (k.ctrlKey || k.metaKey));
      if (!handled) return;
      k.preventDefault();
      k.stopImmediatePropagation();
      if (k.key === 'Escape') onCloseRef.current();
      else if (k.key === 'Enter') void saveRef.current();
      else {
        const items = tabbablesWithin<HTMLElement>(el);
        (items.length ? (k.shiftKey ? items[items.length - 1]! : items[0]!) : el).focus();
      }
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The page's shortcuts and the drawer's own Esc and Tab handling must not see keys meant for the dialog.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === 'Tab' && panel.current) {
      const items = tabbablesWithin<HTMLElement>(panel.current);
      const focused = document.activeElement as HTMLElement | null;
      const active = focused && items.includes(focused) ? focused : null;
      const target = trapFocusTarget(items, active, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      } else if (!items.length) {
        e.preventDefault();
      }
    }
  };

  const changeSide = (s: JournalSide) => {
    setForm((f) => ({ ...f, side: s, venue: venueForSide(f.venue, s) }));
    setError(null);
  };

  if (!host) return null;
  const title = dialogTitle(form.side);
  // A portal still bubbles React events up the component tree: a row or form around the
  // opener (the drawer's price form, a table row) must not see the dialog's clicks or submit.
  return createPortal(
    <div className="rt-root" onKeyDown={onKeyDown} onClick={stop} onDoubleClick={stop} onMouseDown={stop} onPointerDown={stop} onContextMenu={stop}>
      <div className="rt-backdrop" aria-hidden="true" onClick={() => onCloseRef.current()} />
      <div ref={panel} className="rt-dialog" role="dialog" aria-modal="true" aria-labelledby={ids.title} aria-describedby={ids.compare} tabIndex={-1}>
        <form
          className="rt-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void save();
          }}
        >
          <header className="rt-head">
            <div className="rt-title-wrap">
              <h2 id={ids.title} className="rt-title">
                {title}
              </h2>
              <div className="rt-item">
                <ItemName sku={init.sku} name={init.name} maxTags={3} />
              </div>
            </div>
            <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={() => onCloseRef.current()}>
              <Icon name="close" size={16} />
            </button>
          </header>

          <div className="rt-body">
            <div className="rt-row">
              <Field label="Side">
                <Segmented
                  ariaLabel="Bought or sold"
                  value={form.side}
                  onChange={changeSide}
                  options={[
                    { value: 'buy', label: 'Bought' },
                    { value: 'sell', label: 'Sold' },
                  ]}
                />
              </Field>
              <Field label="Venue" htmlFor={ids.venue} error={error?.field === 'venue' ? error.text : null}>
                <input
                  id={ids.venue}
                  className={`input${error?.field === 'venue' ? ' invalid' : ''}`}
                  list={ids.venues}
                  value={form.venue}
                  maxLength={MAX_VENUE_CHARS}
                  autoComplete="off"
                  aria-invalid={error?.field === 'venue' ? true : undefined}
                  onChange={(e) => set('venue', e.target.value)}
                />
                <datalist id={ids.venues}>
                  {VENUE_SUGGESTIONS.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </Field>
            </div>

            <Field label={form.side === 'buy' ? 'Price you paid' : 'Price you sold for'} htmlFor={ids.price} error={error?.field === 'price' ? error.text : null}>
              <PriceInput ref={priceRef} id={ids.price} text={form.text} onText={(t) => set('text', t)} unit={form.unit} onUnit={(u) => set('unit', u)} keyScrap={keyScrap} />
            </Field>

            <Comparison form={form} keyScrap={keyScrap} profit={profit} detail={detail} held={held} now={now()} id={ids.compare} />

            <div className="rt-row">
              <Field label="When" htmlFor={ids.when} error={error?.field === 'when' ? error.text : null}>
                <input
                  id={ids.when}
                  className={`input${error?.field === 'when' ? ' invalid' : ''}`}
                  type="datetime-local"
                  value={form.when}
                  max={toDateTimeLocal(now())}
                  aria-invalid={error?.field === 'when' ? true : undefined}
                  onChange={(e) => set('when', e.target.value)}
                />
              </Field>
              <Field label="Note (optional)" htmlFor={ids.note}>
                <input id={ids.note} className="input" value={form.note} maxLength={MAX_NOTE_CHARS} autoComplete="off" onChange={(e) => set('note', e.target.value)} />
              </Field>
            </div>

            {error?.field === 'save' ? (
              <div className="field-error" role="alert">
                {error.text}
              </div>
            ) : null}
          </div>

          <footer className="rt-foot">
            <span className="muted small rt-foot-hint">Only your own journal changes. Ctrl+Enter saves.</span>
            <button type="button" className="btn" onClick={() => onCloseRef.current()}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={saving}>
              <Icon name="check" size={14} /> {saving ? 'Saving…' : title}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    host,
  );
}

/** The live comparison under the price: Pay up to and profit for a buy, the next FIFO lot for a sale. */
function Comparison({
  form,
  keyScrap,
  profit,
  detail,
  held,
  now,
  id,
}: {
  form: TradeForm;
  keyScrap: Scrap | null;
  profit: ProfitSettings | null;
  detail: Lookup<ItemDetail | null> | null;
  held: Lookup<HoldingRow | null> | null;
  now: number;
  id: string;
}) {
  const { value, state: typed } = typedPrice(form, keyScrap);
  const lookup = form.side === 'buy' ? detail : held;
  let body: ReactNode;
  let tone: CompareTone = 'muted';
  if (!profit || !lookup || lookup.status === 'loading') {
    body = <div className="muted">{form.side === 'buy' ? 'Reading the buyers for this item…' : 'Checking your open lots…'}</div>;
  } else if (lookup.status === 'error') {
    tone = 'bad';
    body = <div className="tone-text-bad">Could not compare: {lookup.message}</div>;
  } else if (form.side === 'buy') {
    const c = buyComparison(value, lookup.value as ItemDetail | null, profit, keyScrap, typed);
    tone = c.tone;
    body = (
      <>
        <div className="rt-line">
          <span className="rt-label">Pay up to</span>
          <span className="money rt-strong">{fmtMoney(c.payUpToScrap, keyScrap)}</span>
        </div>
        {c.order ? (
          <div className="rt-line">
            <span className="rt-label">Sells now</span>
            <Buyer order={c.order} keyScrap={keyScrap} value={c.revenueScrap} />
            <span className="muted small rt-count">{c.buyerCount === 1 ? '1 buyer' : `${fmtInt(c.buyerCount)} buyers`}</span>
          </div>
        ) : null}
        <div className={`rt-verdict ${compareTextClass(c.tone)}`}>{c.text}</div>
      </>
    );
  } else {
    const c = sellComparison(value, lookup.value as HoldingRow | null, profit, keyScrap, now, typed);
    tone = c.tone;
    body = (
      <>
        {c.heldQty > 0 ? (
          <div className="rt-line">
            <span className="rt-label">Next lot</span>
            <span className="money rt-strong">{fmtMoney(c.lotCostScrap, keyScrap)}</span>
            <span className="muted small" title={c.lotTs !== null ? `Bought ${fmtDateTime(c.lotTs)}` : undefined}>
              {c.heldQty === 1 ? 'your only open unit' : `oldest of ${fmtInt(c.heldQty)} open units`}
            </span>
          </div>
        ) : null}
        <div className={`rt-verdict ${compareTextClass(c.tone)}`}>{c.text}</div>
        {/* Typed less than the buyer your settings sell to pays now: worth a second look before saving. */}
        {c.bestNowOrder && c.bestNowScrap !== null && (value === null || value < c.bestNowScrap) ? (
          <div className="rt-line">
            <span className="rt-label">Sells now</span>
            <Buyer order={c.bestNowOrder} keyScrap={keyScrap} value={c.bestNowScrap} />
          </div>
        ) : null}
      </>
    );
  }
  return (
    <section id={id} className={`rt-compare tone-${tone}`} aria-label="Comparison" aria-live="polite">
      {body}
    </section>
  );
}

/** "1.77 ref · ● ⚡ Bot name": what a buyer pays, and who. */
function Buyer({ order, keyScrap, value }: { order: OrderSummary; keyScrap: Scrap | null; value: Scrap | null }) {
  const who = order.userName || order.steamid;
  return (
    <span className="rt-buyer" title={`${who} (${order.isBot ? 'bot' : 'human'}) pays ${fmtMoney(value, keyScrap)}`}>
      <span className="money">{fmtMoney(value, keyScrap)}</span>
      <OnlineDot online={order.online} />
      <Icon name={order.isBot ? 'bolt' : 'user'} size={12} title={order.isBot ? 'Bot' : 'Human'} />
      <span className="buyer-name muted small">{order.userName || (order.isBot ? 'Bot' : 'Human')}</span>
    </span>
  );
}
