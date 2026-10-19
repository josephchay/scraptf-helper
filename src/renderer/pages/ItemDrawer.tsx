import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { SCRAPTF_ITEMS_URL } from '../../shared/links';
import type { BuyerCheck, ItemDetail, LinkSpec, Opportunity, OrderSummary, PriceRule, Scrap, ScrapPrice, ScraptfListRow } from '../../shared/types';
import { rpc } from '../api';
import { seenOnText } from '../banksModel';
import { copyText } from '../clipboard';
import { ConfirmButton, Field } from '../components/Controls';
import { Drawer } from '../components/Drawer';
import { openOrCopy } from '../components/ExternalLink';
import { ErrorBanner, LoadingBlock, Spinner } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { MenuPopover, menuPointFromEvent, openOnScraptf } from '../components/ItemMenu';
import { ItemName, Money } from '../components/ItemName';
import { ConfidenceBadge, FlagList, OnlineDot, TonePill } from '../components/Pills';
import { PriceInput, parsedValueScrap, readPrice, type BareUnit } from '../components/PriceInput';
import { useRecordTrade, type RecordTradeInit } from '../components/RecordTradeDialog';
import { ScraptfHistory } from '../components/ScraptfHistory';
import { Sparkline } from '../components/Sparkline';
import {
  INPUT_KIND_LABELS,
  STATUS_LABELS,
  categoryLabel,
  errorMessage,
  fmtAge,
  fmtAgo,
  fmtCountdown,
  fmtDateTime,
  fmtKeysMetal,
  fmtMoney,
  fmtPct,
  fmtRefOnly,
  snapshotUnavailableReason,
  truncate,
} from '../format';
import { useApp } from '../hooks/appContext';
import { SAVE_MODE } from '../importModel';
import { usePersistentState } from '../hooks/usePersistentState';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useNow } from '../hooks/useTimers';
import {
  backgroundCheckListings,
  blockBuyer,
  buyerLabel,
  buyerMenuSections,
  buyerProfileUrls,
  ceilingVerdict,
  copiedMessage,
  copyTargets,
  defaultPriceTarget,
  describeBuyerCheck,
  drawerCeiling,
  drawerPriceInput,
  fmtDays,
  groupLinks,
  isSteamId64,
  listPriceAlreadySaved,
  listPriceInput,
  listPriceSavedText,
  modalHostOf,
  OPEN_ON_SCRAPTF_LABEL,
  priceFormHeading,
  recordBuyInit,
  recordInitTitle,
  recordSaleInit,
  reconfirmInput,
  referenceAgeGates,
  scraptfListView,
  scraptfOpenTitle,
  scraptfOpenUrl,
  scraptfSearchName,
  unblockBuyer,
  type BlocklistDeps,
  type BuyerMenuAction,
  type MenuPoint,
} from '../itemMenuModel';
import { drawerBankStockLine } from '../marketModel';
import { listRowIsOtherCopy, previewRevenue } from '../quickModel';
import { listBoundaryNote } from '../scraptfListModel';
import { scraptfLinksInWindow, scraptfWindowOn } from '../scraptfWindowModel';

export function ItemDrawer() {
  const { itemSku, closeItem } = useApp();
  return (
    <Drawer open={itemSku !== null} onClose={closeItem} labelledBy="item-title">
      {itemSku ? <ItemDetailView key={itemSku} sku={itemSku} /> : null}
    </Drawer>
  );
}

const STATUS_TONE = { profitable: 'good', 'below-threshold': 'warn', unprofitable: 'bad', 'no-buyers': 'muted' } as const;
const PAY_UP_TO_HELP = 'The highest scrap.tf price that still clears your profit thresholds against this revenue (Settings, Profit).';

function sanitizeUnit(v: unknown): BareUnit {
  return v === 'scrap' || v === 'keys' ? v : 'ref';
}

