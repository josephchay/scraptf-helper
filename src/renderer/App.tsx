import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PushContract } from '../shared/rpc';
import { rpc, windowKind } from './api';
import { ErrorBanner, LoadingBlock, ToastStack } from './components/Feedback';
import { Icon, type IconName } from './components/Icon';
import { StatePill } from './components/Pills';
import { Tip } from './components/Tip';
import { CONN_STATE_LABELS, KEY_SOURCE_LABELS, accelLabel, fmtAge, fmtInt, fmtRefOnly, keyPriceSummary, serviceBannerDetail } from './format';
import { AppProvider, useApp } from './hooks/appContext';
import { usePush, useThrottled } from './hooks/useRpc';
import { useNow } from './hooks/useTimers';
import { serviceNotReady } from './serviceStateModel';
import { AboutPage } from './pages/AboutPage';
import { HealthPage } from './pages/HealthPage';
import { ImportPage } from './pages/ImportPage';
import { ItemDrawer } from './pages/ItemDrawer';
import { JournalPage } from './pages/JournalPage';
import { LogPage } from './pages/LogPage';
import { OpportunitiesPage } from './pages/OpportunitiesPage';
import { PricesPage } from './pages/PricesPage';
import { QuickEntry } from './pages/QuickEntry';
import { ShoppingPage } from './pages/ShoppingPage';
import { SettingsPage } from './pages/SettingsPage';

type RouteId = 'opportunities' | 'shopping' | 'log' | 'prices' | 'import' | 'journal' | 'health' | 'settings' | 'about';

const NAV: { id: RouteId; label: string; icon: IconName }[] = [
  { id: 'opportunities', label: 'Opportunities', icon: 'opps' },
  { id: 'shopping', label: 'Shopping list', icon: 'cart' },
  { id: 'log', label: 'Live log', icon: 'log' },
  { id: 'prices', label: 'Price sheet', icon: 'tag' },
  { id: 'import', label: 'Import', icon: 'import' },
  { id: 'journal', label: 'Journal', icon: 'journal' },
  { id: 'health', label: 'Data health', icon: 'health' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'about', label: 'About & rules', icon: 'shield' },
];

const TITLES: Record<RouteId, string> = {
  opportunities: 'Opportunities',
  shopping: 'Shopping list',
  log: 'Live log',
  prices: 'Price sheet',
  import: 'Import saved pages',
  journal: 'Journal',
  health: 'Data health',
  settings: 'Settings',
  about: 'About & rules',
};

