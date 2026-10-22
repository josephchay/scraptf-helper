import { useMemo, useRef, useState } from 'react';
import { holdingsValuationOf, positionCostAt } from '../../shared/holdings';
import { feeOf } from '../../shared/journal';
import type { JournalEntry, JournalSide } from '../../shared/types';
import { WRITE_OFF_VENUE } from '../../shared/venues';
import { rpc, saveCsv } from '../api';
import { ConfirmButton, Field, Segmented } from '../components/Controls';
import { EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ItemName, Money } from '../components/ItemName';
import { ItemPicker, type ItemPickerHandle, type PickedItem } from '../components/ItemPicker';
import { PriceInput, readPrice, type BareUnit } from '../components/PriceInput';
import { DASH, errorMessage, fmtDateTime, fmtInt, fmtKeysMetal, fmtMoney, fmtRefOnly, fromDateTimeLocal, toDateTimeLocal } from '../format';
import { useApp } from '../hooks/appContext';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useInterval } from '../hooks/useTimers';
import { useRecordTrade } from '../components/RecordTradeDialog';
import {
  JOURNAL_RESULTS_OPTIONS,
  JOURNAL_SIDE_LABELS,
  JOURNAL_SIDE_TONES,
  LOSSES_SHOWN,
  WRITE_OFF_TITLE,
  feesCell,
  fmtHold,
  holdStat,
  inventoryStat,
  journalEditInit,
  journalIndex,
  journalLosses,
  journalResults,
  journalTotals,
  loggedText,
  lossRowView,
  rateCell,
  resultsNotes,
  roiStat,
  tradePnl,
  winRateStat,
  writeOffInit,
  writtenOffText,
  type JournalResultsBy,
  type StatView,
} from '../journalModel';
import {
  BACKFILL_MS,
  FUTURE_SLACK_MS,
  MAX_VENUE_CHARS,
  VENUE_SUGGESTIONS,
  backfillKeyPrice,
  feeHint,
  isBackfill,
  readFee,
  undoneText,
  venueForSide,
  waitingAmountHeader,
  waitingBuyTitle,
  waitingCounts,
  waitingSaleBuyInit,
  waitingSalesText,
  waitingTitle,
} from '../recordTradeModel';

