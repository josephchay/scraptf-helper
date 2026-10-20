import { useCallback, useEffect, useRef, useState } from 'react';
import type { ItemDetail, ProfitSettings, Scrap, ScrapPrice } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { rpc } from '../api';
import { copyText } from '../clipboard';
import { openOrCopy } from '../components/ExternalLink';
import { ToastStack } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ItemName, Money } from '../components/ItemName';
import { ItemPicker, type ItemPickerHandle, type PickedItem } from '../components/ItemPicker';
import { ConfidenceBadge, FlagList, OnlineDot, TonePill } from '../components/Pills';
import { PriceInput, parsedValueScrap, readPrice, type BareUnit } from '../components/PriceInput';
import { STATUS_LABELS, errorMessage, fmtKeysMetal, fmtMoney, fmtPct, fmtSignedMoney } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { usePush, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useNow } from '../hooks/useTimers';
import { REVENUE_ORDER_TITLES, revenueOrderOf } from '../oppModel';
import {
  PREVIEW_DEBOUNCE_MS,
  afterBoughtUndo,
  boughtButton,
  boughtItInput,
  boughtItText,
  buyerCountLabel,
  ceilingVerdict,
  compactLinks,
  createLatestGate,
  freshSavedPrice,
  isCheckKey,
  isChecked,
  listPriceStamp,
  noRevenueText,
  prefillPriceText,
  previewRevenue,
  previewTone,
  profitPreview,
  quickListHint,
  revenueBreakdown,
  type BoughtState,
  type CheckedEntry,
  type ListPriceUse,
} from '../quickModel';