function subscribeHash(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

/** Picks the dashboard or the quick-entry window. */
export function Root() {
  // Re-evaluated on hash changes so "#/quick" works in a plain browser too.
  useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  const kind = windowKind();
  useEffect(() => {
    document.documentElement.dataset['window'] = kind;
    document.title = kind === 'quick-entry' ? 'Quick entry · TF2 Flip Desk' : 'TF2 Flip Desk';
  }, [kind]);
  return <AppProvider>{kind === 'quick-entry' ? <QuickEntry /> : <Dashboard />}</AppProvider>;
}

const SERVICE_STATE_TEXT: Record<string, string> = {
  starting: 'The background service is starting. Data will appear in a moment.',
  restarting: 'The background service stopped unexpectedly and is restarting. Your data is safe.',
  stopped: 'The background service has stopped. Restart TF2 Flip Desk if this persists.',
};

/** Slim strip under the top bar while the service process is not ready. */
function ServiceBanner() {
  const { serviceState } = useApp();
  if (!serviceNotReady(serviceState)) return null;
  const text = SERVICE_STATE_TEXT[serviceState.state] ?? `Background service: ${serviceState.state}`;
  return (
    <div className={`service-banner tone-${serviceState.state === 'starting' ? 'info' : 'warn'}`} role="status">
      <Icon name={serviceState.state === 'starting' ? 'info' : 'warning'} size={14} />
      <span>
        {text}
        <ServiceDetail key={`${serviceState.state}:${serviceState.nextAttemptAt ?? ''}`} state={serviceState} />
      </span>
    </div>
  );
}

/** Mounted only while the banner shows, and ticks only while a restart is pending. */
function ServiceDetail({ state }: { state: PushContract['service.state'] }) {
  const now = useNow(state.state === 'restarting' && state.nextAttemptAt !== null ? 1000 : 0);
  const detail = serviceBannerDetail(state, now);
  return detail ? <span className="muted"> {detail}</span> : null;
}

function Dashboard() {
  const { segments, status, settings, bridgeError, refreshStatus, dataVersion } = useApp();
  const route: RouteId = (NAV.some((n) => n.id === segments[0]) ? segments[0] : 'opportunities') as RouteId;
  const [unseen, setUnseen] = useState(0);
  const [priceCount, setPriceCount] = useState<number | null>(null);

  usePush('opps.changed', (p) => {
    if (route !== 'log') setUnseen((n) => Math.min(999, n + p.appeared + p.changed + p.gone));
  });
  useEffect(() => {
    if (route === 'log') setUnseen(0);
    document.getElementById('content')?.scrollTo({ top: 0 });
  }, [route]);

  useEffect(() => {
    let alive = true;
    rpc('prices.list', {})
      .then((p) => alive && setPriceCount(p.length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [dataVersion]);
  // Imports and quick-entry saves (a separate window) change the count too.
  const recountPrices = useThrottled(() => {
    rpc('prices.list', {})
      .then((p) => setPriceCount(p.length))
      .catch(() => undefined);
  }, 1000);
  usePush('prices.changed', recountPrices);

  if (!status && bridgeError) {
    return (
      <div className="fatal">
        {/* During a known restart (status.get timed out waiting for it) the banner says why, with its countdown. */}
        <ServiceBanner />
        <ErrorBanner message={`Can't reach the background service: ${bridgeError}`} onRetry={refreshStatus} />
      </div>
    );
  }

  const feedBad = status ? status.feed === 'error' || status.feed === 'blocked' : false;
  const counts: Partial<Record<RouteId, { text: string; title: string; tone?: string } | null>> = {
    opportunities: status ? { text: fmtInt(status.counts.profitable), title: `${status.counts.profitable} profitable (${status.counts.highConfidence} high confidence) of ${status.counts.opportunities}` } : null,
    log: unseen ? { text: unseen > 99 ? '99+' : String(unseen), title: `${unseen} new events since you last looked`, tone: 'accent' } : null,
    prices: priceCount !== null ? { text: fmtInt(priceCount), title: `${priceCount} scrap.tf prices` } : null,
    import: settings && !settings.import.enabled ? { text: 'off', title: 'Saved-page import is off', tone: 'muted' } : null,
    health: feedBad ? { text: '!', title: `Live feed: ${CONN_STATE_LABELS[status!.feed]}`, tone: 'bad' } : null,
  };

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="opps" size={16} />
          </span>
          <span className="brand-name">Flip Desk</span>
        </div>
        <ul>
          {NAV.map((n) => {
            const c = counts[n.id];
            return (
              <li key={n.id}>
                <a href={`#/${n.id}`} className={`nav-link${route === n.id ? ' active' : ''}`} aria-current={route === n.id ? 'page' : undefined} title={n.label}>
                  <Icon name={n.icon} size={17} />
                  <span className="nav-label">{n.label}</span>
                  {c ? (
                    <span className={`nav-count${c.tone ? ` tone-${c.tone}` : ''}`} title={c.title}>
                      {c.text}
                    </span>
                  ) : null}
                </a>
              </li>
            );
          })}
        </ul>
        <div className="nav-foot muted small">
          <span className="nav-label">v{status?.version ?? '…'}</span>
        </div>
      </nav>
      <div className="main">
        <TopBar title={TITLES[route]} />
        <ServiceBanner />
        <main className="content" id="content">
          {!status && !bridgeError ? <LoadingBlock label="Starting…" /> : <RouteView route={route} />}
        </main>
      </div>
      <ItemDrawer />
      <ToastStack />
    </div>
  );
}

function RouteView({ route }: { route: RouteId }) {
  switch (route) {
    case 'opportunities':
      return <OpportunitiesPage />;
    case 'shopping':
      return <ShoppingPage />;
    case 'log':
      return <LogPage />;
    case 'prices':
      return <PricesPage />;
    case 'import':
      return <ImportPage />;
    case 'journal':
      return <JournalPage />;
    case 'health':
      return <HealthPage />;
    case 'settings':
      return <SettingsPage />;
    case 'about':
      return <AboutPage />;
  }
}

function TopBar({ title }: { title: string }) {
  const { status, settings, isMock, updateSettings, toast } = useApp();
  const now = useNow(10_000);
  const kp = status?.keyPrice ?? null;
  const key = status ? keyPriceSummary(kp, now) : { value: '…', source: 'loading', age: '', stale: false };
  const paused = status?.networkPaused ?? settings?.networkPaused ?? false;
  const feed = status?.feed ?? 'connecting';

  const openQuick = () => {
    rpc('app.showQuickEntry').catch(() => toast('Could not open quick entry.', 'bad'));
  };

  return (
    <header className="topbar">
      <h1 className="page-title">{title}</h1>
      <div className="topbar-right">
        {isMock ? (
          <span className="pill tone-warn" title="Running in a plain browser against fake data. Nothing here is real.">
            Mock data
          </span>
        ) : null}
        <Tip
          wide
          content={
            kp ? (
              <div>
                <div className="reasons-title">Key price quotes</div>
                <table className="tip-table">
                  <tbody>
                    {kp.quotes.map((q) => (
                      <tr key={q.source}>
                        <td>{KEY_SOURCE_LABELS[q.source] ?? q.source}</td>
                        <td className="num">{fmtRefOnly(q.buyScrap)}</td>
                        <td className="num muted">{fmtAge(now - q.observedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {settings?.keyPrice.scraptfSellScrap ? <div className="muted small">scrap.tf sell (yours): {fmtRefOnly(settings.keyPrice.scraptfSellScrap)}</div> : null}
              </div>
            ) : (
              'No key price yet.'
            )
          }
        >
          <span className={`key-chip${key.stale ? ' stale' : ''}`} tabIndex={0} aria-label={`Key price ${key.value} from ${key.source}, ${key.age} old${key.stale ? ', stale' : ''}`}>
            <Icon name="key" size={14} />
            <span className="money">{key.value}</span>
            <span className="muted small">{key.age ? `${key.source} · ${key.age}` : key.source}</span>
            {key.stale ? <Icon name="warning" size={12} className="tone-text-warn" /> : null}
          </span>
        </Tip>
        <StatePill state={feed} label={`Feed: ${CONN_STATE_LABELS[feed]}`} title="backpack.tf live buy-order feed" />
        <button
          type="button"
          className={`btn small${paused ? ' warn' : ''}`}
          aria-pressed={paused}
          onClick={() => void updateSettings({ networkPaused: !paused })}
          title={paused ? 'Resume all network activity' : 'Stop all network activity (kill switch)'}
        >
          <Icon name={paused ? 'play' : 'pause'} size={14} />
          <span className="btn-label">{paused ? 'Resume network' : 'Pause network'}</span>
        </button>
        <button type="button" className="btn small primary" onClick={openQuick} title={settings?.app.quickEntryHotkey ? `Quick entry (${accelLabel(settings.app.quickEntryHotkey)})` : 'Quick entry'}>
          <Icon name="plus" size={14} />
          <span className="btn-label">Quick entry</span>
        </button>
      </div>
    </header>
  );
}