/** 0.8 (J3): a stat card for a rate or a hold time, muted below MIN_RATE_TRADES flips. */
function StatCard({ label, v }: { label: string; v: StatView }) {
  return (
    <div className={`stat card${v.muted ? ' stat-few' : ''}`} title={v.title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{v.value}</div>
      <div className="muted small">{v.sub}</div>
    </div>
  );
}

export function JournalPage() {
  const { keyScrap, toast, openItem, navigate } = useApp();
  const list = useRpcQuery('journal.list', { limit: 2000 });
  const summary = useRpcQuery('journal.summary', undefined);
  // 0.7.4 (F38): "Record its buy" of a sale with no buy before it. 0.8: also Edit (J6) and Write off….
  const trade = useRecordTrade();
  // 0.8 (J3): how Results groups the closed flips; switching regroups what is loaded and reads nothing.
  const [by, setBy] = useState<JournalResultsBy>('month');

  const after = () => {
    void list.reload();
    void summary.reload();
  };
  // Every journal write pushes 'journal.changed', this page's own (Log a trade, Delete) included, so
  // the push is the one refresh: calling after() as well would read the whole journal twice.
  const reload = useThrottled(after, 300);
  useVisiblePush('journal.changed', reload);
  // 0.9: Holdings' worth now and unrealised P/L as of their read (local; holdings.list sends no request).
  const holdings = useRpcQuery('holdings.list', {});
  const reloadHoldings = useThrottled(() => void holdings.reload(), 2000);
  const reloadHoldingsSoon = useThrottled(() => void holdings.reload(), 300);
  useVisiblePush('journal.changed', reloadHoldingsSoon);
  useVisiblePush('market.changed', reloadHoldings);
  useVisiblePush('prices.changed', reloadHoldings);
  useVisiblePush('scraptf.listChanged', reloadHoldings);
  const valuation = useMemo(() => (holdings.data ? holdingsValuationOf(holdings.data) : null), [holdings.data]);

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
  const waiting = s?.waitingSales ?? [];
  // 0.8: a write-off with no lot waits too; it is counted and named as a write-off, never as a sale.
  const waitingN = waitingCounts(waiting);
  const waitingHelp = waitingSalesText(waitingN.sales, waitingN.writeoffs);
  // 0.8 (J3): the report and each row's P/L, all from the summary's closed ledger (no extra RPC).
  const idx = useMemo(() => (s ? journalIndex(s) : null), [s]);
  const totals = useMemo(() => journalTotals(s?.closed ?? []), [s]);
  const results = useMemo(() => journalResults(s?.closed ?? [], by), [s, by]);
  const losses = useMemo(() => journalLosses(s?.closed ?? []), [s]);
  const writtenOff = writtenOffText(totals.writeoffs);

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
          {s && writtenOff !== null ? <div className="muted small">{writtenOff}</div> : null}
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
        {/* 0.9: what Holdings values the open lots at now, with the read's time; nothing is booked. */}
        <StatCard label="Unrealised P/L" v={inventoryStat(valuation, keyScrap, holdings.data ? null : holdings.error)} />
        {s ? (
          <>
            <StatCard label="Win rate" v={winRateStat(totals)} />
            <StatCard label="ROI" v={roiStat(totals, keyScrap)} />
            <StatCard label="Hold time" v={holdStat(totals)} />
          </>
        ) : null}
        <div className="stat-actions">
          <button type="button" className="btn small" onClick={() => void exportCsv()}>
            <Icon name="download" size={14} /> Export CSV
          </button>
        </div>
      </div>

      <div className="split">
        <section className="card form-card" aria-labelledby="journal-form-title">
          <h2 id="journal-form-title">Log a trade</h2>
          <p className="muted small">A manual record of what you bought and sold. Sells are matched to the oldest buy of the same item dated before them.</p>
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
                    <th className="num">P/L</th>
                    <th className="actions-col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((e) => {
                    const fee = feeOf(e);
                    const pnl = tradePnl(e, idx, keyScrap);
                    return (
                      <tr key={e.id}>
                        <td className="date-cell small">{fmtDateTime(e.ts)}</td>
                        <td>
                          <span className={`pill tone-${JOURNAL_SIDE_TONES[e.side] ?? 'muted'}`}>{JOURNAL_SIDE_LABELS[e.side] ?? e.side}</span>
                        </td>
                        <td>
                          <button type="button" className="row-link" onClick={() => openItem(e.sku)}>
                            <ItemName sku={e.sku} name={e.name} maxTags={2} />
                          </button>
                          {e.note ? <div className="muted small">{e.note}</div> : null}
                        </td>
                        <td>{e.venue}</td>
                        <td className="num">
                          {e.side === 'writeoff' ? (
                            <span className="muted">{DASH}</span>
                          ) : (
                            <>
                              <span className="money">{fmtKeysMetal(e.keys, e.scrap)}</span>
                              {e.keys ? <div className="muted small">key at {fmtMoney(e.keyPriceScrap, null)}</div> : null}
                              {fee ? <div className="muted small journal-fee">fee {fmtKeysMetal(fee.keys, fee.scrap)}</div> : null}
                            </>
                          )}
                        </td>
                        <td className="num journal-pnl">
                          {pnl.kind === 'profit' ? (
                            <Money scrap={pnl.profitScrap} keyScrap={keyScrap} tone="profit" signed title={pnl.title} />
                          ) : (
                            <span className="muted small" title={pnl.title}>
                              {pnl.text}
                            </span>
                          )}
                        </td>
                        <td className="actions-col">
                          <button type="button" className="icon-btn" aria-label={`Edit trade ${e.id}`} title="Edit venue, fee or note" onClick={() => trade.open(journalEditInit(e, idx, list.data))}>
                            <Icon name="edit" size={14} />
                          </button>
                          <ConfirmButton className="icon-btn" ariaLabel={`Delete trade ${e.id}`} title="Delete" confirmLabel="Delete?" onConfirm={() => void remove(e)}>
                            <Icon name="trash" size={14} />
                          </ConfirmButton>
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

      {s?.closed.length ? (
        <div className="split even">
          <section className="card journal-results" aria-labelledby="results-title">
            <div className="section-head">
              <h2 id="results-title">Results</h2>
              <Segmented small ariaLabel="Group results by" value={by} onChange={setBy} options={JOURNAL_RESULTS_OPTIONS} />
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>{by === 'month' ? 'Month' : by === 'week' ? 'Week' : 'Bought on → sold on'}</th>
                  <th className="num">Flips</th>
                  <th className="num">Win rate</th>
                  <th className="num">Profit</th>
                  <th className="num">Fees</th>
                  <th className="num">ROI</th>
                  <th className="num">Median hold</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const win = rateCell(r.winRate, r.trades);
                  const roi = rateCell(r.roi, r.trades, 1);
                  const fees = feesCell(r, keyScrap);
                  return (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td className="num">
                        {fmtInt(r.trades)}
                        {r.writeoffs ? <span className="muted small"> ({fmtInt(r.writeoffs)} written off)</span> : null}
                      </td>
                      <td className={`num${win.muted ? ' muted' : ''}`} title={win.title}>
                        {win.text}
                      </td>
                      <td className="num">
                        <Money scrap={r.profitScrap} keyScrap={keyScrap} tone="profit" signed />
                      </td>
                      <td className="num" title={fees.title}>
                        {fees.text}
                      </td>
                      <td className={`num${roi.muted ? ' muted' : ''}`} title={roi.title}>
                        {roi.text}
                      </td>
                      <td className="num">{fmtHold(r.medianHeldMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {resultsNotes(totals, waitingN.sales, waitingN.writeoffs).map((n) => (
              <p key={n} className="muted small">
                {n}
              </p>
            ))}
          </section>
          <section className="card journal-losses" aria-labelledby="losses-title">
            <h2 id="losses-title">
              Losing flips <span className="count-badge">{losses.length}</span>
            </h2>
            {losses.length ? (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Bought</th>
                      <th>Sold</th>
                      <th className="num">Cost</th>
                      <th className="num">Fees</th>
                      <th className="num">Loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    {losses.slice(0, LOSSES_SHOWN).map((c) => {
                      const v = lossRowView(c, keyScrap);
                      return (
                        <tr key={v.sellId}>
                          <td>
                            <button type="button" className="row-link" onClick={() => openItem(v.sku)}>
                              <ItemName sku={v.sku} name={v.name} maxTags={2} />
                            </button>
                          </td>
                          <td className="small">{v.bought}</td>
                          <td className="small">{v.sold}</td>
                          <td className="num">
                            <Money scrap={v.costScrap} keyScrap={keyScrap} />
                          </td>
                          <td className="num small">{v.fees}</td>
                          <td className="num">
                            <Money scrap={v.profitScrap} keyScrap={keyScrap} tone="profit" signed />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {losses.length > LOSSES_SHOWN ? <p className="muted small">and {losses.length - LOSSES_SHOWN} more in the CSV.</p> : null}
              </>
            ) : (
              <p className="muted small">No losing flips.</p>
            )}
          </section>
        </div>
      ) : null}

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
                    <th className="actions-col">
                      <span className="sr-only">Actions</span>
                    </th>
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
                      <td className="actions-col">
                        {/* 0.8: closes the oldest open lot at a loss in the journal; nothing is sold or traded (R4). */}
                        <button type="button" className="btn small" title={WRITE_OFF_TITLE} onClick={() => trade.open(writeOffInit(p))}>
                          Write off…
                        </button>
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

      {waitingHelp !== null ? (
        <section className="card" aria-labelledby="waiting-sales-title">
          <h2 id="waiting-sales-title">
            {waitingTitle(waitingN.sales, waitingN.writeoffs)} <span className="count-badge">{waiting.length}</span>
          </h2>
          <p className="muted small">{waitingHelp}</p>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Item</th>
                <th className="num">{waitingAmountHeader(waitingN.sales, waitingN.writeoffs)}</th>
                <th className="actions-col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((w) => (
                <tr key={w.id}>
                  <td className="date-cell small">{fmtDateTime(w.ts)}</td>
                  <td>
                    <button type="button" className="row-link" onClick={() => openItem(w.sku)}>
                      <ItemName sku={w.sku} name={w.name} maxTags={2} />
                    </button>
                  </td>
                  <td className="num">{w.writeoff ? <span className="muted">Written off</span> : <span className="money">{fmtKeysMetal(w.keys, w.scrap)}</span>}</td>
                  <td className="actions-col">
                    <button type="button" className="btn small" title={waitingBuyTitle(w)} onClick={() => trade.open(waitingSaleBuyInit(w))}>
                      Record its buy
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {trade.element}
    </div>
  );
}

function JournalForm() {
  // 0.9 (#2): settings for the marketplace.tf fee hint (the user's profit.marketplaceFeePct).
  const { keyScrap, toast, settings } = useApp();
  const [side, setSide] = useState<JournalSide>('buy');
  const [venue, setVenue] = useState('scrap.tf');
  const [item, setItem] = useState<PickedItem | null>(null);
  const [text, setText] = useState('');
  const [unit, setUnit] = useState<BareUnit>('ref');
  // 0.8 (J2): the fee as typed ('' is not recorded, 0 is none).
  const [feeText, setFeeText] = useState('');
  const [feeUnit, setFeeUnit] = useState<BareUnit>('ref');
  // When follows the clock until the user edits it (null = untouched): the page can stay mounted for
  // hours, and a trade logged with When untouched is dated when it is logged, not when the page opened.
  // The clock holds still while the field has focus, so a segment being typed is not reset under the user.
  const [whenEdited, setWhenEdited] = useState<string | null>(null);
  const [whenFocused, setWhenFocused] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  useInterval(() => setClock(Date.now()), 30_000, whenEdited === null && !whenFocused);
  const when = whenEdited ?? toDateTimeLocal(clock);
  const [note, setNote] = useState('');
  // 0.7.4 (F39): a backfill's key price then, in ref as typed ('' is today's).
  const [keyText, setKeyText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const picker = useRef<ItemPickerHandle>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const backfill = whenEdited !== null && isBackfill(whenEdited, clock);

  const submit = async () => {
    setError(null);
    const it = item ?? (await picker.current?.resolvePending()) ?? null;
    if (!it) {
      setError('Pick an item.');
      return;
    }
    // 0.8: a write-off receives nothing (no price, no fee) and has no counterparty (WRITE_OFF_VENUE).
    const writeoff = side === 'writeoff';
    const parsed = writeoff ? { keys: 0, scrap: 0 } : readPrice(text, unit);
    if (!parsed) {
      setError('Enter the price, for example 1.33 or 2 keys 5.11.');
      return;
    }
    if (!writeoff && !venue.trim()) {
      setError('Enter where the trade happened.');
      return;
    }
    const f = writeoff ? { fee: null, error: null } : readFee(feeText, feeUnit);
    if (f.error !== null) {
      setError(f.error);
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
    // 0.7.4 (F39): as the Record trade dialog, a backfill's keys are valued at the key price then.
    let keyPriceScrap: number | null = null;
    if (ts < now - BACKFILL_MS) {
      const k = backfillKeyPrice(keyText, keyScrap);
      if (k.error !== null) {
        setError(k.error);
        return;
      }
      keyPriceScrap = k.value;
    }
    setSaving(true);
    try {
      const e = await rpc('journal.add', {
        side,
        venue: writeoff ? WRITE_OFF_VENUE : venue.trim(),
        sku: it.sku,
        name: it.name,
        keys: parsed.keys,
        scrap: parsed.scrap,
        ts,
        note: note.trim() || null,
        ...(keyPriceScrap !== null ? { keyPriceScrap } : {}),
        ...(f.fee ? { feeKeys: f.fee.keys, feeScrap: f.fee.scrap } : {}),
      });
      // Undo deletes the row again; the 'journal.changed' push refreshes this page and Holdings.
      const undo = () => {
        rpc('journal.delete', { id: e.id })
          .then(() => toast(undoneText(e), 'info'))
          .catch((err: unknown) => toast(`Could not undo: ${errorMessage(err)}`, 'bad'));
      };
      toast(loggedText(e), 'good', { action: { label: 'Undo', onClick: undo } });
      setItem(null);
      setText('');
      setFeeText('');
      setNote('');
      setKeyText('');
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
            setVenue((cur) => venueForSide(cur, v));
          }}
          options={[
            { value: 'buy', label: 'Bought' },
            { value: 'sell', label: 'Sold' },
            { value: 'writeoff', label: 'Written off' },
          ]}
        />
      </Field>
      <Field label="Item" htmlFor="jf-item">
        <ItemPicker ref={picker} id="jf-item" value={item} onChange={setItem} onEnterPicked={() => priceRef.current?.focus()} />
      </Field>
      {side !== 'writeoff' ? (
        <>
          <Field label="Price" htmlFor="jf-price">
            <PriceInput ref={priceRef} id="jf-price" text={text} onText={setText} unit={unit} onUnit={setUnit} keyScrap={keyScrap} />
          </Field>
          <Field label="Fees (optional)" htmlFor="jf-fee" hint={feeHint(venue, side, settings?.profit.marketplaceFeePct)}>
            <PriceInput id="jf-fee" compact text={feeText} onText={setFeeText} unit={feeUnit} onUnit={setFeeUnit} keyScrap={keyScrap} placeholder="0 for none" />
          </Field>
          <Field label="Venue" htmlFor="jf-venue">
            <input id="jf-venue" className="input" list="jf-venues" value={venue} maxLength={MAX_VENUE_CHARS} onChange={(e) => setVenue(e.target.value)} />
            <datalist id="jf-venues">
              {VENUE_SUGGESTIONS.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>
        </>
      ) : null}
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
      {backfill ? (
        <Field label="Key price then" htmlFor="jf-key" hint="What a key cost when this trade happened, in ref. Empty uses today's key price.">
          <input
            id="jf-key"
            className="input"
            inputMode="decimal"
            autoComplete="off"
            value={keyText}
            placeholder={keyScrap && keyScrap > 0 ? `${fmtRefOnly(keyScrap)} (today's)` : 'in ref'}
            onChange={(e) => setKeyText(e.target.value)}
          />
        </Field>
      ) : null}
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
          <Icon name="plus" size={14} /> Log {side === 'writeoff' ? 'write-off' : side}
        </button>
        <span className="muted small">Keys are valued at the key price on the trade date for FIFO: today&apos;s, unless you backfill an older trade.</span>
      </div>
    </form>
  );
}