function ItemDetailView({ sku }: { sku: string }) {
  const { keyScrap: statusKey, toast, closeItem, navigate, secrets, settings, bumpData } = useApp();
  const detail = useRpcQuery('item.detail', { sku });
  const assetId = detail.data?.scrapPrices.find((p) => p.assetId)?.assetId ?? null;
  const links = useRpcQuery('links.forSku', { sku, assetId }, { enabled: detail.data !== undefined });
  const hasRules = detail.data?.opportunities.some((o) => o.inputKind === 'rule') ?? false;
  const rules = useRpcQuery('rules.list', undefined, { enabled: hasRules });
  const reload = useThrottled(() => void detail.reload(), 2000);
  // The drawer stays open while the dashboard sits in the tray.
  useVisiblePush('opps.changed', reload);
  // A price saved in quick entry (another window) or an import shows here at once.
  useVisiblePush('prices.changed', reload);
  // A newly saved scrap.tf/items list (F14) updates the price-list block and the sale prefill.
  useVisiblePush('scraptf.listChanged', reload);
  const now = useNow(1000);
  const [refresh, setRefresh] = useState<{ queued: boolean; reason: string | null; until: number | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadDetail = detail.reload;
  useEffect(() => {
    if (!refresh?.queued || refresh.until === null) return;
    const id = setTimeout(() => {
      void reloadDetail();
      setRefresh(null);
    }, Math.max(500, refresh.until - Date.now() + 500));
    return () => clearTimeout(id);
  }, [refresh, reloadDetail]);

  const afterChange = useCallback(() => {
    void reloadDetail();
    bumpData();
  }, [reloadDetail, bumpData]);
  const buyers = useBuyerActions(afterChange);
  // F12: one dialog for Record buy, Record sale and each buyer's "Record sale to this buyer".
  const recordTrade = useRecordTrade();

  const d = detail.data;
  const keyScrap = d?.keyPrice?.valueScrap ?? statusKey;
  const profit = settings?.profit ?? DEFAULT_SETTINGS.profit;
  const useOrder = profit.useOrder;
  const checkListings = useMemo(() => backgroundCheckListings(d?.opportunities ?? [], useOrder), [d, useOrder]);
  // The buy prefills with your newest scrap.tf price, the sale with the order your profit uses, or with
  // scrap.tf's saved list price when Holdings' rule makes it the better exit (F14).
  const buyInit = useMemo<RecordTradeInit | null>(() => (d ? recordBuyInit(d, d.scrapPrices) : null), [d]);
  const saleInit = useMemo<RecordTradeInit | null>(
    () => (d ? recordSaleInit(d, previewRevenue(d, profit).order, d.scraptfList ? { list: d.scraptfList, now } : null) : null),
    [d, profit, now],
  );
  const recordSaleTo = useCallback((o: OrderSummary) => (d ? recordTrade.open(recordSaleInit(d, o)) : undefined), [d, recordTrade]);

  const doRefresh = async () => {
    setBusy(true);
    try {
      const r = await rpc('item.refresh', { sku });
      setRefresh({ queued: r.queued, reason: r.reason, until: r.etaMs !== null ? Date.now() + r.etaMs : null });
    } catch (e) {
      setRefresh({ queued: false, reason: errorMessage(e), until: null });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    const ok = await copyText(text);
    toast(copiedMessage(text, ok), ok ? 'good' : 'bad');
  };

  const openQuick = () => {
    rpc('app.showQuickEntry', { sku: d?.sku ?? sku }).catch((e: unknown) => toast(`Could not open quick entry: ${errorMessage(e)}`, 'bad'));
  };

  const openSettings = () => {
    closeItem();
    navigate('settings');
  };

  if (detail.loading && !d) {
    return (
      <div className="drawer-body">
        <DrawerHead title={sku} onClose={closeItem} />
        <LoadingBlock label="Loading item…" />
      </div>
    );
  }
  if (!d) {
    return (
      <div className="drawer-body">
        <DrawerHead title={sku} onClose={closeItem} />
        {detail.error ? <ErrorBanner message={detail.error} onRetry={() => void detail.reload()} /> : <p className="muted">This item is not known yet. Check the SKU, or wait for the schema to load.</p>}
      </div>
    );
  }

  const ruleNames = new Map<number, string>((rules.data ?? []).map((r: PriceRule) => [r.id, r.name]));
  const linkList: LinkSpec[] = links.data ?? d.links;
  // The specific, fixable reason (missing token, API off) rather than a vague "unavailable".
  const unavailable = d.snapshot.available ? null : snapshotUnavailableReason(secrets, settings);
  const ceiling = drawerCeiling(d);
  // Never null without a links state: the bank page the item was last seen on (F15), else its
  // category's, else the full scrap.tf/items list.
  const stfUrl = scraptfOpenUrl(d.category, null, d.seenOn) ?? SCRAPTF_ITEMS_URL;
  const seen = seenOnText(d.seenOn, now);
  // F17: the newest bank page save that lists this copy, and its change since the previous save.
  const stockLine = drawerBankStockLine(d.bankStock, keyScrap, now);
  const openStock = (route: string) => {
    closeItem();
    navigate(route);
  };

  return (
    <div className="drawer-body">
      <header className="drawer-head">
        <div className="drawer-title-wrap">
          <h2 id="item-title" className="drawer-title">
            <ItemName sku={d.sku} name={d.name} maxTags={6} />
          </h2>
          <div className="drawer-sub">
            <code className="sku">{d.sku}</code>
            <span className="muted">· {categoryLabel(d.category)}</span>
            {/* F15: from the newest imported price's saved page; nothing here loads it. */}
            {seen ? (
              <span className="drawer-seen muted" title={seen.title}>
                · {seen.text}
              </span>
            ) : null}
          </div>
          {/* F17: text from the user's saved pages only; View stock opens the bank stock page in the app. */}
          {stockLine ? (
            <p className="drawer-bank-stock small" title={stockLine.title}>
              <Icon name="banks" size={13} />
              <span className="drawer-bank-stock-text">
                {stockLine.prefix}
                {stockLine.change !== null ? <span className={`drawer-bank-stock-change${stockLine.tone ? ` tone-${stockLine.tone}` : ''}`}>{stockLine.change}</span> : null}
              </span>
              <button type="button" className="link-btn small" title="Every item on this page in your newest save, and what changed since the previous one" onClick={() => openStock(stockLine.route)}>
                View stock
              </button>
            </p>
          ) : null}
          {/* Copying the name is how the user searches scrap.tf's own search box in their browser. */}
          <div className="drawer-copy" role="group" aria-label="Copy to the clipboard or search scrap.tf">
            {copyTargets(d).map((c) => (
              <button key={c.kind} type="button" className="btn small ghost" title={c.text} onClick={() => void copy(c.text)}>
                <Icon name="copy" size={13} /> {c.label}
              </button>
            ))}
            {/* F14: copies the name, then the user's browser opens the bank page (links.open). F19: armed
                first with exactly that name, so a price copied there is checked as this item. */}
            <button
              type="button"
              className="btn small ghost"
              title={scraptfOpenTitle(stfUrl, scraptfSearchName(d), scraptfLinksInWindow(settings))}
              onClick={() => void openOnScraptf(stfUrl, scraptfSearchName(d), toast, { sku: d.sku, settings })}
            >
              <Icon name="external" size={13} /> {OPEN_ON_SCRAPTF_LABEL}
            </button>
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={closeItem} aria-label="Close item">
          <Icon name="close" />
        </button>
      </header>

      <div className="refresh-row">
        <button type="button" className="btn" disabled={busy || !d.snapshot.available} onClick={() => void doRefresh()}>
          <Icon name="refresh" size={14} /> Refresh from backpack.tf
        </button>
        <span className="muted small">
          {unavailable ? (
            <>
              {unavailable.text}
              {unavailable.settings ? (
                <>
                  {' '}
                  <button type="button" className="link-btn" onClick={openSettings}>
                    Open Settings
                  </button>
                </>
              ) : null}
            </>
          ) : d.snapshot.lastAt
              ? `Last snapshot ${fmtAge(now - d.snapshot.lastAt)} ago.`
              : 'No snapshot yet; buy orders come from the live feed.'}
          {d.snapshot.nextAllowedAt && d.snapshot.nextAllowedAt > now ? ` Next slot in ${fmtCountdown(d.snapshot.nextAllowedAt, now)}.` : ''}
        </span>
        {refresh ? (
          <span className={`small ${refresh.queued ? 'tone-text-good' : 'tone-text-warn'}`} role="status">
            {refresh.queued
              ? `Queued. Expected in about ${refresh.until ? fmtCountdown(refresh.until, now) : 'a moment'}.`
              : `${refresh.reason ?? 'Not queued.'}${refresh.until && refresh.until > now ? ` Try again in ${fmtCountdown(refresh.until, now)}.` : ''}`}
          </span>
        ) : null}
      </div>

      {/* F12: the user's own journal; Holdings follows it. Nothing is bought, sold or offered (R4). */}
      <div className="drawer-trade-row" role="group" aria-label="Record a trade in your journal">
        {buyInit ? (
          <button type="button" className="btn small" title={recordInitTitle(buyInit)} onClick={() => recordTrade.open(buyInit)}>
            <Icon name="cart" size={14} /> Record buy
          </button>
        ) : null}
        {saleInit ? (
          <button type="button" className="btn small" title={recordInitTitle(saleInit)} onClick={() => recordTrade.open(saleInit)}>
            <Icon name="journal" size={14} /> Record sale
          </button>
        ) : null}
        <span className="muted small">Bought it on scrap.tf or sold it? Write it to your journal; Holdings tracks what you hold.</span>
      </div>

      <section className="drawer-section" aria-labelledby="sec-profit">
        <h3 id="sec-profit">Profit by input</h3>
        {d.opportunities.length ? (
          <div className="input-cards">
            {d.opportunities.map((o) => (
              <InputCard key={o.key} o={o} keyScrap={keyScrap} now={now} ruleName={o.inputRef.startsWith('rule:') ? ruleNames.get(Number(o.inputRef.slice(5))) : undefined} />
            ))}
          </div>
        ) : (
          <p className="muted">
            No scrap.tf price or rule covers this item yet. Record the price you see on scrap.tf below
            {ceiling !== null ? (
              <>
                ; pay up to <Money scrap={ceiling} keyScrap={keyScrap} /> for a flip
              </>
            ) : null}
            .
          </p>
        )}
      </section>

      <ScraptfListSection d={d} row={d.scraptfList} keyScrap={keyScrap} now={now} onChanged={afterChange} />

      {/* F20 (U1): the price on each of the user's saves of its bank, time listed and its change events. */}
      <ScraptfHistory sku={d.sku} keyScrap={keyScrap} now={now} />

      <PriceSection d={d} keyScrap={keyScrap} now={now} ceiling={ceiling} onChanged={afterChange} onOpenQuick={openQuick} />

      <OrderBook
        title="Buy orders"
        orders={d.buyOrders}
        keyScrap={keyScrap}
        now={now}
        kind="buy"
        buyer={{ actions: buyers, highlight: checkListings, onOpenSettings: openSettings, onRecordSale: recordSaleTo }}
      />
      <OrderBook title="Sell listings" orders={d.sellListings} keyScrap={keyScrap} now={now} kind="sell" />

      <section className="drawer-section" aria-labelledby="sec-refs">
        <h3 id="sec-refs">Reference prices</h3>
        <References d={d} keyScrap={keyScrap} now={now} />
        <SteamMarketCheck sku={d.sku} unusual={d.skuObject.quality === 5} />
      </section>

      <section className="drawer-section" aria-labelledby="sec-history">
        <h3 id="sec-history">Price history</h3>
        <Sparkline history={d.history} keyScrap={keyScrap} />
        <p className="attribution muted small">Prices by PriceDB.io</p>
      </section>

      <section className="drawer-section" aria-labelledby="sec-links">
        <h3 id="sec-links">Open in your browser</h3>
        <LinkMenu links={linkList} />
      </section>
      {recordTrade.element}
    </div>
  );
}

function DrawerHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header className="drawer-head">
      <h2 id="item-title" className="drawer-title">
        {title}
      </h2>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close item">
        <Icon name="close" />
      </button>
    </header>
  );
}

