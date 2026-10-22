import { useState } from 'react';
import type { HealthReport, KeyPriceState, Settings } from '../../shared/types';
import { rpc } from '../api';
import { ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { StatePill, TonePill } from '../components/Pills';
import {
  KEY_SOURCE_LABELS,
  errorMessage,
  fmtAge,
  fmtAgo,
  fmtBytes,
  fmtCountdown,
  fmtDateTime,
  fmtDuration,
  fmtInt,
  fmtRefOnly,
  fmtTime,
  keyPriceNotes,
  visibleBudgets,
} from '../format';
import { useApp } from '../hooks/appContext';
import { scraptfKeyHealthRows } from '../settingsFields';
import { useRpcQuery } from '../hooks/useRpc';
import { useDocumentVisible, useInterval, useNow } from '../hooks/useTimers';
import { assetIdsLines } from '../timingModel';

export function HealthPage() {
  const { toast } = useApp();
  const visible = useDocumentVisible();
  const health = useRpcQuery('health.get', undefined);
  useInterval(() => void health.reload(), 5000, visible);
  const now = useNow(1000);
  const [running, setRunning] = useState(false);

  const runEngine = async () => {
    setRunning(true);
    try {
      const r = await rpc('engine.runNow');
      toast(`Evaluated ${fmtInt(r.evaluated)} inputs in ${fmtDuration(r.ms)}`, 'good');
      void health.reload();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setRunning(false);
    }
  };

  const h = health.data;
  if (!h) {
    return (
      <div className="page health-page">
        {health.error ? <ErrorBanner message={`Could not load health: ${health.error}`} onRetry={() => void health.reload()} /> : <LoadingBlock label="Loading health…" />}
      </div>
    );
  }

  const capPct = h.feed.capBytes > 0 ? Math.min(1, h.feed.bytesToday / h.feed.capBytes) : 0;
  const blockedHosts = h.blockedHosts ?? [];

  return (
    <div className="page health-page">
      {health.error ? <ErrorBanner message={`Refresh failed: ${health.error}`} /> : null}
      <div className="stat-row">
        <div className="stat card">
          <div className="stat-label">Live feed</div>
          <div className="stat-value">
            <StatePill state={h.feed.state} />
          </div>
          <div className="muted small">{h.feed.lastFrameAt ? `last frame ${fmtAgo(h.feed.lastFrameAt, now)}` : 'no frames yet'}</div>
        </div>
        <div className="stat card">
          <div className="stat-label">Data today</div>
          <div className="stat-value num">
            {fmtBytes(h.feed.bytesToday)} <span className="muted small">of {fmtBytes(h.feed.capBytes)}</span>
          </div>
          <div className={`meter${capPct > 0.9 ? ' bad' : capPct > 0.7 ? ' warn' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(capPct * 100)} aria-label="Daily data cap used">
            <span style={{ width: `${capPct * 100}%` }} />
          </div>
        </div>
        <div className="stat card">
          <div className="stat-label">Engine</div>
          <div className="stat-value num">{fmtInt(h.engine.evaluated)} inputs</div>
          <div className="muted small">
            {h.engine.lastRunAt ? `ran ${fmtAgo(h.engine.lastRunAt, now)} in ${fmtDuration(h.engine.lastRunMs)}` : 'not run yet'}
          </div>
        </div>
        <div className="stat card">
          <div className="stat-label">Database</div>
          <div className="stat-value num">{fmtBytes(h.db.sizeBytes)}</div>
          <div className="muted small mono ellipsis" title={h.db.path}>
            {h.db.path}
          </div>
        </div>
        <div className="stat-actions">
          <button type="button" className="btn small" disabled={running} onClick={() => void runEngine()}>
            <Icon name="refresh" size={14} /> Re-check everything
          </button>
          <span className="muted small">{visible ? 'Updates every 5 s' : 'Paused while hidden'}</span>
        </div>
      </div>

      <section className="card" aria-labelledby="h-conn">
        <h2 id="h-conn">Connections</h2>
        {blockedHosts.length > 0 ? (
          <div className="banner tone-bad" role="alert">
            <Icon name="warning" />
            <div className="banner-text">
              <p>
                These hosts answered with a challenge or error page, so the app stopped contacting them. They stay off after a restart until you
                re-enable them. Open the site in your own browser first and re-enable it only once it loads normally.
              </p>
              <ul className="plain-list">
                {blockedHosts.map((b) => (
                  <li key={b.host}>
                    <span className="mono">{b.host}</span>: <span className="small">{b.reason}</span>{' '}
                    <ReenableHostButton host={b.host} onDone={() => void health.reload()} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>State</th>
                <th>Detail</th>
                <th className="num">Last OK</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {h.connectors.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.label}</strong>
                  </td>
                  <td>
                    <StatePill state={c.state} />
                  </td>
                  <td className="small">
                    {c.detail}
                    {c.disabledReason ? (
                      <div className="tone-text-bad">
                        Disabled: {c.disabledReason}
                        {c.blockedHost ? (
                          <>
                            {' '}
                            <ReenableHostButton host={c.blockedHost} onDone={() => void health.reload()} />
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="num small">{c.lastOkAt ? fmtAgo(c.lastOkAt, now) : '—'}</td>
                  <td className="small">
                    {c.lastError ? (
                      <span className="tone-text-bad" title={c.lastErrorAt ? fmtDateTime(c.lastErrorAt) : undefined}>
                        {c.lastErrorAt ? `${fmtAgo(c.lastErrorAt, now)}: ` : ''}
                        {c.lastError}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split even">
        <section className="card" aria-labelledby="h-budgets">
          <h2 id="h-budgets">Request budgets</h2>
          <p className="muted small">Each host gets a budget below its published limit. A 429 pauses that host; after 3 in a row it pauses for an hour.</p>
          <table className="table">
            <thead>
              <tr>
                <th>Host</th>
                <th className="num">Last hour</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleBudgets(h.budgets).map((b) => {
                const pausedNow = b.pausedUntil !== null && b.pausedUntil > now;
                // One host can have several budgets (backpack.tf has one per endpoint family).
                return (
                  <tr key={b.id ?? b.host}>
                    <td>
                      <div className="mono small">
                        {b.host}
                        {b.id ? <span className="muted"> · {b.id}</span> : null}
                      </div>
                      <div className="muted small">{b.policy}</div>
                    </td>
                    <td className="num">{fmtInt(b.usedLastHour)}</td>
                    <td>
                      {pausedNow ? (
                        <TonePill tone="warn" title={`Until ${fmtDateTime(b.pausedUntil)}`}>
                          Paused {fmtCountdown(b.pausedUntil, now)}
                        </TonePill>
                      ) : (
                        <TonePill tone="good">OK</TonePill>
                      )}
                      {b.consecutive429 ? <div className="tone-text-warn small">{b.consecutive429}× 429 in a row</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="card" aria-labelledby="h-feed">
          <h2 id="h-feed">Live feed and book</h2>
          <dl className="kv">
            <dt>Enabled</dt>
            <dd>{h.feed.enabled ? 'Yes' : 'No'}</dd>
            <dt>Events today</dt>
            <dd className="num">{fmtInt(h.feed.eventsToday)}</dd>
            <dt>Listings stored</dt>
            <dd className="num">
              {fmtInt(h.feed.listingsTotal)} <span className="muted small">({fmtInt(h.feed.buyListings)} buy, {fmtInt(h.feed.sellListings)} sell)</span>
            </dd>
            <dt>Parse failures</dt>
            <dd className={`num${h.feed.parseFailures ? ' tone-text-warn' : ''}`}>{fmtInt(h.feed.parseFailures)}</dd>
            <dt>Schema</dt>
            <dd>
              {h.schema.loadedAt ? (
                <>
                  {fmtInt(h.schema.items)} items, {fmtInt(h.schema.effects)} effects, {fmtInt(h.schema.paintkits)} paintkits{' '}
                  <span className="muted small">· loaded {fmtAgo(h.schema.loadedAt, now)}</span>
                </>
              ) : (
                <span className="tone-text-warn">Not loaded yet</span>
              )}
            </dd>
          </dl>
          <p className="attribution muted small">Data from backpack.tf · Prices by PriceDB.io</p>
        </section>
      </div>

      <KeyPriceCard kp={h.keyPrice} now={now} />

      <ScraptfSavesCard list={h.scraptfAssetIds} />

      <RequestLog rows={h.recentRequests} now={now} />
    </div>
  );
}

/** Clears a challenge block. The app never does this on its own (R7); the user checks the site in a browser first. */
function ReenableHostButton({ host, onDone }: { host: string; onDone: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const reenable = async () => {
    setBusy(true);
    try {
      await rpc('net.unblock', { host });
      toast(`${host} re-enabled. Its data will refresh shortly.`, 'good');
      onDone();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="btn small"
      disabled={busy}
      title={`Check that ${host} loads normally in your browser before re-enabling it`}
      onClick={() => void reenable()}
    >
      Re-enable {host}
    </button>
  );
}

/**
 * 0.8 (LC-5): how stable scrap.tf's item ids were between the user's looks, per saved bank (assetIdsLines): the gate
 * behind "the same item came back" and "turned untradable". Hidden when the report has none (an older service, or
 * no bank saved yet).
 */
function ScraptfSavesCard({ list }: { list: HealthReport['scraptfAssetIds'] }) {
  const lines = assetIdsLines(list);
  if (lines.length === 0) return null;
  return (
    <section className="card" aria-labelledby="h-stf">
      <h2 id="h-stf">scrap.tf saves</h2>
      {lines.map((l, i) => (
        <p key={i} className={`small${l.tone === 'muted' ? ' muted' : ` tone-text-${l.tone}`}`} title={l.title}>
          {l.text}
        </p>
      ))}
    </section>
  );
}

function KeyPriceCard({ kp, now }: { kp: KeyPriceState | null; now: number }) {
  const { settings } = useApp();
  return (
    <section className="card" aria-labelledby="h-key">
      <h2 id="h-key">Key price</h2>
      {kp ? <KeyPriceTable kp={kp} typed={settings?.keyPrice ?? null} now={now} /> : <p className="muted">No key price yet.</p>}
    </section>
  );
}

/**
 * The key price in use and every quote, then scrap.tf's own key prices: the typed ones and the saved
 * scrap.tf/items list's (F14), each saying whether it caps the automatic value (scraptfKeyHealthRows).
 * `typed` null (settings still loading) leaves the scrap.tf rows out rather than guess which one caps.
 */
export function KeyPriceTable({ kp, typed, now }: { kp: KeyPriceState; typed: Settings['keyPrice'] | null; now: number }) {
  const stf = typed ? scraptfKeyHealthRows(kp.scraptfFromList, typed) : [];
  // 0.7.4 (F71): Age is when the quote was checked; Price set is when its source last changed the price.
  const notes = keyPriceNotes(kp, now);
  return (
    <>
      <p>
        Using <strong className="money">{fmtRefOnly(kp.valueScrap)}</strong> from {KEY_SOURCE_LABELS[kp.source] ?? kp.source}
        {kp.observedAt ? `, ${fmtAge(now - kp.observedAt)} old` : ''}
        {notes.priceSet ? <span title={notes.priceSetTitle ?? undefined}>, price {notes.priceSet}</span> : null}.
        {kp.stale ? <span className="tone-text-warn"> Stale: no fresh quote in 6 h.</span> : null}
        {notes.divergence ? <span className="tone-text-warn"> {notes.divergence}</span> : null}
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Source</th>
            <th className="num">Buy</th>
            <th className="num">Sell</th>
            <th className="num" title="When the quote was last checked">Age</th>
            <th className="num" title="When the source last changed the price">Price set</th>
          </tr>
        </thead>
        <tbody>
          {kp.quotes.map((q) => (
            <tr key={q.source}>
              <td>{KEY_SOURCE_LABELS[q.source] ?? q.source}</td>
              <td className="num money">{fmtRefOnly(q.buyScrap)}</td>
              <td className="num money">{fmtRefOnly(q.sellScrap)}</td>
              <td className={`num${now - q.observedAt > 6 * 3_600_000 ? ' tone-text-warn' : ''}`}>{fmtAge(now - q.observedAt)}</td>
              <td className="num" title={typeof q.priceAt === 'number' ? fmtDateTime(q.priceAt) : 'Not known for this quote'}>
                {typeof q.priceAt === 'number' && Number.isFinite(q.priceAt) ? fmtAgo(q.priceAt, now) : '—'}
              </td>
            </tr>
          ))}
          {stf.map((r) => (
            <tr key={`scraptf-${r.source}`} className="muted">
              <td>{r.label}</td>
              <td className="num money">{fmtRefOnly(r.buyScrap)}</td>
              <td className="num money">{fmtRefOnly(r.sellScrap)}</td>
              <td className="num">{r.observedAt ? fmtAge(now - r.observedAt) : '—'}</td>
              <td className="num">—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Host filter options. The selected host stays listed after it drops out of the
 * latest rows, so the select keeps showing the real filter and "All hosts" clears it.
 */
export function requestLogHostOptions(rows: readonly { host: string }[], selected: string): string[] {
  const set = new Set(rows.map((r) => r.host));
  if (selected) set.add(selected);
  return [...set].sort();
}

function RequestLog({ rows, now }: { rows: HealthReport['recentRequests']; now: number }) {
  const [host, setHost] = useState('');
  const hosts = requestLogHostOptions(rows, host);
  const shown = host ? rows.filter((r) => r.host === host) : rows;
  return (
    <section className="card" aria-labelledby="h-req">
      <div className="section-head">
        <h2 id="h-req">Recent requests</h2>
        <select className="input select small" aria-label="Filter by host" value={host} onChange={(e) => setHost(e.target.value)}>
          <option value="">All hosts</option>
          {hosts.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </div>
      <p className="muted small">Keys and tokens are replaced with [redacted] before anything is stored.</p>
      <div className="table-wrap tall">
        <table className="table compact-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Host</th>
              <th>Request</th>
              <th className="num">Status</th>
              <th className="num">Time</th>
              <th className="num">Size</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.ts}-${i}`}>
                <td className="num small" title={`${fmtDateTime(r.ts)} (${fmtAgo(r.ts, now)})`}>
                  {fmtTime(r.ts)}
                </td>
                <td className="mono small">{r.host}</td>
                <td className="mono small path-cell" title={`${r.method} ${r.path}`}>
                  <span className="muted">{r.method}</span> {r.path}
                  {r.note ? <div className="muted">{r.note}</div> : null}
                </td>
                <td className={`num ${r.status >= 500 || r.status === 429 || r.status === 403 || r.status === 401 ? 'tone-text-bad' : r.status >= 400 ? 'tone-text-warn' : ''}`}>{r.status || '—'}</td>
                <td className="num small">{fmtDuration(r.ms)}</td>
                <td className="num small">{fmtBytes(r.bytes)}</td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted small">
                  {host ? `No requests to ${host} among the latest ${rows.length}.` : 'No requests yet.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
