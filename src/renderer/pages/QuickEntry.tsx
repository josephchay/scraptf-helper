import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemDetail, ScrapPrice } from '../../shared/types';
import { rpc } from '../api';
import { ToastStack } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ItemName, Money } from '../components/ItemName';
import { ItemPicker, type ItemPickerHandle, type PickedItem } from '../components/ItemPicker';
import { ConfidenceBadge, FlagList, OnlineDot } from '../components/Pills';
import { PriceInput, readPrice, type BareUnit } from '../components/PriceInput';
import { STATUS_LABELS, errorMessage, fmtKeysMetal, fmtPct } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { usePush, useThrottled } from '../hooks/useRpc';
import { revenueOrderOf } from '../oppModel';

function sanitizeUnit(v: unknown): BareUnit {
  return v === 'scrap' || v === 'keys' ? v : 'ref';
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Compact always-on-top window: type an item and its scrap.tf price, Enter saves, Esc hides. */
export function QuickEntry() {
  const { keyScrap, isMock, toast, settings } = useApp();
  const [item, setItem] = useState<PickedItem | null>(null);
  const [text, setText] = useState('');
  const [unit, setUnit] = usePersistentState<BareUnit>('price.unit', 'ref', sanitizeUnit);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ price: ScrapPrice; detail: ItemDetail | null } | null>(null);
  const picker = useRef<ItemPickerHandle>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  const hide = useCallback(() => {
    rpc('app.hideWindow').catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        hide();
      }
    };
    window.addEventListener('keydown', onKey);
    const onFocus = () => picker.current?.focus();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focus', onFocus);
    };
  }, [hide]);

  const loadDetail = useCallback(async (price: ScrapPrice) => {
    // The engine evaluates on a short debounce, so the first read may predate it.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const detail = await rpc('item.detail', { sku: price.sku });
        const ready = detail?.opportunities.some((o) => o.inputRef === `price:${price.id}`) ?? false;
        setResult((r) => (r && r.price.id === price.id ? { price, detail } : r));
        if (ready || !detail) return;
      } catch {
        // keep the saved confirmation; the push below retries
      }
      await delay(700);
    }
  }, []);

  const refresh = useThrottled(() => {
    if (result) void loadDetail(result.price);
  }, 2000);
  usePush('opps.changed', refresh, result !== null);

  const submit = async () => {
    setError(null);
    const it = item ?? (await picker.current?.resolvePending()) ?? null;
    if (!it) {
      setError('Type or pick an item.');
      picker.current?.focus();
      return;
    }
    const parsed = readPrice(text, unit);
    if (!parsed) {
      setError('Type the scrap.tf price, e.g. 1.33 or 2 keys 5.11.');
      priceRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const price = await rpc('prices.upsert', {
        sku: it.sku,
        name: it.name,
        costKeys: parsed.keys,
        costScrap: parsed.scrap,
        source: 'user',
        observedAt: Date.now(),
        note: note.trim() || null,
      });
      setResult({ price, detail: null });
      setItem(null);
      setText('');
      setNote('');
      picker.current?.focus();
      void loadDetail(price);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const openInDashboard = (sku: string) => {
    rpc('app.openItem', { sku }).catch((e: unknown) => toast(`Could not open the dashboard: ${errorMessage(e)}`, 'bad'));
  };

  const d = result?.detail ?? null;
  const opp = result && d ? d.opportunities.find((o) => o.inputRef === `price:${result.price.id}`) : undefined;
  // The order the profit below is computed from (Settings: revenue used for profit), not
  // simply the top of the book, which may be an outlier the profit ignores.
  const revenueOrder = opp ? revenueOrderOf(opp, settings?.profit.useOrder ?? 'conservative') : (d?.buyOrders.find((o) => o.eligible && !o.flags.includes('outlier')) ?? null);
  const k = d?.keyPrice?.valueScrap ?? keyScrap;

  return (
    <div className="quick">
      <header className="quick-head">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="quick" size={14} />
        </span>
        <h1>Quick entry</h1>
        <span className="muted small">
          <kbd>Enter</kbd> saves · <kbd>Esc</kbd> hides
        </span>
        {isMock ? <span className="pill tone-warn">Mock data</span> : null}
      </header>
      <form
        className="quick-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="q-item">
          Item
        </label>
        <ItemPicker ref={picker} id="q-item" autoFocus value={item} onChange={setItem} compact placeholder="Item (name, SKU or link)" onEnterPicked={() => priceRef.current?.focus()} />
        <label className="sr-only" htmlFor="q-price">
          scrap.tf price
        </label>
        <PriceInput ref={priceRef} id="q-price" text={text} onText={setText} unit={unit} onUnit={setUnit} keyScrap={keyScrap} onEnter={() => void submit()} compact placeholder="scrap.tf price" />
        <div className="quick-row">
          <label className="sr-only" htmlFor="q-note">
            Note
          </label>
          <input id="q-note" className="input" placeholder="Note (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error ? (
          <div className="field-error" role="alert">
            {error}
          </div>
        ) : null}
      </form>

      {result ? (
        <section className="quick-result" aria-live="polite" aria-label="Saved price">
          <div className="quick-saved">
            <Icon name="check" size={14} /> Saved <ItemName sku={result.price.sku} name={result.price.name} maxTags={2} /> at{' '}
            <span className="money">{fmtKeysMetal(result.price.costKeys, result.price.costScrap)}</span>
          </div>
          {!d ? (
            <div className="muted small">Checking buy orders…</div>
          ) : (
            <dl className="kv tight">
              <dt>Buy order used</dt>
              <dd>
                {revenueOrder ? (
                  <>
                    <Money scrap={revenueOrder.valueScrap} keyScrap={k} />{' '}
                    <span className="buyer-type muted small">
                      <OnlineDot online={revenueOrder.online} />
                      {revenueOrder.isBot ? 'bot' : 'human'}
                      {revenueOrder.flags.includes('outlier') ? ' (outlier)' : ''}
                    </span>
                  </>
                ) : (
                  <span className="muted">none yet</span>
                )}
              </dd>
              <dt>Profit</dt>
              <dd>
                {opp ? (
                  <>
                    <strong>
                      <Money scrap={opp.profitScrap} keyScrap={k} tone="profit" signed />
                    </strong>
                    <span className="muted small">
                      {' '}
                      · {fmtPct(opp.margin)} · {STATUS_LABELS[opp.status]}
                    </span>
                  </>
                ) : (
                  <span className="muted">evaluating…</span>
                )}
              </dd>
              <dt>Confidence</dt>
              <dd>{opp ? <ConfidenceBadge score={opp.confidence} level={opp.confidenceLevel} reasons={opp.reasons} /> : <span className="muted">—</span>}</dd>
            </dl>
          )}
          {opp?.flags.length ? <FlagList flags={opp.flags} /> : null}
          <div className="quick-actions">
            <button type="button" className="btn small" onClick={() => openInDashboard(result.price.sku)}>
              <Icon name="external" size={13} />
              Open in dashboard
            </button>
          </div>
        </section>
      ) : (
        <p className="quick-tip muted small">Prices are saved as seen now. The dashboard updates as soon as you save.</p>
      )}
      <ToastStack />
    </div>
  );
}