function sanitizeUnit(v: unknown): BareUnit {
  return v === 'scrap' || v === 'keys' ? v : 'ref';
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live preview for the picked item ('item.detail' with history:false, so local data only). */
interface PreviewState {
  sku: string;
  detail: ItemDetail | null;
  error: string | null;
  loading: boolean;
}

/**
 * Compact always-on-top window: type an item and its scrap.tf price, see what it
 * sells for and the most to pay while typing; Enter saves, Shift+Enter only checks, Esc hides.
 */
export function QuickEntry() {
  const { keyScrap, isMock, toast, settings } = useApp();
  const [item, setItem] = useState<PickedItem | null>(null);
  const [text, setText] = useState('');
  const [unit, setUnit] = usePersistentState<BareUnit>('price.unit', 'ref', sanitizeUnit);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ price: ScrapPrice; detail: ItemDetail | null } | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [checked, setChecked] = useState<CheckedEntry | null>(null);
  const [bought, setBought] = useState<BoughtState | null>(null);
  // F14: the scrap.tf list price Use put in the price field, so a save of it keeps the list's date.
  const [listUse, setListUse] = useState<ListPriceUse | null>(null);
  // A double click must not record the buy twice (Holdings would count two units).
  const boughtBusy = useRef(false);
  const [focusPriceTick, setFocusPriceTick] = useState(0);
  const picker = useRef<ItemPickerHandle>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const [previewGate] = useState(createLatestGate);
  const [prefillGate] = useState(createLatestGate);
  // 'applied' from a prefill's pick until the window loses focus, so showing the window lands on the
  // price, not the item. While it is still resolving, focus stays put: moving it to the price would
  // blur the picker, whose blur handler may resolve leftover text and cancel the prefill.
  const prefilled = useRef<'off' | 'pending' | 'applied'>('off');
  // Enter in the price field calls submit directly (the disabled Save button does not stop it).
  const savingRef = useRef(false);
  const sku = item?.sku ?? null;

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
    const onFocus = () => {
      if (prefilled.current === 'applied') priceRef.current?.focus();
      // The focus effect below moves to the price once a pending prefill has picked its item.
      else if (prefilled.current === 'off') picker.current?.focus();
    };
    const onBlur = () => {
      prefilled.current = 'off';
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [hide]);

  // After the commit, so the picker already holds the new item when focus leaves it
  // (its blur handler would otherwise resolve the old text over the prefill).
  useEffect(() => {
    if (focusPriceTick) priceRef.current?.focus();
  }, [focusPriceTick]);

  // ----- live preview -----

  const loadPreview = useCallback(
    async (s: string) => {
      const ticket = previewGate.next();
      setPreview((p) => (p && p.sku === s ? { ...p, loading: true } : { sku: s, detail: null, error: null, loading: true }));
      try {
        // 'plain': priced like the row Enter saves, not like a newer painted or spelled copy of the item.
        const detail = await rpc('item.detail', { sku: s, history: false, target: 'plain' });
        if (previewGate.isCurrent(ticket)) setPreview({ sku: s, detail, error: null, loading: false });
      } catch (e) {
        if (!previewGate.isCurrent(ticket)) return;
        setPreview((p) => ({ sku: s, detail: p && p.sku === s ? p.detail : null, error: errorMessage(e), loading: false }));
      }
    },
    [previewGate],
  );

  useEffect(() => {
    // Any answer still on its way is for an item that is no longer picked.
    previewGate.cancel();
    if (!sku) {
      setPreview(null);
      return;
    }
    const id = setTimeout(() => void loadPreview(sku), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [sku, loadPreview, previewGate]);

  const refreshPreview = useThrottled(() => {
    if (sku) void loadPreview(sku);
  }, 2000);
  // Buy orders move with the live feed; a hidden window catches up once when shown.
  useVisiblePush('opps.changed', refreshPreview, sku !== null);
  // A newly saved scrap.tf/items list (F14) updates the list hint; a local read, like the rest.
  useVisiblePush('scraptf.listChanged', refreshPreview, sku !== null);

  // ----- prefill ('app.showQuickEntry' with a SKU) -----

  const applyPrefill = useCallback(
    async (pushedSku: string, priceText = '') => {
      // Main already validates and lower-cases it; SKUs are canonical in lower case.
      const prefillSku = pushedSku.trim().toLowerCase();
      const ticket = prefillGate.next();
      prefilled.current = 'pending';
      setError(null);
      try {
        const r = await rpc('item.resolve', { text: prefillSku });
        let picked: PickedItem | null = r ? { sku: r.sku, name: r.name, category: r.category, warnings: r.warnings, match: r.match } : null;
        if (!picked) {
          const d = await rpc('item.detail', { sku: prefillSku, history: false });
          picked = d ? { sku: d.sku, name: d.name, category: d.category, match: 'sku' } : null;
        }
        if (!prefillGate.isCurrent(ticket)) return;
        if (!picked) {
          prefilled.current = 'off';
          setError(`No item matches ${prefillSku}. Type its name instead.`);
          return;
        }
        // A price typed for another item would be wrong for this one. The live check popup (F16)
        // sends the price it checked, so it lands in the field with the item.
        setText(priceText);
        setNote('');
        setResult(null);
        setChecked(null);
        setListUse(null);
        setItem(picked);
        prefilled.current = 'applied';
        setFocusPriceTick((n) => n + 1);
      } catch (e) {
        if (!prefillGate.isCurrent(ticket)) return;
        prefilled.current = 'off';
        setError(`Could not open ${prefillSku}: ${errorMessage(e)}`);
      }
    },
    [prefillGate],
  );

  usePush('ui.quickPrefill', ({ sku: prefillSku, price }) => void applyPrefill(prefillSku, prefillPriceText(price)));

  const onPick = (v: PickedItem | null) => {
    // The user's own pick wins over a prefill still resolving.
    prefillGate.cancel();
    if (prefilled.current === 'pending') prefilled.current = 'off';
    setItem(v);
    if (v) setResult(null);
  };

  // ----- save and check -----

  const loadDetail = useCallback(async (price: ScrapPrice) => {
    // The engine evaluates on a short debounce, so the first read may predate it.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const detail = await rpc('item.detail', { sku: price.sku, history: false });
        const ready = detail?.opportunities.some((o) => o.inputRef === `price:${price.id}`) ?? false;
        // The row as stored now: an edit elsewhere keeps its id, and 'Saved … at' and Bought it must follow it.
        const fresh = freshSavedPrice(price, detail);
        setResult((r) => (r && r.price.id === price.id ? { price: fresh, detail } : r));
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
  // `result` outlives Esc/blur (the window only hides), so gate on visibility rather than on it.
  useVisiblePush('opps.changed', refresh, result !== null);
  // The saved price edited in the drawer or on the Prices page (same row id): re-read its cost.
  useVisiblePush('prices.changed', refresh, result !== null);

  /** The picked (or typed) item and the parsed price, or null after showing what is missing. */
  const readEntry = async () => {
    setError(null);
    const it = item ?? (await picker.current?.resolvePending()) ?? null;
    if (!it) {
      setError('Type or pick an item.');
      picker.current?.focus();
      return null;
    }
    const parsed = readPrice(text, unit);
    if (!parsed) {
      setError('Type the scrap.tf price, e.g. 1.33 or 2 keys 5.11.');
      priceRef.current?.focus();
      return null;
    }
    return { it, parsed };
  };

  const submit = async () => {
    // A second Enter while the first save is on its way would record the price twice.
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await save();
    } finally {
      savingRef.current = false;
    }
  };

  const save = async () => {
    const entry = await readEntry();
    if (!entry) return;
    const { it, parsed } = entry;
    // A list price saved as Use put it keeps the list's date and note (F14); anything else is seen now.
    const stamp = listPriceStamp(listUse, { sku: it.sku, text }, note, Date.now());
    setSaving(true);
    try {
      const price = await rpc('prices.upsert', {
        sku: it.sku,
        name: it.name,
        costKeys: parsed.keys,
        costScrap: parsed.scrap,
        source: 'user',
        observedAt: stamp.observedAt,
        note: stamp.note,
      });
      setResult({ price, detail: null });
      setItem(null);
      setText('');
      setNote('');
      setChecked(null);
      setListUse(null);
      prefilled.current = 'off';
      picker.current?.focus();
      void loadDetail(price);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  /** Shift+Enter: show the verdict for this price without saving it. */
  const check = async () => {
    const entry = await readEntry();
    if (!entry) return;
    setChecked({ sku: entry.it.sku, text, unit });
    // A failed preview is retried; a fresh pick is already loading through the effect above.
    if (entry.it === item && (!preview || preview.sku !== item.sku || preview.error)) void loadPreview(item.sku);
    priceRef.current?.focus();
  };

  const openInDashboard = (s: string) => {
    rpc('app.openItem', { sku: s }).catch((e: unknown) => toast(`Could not open the dashboard: ${errorMessage(e)}`, 'bad'));
  };

  // F12 "Bought it": one click writes the journal buy at the saved price; the toast offers Undo.
  // Only the user's own journal changes; nothing is bought (R4).
  const undoBought = async (entryId: number) => {
    try {
      await rpc('journal.delete', { id: entryId });
      setBought((b) => afterBoughtUndo(b, entryId));
      toast('Removed that buy from your journal.', 'info');
    } catch (e) {
      toast(`Could not undo: ${errorMessage(e)}`, 'bad');
    }
  };

  /** The saved row's current cost; the copy on the card if it cannot be read (or was deleted since). */
  const currentPrice = async (saved: ScrapPrice): Promise<ScrapPrice> => {
    try {
      return freshSavedPrice(saved, await rpc('item.detail', { sku: saved.sku, history: false }));
    } catch {
      return saved;
    }
  };

  const boughtIt = async (saved: ScrapPrice) => {
    if (boughtBusy.current) return;
    boughtBusy.current = true;
    setBought({ priceId: saved.id, status: 'saving' });
    try {
      // Read again first: an edit that landed while the window was hidden has not refreshed the card yet.
      const price = await currentPrice(saved);
      const entry = await rpc('journal.add', boughtItInput(price));
      setBought((b) => (b?.priceId === price.id ? { priceId: price.id, status: 'done', entryId: entry.id } : b));
      toast(boughtItText(entry), 'good', { action: { label: 'Undo', onClick: () => void undoBought(entry.id) } });
    } catch (e) {
      setBought((b) => (b?.priceId === saved.id ? null : b));
      toast(`Could not record the buy: ${errorMessage(e)}`, 'bad');
    } finally {
      boughtBusy.current = false;
    }
  };

  const copy = async (value: string, what: string) => {
    const ok = await copyText(value);
    toast(ok ? `Copied ${what}` : 'Could not copy to the clipboard.', ok ? 'good' : 'bad');
  };

  const profit = settings?.profit ?? DEFAULT_SETTINGS.profit;
  const d = result?.detail ?? null;
  const opp = result && d ? d.opportunities.find((o) => o.inputRef === `price:${result.price.id}`) : undefined;
  // The order the profit below is computed from (Settings: revenue used for profit), not
  // simply the top of the book, which may be an outlier the profit ignores.
  const revenueOrder = opp ? revenueOrderOf(opp, profit.useOrder) : (d?.buyOrders.find((o) => o.eligible && !o.flags.includes('outlier')) ?? null);
  const k = d?.keyPrice?.valueScrap ?? keyScrap;
  const payUpTo = opp?.maxCostScrap ?? d?.revenue?.maxCostScrap ?? null;
  const boughtBtn = result ? boughtButton(bought, result.price.id) : null;

  return (
    <div className="quick">
      <header className="quick-head">
        <span className="brand-mark" aria-hidden="true">
          <Icon name="quick" size={14} />
        </span>
        <h1>Quick entry</h1>
        <span className="muted small quick-keys">
          <kbd>Enter</kbd> save · <kbd>Shift+Enter</kbd> check · <kbd>Esc</kbd> hide
        </span>
        {isMock ? <span className="pill tone-warn">Mock data</span> : null}
      </header>
      <form
        className="quick-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDownCapture={(e) => {
          // Captured before the item picker and price field handle Enter themselves.
          if (isCheckKey({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing })) {
            e.preventDefault();
            e.stopPropagation();
            if (!saving) void check();
          }
        }}
      >
        <label className="sr-only" htmlFor="q-item">
          Item
        </label>
        <ItemPicker ref={picker} id="q-item" autoFocus value={item} onChange={onPick} compact placeholder="Item (name, SKU or link)" onEnterPicked={() => priceRef.current?.focus()} />
        <label className="sr-only" htmlFor="q-price">
          scrap.tf price
        </label>
        <PriceInput ref={priceRef} id="q-price" text={text} onText={setText} unit={unit} onUnit={setUnit} keyScrap={keyScrap} onEnter={() => void submit()} compact placeholder="scrap.tf price" />
        <div className="quick-row">
          <label className="sr-only" htmlFor="q-note">
            Note
          </label>
          <input id="q-note" className="input" placeholder="Note (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn" disabled={saving} onClick={() => void check()} title="Show the result without saving (Shift+Enter)">
            Check only
          </button>
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

      {item ? (
        <QuickPreview
          item={item}
          preview={preview && preview.sku === item.sku ? preview : null}
          text={text}
          unit={unit}
          profit={profit}
          keyScrap={keyScrap}
          checked={isChecked(checked, { sku: item.sku, text, unit })}
          onCopy={(value, what) => void copy(value, what)}
          onRetry={() => void loadPreview(item.sku)}
          onUseListPrice={(price, observedAt, otherCopy) => {
            // Written with units, so the bare-number unit toggle does not change what it means.
            setText(price);
            setListUse({ sku: item.sku, text: price, observedAt, otherCopy });
            setError(null);
            priceRef.current?.focus();
          }}
        />
      ) : result ? (
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
              <dt>Pay up to</dt>
              <dd>{payUpTo !== null ? <Money scrap={payUpTo} keyScrap={k} /> : <span className="muted">—</span>}</dd>
              <dt>Confidence</dt>
              <dd>{opp ? <ConfidenceBadge score={opp.confidence} level={opp.confidenceLevel} reasons={opp.reasons} /> : <span className="muted">—</span>}</dd>
            </dl>
          )}
          {opp?.flags.length ? <FlagList flags={opp.flags} /> : null}
          <div className="quick-actions">
            {boughtBtn ? (
              <button
                type="button"
                className={`btn small${boughtBtn.done ? '' : ' primary'} quick-bought`}
                disabled={boughtBtn.disabled}
                title={`Record that you bought it on scrap.tf at ${fmtKeysMetal(result.price.costKeys, result.price.costScrap)}: a journal buy, shown in Holdings. Nothing is bought.`}
                onClick={() => void boughtIt(result.price)}
              >
                <Icon name={boughtBtn.done ? 'check' : 'cart'} size={13} />
                {boughtBtn.label}
              </button>
            ) : null}
            <button type="button" className="btn small" onClick={() => openInDashboard(result.price.sku)}>
              <Icon name="external" size={13} />
              Open in dashboard
            </button>
          </div>
        </section>
      ) : (
        <p className="quick-tip muted small">Pick an item to see what it sells for and the most to pay on scrap.tf. Prices are saved as seen now.</p>
      )}
      <ToastStack />
    </div>
  );
}

/** What the picked item sells for, the most to pay, and the live verdict for the typed price. */
function QuickPreview({
  item,
  preview,
  text,
  unit,
  profit,
  keyScrap,
  checked,
  onCopy,
  onRetry,
  onUseListPrice,
}: {
  item: PickedItem;
  preview: PreviewState | null;
  text: string;
  unit: BareUnit;
  profit: ProfitSettings;
  keyScrap: Scrap | null;
  checked: boolean;
  onCopy: (value: string, what: string) => void;
  onRetry: () => void;
  /** F14: put the saved scrap.tf list's price to buy into the price field. */
  onUseListPrice: (price: string, observedAt: number, otherCopy: boolean) => void;
}) {
  const { toast } = useApp();
  const now = useNow(30_000);
  const d = preview?.detail ?? null;
  // The picked item's row of the user's saved scrap.tf/items list (F14); local, like the rest of the preview.
  const listHint = d ? quickListHint(d.scraptfList, item.sku, now) : null;
  const k = d?.keyPrice?.valueScrap ?? keyScrap;
  const rev = d ? previewRevenue(d, profit) : null;
  const order = rev?.order ?? null;
  const ceiling = rev?.maxCostScrap ?? null;
  const parsed = text.trim() ? readPrice(text, unit) : null;
  // Keys are valued with the key price the service used for this item, as the engine does.
  const cost = parsedValueScrap(parsed, k);
  const pv = rev && cost !== null ? profitPreview(cost, rev, profit) : null;
  const tone = pv ? previewTone(pv) : null;
  const links = d ? compactLinks(d.links) : [];

  const body = (() => {
    if (!preview || (preview.loading && !d)) return <div className="muted small">Loading buy orders…</div>;
    if (preview.error && !d) {
      return (
        <div className="small">
          <span className="tone-text-bad">Could not load buy orders: {preview.error}</span>{' '}
          <button type="button" className="link-btn" onClick={onRetry}>
            Retry
          </button>
        </div>
      );
    }
    if (!d) return <div className="muted small">This item is not known yet. Check the SKU, or wait for the schema to load.</div>;
    return (
      <>
        <div className="qp-line">
          <span className="qp-label" title={REVENUE_ORDER_TITLES[rev?.useOrder ?? profit.useOrder]}>
            Sells for
          </span>
          {order ? (
            <>
              <strong>
                <Money scrap={order.valueScrap} keyScrap={k} title={rev ? revenueBreakdown(rev, k) : undefined} />
              </strong>
              <span className="buyer-type small">
                <OnlineDot online={order.online} />
                {order.isBot ? (
                  <>
                    <Icon name="bolt" size={12} /> bot
                  </>
                ) : (
                  <>
                    <Icon name="user" size={12} /> human
                  </>
                )}
              </span>
              {order.userName ? (
                <span className="buyer-name muted small" title={order.userName}>
                  {order.userName}
                </span>
              ) : null}
              {order.flags.includes('outlier') ? <TonePill tone="warn">outlier</TonePill> : null}
            </>
          ) : (rev?.eligibleCount ?? 0) > 0 ? (
            // 0.7.3: orders exist but none is usable (all outliers, or no bot for Instant); the hover says which.
            <span className="muted" title={noRevenueText(rev)}>
              no usable buy order
            </span>
          ) : (
            <span className="muted">no eligible buy order</span>
          )}
          <span className="muted small qp-count">{buyerCountLabel(rev?.eligibleCount ?? 0)}</span>
        </div>
        <div className="qp-line">
          <span className="qp-label">Pay up to</span>
          {ceiling !== null ? (
            <strong className="qp-ceiling">
              <Money scrap={ceiling} keyScrap={k} />
            </strong>
          ) : (
            <span className="muted" title="No scrap.tf price clears your profit thresholds against this buy order.">
              —
            </span>
          )}
          {pv && tone ? <TonePill tone={tone}>{ceilingVerdict(pv, k, rev?.eligibleCount ?? 0)}</TonePill> : null}
        </div>
        <div className="qp-line">
          <span className="qp-label">Profit</span>
          {pv ? (
            <>
              <strong>
                <Money scrap={pv.profitScrap} keyScrap={k} tone="profit" signed />
              </strong>
              <span className="muted small">
                {fmtPct(pv.margin)} · {STATUS_LABELS[pv.status]}
              </span>
            </>
          ) : parsed && cost === null ? (
            <span className="muted small">Needs a key price to value keys.</span>
          ) : (
            <span className="muted small">Type the scrap.tf price to see it.</span>
          )}
        </div>
        {listHint ? (
          <div className="qp-line qp-list" title={listHint.title}>
            <span className="qp-label">scrap.tf list</span>
            <span className={`small qp-list-text${listHint.tone === 'warn' ? ' tone-text-warn' : ''}`}>{listHint.text}</span>
            {listHint.price ? (
              <button
                type="button"
                className="btn small ghost qp-use"
                aria-label={`Use scrap.tf's list price ${listHint.price}`}
                title={`Put ${listHint.price} in the price field (Enter saves it, dated when you saved the list)`}
                onClick={() => listHint.price && onUseListPrice(listHint.price, listHint.observedAt, listHint.otherCopy)}
              >
                Use
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    );
  })();

  const verdict = pv ? `${STATUS_LABELS[pv.status]}, profit ${fmtSignedMoney(pv.profitScrap, k)}, ${ceilingVerdict(pv, k, rev?.eligibleCount ?? 0)}${ceiling !== null ? ` (pay up to ${fmtMoney(ceiling, k)})` : ''}.` : null;

  return (
    <section className={`quick-preview${tone === 'good' ? ' under' : ''}`} aria-label="Preview">
      <div className="qp-head">
        <ItemName sku={item.sku} name={d?.name ?? item.name} maxTags={2} />
        {checked ? <TonePill tone="info">Checked, not saved</TonePill> : null}
        {preview?.loading && d ? <span className="qp-busy" aria-hidden="true" /> : null}
        {/* A failed refresh keeps the last answer on screen; say that it may be out of date. */}
        {preview?.error && d && !preview.loading ? (
          <TonePill tone="warn" title={`Could not refresh: ${preview.error}`}>
            Not updated
          </TonePill>
        ) : null}
      </div>
      {body}
      <div className="qp-foot">
        {links.length ? (
          <nav className="qp-links" aria-label="Links">
            {links.map(({ link, short }) => (
              <button key={link.id} type="button" className="link-btn" title={`${link.label}: ${link.url}`} onClick={() => void openOrCopy(link.url, toast)}>
                {short}
              </button>
            ))}
          </nav>
        ) : null}
        <span className="qp-copy">
          <button
            type="button"
            className="btn small ghost"
            aria-label="Copy name"
            onClick={() => onCopy(d?.name ?? item.name, 'name')}
            title="Copy the item name, e.g. for scrap.tf's search box"
          >
            <Icon name="copy" size={12} /> Name
          </button>
          <button
            type="button"
            className="btn small ghost"
            aria-label="Copy bp.tf name"
            disabled={!d}
            onClick={() => d && onCopy(d.bptfName, 'backpack.tf name')}
            title="Copy the backpack.tf name"
          >
            <Icon name="copy" size={12} /> bp.tf name
          </button>
        </span>
      </div>
      <div className="sr-only" role="status">
        {checked && verdict ? `Checked, not saved. ${verdict}` : ''}
      </div>
    </section>
  );
}
