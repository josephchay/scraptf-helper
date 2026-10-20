// F21: the scrap.tf window's toolbar (window kind 'scraptf', main's SCRAPTF_BAR_URL; '#/scraptf-bar' in a
// plain browser against the mock). An app:// page 48 px tall above main's scrap.tf view, so nothing here
// may draw below that line (the view covers it): tooltips are native titles, notes stay in the bar.
//
// Every control is a user action sent to main ('scraptfWindow.*'): Back, Forward, Reload, Home, the bank
// chips (static SCRAPTF_BANKS pages only; main refuses anything else), Read page now and Log out & clear.
// 0.7.1: Show flips and the best flip's name show the dashboard ('app.showBankStock', 'app.openItem'); they
// load nothing in the window. The address is read-only text from main's 'scraptfWindow.nav' (origin and
// path, never a query), the status line from 'scraptfWindow.read' and nav's fixed notice. This page never
// loads, reads or sees scrap.tf itself: no effect, push listener or timer here calls main's window methods
// or Show flips (the compliance scan checks), and nothing here builds a URL. Pure helpers live in
// scraptfWindowModel.ts, styles in styles/scraptf-window.css.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { RpcMethod } from '../../shared/rpc';
import type { ScraptfWindowNav, ScraptfWindowRead } from '../../shared/types';
import { isMock, rpc } from '../api';
import { ConfirmButton } from '../components/Controls';
import { Icon, type IconName } from '../components/Icon';
import { errorMessage } from '../format';
import { useApp } from '../hooks/appContext';
import { usePush } from '../hooks/useRpc';
import { useNow } from '../hooks/useTimers';
import {
  activeBankOf,
  addressView,
  BAR_SHORTCUTS,
  barBankChips,
  barFocusMove,
  barShortcut,
  bestFlipTitle,
  readButtonView,
  readStatusView,
  SCRAPTF_WINDOW_CLEAR_TITLE,
  SCRAPTF_WINDOW_PARTITION_NOTE,
  SCRAPTF_WINDOW_PARTITION_PILL,
  SCRAPTF_WINDOW_RISK_PILL,
  SCRAPTF_WINDOW_RISK_TIP,
  showFlipsView,
  WINDOW_CLEARED_TEXT,
  windowNoticeText,
  type BarAction,
  type ShowFlipsView,
} from '../scraptfWindowModel';

// Kept importable from here (the mock's tests used it before the model existed).
export { readStatusText, SCRAPTF_WINDOW_RISK_TIP } from '../scraptfWindowModel';

/** Main's method per view control. The literals sit here, outside any effect or callback. */
const NAV_METHODS = {
  back: 'scraptfWindow.back',
  forward: 'scraptfWindow.forward',
  reload: 'scraptfWindow.reload',
  home: 'scraptfWindow.home',
} as const satisfies Record<BarAction, RpcMethod>;

const NO_NAV: ScraptfWindowNav = { url: null, canGoBack: false, canGoForward: false, loading: false };

interface Note {
  text: string;
  tone: 'good' | 'warn' | 'bad';
}

/** A note (a refusal, a failed call, Log out done) gives the status line back after this. */
const NOTE_MS = { good: 6_000, warn: 8_000, bad: 12_000 } as const;
/** A read under a minute old ticks its "3 s ago" every second, older ones every 15 s. */
const FRESH_READ_MS = 60_000;

/** The toolbar's focusable controls in order, for its arrow keys (hidden ones, display: none, skipped). */
function barControls(root: HTMLElement | null): HTMLElement[] {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.from(root.querySelectorAll<HTMLElement>('button, input')).filter(
    (el) => !(el as HTMLButtonElement).disabled && !el.hasAttribute('disabled') && (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0),
  );
}