function InputCard({ o, keyScrap, now, ruleName }: { o: Opportunity; keyScrap: Scrap | null; now: number; ruleName?: string | undefined }) {
  const label =
    o.inputKind === 'rule' ? `Rule: ${ruleName ?? o.inputRef.replace('rule:', '#')}` : `${INPUT_KIND_LABELS[o.inputKind]} ${o.inputRef.replace('price:', '#')}`;
  const verdict = ceilingVerdict(o.costScrap, o.maxCostScrap);
  return (
    <div className={`input-card status-${o.status}`}>
      <div className="input-card-head">
        <span className="input-card-title">{label}</span>
        <TonePill tone={STATUS_TONE[o.status]}>{STATUS_LABELS[o.status]}</TonePill>
      </div>
      <dl className="kv">
        <dt>Cost</dt>
        <dd>
          <Money scrap={o.costScrap} keyScrap={keyScrap} />
          {o.costKeys && fmtKeysMetal(o.costKeys, o.costScrapRaw) !== fmtMoney(o.costScrap, keyScrap) ? (
            <span className="muted small"> (entered as {fmtKeysMetal(o.costKeys, o.costScrapRaw)})</span>
          ) : null}
          <span className="muted small"> · seen {fmtAgo(o.inputObservedAt, now)}</span>
        </dd>
        <dt>Revenue</dt>
        <dd>
          <Money scrap={o.revenueScrap} keyScrap={keyScrap} />
          <span className="muted small">
            {' '}
            best {fmtMoney(o.bestScrap, keyScrap)} · instant {fmtMoney(o.instantScrap, keyScrap)}
          </span>
        </dd>
        <dt title={PAY_UP_TO_HELP}>Pay up to</dt>
        <dd title={PAY_UP_TO_HELP}>
          {o.maxCostScrap !== null ? (
            <>
              <strong>
                <Money scrap={o.maxCostScrap} keyScrap={keyScrap} />
              </strong>
              {verdict ? (
                <span className={`small ${verdict.under ? 'tone-text-good' : 'tone-text-bad'}`}>
                  {' '}
                  · {o.inputKind === 'rule' ? 'estimate' : 'cost'}{' '}
                  {verdict.diffScrap === 0 ? 'at the ceiling' : `${fmtMoney(verdict.diffScrap, keyScrap)} ${verdict.under ? 'under' : 'over'}`}
                </span>
              ) : null}
            </>
          ) : (
            <span className="muted">{o.revenueScrap === null ? '— (no eligible buy order)' : '— (no price clears your thresholds)'}</span>
          )}
        </dd>
        <dt>Profit</dt>
        <dd>
          <strong>
            <Money scrap={o.profitScrap} keyScrap={keyScrap} tone="profit" signed />
          </strong>
          <span className="muted small"> · margin {fmtPct(o.margin)}</span>
        </dd>
        <dt>Confidence</dt>
        <dd>
          <ConfidenceBadge score={o.confidence} level={o.confidenceLevel} reasons={o.reasons} />
        </dd>
      </dl>
      {o.flags.length ? <FlagList flags={o.flags} /> : null}
      {o.reasons.length ? (
        <details className="reasons-details">
          <summary>Why this confidence</summary>
          <ul>
            {o.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// scrap.tf price list (F14)
// ---------------------------------------------------------------------------

/**
 * The item's row of the user's saved scrap.tf/items list: what scrap.tf charges and pays, its stock
 * and the save's age, with "Use as my price" and scrap.tf/items to open in the user's browser (UX-11: the
 * item's bank page is the header's Open on scrap.tf, so it is not offered twice). The list only ever comes
 * from a page the user saved (R10); Flip Desk never loads scrap.tf on its own (R1).
 */
function ScraptfListSection({ d, row, keyScrap, now, onChanged }: { d: ItemDetail; row: ScraptfListRow | null | undefined; keyScrap: Scrap | null; now: number; onChanged: () => void }) {
  const { toast, settings } = useApp();
  const [saving, setSaving] = useState(false);
  // A second click before the first save answers would add the price twice.
  const savingRef = useRef(false);
  const view = row ? scraptfListView(row, keyScrap, now) : null;
  // The list prices the plain copy; a painted drawer shows that copy's row, and says so.
  const otherCopy = row ? listRowIsOtherCopy(row, d.sku) : false;
  // Each prices.upsert adds a row: once this list price is on the sheet, a second click would only duplicate it.
  // A painted drawer's own prices never hold the plain copy's row, so the service answers for it.
  const used = row ? d.scraptfListSaved || listPriceAlreadySaved(row, d.scrapPrices) : false;

  const saveAsMine = async () => {
    const input = row ? listPriceInput(row, d) : null;
    if (!row || !input || used || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await rpc('prices.upsert', input);
      toast(listPriceSavedText(saved, row.observedAt, Date.now()), 'good');
      onChanged();
    } catch (e) {
      toast(`Could not save the price: ${errorMessage(e)}`, 'bad');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section className="drawer-section stf-list" aria-labelledby="sec-stf-list">
      <div className="section-head">
        <h3 id="sec-stf-list">scrap.tf price list</h3>
        {/* The age reads next to the prices; only a save Holdings no longer trusts gets a pill. */}
        {view && !view.fresh ? (
          <TonePill tone="warn" title={view.title}>
            Over a day old
          </TonePill>
        ) : null}
      </div>
      {view ? (
        <p className="stf-list-line" title={view.title}>
          <span title={view.sellsTitle}>
            {view.hasSells ? (
              <>
                sells <strong className="money">{view.sells}</strong>
              </>
            ) : (
              <strong>{view.sells}</strong>
            )}
            {otherCopy ? (
              <span className="muted" title="scrap.tf's list prices the plain copy of this item, not this painted one.">
                {' '}
                (plain copy)
              </span>
            ) : null}
          </span>
          <span className="stf-sep" aria-hidden="true">
            ·
          </span>
          <span title={view.paysTitle}>
            pays <strong className="money">{view.pays}</strong>
          </span>
          {view.stock !== null ? (
            <>
              <span className="stf-sep" aria-hidden="true">
                ·
              </span>
              <span>
                stock <span className="num">{view.stock}</span>
                {view.full ? (
                  <>
                    {' '}
                    <TonePill tone="warn" title="scrap.tf is at its limit for this item, so it buys no more right now (as of your saved list).">
                      Full
                    </TonePill>
                  </>
                ) : null}
              </span>
            </>
          ) : null}
          <span className="stf-sep" aria-hidden="true">
            ·
          </span>
          <span className={view.fresh ? 'muted' : 'tone-text-warn'}>{view.saved}</span>
        </p>
      ) : (
        <p className="muted small">
          Not on your saved scrap.tf price list. Open scrap.tf/items, save it with Ctrl+S as <strong>{SAVE_MODE}</strong> into your watch folder (Import), and scrap.tf&apos;s prices for every item it
          trades show here.
        </p>
      )}
      <div className="stf-list-actions" role="group" aria-label="scrap.tf price list actions">
        {row && view ? (
          <button
            type="button"
            className="btn small"
            disabled={!view.canUse || used || saving}
            title={
              !view.canUse
                ? (view.unusable ?? undefined)
                : used
                  ? otherCopy
                    ? `${view.sells} from this saved list is already one of your prices, for a plain copy (Price sheet).`
                    : `${view.sells} from this saved list is already one of your prices (Your scrap.tf prices, below).`
                  : `Save ${view.sells} (scrap.tf's price to buy, as listed) as your typed price for a plain copy, dated when you saved the list.`
            }
            onClick={() => void saveAsMine()}
          >
            <Icon name="check" size={13} /> {saving ? 'Saving…' : used ? 'Saved as my price' : 'Use as my price'}
          </button>
        ) : null}
        <button type="button" className="btn small ghost" title={`${SCRAPTF_ITEMS_URL}: open it in your browser to save the whole list again`} onClick={() => void openOrCopy(SCRAPTF_ITEMS_URL, toast)}>
          <Icon name="external" size={12} /> Open scrap.tf/items
        </button>
      </div>
      <p className="muted small stf-list-note">{listBoundaryNote(scraptfWindowOn(settings))}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Your scrap.tf prices (F8)
// ---------------------------------------------------------------------------

function PriceSection({
  d,
  keyScrap,
  now,
  ceiling,
  onChanged,
  onOpenQuick,
}: {
  d: ItemDetail;
  keyScrap: Scrap | null;
  now: number;
  ceiling: Scrap | null;
  onChanged: () => void;
  onOpenQuick: () => void;
}) {
  const { toast, settings, closeItem, navigate } = useApp();
  const staleMs = settings?.profit.inputStaleMs ?? DEFAULT_SETTINGS.profit.inputStaleMs;
  const heading = priceFormHeading(d);

  const seenNow = async (p: ScrapPrice) => {
    try {
      await rpc('prices.upsert', reconfirmInput(p, Date.now()));
      toast(`Marked ${fmtKeysMetal(p.costKeys, p.costScrap)} as seen now`, 'good');
      onChanged();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const remove = async (p: ScrapPrice) => {
    try {
      await rpc('prices.delete', { id: p.id });
      toast(`Deleted the ${fmtKeysMetal(p.costKeys, p.costScrap)} price`, 'info');
      onChanged();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  return (
    <section className="drawer-section" aria-labelledby="sec-prices">
      <div className="section-head">
        <h3 id="sec-prices">
          Your scrap.tf prices {d.scrapPrices.length ? <span className="count-badge">{d.scrapPrices.length}</span> : null}
        </h3>
        <button type="button" className="btn small ghost" onClick={onOpenQuick} title="Open the quick-entry window with this item picked">
          <Icon name="quick" size={14} /> Open in quick entry
        </button>
      </div>
      {d.scrapPrices.length ? (
        <ul className="plain-list price-lines">
          {d.scrapPrices.map((p) => {
            const age = now - p.observedAt;
            const stale = age > staleMs;
            const price = fmtKeysMetal(p.costKeys, p.costScrap);
            return (
              <li key={p.id} className="price-line">
                <span className="money">{price}</span>
                <span className="muted">
                  {p.source === 'import' ? `imported${p.importBatch ? ` (batch ${p.importBatch})` : ''}` : 'typed'} ·{' '}
                  <span className={stale ? 'tone-text-warn' : undefined} title={`${fmtDateTime(p.observedAt)}${stale ? ' (stale: check scrap.tf again)' : ''}`}>
                    {fmtAgo(p.observedAt, now)}
                  </span>
                  {p.stock !== null ? ` · stock ${p.stock}` : ''}
                </span>
                {p.note ? <span className="muted">· {p.note}</span> : null}
                <span className="row-actions price-line-actions">
                  <button type="button" className="btn small ghost" title="Still this price on scrap.tf: mark it as seen now" aria-label={`Mark ${price} as seen now`} onClick={() => void seenNow(p)}>
                    <Icon name="check" size={13} /> Seen now
                  </button>
                  <ConfirmButton className="btn small ghost" ariaLabel={`Delete the ${price} price`} title="Delete this price" confirmLabel="Delete?" onConfirm={() => void remove(p)}>
                    <Icon name="trash" size={13} /> Delete
                  </ConfirmButton>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="drawer-price-card">
        <div className="drawer-price-title">{heading.title}</div>
        <p className="muted small">{heading.hint}</p>
        <DrawerPriceForm key={d.sku} d={d} keyScrap={keyScrap} now={now} ceiling={ceiling} onSaved={onChanged} />
      </div>

      {d.scrapPrices.length ? (
        <button
          type="button"
          className="link-btn small"
          onClick={() => {
            closeItem();
            navigate('prices');
          }}
        >
          Edit in the price sheet
        </button>
      ) : null}
    </section>
  );
}

function DrawerPriceForm({ d, keyScrap, now, ceiling, onSaved }: { d: ItemDetail; keyScrap: Scrap | null; now: number; ceiling: Scrap | null; onSaved: () => void }) {
  const { toast } = useApp();
  const userPrices = useMemo(() => d.scrapPrices.filter((p) => p.source === 'user').sort((a, b) => b.observedAt - a.observedAt), [d.scrapPrices]);
  const [targetId, setTargetId] = useState<number | null>(() => defaultPriceTarget(d.scrapPrices));
  // A price deleted meanwhile (here or elsewhere) turns the form back into "add".
  const target = userPrices.find((p) => p.id === targetId) ?? null;
  const [text, setText] = useState('');
  const [unit, setUnit] = usePersistentState<BareUnit>('price.unit', 'ref', sanitizeUnit);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A second Enter before the first save answers would add the price twice.
  const savingRef = useRef(false);
  const priceRef = useRef<HTMLInputElement>(null);

  const parsed = text.trim() ? readPrice(text, unit) : null;
  const verdict = ceilingVerdict(parsedValueScrap(parsed, keyScrap), ceiling);

  const submit = async () => {
    if (savingRef.current) return;
    setError(null);
    const price = readPrice(text, unit);
    if (!price) {
      setError('Enter a price, for example 1.33 or 2 keys 5.11.');
      priceRef.current?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await rpc('prices.upsert', drawerPriceInput({ sku: d.sku, name: d.name, price, note, target, now: Date.now() }));
      toast(`${target ? 'Updated' : 'Added'} ${saved.name} at ${fmtKeysMetal(saved.costKeys, saved.costScrap)}`, 'good');
      setText('');
      setNote('');
      setTargetId(saved.id);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <form
      className="form-grid drawer-price-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {userPrices.length ? (
        <Field label="Save as" htmlFor="dp-target">
          <select id="dp-target" className="input select" value={target ? String(target.id) : 'new'} onChange={(e) => setTargetId(e.target.value === 'new' ? null : Number(e.target.value))}>
            {userPrices.map((p) => (
              <option key={p.id} value={String(p.id)}>
                Update typed price #{p.id} ({fmtKeysMetal(p.costKeys, p.costScrap)}, {fmtAgo(p.observedAt, now)})
              </option>
            ))}
            <option value="new">New price</option>
          </select>
        </Field>
      ) : null}
      <Field label="scrap.tf price" htmlFor="dp-price">
        <PriceInput
          ref={priceRef}
          id="dp-price"
          text={text}
          onText={setText}
          unit={unit}
          onUnit={setUnit}
          keyScrap={keyScrap}
          {...(target ? { placeholder: `now ${fmtKeysMetal(target.costKeys, target.costScrap)}` } : {})}
        />
      </Field>
      <Field label="Note (optional)" htmlFor="dp-note">
        <input
          id="dp-note"
          className="input"
          type="text"
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={target?.note ? `Keeps "${truncate(target.note, 40)}"` : 'e.g. 2 in stock'}
        />
      </Field>
      {ceiling !== null ? (
        <div className="drawer-ceiling small" title={PAY_UP_TO_HELP}>
          Pay up to <Money scrap={ceiling} keyScrap={keyScrap} />
          {verdict ? (
            <span className={verdict.under ? 'tone-text-good' : 'tone-text-bad'}>
              {' '}
              · {verdict.diffScrap === 0 ? 'right at the ceiling' : `${fmtMoney(verdict.diffScrap, keyScrap)} ${verdict.under ? 'under' : 'over'} the ceiling`}
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={saving}>
          <Icon name={target ? 'check' : 'plus'} size={14} /> {target ? 'Update price' : 'Add price'}
        </button>
        <span className="muted small">Saved as seen now.</span>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Buyer actions (F3)
// ---------------------------------------------------------------------------

interface CheckState {
  busy: boolean;
  result: BuyerCheck | null;
  error: string | null;
}

interface BuyerActions {
  checks: Readonly<Record<string, CheckState>>;
  blocked: ReadonlySet<string>;
  check: (steamid: string) => Promise<void>;
  block: (o: OrderSummary) => Promise<void>;
  unblock: (o: OrderSummary) => Promise<void>;
}

function useBuyerActions(onChanged: () => void): BuyerActions {
  const { settings, updateSettings, toast } = useApp();
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const blocked = useMemo(() => new Set(settings?.blocklist ?? []), [settings]);

  // Always from a fresh settings.get, and always the full list: arrays replace in mergeSettings.
  const deps: BlocklistDeps = { getSettings: () => rpc('settings.get'), save: (patch) => updateSettings(patch) };

  const check = async (steamid: string) => {
    if (!isSteamId64(steamid)) return;
    setChecks((c) => ({ ...c, [steamid]: { busy: true, result: c[steamid]?.result ?? null, error: null } }));
    try {
      const result = await rpc('buyer.check', { steamid });
      setChecks((c) => ({ ...c, [steamid]: { busy: false, result, error: null } }));
    } catch (e) {
      setChecks((c) => ({ ...c, [steamid]: { busy: false, result: null, error: errorMessage(e) } }));
    }
  };

  const block = async (o: OrderSummary) => {
    const who = buyerLabel(o);
    const steamid = o.steamid;
    try {
      const r = await blockBuyer(steamid, deps);
      if (r === 'already') toast(`${who} is already on your blocklist.`, 'info');
      else if (r === 'blocked') {
        // H3: Undo lives on the toast (12 s, held while hovered or focused); it unblocks from a fresh read.
        toast(`Blocked ${who}. Their orders no longer count toward profit.`, 'info', { action: { label: 'Undo', onClick: () => void remove(steamid, who) } });
        onChanged();
      }
      // 'failed': updateSettings has already said why.
    } catch (e) {
      toast(`Could not block ${who}: ${errorMessage(e)}`, 'bad');
    }
  };

  const remove = async (steamid: string, who: string) => {
    try {
      const r = await unblockBuyer(steamid, deps);
      if (r === 'unblocked') {
        toast(`Removed ${who} from your blocklist.`, 'good');
        onChanged();
      } else if (r === 'absent') toast(`${who} is not on your blocklist.`, 'info');
    } catch (e) {
      toast(`Could not unblock ${who}: ${errorMessage(e)}`, 'bad');
    }
  };

  return {
    checks,
    blocked,
    check,
    block,
    unblock: (o) => remove(o.steamid, buyerLabel(o)),
  };
}

interface BuyerProps {
  actions: BuyerActions;
  /** listingIds whose Check bans is highlighted (revenue order of a 'background-check' opportunity). */
  highlight: ReadonlySet<string>;
  onOpenSettings: () => void;
  /** "Record sale to this buyer" (F12): the Record trade dialog at this order's price. */
  onRecordSale: (o: OrderSummary) => void;
}

function OrderBook({
  title,
  orders,
  keyScrap,
  now,
  kind,
  buyer,
}: {
  title: string;
  orders: OrderSummary[];
  keyScrap: Scrap | null;
  now: number;
  kind: 'buy' | 'sell';
  buyer?: BuyerProps;
}) {
  const { toast } = useApp();
  const [showExcluded, setShowExcluded] = useState(true);
  const [menu, setMenu] = useState<{ seq: number; order: OrderSummary; at: MenuPoint; opener: Element | null; anchor: Element | null } | null>(null);
  const menuSeq = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const excluded = orders.filter((o) => !o.eligible).length;
  const shown = showExcluded ? orders : orders.filter((o) => o.eligible);
  const id = `sec-${kind}`;
  const columns = buyer ? 6 : 4;

  // Memoised: the drawer re-renders every second (relative times), and new sections would re-run the menu's focus effect each time.
  const menuBlocked = menu && buyer ? buyer.actions.blocked.has(menu.order.steamid) : false;
  const menuHighlight = menu && buyer ? buyer.highlight.has(menu.order.listingId) : false;
  const menuChecking = menu && buyer ? buyer.actions.checks[menu.order.steamid]?.busy === true : false;
  const menuSections = useMemo(
    () => (menu ? buyerMenuSections(menu.order, { blocked: menuBlocked, highlightCheck: menuHighlight, checking: menuChecking }) : null),
    [menu, menuBlocked, menuHighlight, menuChecking],
  );

  /** `anchor`: the button the menu hangs under (a right-click anchors on the row under the pointer). */
  const openMenu = (order: OrderSummary, at: MenuPoint, anchor: Element | null = null) => {
    const active = document.activeElement;
    const seq = ++menuSeq.current;
    setMenu((prev) => ({
      seq,
      order,
      at,
      // Reopened from inside the open menu: focus still belongs back on the original row button.
      opener: active instanceof Element && active.closest('.item-menu') ? (prev?.opener ?? null) : active === document.body ? null : active,
      anchor,
    }));
  };

  const runBuyerAction = (a: BuyerMenuAction, o: OrderSummary) => {
    if (!buyer) return;
    switch (a.kind) {
      case 'open':
        void openOrCopy(a.url, toast);
        return;
      case 'copy-id':
        void copyText(o.steamid).then((ok) => toast(copiedMessage(o.steamid, ok), ok ? 'good' : 'bad'));
        return;
      case 'record-sale':
        buyer.onRecordSale(o);
        return;
      case 'check':
        void buyer.actions.check(o.steamid);
        return;
      case 'block':
        void buyer.actions.block(o);
        return;
      case 'unblock':
        void buyer.actions.unblock(o);
        return;
    }
  };

  return (
    <section ref={sectionRef} className="drawer-section" aria-labelledby={id}>
      <div className="section-head">
        <h3 id={id}>
          {title} <span className="count-badge">{orders.length}</span>
        </h3>
        {excluded ? (
          <label className="check-inline small">
            <input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} /> Show {excluded} excluded
          </label>
        ) : null}
      </div>
      {shown.length ? (
        <div className="table-wrap">
          <table className="table compact-table">
            <thead>
              <tr>
                <th className="num">Price</th>
                <th>{kind === 'buy' ? 'Buyer' : 'Seller'}</th>
                <th className="num">Seen</th>
                <th>Note</th>
                {buyer ? <th>Flags</th> : null}
                {buyer ? (
                  <th className="actions-col">
                    <span className="sr-only">Buyer actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const highlight = buyer?.highlight.has(o.listingId) ?? false;
                const check = buyer?.actions.checks[o.steamid];
                const who = buyerLabel(o);
                const onRowMenu = buyer
                  ? (e: ReactMouseEvent) => {
                      e.preventDefault();
                      openMenu(o, menuPointFromEvent({ x: e.clientX, y: e.clientY }));
                    }
                  : undefined;
                return (
                  <Fragment key={o.listingId}>
                    <tr className={[o.eligible ? '' : 'excluded', highlight ? 'bg-check-row' : ''].filter(Boolean).join(' ') || undefined} onContextMenu={onRowMenu}>
                      <td className="num">
                        <span className="money" title={`${o.valueScrap} scrap`}>
                          {fmtKeysMetal(o.keys, o.metalScrap)}
                        </span>
                        {o.keys ? <div className="muted small">{fmtRefOnly(o.valueScrap)}</div> : null}
                      </td>
                      <td>
                        <span className="buyer-type">
                          <OnlineDot online={o.online} />
                          {o.isBot ? <Icon name="bolt" size={12} title="Bot (user agent)" /> : <Icon name="user" size={12} title="Human" />}
                          <span className="buyer-name" title={o.steamid}>
                            {o.userName ?? 'unknown'}
                          </span>
                        </span>
                      </td>
                      <td className="num" title={`Last event ${fmtDateTime(o.lastEventAt)}${o.bumpedAt ? `, bumped ${fmtDateTime(o.bumpedAt * 1000)}` : ''}`}>
                        {fmtAge(now - o.lastEventAt)}
                      </td>
                      <td className="note-cell" title={o.details || undefined}>
                        {o.details ? truncate(o.details, 70) : <span className="muted">—</span>}
                      </td>
                      {buyer ? (
                        <td>
                          {!o.eligible ? <span className="chip-flag tone-muted">Excluded</span> : null}
                          <FlagList flags={o.flags} />
                        </td>
                      ) : null}
                      {buyer ? (
                        <td className="actions-col">
                          <div className="row-actions">
                            {highlight ? (
                              <button
                                type="button"
                                className="btn small warn"
                                disabled={check?.busy === true || !isSteamId64(o.steamid)}
                                title="This order sets the revenue of an item worth a background check: check the buyer for bans before trading"
                                onClick={() => void buyer.actions.check(o.steamid)}
                              >
                                <Icon name="shield" size={12} /> {check?.busy ? 'Checking…' : 'Check bans'}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="icon-btn buyer-menu-btn"
                              aria-haspopup="menu"
                              aria-expanded={menu?.order.listingId === o.listingId}
                              aria-label={`Actions for buyer ${who}`}
                              title="Buyer actions"
                              onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                // Right-aligned under the button: placeMenu flips it left at the drawer's edge,
                                // and above the button (upY) near the bottom of the window.
                                openMenu(o, { x: r.right, y: r.bottom + 2, upY: r.top - 2 }, e.currentTarget);
                              }}
                            >
                              <Icon name="user" size={13} />
                              <Icon name="chevronDown" size={12} />
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                    {buyer && check ? (
                      <tr className="buyer-check-row">
                        <td colSpan={columns}>
                          <BuyerCheckLine state={check} now={now} onOpenSettings={buyer.onOpenSettings} onRetry={() => void buyer.actions.check(o.steamid)} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">
          {kind === 'buy'
            ? 'No buy orders for this exact item. They appear here as soon as the live feed sees one.'
            : 'No sell listings stored. Sell listings are kept only for items you track (Settings, Live feed).'}
        </p>
      )}
      {kind === 'buy' && orders.length ? <p className="attribution muted small">Data from backpack.tf</p> : null}
      {buyer && menu && menuSections ? (
        <MenuPopover
          key={menu.seq}
          at={menu.at}
          label={`Actions for buyer ${buyerLabel(menu.order)}`}
          title={buyerLabel(menu.order)}
          sections={menuSections}
          opener={menu.opener}
          // Inside the drawer's aria-modal dialog, not on document.body.
          container={modalHostOf(sectionRef.current)}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onAction={(a) => runBuyerAction(a, menu.order)}
        />
      ) : null}
    </section>
  );
}

function BuyerCheckLine({ state, now, onOpenSettings, onRetry }: { state: CheckState; now: number; onOpenSettings: () => void; onRetry: () => void }) {
  if (state.busy && !state.result) {
    return (
      <div className="buyer-check tone-muted" role="status">
        <Spinner label="Checking bans" />
        <span>Checking bans on backpack.tf…</span>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="buyer-check tone-warn" role="status">
        <Icon name="warning" size={14} />
        <span>Ban check failed: {state.error}</span>
        <button type="button" className="link-btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (!state.result) return null;
  const v = describeBuyerCheck(state.result, now);
  const profiles = buyerProfileUrls(state.result.steamid);
  return (
    <div className={`buyer-check tone-${v.tone}`} role="status">
      <Icon name={v.tone === 'good' ? 'check' : v.tone === 'muted' ? 'info' : 'warning'} size={14} />
      <span>
        {v.text}
        {v.details.length ? <span className="buyer-check-details"> {v.details.join('; ')}</span> : null}
      </span>
      {v.when ? <span className="muted">{v.when}</span> : null}
      {v.needsSettings ? (
        <button type="button" className="link-btn" onClick={onOpenSettings}>
          Open Settings
        </button>
      ) : null}
      {v.retry ? (
        <button type="button" className="link-btn" disabled={state.busy} onClick={onRetry}>
          {state.busy ? 'Checking…' : 'Try again'}
        </button>
      ) : null}
      {/* backpack.tf bans are not the whole story; the profile shows trust and other site bans. */}
      {!v.needsSettings && profiles ? <BuyerProfileLink url={profiles.backpack} /> : null}
    </div>
  );
}

function BuyerProfileLink({ url }: { url: string }) {
  const { toast } = useApp();
  return (
    <button type="button" className="link-btn" title={url} onClick={() => void openOrCopy(url, toast)}>
      Profile <Icon name="external" size={12} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// References, Steam Market, links
// ---------------------------------------------------------------------------

type ScmResult = { lowest: string | null; median: string | null; volume: string | null; marketHashName: string | null } | null;

/** Steam Community Market price overview: off unless enabled in Settings, one request per click. */
function SteamMarketCheck({ sku, unusual }: { sku: string; unusual: boolean }) {
  const { settings } = useApp();
  const [state, setState] = useState<{ busy: boolean; result: ScmResult | undefined; error: string | null }>({ busy: false, result: undefined, error: null });
  if (!settings?.connectors.scm) return null;
  const check = async () => {
    setState({ busy: true, result: undefined, error: null });
    try {
      setState({ busy: false, result: await rpc('item.scm', { sku }), error: null });
    } catch (e) {
      setState({ busy: false, result: undefined, error: errorMessage(e) });
    }
  };
  const r = state.result;
  return (
    <div className="scm-check">
      <button type="button" className="btn small" disabled={state.busy} onClick={() => void check()}>
        {state.busy ? 'Checking…' : 'Check Steam Market price'}
      </button>
      {state.error ? <span className="small tone-text-bad">{state.error}</span> : null}
      {r === null ? <span className="muted small">Steam Market lookups are off or paused.</span> : null}
      {r ? (
        r.marketHashName === null ? (
          <span className="muted small">This item is not sold on the Steam Market.</span>
        ) : (
          <span className="small">
            Lowest {r.lowest ?? '—'} · median {r.median ?? '—'} · {r.volume ?? '0'} sold in 24 h
            <span className="muted">
              {' '}
              (USD, Steam Wallet funds, about 15% fees{unusual ? '; one price for every effect' : ''})
            </span>
          </span>
        )
      ) : null}
    </div>
  );
}

function References({ d, keyScrap, now }: { d: ItemDetail; keyScrap: Scrap | null; now: number }) {
  const { settings } = useApp();
  // Same limit the engine uses to ignore a reference (F4); older ones are shown faded and marked.
  // Community prices get at least a year there, so they use their own limit.
  const maxAge = settings?.profit.referenceMaxAgeMs ?? DEFAULT_SETTINGS.profit.referenceMaxAgeMs;
  const p = d.references.pricedb;
  const c = d.references.community;
  const gates = referenceAgeGates(d.references, maxAge, now);
  const pOld = gates.pricedb.old;
  const cAge = gates.community.ageMs;
  const cOld = gates.community.old;
  const ignored = (limitMs: number) => ` (over ${fmtDays(limitMs)}, ignored)`;
  return (
    <div className="ref-grid">
      <div className={`ref-card${pOld ? ' faded' : ''}`}>
        <div className="ref-title">PriceDB</div>
        {p ? (
          <dl className="kv tight">
            <dt>Buy</dt>
            <dd>
              <Money scrap={p.buyScrap} keyScrap={keyScrap} />
            </dd>
            <dt>Sell</dt>
            <dd>
              <Money scrap={p.sellScrap} keyScrap={keyScrap} />
            </dd>
            <dt>Age</dt>
            <dd className={pOld ? 'tone-text-warn' : undefined}>
              {p.ageMs !== null ? fmtAge(p.ageMs) : p.time ? fmtAge(now - p.time * 1000) : '—'}
              {pOld ? ignored(gates.pricedb.limitMs) : ''}
            </dd>
          </dl>
        ) : (
          <p className="muted small">No reliable PriceDB price.</p>
        )}
      </div>
      <div className={`ref-card${cOld ? ' faded' : ''}`}>
        <div className="ref-title">backpack.tf community</div>
        {c ? (
          <dl className="kv tight">
            <dt>Value</dt>
            <dd>
              <Money scrap={c.valueScrap} keyScrap={keyScrap} />
              {c.valueHighScrap !== null ? (
                <>
                  {' '}
                  – <Money scrap={c.valueHighScrap} keyScrap={keyScrap} />
                </>
              ) : null}
            </dd>
            <dt>Updated</dt>
            <dd className={cOld ? 'tone-text-warn' : undefined}>
              {cAge !== null ? `${fmtAge(cAge)} ago` : '—'}
              {cOld ? ignored(gates.community.limitMs) : ''}
            </dd>
          </dl>
        ) : (
          <p className="muted small">No community price (needs a backpack.tf API key).</p>
        )}
      </div>
    </div>
  );
}

export function LinkMenu({ links }: { links: LinkSpec[] }) {
  const { toast } = useApp();
  const grouped = useMemo(() => groupLinks(links), [links]);
  if (!links.length) return <p className="muted small">No links for this item.</p>;
  return (
    <div className="link-menu">
      {grouped.map((g) => (
        <div key={g.group} className="link-group">
          <div className="link-group-title">{g.label}</div>
          <div className="link-buttons">
            {g.links.map((l) => (
              <button key={l.id} type="button" className="btn small" title={l.url} onClick={() => void openOrCopy(l.url, toast)}>
                <Icon name="external" size={12} /> {l.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
