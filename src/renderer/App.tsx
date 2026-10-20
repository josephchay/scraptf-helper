import { Fragment, useEffect, useState, useSyncExternalStore } from 'react';
import type { PushContract } from '../shared/rpc';
import type { ScraptfBank } from '../shared/types';
import { rpc, windowKind, type WindowKind } from './api';
import { bankStockRouteBank } from './banksModel';
import { logTabOf } from './changesModel';
import { DataTooNewScreen } from './components/DataTooNewScreen';
import { ErrorBanner, LoadingBlock, ToastStack } from './components/Feedback';
import { Icon, type IconName } from './components/Icon';
import { StatePill } from './components/Pills';
import { Tip } from './components/Tip';
import { parseDataTooNew } from './dataTooNewModel';
import { CONN_STATE_LABELS, KEY_SOURCE_LABELS, accelLabel, errorMessage, fmtAge, fmtInt, fmtRefOnly, keyPriceSummary, serviceBannerDetail } from './format';
import { AppProvider, useApp } from './hooks/appContext';
import { usePush, useThrottled, useVisiblePush } from './hooks/useRpc';
import { useNow } from './hooks/useTimers';
import { SCRAPTF_WINDOW_NAV_LABEL, SCRAPTF_WINDOW_NAV_TITLE, scraptfWindowOn, windowOpenFailedText } from './scraptfWindowModel';
import { serviceNotReady } from './serviceStateModel';
import { scraptfKeyTipText } from './settingsFields';
import { AboutPage } from './pages/AboutPage';
import { BankStockPage } from './pages/BankStockPage';
import { BanksPage } from './pages/BanksPage';
import { CheckPopup } from './pages/CheckPopup';
import { HealthPage } from './pages/HealthPage';
import { HoldingsPage } from './pages/HoldingsPage';
import { ImportPage } from './pages/ImportPage';
import { ItemDrawer } from './pages/ItemDrawer';
import { JournalPage } from './pages/JournalPage';
import { LogPage } from './pages/LogPage';
import { MarketPage } from './pages/MarketPage';
import { OpportunitiesPage } from './pages/OpportunitiesPage';
import { PricesPage } from './pages/PricesPage';
import { QuickEntry } from './pages/QuickEntry';
import { ScraptfWindowBar } from './pages/ScraptfWindowBar';
import { ShoppingPage } from './pages/ShoppingPage';
import { SettingsPage } from './pages/SettingsPage';

type RouteId = 'opportunities' | 'market' | 'banks' | 'shopping' | 'holdings' | 'log' | 'prices' | 'import' | 'journal' | 'health' | 'settings' | 'about';