export function ScraptfWindowBar() {
  const { settings } = useApp();
  const [nav, setNav] = useState<ScraptfWindowNav>(NO_NAV);
  const [read, setRead] = useState<ScraptfWindowRead | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [reading, setReading] = useState(false);
  // main's notice about the page on screen (a challenge, a failed load, a link it kept): shown until a newer
  // read or the next page (main clears it at the next commit).
  const [notice, setNotice] = useState<string | null>(null);
  const lastNotice = useRef<string | null>(null);
  // F21-6: a "Stay signed in" change waits for the window to be reopened.
  const [pendingPartition, setPendingPartition] = useState(false);
  const readingRef = useRef(false);
  // A push that came before the state answer is newer than it.
  const navPushed = useRef(false);
  const readPushed = useRef(false);
  const barRef = useRef<HTMLDivElement>(null);
  const riskId = useId();
  const now = useNow(read !== null && Date.now() - read.at < FRESH_READ_MS ? 1000 : 15_000);

  // A toolbar that loads after main's first pushes asks for the state once ('state' moves nothing).
  useEffect(() => {
    let alive = true;
    rpc('scraptfWindow.state')
      .then((s) => {
        if (!alive) return;
        if (!navPushed.current) setNav({ url: s.url, canGoBack: s.canGoBack, canGoForward: s.canGoForward, loading: false });
        if (!readPushed.current) setRead(s.lastRead);
        setPendingPartition(s.pendingPartitionChange === true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  // "Stay signed in" changed after the toolbar knew it: main says whether this window now waits for a reopen.
  // 'state' only reports; it moves and reads nothing.
  const keep = settings?.scraptfWindow?.keepLoggedIn;
  const keepSeen = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (keep === undefined) return;
    const before = keepSeen.current;
    keepSeen.current = keep;
    if (before === undefined || before === keep) return;
    let alive = true;
    rpc('scraptfWindow.state')
      .then((s) => {
        if (alive) setPendingPartition(s.pendingPartitionChange === true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [keep]);
  usePush('scraptfWindow.nav', (n) => {
    navPushed.current = true;
    setNav(n);
    // A new notice (or none, at the next page) takes the status line; the same one again changes nothing.
    const next = windowNoticeText(n.notice);
    if (next !== lastNotice.current) {
      lastNotice.current = next;
      setNotice(next);
    }
  });
  usePush('scraptfWindow.read', (r) => {
    readPushed.current = true;
    setRead(r);
    // A newer read takes the line from a notice.
    setNotice(null);
    // null: Log out & clear ran (here or in Settings): the read belonged to the session just cleared.
    setNote(r === null ? { text: WINDOW_CLEARED_TEXT, tone: 'good' } : null);
  });

  // Only the note goes away on its own; this timer never calls main.
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), NOTE_MS[note.tone]);
    return () => clearTimeout(id);
  }, [note]);

  const fail = (e: unknown) => setNote({ text: errorMessage(e), tone: 'bad' });

  const act = (a: BarAction) => {
    rpc(NAV_METHODS[a]).catch(fail);
  };

  const go = (url: string) => {
    rpc('scraptfWindow.go', { url }).catch(fail);
  };

  const readNow = () => {
    // One read at a time; main throttles Read page now as well (READ_MANUAL_MIN_GAP_MS).
    if (readingRef.current) return;
    readingRef.current = true;
    setReading(true);
    rpc('scraptfWindow.read')
      .then((o) => {
        if (o.read) {
          readPushed.current = true;
          setRead(o.read);
          setNotice(null);
        }
        setNote(o.reason ? { text: o.reason, tone: 'warn' } : null);
      })
      .catch(fail)
      .finally(() => {
        readingRef.current = false;
        setReading(false);
      });
  };

  // Show flips: the dashboard on the read bank's stock page (main shows it; nothing loads in this window).
  const showFlips = (f: ShowFlipsView) => {
    rpc('app.showBankStock', { bank: f.bank, filter: f.filter }).catch(fail);
  };

  // The best flip's name: its item in the dashboard.
  const openBest = (sku: string) => {
    rpc('app.openItem', { sku }).catch(fail);
  };

  const clear = () => {
    rpc('scraptfWindow.clear')
      .then(() => {
        setRead(null);
        setNote({ text: WINDOW_CLEARED_TEXT, tone: 'good' });
      })
      .catch(fail);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const a = barShortcut(e);
    if (a) {
      e.preventDefault();
      // A held key is one press: holding F5 must not reload over and over.
      if (e.repeat) return;
      if ((a === 'back' && !nav.canGoBack) || (a === 'forward' && !nav.canGoForward) || (a === 'reload' && !nav.url)) return;
      act(a);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    // The address keeps its own caret keys.
    if (target.tagName === 'INPUT') return;
    const controls = barControls(barRef.current);
    const at = controls.indexOf(target);
    if (at < 0) return;
    const next = barFocusMove(at, e.key, controls.length);
    if (next === null) return;
    e.preventDefault();
    controls[next]!.focus();
  };

  const readOnLoad = settings?.scraptfWindow?.readOnLoad ?? true;
  const address = addressView(nav.url);
  const readBtn = readButtonView(nav.url, reading, nav.importable);
  const status = readStatusView(read, now, readOnLoad);
  const flips = showFlipsView(read);
  // 0.7.3: main's notice as the reading-on-load setting words it (a challenge says to press Read page now when off).
  const noticeLine = notice === null ? null : windowNoticeText(notice, readOnLoad);
  // The line: a note (a refusal, Log out done) first, then main's notice, then the newest read.
  const tone = note ? note.tone : noticeLine ? 'warn' : status.tone;
  const lineTitle = note ? note.text : (noticeLine ?? status.title);
  const active = activeBankOf(nav.url);
  const addressIcon: IconName = address.kind === 'scraptf' ? 'shield' : address.kind === 'steam' ? 'user' : 'info';

  return (
    <>
      <div ref={barRef} className="stfw-bar" role="toolbar" aria-label="scrap.tf window" onKeyDown={onKeyDown}>
        <div className="stfw-nav" role="group" aria-label="Page">
          <NavButton action="back" icon="chevronLeft" label="Back" disabled={!nav.canGoBack} onAct={act} />
          <NavButton action="forward" icon="chevronRight" label="Forward" disabled={!nav.canGoForward} onAct={act} />
          <NavButton action="reload" icon="refresh" label="Reload" disabled={!nav.url} onAct={act} />
          <NavButton action="home" icon="home" label="Home (scrap.tf)" onAct={act} />
        </div>
        <div className="stfw-chips" role="group" aria-label="scrap.tf banks">
          {barBankChips().map((c) => (
            <button
              key={c.bank}
              type="button"
              className={`stfw-chip${active === c.bank ? ' active' : ''}`}
              aria-current={active === c.bank ? 'page' : undefined}
              title={c.title}
              onClick={() => go(c.url)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="stfw-info">
          <div className={`stfw-address-row kind-${address.kind}`}>
            <Icon name={addressIcon} size={12} />
            <input
              className="stfw-address"
              type="text"
              readOnly
              value={address.text}
              placeholder="No page open"
              aria-label="Page address (read-only)"
              aria-busy={nav.loading || undefined}
              title={address.title}
              spellCheck={false}
            />
            {nav.loading ? <span className="stfw-loading">Loading…</span> : nav.reading ? <span className="stfw-loading">Reading…</span> : null}
          </div>
          <div className={`stfw-statusline${tone === 'muted' ? ' muted' : tone ? ` tone-text-${tone}` : ''}`} title={lineTitle}>
            <span className="stfw-status" role="status">
              {note ? (
                note.text
              ) : noticeLine ? (
                noticeLine
              ) : status.best ? (
                <>
                  {status.lead} · best{' '}
                  <button type="button" className="link-btn stfw-best" title={bestFlipTitle(status.best)} onClick={() => openBest(status.best!.sku)}>
                    {status.best.name}
                  </button>{' '}
                  {status.best.profit}
                  {status.tail}
                </>
              ) : (
                status.main
              )}
            </span>
            {!note && !noticeLine && status.age ? (
              <span className="stfw-age" aria-hidden="true">
                {' '}
                · {status.age}
              </span>
            ) : null}
          </div>
        </div>
        <button type="button" className="btn small primary stfw-read" disabled={readBtn.disabled} title={readBtn.title} onClick={readNow}>
          <Icon name="import" size={13} />
          <span className="stfw-long">{readBtn.label}</span>
          <span className="stfw-short">{reading ? 'Reading…' : 'Read'}</span>
        </button>
        {flips ? (
          <button type="button" className="btn small stfw-read stfw-flips" title={flips.title} onClick={() => showFlips(flips)}>
            <Icon name="bolt" size={13} />
            <span className="stfw-long">{flips.label}</span>
            <span className="stfw-short">Flips</span>
          </button>
        ) : null}
        {pendingPartition ? (
          <button type="button" className="pill tone-info stfw-risk stfw-reopen" title={SCRAPTF_WINDOW_PARTITION_NOTE} onClick={() => setNote({ text: SCRAPTF_WINDOW_PARTITION_NOTE, tone: 'warn' })}>
            <Icon name="info" size={12} />
            <span className="stfw-long">{SCRAPTF_WINDOW_PARTITION_PILL}</span>
            <span className="stfw-short">Reopen</span>
          </button>
        ) : null}
        {/* Always shown. A click puts the risk in the status line, for keyboard and touch too. */}
        <button type="button" className="pill tone-warn stfw-risk" title={SCRAPTF_WINDOW_RISK_TIP} aria-describedby={riskId} onClick={() => setNote({ text: SCRAPTF_WINDOW_RISK_TIP, tone: 'warn' })}>
          <Icon name="warning" size={12} />
          <span className="stfw-long">{SCRAPTF_WINDOW_RISK_PILL}</span>
          <span className="stfw-short">Risk</span>
        </button>
        <span id={riskId} className="sr-only">
          {SCRAPTF_WINDOW_RISK_TIP}
        </span>
        <ConfirmButton className="btn small ghost stfw-clear" confirmLabel="Log out and clear?" ariaLabel="Log out & clear" title={SCRAPTF_WINDOW_CLEAR_TITLE} onConfirm={clear}>
          <Icon name="logout" size={13} />
          <span className="stfw-long">Log out &amp; clear</span>
        </ConfirmButton>
      </div>
      {isMock ? (
        <p className="stfw-mock muted small">
          Browser preview. In the app, the scrap.tf page you browse shows below this bar; nothing is loaded or read here, and every read above is made up.
        </p>
      ) : null}
    </>
  );
}

function NavButton({ action, icon, label, disabled = false, onAct }: { action: BarAction; icon: IconName; label: string; disabled?: boolean; onAct: (a: BarAction) => void }) {
  const keys = BAR_SHORTCUTS[action];
  return (
    <button type="button" className="icon-btn stfw-navbtn" disabled={disabled} aria-label={label} aria-keyshortcuts={keys.aria} title={`${label} (${keys.text})`} onClick={() => onAct(action)}>
      <Icon name={icon} size={15} />
    </button>
  );
}
