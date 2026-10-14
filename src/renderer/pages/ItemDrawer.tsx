import { useEffect, useMemo, useState } from 'react';
import type { ItemDetail, LinkGroup, LinkSpec, Opportunity, OrderSummary, PriceRule, Scrap } from '../../shared/types';
import { rpc } from '../api';
import { copyText } from '../clipboard';
import { Drawer } from '../components/Drawer';
import { openOrCopy } from '../components/ExternalLink';
import { ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ItemName, Money } from '../components/ItemName';
import { ConfidenceBadge, FlagList, OnlineDot, TonePill } from '../components/Pills';
import { Sparkline } from '../components/Sparkline';
import {
  INPUT_KIND_LABELS,
  STATUS_LABELS,
  categoryLabel,
  errorMessage,
  fmtAge,
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
import { usePush, useRpcQuery, useThrottled } from '../hooks/useRpc';
import { useNow } from '../hooks/useTimers';

export function ItemDrawer() {
  const { itemSku, closeItem } = useApp();
  return (
    <Drawer open={itemSku !== null} onClose={closeItem} labelledBy="item-title">
      {itemSku ? <ItemDetailView key={itemSku} sku={itemSku} /> : null}
    </Drawer>
  );
}

const STATUS_TONE = { profitable: 'good', 'below-threshold': 'warn', unprofitable: 'bad', 'no-buyers': 'muted' } as const;
const LINK_GROUP_LABELS: Record<LinkGroup, string> = { backpack: 'backpack.tf', market: 'Markets', tools: 'Tools' };

function ItemDetailView({ sku }: { sku: string }) {
  const { keyScrap: statusKey, toast, closeItem, navigate, secrets, settings } = useApp();
  const detail = useRpcQuery('item.detail', { sku });
  const assetId = detail.data?.scrapPrices.find((p) => p.assetId)?.assetId ?? null;
  const links = useRpcQuery('links.forSku', { sku, assetId }, { enabled: detail.data !== undefined });
  const hasRules = detail.data?.opportunities.some((o) => o.inputKind === 'rule') ?? false;
  const rules = useRpcQuery('rules.list', undefined, { enabled: hasRules });
  const reload = useThrottled(() => void detail.reload(), 2000);
  usePush('opps.changed', reload);
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

  const d = detail.data;
  const keyScrap = d?.keyPrice?.valueScrap ?? statusKey;

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

  const copySku = async () => {
    const ok = await copyText(sku);
    toast(ok ? `Copied ${sku}` : 'Could not copy to the clipboard.', ok ? 'good' : 'bad');
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

  return (
    <div className="drawer-body">
      <header className="drawer-head">
        <div className="drawer-title-wrap">
          <h2 id="item-title" className="drawer-title">
            <ItemName sku={d.sku} name={d.name} maxTags={6} />
          </h2>
          <div className="drawer-sub">
            <code className="sku">{d.sku}</code>
            <button type="button" className="icon-btn" onClick={() => void copySku()} aria-label="Copy SKU" title="Copy SKU">
              <Icon name="copy" size={14} />
            </button>
            <span className="muted">· {categoryLabel(d.category)}</span>
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
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      closeItem();
                      navigate('settings');
                    }}
                  >
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
            No scrap.tf price or rule covers this item.{' '}
            <button type="button" className="link-btn" onClick={() => void rpc('app.showQuickEntry')}>
              Add a price
            </button>
          </p>
        )}
      </section>

      <OrderBook title="Buy orders" orders={d.buyOrders} keyScrap={keyScrap} now={now} kind="buy" />
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

      {d.scrapPrices.length ? (
        <section className="drawer-section" aria-labelledby="sec-prices">
          <h3 id="sec-prices">Your scrap.tf prices</h3>
          <ul className="plain-list">
            {d.scrapPrices.map((p) => (
              <li key={p.id} className="price-line">
                <span className="money">{fmtKeysMetal(p.costKeys, p.costScrap)}</span>
                <span className="muted">
                  {p.source === 'import' ? `imported${p.importBatch ? ` (batch ${p.importBatch})` : ''}` : 'typed'} · {fmtAge(now - p.observedAt)} ago
                  {p.stock !== null ? ` · stock ${p.stock}` : ''}
                </span>
                {p.note ? <span className="muted">· {p.note}</span> : null}
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn" onClick={() => {
            closeItem();
            navigate('prices');
          }}>
            Edit in the price sheet
          </button>
        </section>
      ) : null}

      <section className="drawer-section" aria-labelledby="sec-links">
        <h3 id="sec-links">Open in your browser</h3>
        <LinkMenu links={linkList} />
      </section>
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
          <span className="muted small"> · {fmtAge(now - o.inputObservedAt)} old</span>
        </dd>
        <dt>Revenue</dt>
        <dd>
          <Money scrap={o.revenueScrap} keyScrap={keyScrap} />
          <span className="muted small">
            {' '}
            best {fmtMoney(o.bestScrap, keyScrap)} · instant {fmtMoney(o.instantScrap, keyScrap)}
          </span>
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

function OrderBook({ title, orders, keyScrap, now, kind }: { title: string; orders: OrderSummary[]; keyScrap: Scrap | null; now: number; kind: 'buy' | 'sell' }) {
  const [showExcluded, setShowExcluded] = useState(true);
  const excluded = orders.filter((o) => !o.eligible).length;
  const shown = showExcluded ? orders : orders.filter((o) => o.eligible);
  const id = `sec-${kind}`;
  return (
    <section className="drawer-section" aria-labelledby={id}>
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
                {kind === 'buy' ? <th>Flags</th> : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.listingId} className={o.eligible ? undefined : 'excluded'}>
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
                      <span className="buyer-name">{o.userName ?? 'unknown'}</span>
                    </span>
                  </td>
                  <td className="num" title={`Last event ${fmtDateTime(o.lastEventAt)}${o.bumpedAt ? `, bumped ${fmtDateTime(o.bumpedAt * 1000)}` : ''}`}>
                    {fmtAge(now - o.lastEventAt)}
                  </td>
                  <td className="note-cell" title={o.details || undefined}>
                    {o.details ? truncate(o.details, 70) : <span className="muted">—</span>}
                  </td>
                  {kind === 'buy' ? (
                    <td>
                      {!o.eligible ? <span className="chip-flag tone-muted">Excluded</span> : null}
                      <FlagList flags={o.flags} />
                    </td>
                  ) : null}
                </tr>
              ))}
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
    </section>
  );
}

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
  const p = d.references.pricedb;
  const c = d.references.community;
  const veryOld = p?.ageMs !== null && p?.ageMs !== undefined && p.ageMs > 30 * 86_400_000;
  return (
    <div className="ref-grid">
      <div className={`ref-card${veryOld ? ' faded' : ''}`}>
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
            <dd className={veryOld ? 'tone-text-warn' : undefined}>
              {p.ageMs !== null ? fmtAge(p.ageMs) : p.time ? fmtAge(now - p.time * 1000) : '—'}
              {veryOld ? ' (over 30 days)' : ''}
            </dd>
          </dl>
        ) : (
          <p className="muted small">No reliable PriceDB price.</p>
        )}
      </div>
      <div className="ref-card">
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
            <dd>{c.lastUpdate ? `${fmtAge(now - c.lastUpdate * 1000)} ago` : '—'}</dd>
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
  const grouped = useMemo(() => {
    const m = new Map<LinkGroup, LinkSpec[]>();
    for (const l of links) {
      const arr = m.get(l.group) ?? [];
      arr.push(l);
      m.set(l.group, arr);
    }
    return [...m.entries()];
  }, [links]);
  if (!links.length) return <p className="muted small">No links for this item.</p>;
  return (
    <div className="link-menu">
      {grouped.map(([group, list]) => (
        <div key={group} className="link-group">
          <div className="link-group-title">{LINK_GROUP_LABELS[group] ?? group}</div>
          <div className="link-buttons">
            {list.map((l) => (
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