const NAV: { id: RouteId; label: string; icon: IconName }[] = [
  { id: 'opportunities', label: 'Opportunities', icon: 'opps' },
  { id: 'market', label: 'Live market', icon: 'market' },
  { id: 'banks', label: 'scrap.tf banks', icon: 'banks' },
  { id: 'shopping', label: 'Shopping list', icon: 'cart' },
  { id: 'holdings', label: 'Holdings', icon: 'holdings' },
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
  market: 'Live market',
  banks: 'scrap.tf banks',
  shopping: 'Shopping list',
  holdings: 'Holdings',
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

const WINDOW_TITLES: Record<WindowKind, string> = {
  dashboard: 'TF2 Flip Desk',
  'quick-entry': 'Quick entry · TF2 Flip Desk',
  check: 'Live check · TF2 Flip Desk',
  scraptf: 'scrap.tf · Flip Desk',
};

/** Picks the dashboard, the quick-entry window, the live check popup (F16) or the scrap.tf window's toolbar (F21). */
export function Root() {
  // Re-evaluated on hash changes so "#/quick", "#/check" and "#/scraptf-bar" work in a plain browser too.
  useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  const kind = windowKind();
  useEffect(() => {
    document.documentElement.dataset['window'] = kind;
    document.title = WINDOW_TITLES[kind];
  }, [kind]);
  return (
    <AppProvider>{kind === 'quick-entry' ? <QuickEntry /> : kind === 'check' ? <CheckPopup /> : kind === 'scraptf' ? <ScraptfWindowBar /> : <Dashboard />}</AppProvider>
  );
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
  // F17: #/banks/<bank>/stock is a bank's stock page, under the scrap.tf banks nav entry.
  const stockBank = route === 'banks' ? bankStockRouteBank(segments) : null;
  const [unseen, setUnseen] = useState(0);
  const [priceCount, setPriceCount] = useState<number | null>(null);
  // F20: the badge counts opportunity events, so only their tab clears it (not #/log/changes).
  const oppEventsShown = route === 'log' && logTabOf(segments) === 'events';

  usePush('opps.changed', (p) => {
    if (!oppEventsShown) setUnseen((n) => Math.min(999, n + p.appeared + p.changed + p.gone));
  });
  useEffect(() => {
    if (oppEventsShown) setUnseen(0);
  }, [oppEventsShown]);
  useEffect(() => {
    document.getElementById('content')?.scrollTo({ top: 0 });
  }, [route, stockBank]);

  useEffect(() => {
    let alive = true;
    rpc('prices.list', {})
      .then((p) => alive && setPriceCount(p.length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [dataVersion]);
  // Imports and quick-entry saves (a separate window) change the count too. 0.7.3: only while visible
  // (a read is the whole list); closed to the tray, it recounts once when shown again.
  const recountPrices = useThrottled(() => {
    rpc('prices.list', {})
      .then((p) => setPriceCount(p.length))
      .catch(() => undefined);
  }, 1000);
  useVisiblePush('prices.changed', recountPrices);

  if (!status && bridgeError) {
    // 0.7.2: the service answered but refused data a newer copy of the app already updated. It is
    // reachable, so this gets its own screen: what happened, which copy is running, what to do.
    const tooNew = parseDataTooNew(bridgeError);
    return (
      <div className="fatal">
        {/* During a known restart (status.get timed out waiting for it) the banner says why, with its countdown. */}
        <ServiceBanner />
        {tooNew ? (
          <DataTooNewScreen refusal={tooNew} onRetry={refreshStatus} />
        ) : (
          <ErrorBanner message={`Can't reach the background service: ${bridgeError}`} onRetry={refreshStatus} />
        )}
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
              <Fragment key={n.id}>
                <li>
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
                {/* F21: right under the banks, only while the user has the opt-in window on. */}
                {n.id === 'banks' && scraptfWindowOn(settings) ? <ScraptfWindowNavItem /> : null}
              </Fragment>
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
          {!status && !bridgeError ? <LoadingBlock label="Starting…" /> : <RouteView route={route} stockBank={stockBank} />}
        </main>
      </div>
      <ItemDrawer />
      <ToastStack />
    </div>
  );
}

/**
 * F21: opens the scrap.tf window, or brings it to the front (main's 'scraptfWindow.open' with no page:
 * a new window starts on scrap.tf's front page). A window, not a route: it is a button, on a click only.
 */
function ScraptfWindowNavItem() {
  const { toast } = useApp();
  const open = () => {
    rpc('scraptfWindow.open').catch((e: unknown) => toast(windowOpenFailedText(errorMessage(e)), 'bad'));
  };
  return (
    <li>
      {/* Named by aria-label: the icon-only nav (1100 px and down) hides the label, and the title is a sentence. */}
      <button type="button" className="nav-link nav-window" aria-label={SCRAPTF_WINDOW_NAV_LABEL} title={SCRAPTF_WINDOW_NAV_TITLE} onClick={open}>
        <Icon name="window" size={17} />
        <span className="nav-label">{SCRAPTF_WINDOW_NAV_LABEL}</span>
        <Icon name="external" size={12} className="nav-ext" />
      </button>
    </li>
  );
}

function RouteView({ route, stockBank }: { route: RouteId; stockBank: ScraptfBank | null }) {
  // Keyed by bank: each bank's page starts fresh with its own remembered filter, search and order.
  if (stockBank) return <BankStockPage key={stockBank} bank={stockBank} />;
  switch (route) {
    case 'opportunities':
      return <OpportunitiesPage />;
    case 'market':
      return <MarketPage />;
    case 'banks':
      return <BanksPage />;
    case 'shopping':
      return <ShoppingPage />;
    case 'holdings':
      return <HoldingsPage />;
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
  // 0.7.3: the user's switch, the value the click flips (as the tray and Settings show it). Main
  // broadcasts every settings change; status lags, e.g. while the service is restarting.
  const paused = settings?.networkPaused ?? status?.networkPaused ?? false;
  const feed = status?.feed ?? 'connecting';
  // What scrap.tf pays for a key, from the source that caps the automatic value (a newer saved list replaces the typed price).
  const stfTip = kp && settings ? scraptfKeyTipText(kp.scraptfFromList, settings.keyPrice, now) : null;

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
                {stfTip ? <div className="muted small">{stfTip}</div> : null}
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
