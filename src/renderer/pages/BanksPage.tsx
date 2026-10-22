// scrap.tf banks (F15): one card per scrap.tf page the user saves (the seven bank pages and the
// /items price list), from 'scraptf.banks': when each was last saved, its flips and what to look
// for there. Everything on it comes from pages the user saved with their own browser into the
// opt-in watch folder (R10). "Open in browser" hands the static page to links.open (openOrCopy);
// Flip Desk never loads scrap.tf on its own (R1): no fetch, nothing polled. Pure helpers
// live in banksModel.ts, styles in styles/banks.css. F17: each card says what changed since the
// previous save and links to the bank's stock page (#/banks/<bank>/stock). F21: while the user has
// the opt-in scrap.tf window on, each card also has "Open in Flip Desk window" ('scraptfWindow.open'
// with the bank's static SCRAPTF_BANKS page, on a click only); main loads it there for the user.
// 0.7.1 (UX-1): the header adds "N flips on your saves, newest 3 min ago · View all", which opens
// the Live market's #/market/flips (every Flip from a saved page, the freshest sighting first).
// 0.8 (G1): "Your scrap.tf watches" (WatchesCard) below the cards: a local list, judged on the user's own saves.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { scraptfBankInfo } from '../../shared/links';
import type { Scrap, ScraptfBank, ScraptfBanksResult, ScraptfListStatus, UnixMs } from '../../shared/types';
import { rpc } from '../api';
import {
  BANKS_REFRESH_MS,
  BANK_SAVE_TIP,
  LIST_SAVE_TIP,
  bankCards,
  banksFlipsLine,
  bankGridMove,
  bankStockPath,
  banksHeadline,
  banksRouteBank,
  createBanksLoader,
  gridColumns,
  type BankCardView,
  type BanksLoader,
} from '../banksModel';
import { openOrCopy } from '../components/ExternalLink';
import { ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { useItemMenu, type ItemMenuTarget } from '../components/ItemMenu';
import { ItemName } from '../components/ItemName';
import { SaveModeChoice, SetupNoteView, copyFolderPath, useScraptfListStatus, useWatchFolderPicker } from '../components/ScraptfListCard';
import { WatchesCard } from '../components/WatchesCard';
import { errorMessage } from '../format';
import { useApp } from '../hooks/appContext';
import { useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useNow } from '../hooks/useTimers';
import { SAVE_MODE, SAVE_MODE_LIST_ONLY } from '../importModel';
import { MARKET_FLIPS_PATH, marketBankPath } from '../marketModel';
import { listBoundaryNote, listSetupNote, listSetupState, listStatusLine } from '../scraptfListModel';
import { bankWindowView, OPEN_IN_WINDOW_LABEL, windowOpenFailedText, windowOpenTitle, type BankWindowView } from '../scraptfWindowModel';

type MenuPoint = { x: number; y: number };

const IMPORT_OFF_TIP = 'Turn on saved-page import first: a page you save is not read while it is off.';
const LIST_ABOUT = "scrap.tf's public price list of every item it trades: what it charges, what it pays and its stock.";

/**
 * 'scraptf.banks', kept current: every import, price, list or market change pushes
 * 'scraptf.banksChanged' (the mock pushes each one at once), so reads are throttled to one per
 * BANKS_REFRESH_MS, none while the window is hidden (one catch-up when shown), and reads never
 * overlap, so an older answer never replaces a newer one (createBanksLoader).
 */
function useBanks(): { data: ScraptfBanksResult | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<ScraptfBanksResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loader = useRef<BanksLoader | null>(null);
  // Created in an effect, so StrictMode's mount, unmount, mount ends with a live loader, and an
  // unmount drops whatever is still in flight.
  useEffect(() => {
    const l = createBanksLoader(() => rpc('scraptf.banks'), {
      data: (r) => {
        setData(r);
        setError(null);
      },
      error: setError,
    });
    loader.current = l;
    l.refresh();
    return () => {
      l.dispose();
      loader.current = null;
    };
  }, []);
  const refresh = useCallback(() => loader.current?.refresh(), []);
  const refreshSoon = useThrottled(refresh, BANKS_REFRESH_MS);
  useVisiblePush('scraptf.banksChanged', refreshSoon);
  return { data, error, refresh };
}

export function BanksPage() {
  const { keyScrap, segments, navigate, openItem, toast, settings } = useApp();
  const banks = useBanks();
  const list = useScraptfListStatus();
  const folder = useWatchFolderPicker();
  const now = useNow(15_000);
  const menu = useItemMenu();
  const openMenu = useRef(menu.open);
  openMenu.current = menu.open;
  const scraptfWindow = bankWindowView(settings);

  const openInWindow = (c: BankCardView) => {
    // The page from the static list by the card's bank id, never one an answer carried.
    const info = scraptfBankInfo(c.bank);
    if (!info) return;
    rpc('scraptfWindow.open', { start: info.url }).catch((e: unknown) => toast(windowOpenFailedText(errorMessage(e)), 'bad'));
  };

  return (
    <div className="page banks-page">
      <BanksView
        result={banks.data}
        error={banks.error}
        status={list.status}
        now={now}
        keyScrap={keyScrap}
        picking={folder.picking}
        focusBank={banksRouteBank(segments)}
        scraptfWindow={scraptfWindow}
        inputStaleMs={settings?.profit.inputStaleMs ?? null}
        onRetry={banks.refresh}
        onViewFlips={() => navigate(MARKET_FLIPS_PATH)}
        onPickFolder={folder.pick}
        onGoImport={() => navigate('import')}
        onCopyPath={(path) => copyFolderPath(path, toast)}
        onOpenBank={(c) => void openOrCopy(c.url, toast, { allowWindow: true })}
        onOpenInWindow={openInWindow}
        onImportOff={() => toast(IMPORT_OFF_TIP, 'warn')}
        onItem={openItem}
        onItemMenu={(target, at) => openMenu.current(target, at)}
        onSeeAll={(bank) => {
          const path = marketBankPath(bank);
          if (path) navigate(path);
        }}
        onViewStock={(bank) => {
          const stock = bankStockPath(bank);
          if (stock) navigate(stock);
        }}
      />
      {/* 0.8 (G1): the user's scrap.tf watches, judged on their own reads and saves only (a local list). */}
      <WatchesCard keyScrap={keyScrap} now={now} onItem={(sku, copy) => openItem(sku, copy)} />
      <p className="hint-line muted small">
        Keyboard: arrows move between the pages, <kbd>Enter</kbd> opens the focused one in {openTarget(scraptfWindow)}, <kbd>Shift</kbd>+<kbd>F10</kbd> or right-click on an item
        for its actions.
      </p>
      {menu.element}
    </div>
  );
}

export interface BanksViewProps {
  /** null until the first 'scraptf.banks' answer. */
  result: ScraptfBanksResult | null;
  error: string | null;
  /** The watch folder's state ('scraptf.listStatus'), as the price list card reads it; null until read. */
  status: ScraptfListStatus | null;
  now: UnixMs;
  keyScrap: Scrap | null;
  /** The folder dialog is open. */
  picking: boolean;
  /** #/banks/<bank>: focus that card once (a Live market coverage chip). */
  focusBank: ScraptfBank | null;
  /** F21: the user's opt-in scrap.tf window (bankWindowView); null or absent while it is off. */
  scraptfWindow?: BankWindowView | null;
  /** ACT-8: settings.profit.inputStaleMs, so a fresh save words "What to look for" as restocks to watch. */
  inputStaleMs?: number | null;
  onRetry(): void;
  /** UX-1: the header's "View all" flips (#/market/flips). */
  onViewFlips?(): void;
  onPickFolder(): void;
  onGoImport(): void;
  onCopyPath(path: string): void;
  /** Hands card.url (a static SCRAPTF_BANKS page) to the user's browser. */
  onOpenBank(card: BankCardView): void;
  /** F21: "Open in Flip Desk window" (shown only with `scraptfWindow`). */
  onOpenInWindow?(card: BankCardView): void;
  /** Enter on a card while import is off (its Open button is disabled). */
  onImportOff(): void;
  onItem(sku: string): void;
  onItemMenu(target: ItemMenuTarget, at: MenuPoint): void;
  onSeeAll(bank: ScraptfBank): void;
  /** F17: the bank's stock page (#/banks/<bank>/stock). */
  onViewStock(bank: ScraptfBank): void;
}

/** The page without its data hooks. Exported for the render tests only. */
export function BanksView(p: BanksViewProps) {
  const stale = p.inputStaleMs ?? null;
  const cards = useMemo(() => bankCards(p.result, p.keyScrap, p.now, stale), [p.result, p.keyScrap, p.now, stale]);
  // The list status says first (it is re-read on every settings change); the banks answer until then.
  const importOff = p.status ? !p.status.importEnabled : p.result ? !p.result.importEnabled : false;
  const listDetail = p.status ? listStatusLine(p.status, p.now).detail : null;
  return (
    <>
      <BanksHeader {...p} />
      {p.error ? <ErrorBanner message={`Could not read your scrap.tf pages: ${p.error}`} onRetry={p.onRetry} /> : null}
      {p.result ? (
        <BankGrid
          cards={cards}
          focusBank={p.focusBank}
          actions={{
            importOff,
            listDetail,
            scraptfWindow: p.scraptfWindow ?? null,
            onOpenBank: p.onOpenBank,
            onOpenInWindow: p.onOpenInWindow,
            onImportOff: p.onImportOff,
            onItem: p.onItem,
            onItemMenu: p.onItemMenu,
            onSeeAll: p.onSeeAll,
            onViewStock: p.onViewStock,
          }}
        />
      ) : p.error ? null : (
        <LoadingBlock label="Reading your saved scrap.tf pages…" />
      )}
    </>
  );
}

/** "3 of 8 scrap.tf pages saved in the last hour", what to fix before a save is read, the folder and the boundary. */
function BanksHeader(p: BanksViewProps) {
  const head = banksHeadline(p.result, p.now);
  const flips = banksFlipsLine(p.result, p.now);
  const windowOn = (p.scraptfWindow ?? null) !== null;
  // Until (or unless) the list status is read, the banks answer says whether import is off, as the
  // disabled Open buttons do, so they are never disabled without the reason and its fix.
  const setup = p.status ? listSetupState(p.status, windowOn) : p.result && !p.result.importEnabled ? 'import-off' : null;
  const note = setup ? listSetupNote(setup, 'banks', p.status?.watchError ?? null) : null;
  const folder = setup === 'ready' ? (p.status?.watchFolder ?? null) : null;
  return (
    <section className="card banks-head" aria-labelledby="banks-headline">
      <h2 id="banks-headline" className="banks-headline" title={head.title}>
        <Icon name="banks" size={15} /> {head.text}
      </h2>
      {flips ? (
        <p className="banks-flips" title={flips.title}>
          <Icon name="bolt" size={13} />
          <span className="tone-text-good">{flips.text}</span>
          {p.onViewFlips ? (
            <>
              <span aria-hidden="true"> · </span>
              <button type="button" className="link-btn small banks-view-flips" title="Opens the Live market on every Flip from your saved pages, the freshest first." onClick={p.onViewFlips}>
                View all
                <Icon name="chevronRight" size={12} />
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {note ? <SetupNoteView note={note} picking={p.picking} onGoImport={p.onGoImport} onPickFolder={p.onPickFolder} /> : null}
      {folder ? (
        <p className="banks-folder">
          <Icon name="folder" size={13} />
          <span>Save into</span>
          <span className="sl-path mono" title={folder}>
            {folder}
          </span>
          <button type="button" className="btn ghost small" onClick={() => p.onCopyPath(folder)} title="Copy the folder path, to paste into your browser's save dialog">
            <Icon name="copy" size={13} /> Copy path
          </button>
        </p>
      ) : null}
      {/* F18: said once here in full; each card names the save type only. The list card is the one
          page the alternative does not suit, so the line says so too, not only the card's tooltip. */}
      <p className="sl-boundary banks-save-mode">
        <Icon name="info" size={13} />
        <span>
          In the save dialog, <SaveModeChoice />. {SAVE_MODE_LIST_ONLY}
        </span>
      </p>
      <p className="sl-boundary">
        <Icon name="shield" size={13} />
        <span>{listBoundaryNote(windowOn)}</span>
      </p>
    </section>
  );
}

const MOVE_KEYS: ReadonlySet<string> = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']);

/** What a card does and shows besides its own data. */
type CardActions = Pick<BanksViewProps, 'onOpenBank' | 'onOpenInWindow' | 'onImportOff' | 'onItem' | 'onItemMenu' | 'onSeeAll' | 'onViewStock'> & {
  importOff: boolean;
  /** The list card's F14 detail ("3 saved pages, the oldest 26 h ago"), or null. */
  listDetail: string | null;
  /** F21: the user's scrap.tf window, null while it is off. */
  scraptfWindow: BankWindowView | null;
};

/** Where Enter (links.open) sends a card's page: main opens it in the scrap.tf window when the user chose that. */
function openTarget(w: BankWindowView | null | undefined): string {
  return w?.linksHere ? 'the Flip Desk window' : 'your browser';
}

/** The responsive card grid: one roving tab stop, arrows between cards, Enter opens the focused bank. */
function BankGrid({ cards, focusBank, actions: a }: { cards: BankCardView[]; focusBank: ScraptfBank | null; actions: CardActions }) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  const focusCard = (i: number) => {
    setActive(i);
    refs.current[i]?.focus();
  };

  // A Live market chip (#/banks/<bank>) lands on its card, once per visit of that route.
  const focusedFor = useRef<ScraptfBank | null>(null);
  useEffect(() => {
    if (focusBank === null) {
      focusedFor.current = null;
      return;
    }
    if (focusedFor.current === focusBank) return;
    const i = cards.findIndex((c) => c.bank === focusBank);
    if (i < 0) return;
    focusedFor.current = focusBank;
    setActive(i);
    const el = refs.current[i];
    el?.focus({ preventScroll: true });
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [focusBank, cards]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, i: number) => {
    // Only the card itself: its buttons keep their own keys.
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      // A held Enter would hand the page to the browser once per key repeat: one tab each.
      if (e.repeat) return;
      if (a.importOff) a.onImportOff();
      else a.onOpenBank(cards[i]!);
      return;
    }
    if (!MOVE_KEYS.has(e.key)) return;
    e.preventDefault();
    // Rows of the wrapped grid, read from the layout: up and down keep the column.
    const tops = refs.current.slice(0, cards.length).map((el) => (el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().top : 0));
    const next = bankGridMove(i, e.key, cards.length, gridColumns(tops));
    if (next !== null) focusCard(next);
  };

  return (
    <div className="banks-grid" role="group" aria-label={`Your scrap.tf pages. Arrow keys move between them, Enter opens one in ${openTarget(a.scraptfWindow)}.`}>
      {cards.map((c, i) => (
        <BankCard
          key={c.bank}
          card={c}
          tabIndex={i === active ? 0 : -1}
          cardRef={(el) => {
            refs.current[i] = el;
          }}
          onKeyDown={(e) => onKeyDown(e, i)}
          onFocus={() => setActive(i)}
          actions={a}
        />
      ))}
    </div>
  );
}

function BankCard(p: {
  card: BankCardView;
  tabIndex: number;
  cardRef(el: HTMLElement | null): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  onFocus(): void;
  actions: CardActions;
}) {
  const { card: c, actions: a } = p;
  const w = a.scraptfWindow;
  const ids = useId();
  const titleId = `${ids}-title`;
  const savedId = `${ids}-saved`;
  const flipsId = `${ids}-flips`;
  const lookId = `${ids}-look`;
  const fresh = c.freshness.tone === 'good';
  const menuAt = (e: MouseEvent, target: ItemMenuTarget) => {
    // Right-click, or Shift+F10 / the ContextMenu key on the focused row (the menu places a keyboard
    // event's 0,0 next to that row).
    e.preventDefault();
    a.onItemMenu(target, { x: e.clientX, y: e.clientY });
  };
  return (
    <section
      ref={p.cardRef}
      className={`card bank-card tone-${c.freshness.tone}${c.isList ? ' bank-list' : ''}`}
      data-bank={c.bank}
      tabIndex={p.tabIndex}
      aria-labelledby={titleId}
      aria-describedby={savedId}
      onKeyDown={p.onKeyDown}
      onFocus={p.onFocus}
    >
      <div className="bank-head">
        <h3 id={titleId} className="bank-title">
          {c.label}
        </h3>
        <span className="bank-path mono">{c.path}</span>
        <span className={`pill bank-fresh tone-${c.freshness.tone}`} title={c.freshness.title}>
          <span className="status-dot" aria-hidden="true" />
          {c.freshness.label}
        </span>
      </div>
      <p id={savedId} className="bank-saved" title={c.saved.title}>
        {c.saved.text}
      </p>
      {/* 0.9 (#13): the bank's newest look said it was not trading: that look stored no save (nothing reads as sold). */}
      {c.unavailable ? (
        <p className="bank-unavailable small tone-text-warn" title={c.unavailable.title}>
          <Icon name="warning" size={12} /> {c.unavailable.text}
        </p>
      ) : null}
      {/* F17: what changed since the previous save, and every item on the newest one. */}
      <div className="bank-stock-line">
        {c.whatsNew ? (
          <p className={`bank-whats-new${c.whatsNew.kind === 'first' ? ' muted' : ''}`} title={c.whatsNew.title}>
            {c.whatsNew.lead}
            {c.whatsNew.parts.map((part, i) => (
              <span key={part.text} className={part.tone === 'muted' ? 'muted' : part.tone ? `tone-text-${part.tone}` : undefined}>
                {i > 0 ? ' · ' : ' '}
                {part.strong ? <strong>{part.text}</strong> : part.text}
                {part.extra ? ` ${part.extra}` : null}
              </span>
            ))}
          </p>
        ) : null}
        <button type="button" className="link-btn small bank-view-stock" title={c.stockTitle} aria-label={`View stock: ${c.path}`} onClick={() => a.onViewStock(c.bank)}>
          View stock
          <Icon name="chevronRight" size={12} />
        </button>
      </div>
      {c.isList ? (
        <p className="bank-about muted small">
          {LIST_ABOUT}
          {a.listDetail ? ` From ${a.listDetail}.` : ''}
        </p>
      ) : null}

      <div className="bank-open">
        {/* Eight buttons read alike: the name says which page, starting with the visible text. F21: when
            main sends Flip Desk's scrap.tf links to the user's window, this one would land there too. */}
        {w?.linksHere ? null : (
          <button
            type="button"
            className={`btn small${fresh ? '' : ' primary'}`}
            disabled={a.importOff}
            title={a.importOff ? IMPORT_OFF_TIP : c.openTitle}
            aria-label={`Open in browser: ${c.path}`}
            onClick={() => a.onOpenBank(c)}
          >
            <Icon name="external" size={13} /> Open in browser
          </button>
        )}
        {w ? (
          <button
            type="button"
            className={`btn small bank-open-window${w.linksHere && !fresh ? ' primary' : ''}`}
            disabled={a.importOff}
            title={a.importOff ? IMPORT_OFF_TIP : windowOpenTitle(c.path, w.readOnLoad)}
            aria-label={`${OPEN_IN_WINDOW_LABEL}: ${c.path}`}
            onClick={() => a.onOpenInWindow?.(c)}
          >
            <Icon name="window" size={13} /> {OPEN_IN_WINDOW_LABEL}
          </button>
        ) : null}
        <span className="bank-tip muted small" title={c.isList ? LIST_SAVE_TIP : BANK_SAVE_TIP}>
          {w ? (
            <>
              In the Flip Desk window it is {w.readOnLoad ? 'read as it loads' : 'read when you press Read page now'}; or save it with <kbd>Ctrl</kbd>+<kbd>S</kbd> as{' '}
              <strong>{SAVE_MODE}</strong> into your watch folder.
            </>
          ) : (
            <>
              Save it with <kbd>Ctrl</kbd>+<kbd>S</kbd> as <strong>{SAVE_MODE}</strong> into your watch folder; it updates here within seconds.
            </>
          )}
        </span>
      </div>

      <div className="bank-block" role="group" aria-labelledby={flipsId}>
        <h4 id={flipsId} className="bank-block-title" title={c.flips.title}>
          {c.flips.text}
          {c.flips.profit ? <span className="money pos"> {c.flips.profit}</span> : null}
        </h4>
        {c.top.length ? (
          <ul className="bank-rows">
            {/* Keyed by place too: a plain and a spelled copy of one SKU are two opportunities (sku|inputRef). */}
            {c.top.map((r, i) => (
              <li key={`${i}:${r.sku}`}>
                <button
                  type="button"
                  className="bank-row"
                  title={r.title}
                  onClick={() => a.onItem(r.sku)}
                  onContextMenu={(e) => menuAt(e, { sku: r.sku, name: r.name, bank: c.bank })}
                >
                  <span className="bank-row-name">
                    <ItemName sku={r.sku} name={r.name} tags={false} />
                  </span>
                  <span className="bank-row-meta">
                    {r.cost} · <span className={`conf-${r.level}`}>{r.confidence}</span>
                  </span>
                  <span className="bank-row-value money pos">{r.profit}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {c.lookFor ? (
        <div className="bank-block" role="group" aria-labelledby={lookId}>
          <h4 id={lookId} className="bank-block-title" title={c.lookFor.title.title}>
            {c.lookFor.title.text}
          </h4>
          {c.lookFor.rows.length ? (
            <ul className="bank-rows">
              {c.lookFor.rows.map((r, i) => (
                <li key={`${i}:${r.sku}`}>
                  <button
                    type="button"
                    className="bank-row"
                    title={r.title}
                    onClick={() => a.onItem(r.sku)}
                    onContextMenu={(e) => menuAt(e, { sku: r.sku, name: r.name, bank: c.bank })}
                  >
                    <span className="bank-row-name">
                      <ItemName sku={r.sku} name={r.name} tags={false} />
                    </span>
                    <span className="bank-row-value money">{r.payUpTo}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {c.lookFor.empty ? <p className="bank-empty muted small">{c.lookFor.empty}</p> : null}
          {c.lookFor.seeAll ? (
            <button
              type="button"
              className="link-btn small bank-see-all"
              title={c.lookFor.seeAllTitle}
              aria-label={`${c.lookFor.seeAll}: ${c.label}`}
              onClick={() => a.onSeeAll(c.bank)}
            >
              {c.lookFor.seeAll}
              <Icon name="chevronRight" size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
