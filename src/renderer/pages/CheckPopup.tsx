// Live check popup (F16, window kind 'check'): main pushes 'ui.checkShow' with a CheckResult after the
// check hotkey or the opt-in clipboard watcher. In a plain browser, '#/check?demo=flip|over|no-price|not-item'
// gets demo results from the mock. The page never reads the clipboard itself (main does, readText only),
// never sees the copied text (only the resolved result), and nothing here contacts scrap.tf (R1).
//
// Small (about 380 x 220), frameless and always on top. It hides itself 10 s after each result unless
// hovered, focused or showing an Undo; main never hides it on blur. Keys: Enter saves the price,
// B records the buy, D opens the item in the dashboard, Esc hides.
//
// F19: a price copied on its own after "Open on scrap.tf" is checked as that item (main's 'check.arm');
// the note line says so. A saved price or a recorded buy ends that trip, so the popup disarms.

import { useEffect, useRef, useState } from 'react';
import { CHECK_HINT } from '../../shared/check';
import type { CheckResult } from '../../shared/types';
import { rpc } from '../api';
import {
  CHECK_WAITING_TEXT,
  checkActions,
  checkBoughtInput,
  checkCategoryText,
  checkKey,
  checkPayUpTo,
  checkPopupKey,
  checkPopupNote,
  checkPriceLine,
  checkQuickEntryParams,
  checkSaveButton,
  checkSaveInput,
  checkSellsLine,
  checkSummaryText,
  checkVerdictView,
  createCheckHideTimer,
  type CheckPopupAction,
  type CheckSaveState,
} from '../checkModel';
import { ToastStack } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { ItemName } from '../components/ItemName';
import { ConfidenceBadge, OnlineDot, TonePill } from '../components/Pills';
import { errorMessage, fmtKeysMetal } from '../format';
import { useApp } from '../hooks/appContext';
import { usePush } from '../hooks/useRpc';
import { useDocumentVisible, useNow } from '../hooks/useTimers';
import { afterBoughtUndo, boughtButton, boughtItText, type BoughtState } from '../quickModel';

/** The popup hides itself through main ('app.hideWindow'); in a plain browser that call is a no-op. */
function hide(): void {
  rpc('app.hideWindow').catch(() => undefined);
}

/** F19: the item opened on scrap.tf is dealt with once saved or bought; main's arm also lapses by itself. */
function disarm(): void {
  rpc('check.arm', null).catch(() => undefined);
}

/** True when `el` shows a keyboard focus ring (Tab), not focus left by a mouse click. */
function isKeyboardFocus(el: EventTarget | null): boolean {
  const m = (el as { matches?: (selector: string) => boolean } | null)?.matches;
  if (typeof m !== 'function') return true;
  try {
    return m.call(el, ':focus-visible');
  } catch {
    return true;
  }
}

/** The verdict pill, shared with the Live market's Recent checks and Settings → Live check → Test. */
export function CheckVerdictPill({ result }: { result: CheckResult }) {
  const v = checkVerdictView(result);
  return v ? (
    <TonePill tone={v.tone} title={v.title}>
      {v.text}
    </TonePill>
  ) : null;
}

export function CheckPopup() {
  const { toast, toasts } = useApp();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [saveState, setSaveState] = useState<CheckSaveState | null>(null);
  const [bought, setBought] = useState<BoughtState | null>(null);
  // A double press (Enter twice, B twice) must not write twice: Holdings would count two units.
  const busy = useRef({ save: false, bought: false });
  const [timer] = useState(() => createCheckHideTimer(hide));
  const visible = useDocumentVisible();
  const now = useNow(30_000);

  const shown = useRef(false);
  const shownKey = useRef<string | null>(null);
  usePush('ui.checkShow', (r) => {
    shown.current = true;
    // Another check starts its buttons afresh. Ids restart with the service process, so a restarted
    // service's id 1 must not inherit "Saved" from the old id 1: the key includes the check's time.
    // The same result shown again (main re-sends it on each show) keeps its state, so nothing writes twice.
    const key = checkKey(r);
    if (key !== shownKey.current) {
      shownKey.current = key;
      setSaveState(null);
      setBought(null);
    }
    setResult(r);
    timer.restart();
  });

  // Hidden (Esc, the timer, Details, or by main): nothing pending, and no pointer or focus can be on
  // it (a window hidden under the pointer never gets its mouseleave). Shown again: a fresh countdown
  // (main also pushes the result again, which restarts it the same way).
  useEffect(() => {
    if (!visible) {
      timer.stop();
      timer.hold('hover', false);
      timer.hold('focus', false);
    } else if (shown.current) timer.restart();
  }, [visible, timer]);
  useEffect(() => () => timer.stop(), [timer]);
  // Focus only holds while the popup window has it: a button left focused (or disabled under the
  // keyboard focus after Save) must not keep the popup up once the user is back in the browser.
  useEffect(() => {
    const onBlur = () => timer.hold('focus', false);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [timer]);

  // An Undo toast keeps the popup up until it goes (12 s, longer while hovered).
  const undoShown = toasts.some((t) => t.action !== undefined);
  useEffect(() => timer.hold('toast', undoShown), [timer, undoShown]);

  const hideNow = () => {
    timer.stop();
    hide();
  };

  const savePrice = async () => {
    const r = result;
    const input = checkSaveInput(r, Date.now());
    if (!r || !input || busy.current.save || checkSaveButton(saveState, r.id).disabled) return;
    busy.current.save = true;
    setSaveState({ id: r.id, status: 'saving' });
    try {
      await rpc('prices.upsert', input);
      disarm();
      setSaveState((s) => (s?.id === r.id ? { id: r.id, status: 'done' } : s));
      toast(`Saved ${input.name ?? input.sku} at ${fmtKeysMetal(input.costKeys ?? 0, input.costScrap)} as your scrap.tf price.`, 'good');
    } catch (e) {
      setSaveState((s) => (s?.id === r.id ? null : s));
      toast(`Could not save the price: ${errorMessage(e)}`, 'bad');
    } finally {
      busy.current.save = false;
    }
  };

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

  const boughtIt = async () => {
    const r = result;
    const input = checkBoughtInput(r);
    if (!r || !input || busy.current.bought || boughtButton(bought, r.id).disabled) return;
    busy.current.bought = true;
    setBought({ priceId: r.id, status: 'saving' });
    try {
      const entry = await rpc('journal.add', input);
      disarm();
      setBought((b) => (b?.priceId === r.id ? { priceId: r.id, status: 'done', entryId: entry.id } : b));
      toast(boughtItText(entry), 'good', { action: { label: 'Undo', onClick: () => void undoBought(entry.id) } });
    } catch (e) {
      setBought((b) => (b?.priceId === r.id ? null : b));
      toast(`Could not record the buy: ${errorMessage(e)}`, 'bad');
    } finally {
      busy.current.bought = false;
    }
  };

  const details = async () => {
    const sku = result?.status === 'item' ? result.sku : null;
    if (!sku) return;
    try {
      await rpc('app.openItem', { sku });
      hideNow();
    } catch (e) {
      toast(`Could not open the dashboard: ${errorMessage(e)}`, 'bad');
    }
  };

  const quickEntry = async () => {
    const params = checkQuickEntryParams(result);
    if (!params) return;
    try {
      await rpc('app.showQuickEntry', params);
      hideNow();
    } catch (e) {
      toast(`Could not open quick entry: ${errorMessage(e)}`, 'bad');
    }
  };

  // Keys reach the page only when main showed it focused (the hotkey); the watcher's popup never takes focus.
  const run = useRef<(a: CheckPopupAction) => void>(() => undefined);
  run.current = (a) => {
    if (a === 'hide') hideNow();
    else if (a === 'save') void savePrice();
    else if (a === 'bought') void boughtIt();
    else void details();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = checkPopupKey(e, e.target as HTMLElement | null);
      if (!action) return;
      e.preventDefault();
      run.current(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The clock ticks every 30 s; a result never reads as checked in the future.
  const shownNow = Math.max(now, result?.checkedAt ?? 0);
  const label = result === null ? 'Live check' : result.status === 'item' ? `Live check: ${result.name ?? result.sku ?? 'item'}` : 'Live check: not an item';
  return (
    <div
      className={`check-popup${result ? ` status-${result.status}` : ''}${result?.verdict ? ` verdict-${result.verdict}` : ''}`}
      role="dialog"
      aria-label={label}
      aria-describedby="check-summary"
      onMouseEnter={() => timer.hold('hover', true)}
      onMouseLeave={() => timer.hold('hover', false)}
      // Keyboard focus only: a mouse click is already a hover, and its focus would outlive the pointer.
      onFocus={(e) => {
        if (isKeyboardFocus(e.target)) timer.hold('focus', true);
      }}
      onBlur={(e) => {
        // Moving between the popup's own buttons keeps the hold.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) timer.hold('focus', false);
      }}
    >
      {result === null ? (
        <CheckWaiting onHide={hideNow} />
      ) : result.status === 'item' ? (
        <CheckItemView
          result={result}
          now={shownNow}
          saveState={saveState}
          bought={bought}
          onSave={() => void savePrice()}
          onBought={() => void boughtIt()}
          onDetails={() => void details()}
          onQuick={() => void quickEntry()}
          onHide={hideNow}
        />
      ) : (
        <CheckNotItemView result={result} onHide={hideNow} />
      )}
      <div id="check-summary" className="sr-only" role="status">
        {result ? checkSummaryText(result, shownNow) : CHECK_WAITING_TEXT}
      </div>
      <ToastStack />
    </div>
  );
}

function CloseButton({ onHide }: { onHide: () => void }) {
  return (
    <button type="button" className="icon-btn cp-close" aria-label="Hide (Esc)" title="Hide (Esc)" onClick={onHide}>
      <Icon name="close" size={14} />
    </button>
  );
}

function CheckWaiting({ onHide }: { onHide: () => void }) {
  return (
    <>
      <header className="cp-head">
        <span className="cp-mark" aria-hidden="true">
          <Icon name="search" size={13} />
        </span>
        <h1 className="cp-title">Live check</h1>
        <CloseButton onHide={onHide} />
      </header>
      <p className="cp-text muted">{CHECK_WAITING_TEXT}</p>
    </>
  );
}

function CheckNotItemView({ result, onHide }: { result: CheckResult; onHide: () => void }) {
  const refused = result.status === 'refused';
  return (
    <>
      <header className="cp-head">
        <span className={`cp-mark tone-${refused ? 'warn' : 'muted'}`} aria-hidden="true">
          <Icon name={refused ? 'warning' : 'info'} size={13} />
        </span>
        <h1 className="cp-title">{refused ? 'Not checked' : 'Not an item'}</h1>
        <CloseButton onHide={onHide} />
      </header>
      <p className="cp-text">{result.reason ?? 'Nothing to check.'}</p>
      <p className="cp-text muted small">{CHECK_HINT}.</p>
      <p className="cp-keys muted small">
        <kbd>Esc</kbd> hide
      </p>
    </>
  );
}

function CheckItemView({
  result: r,
  now,
  saveState,
  bought,
  onSave,
  onBought,
  onDetails,
  onQuick,
  onHide,
}: {
  result: CheckResult;
  now: number;
  saveState: CheckSaveState | null;
  bought: BoughtState | null;
  onSave: () => void;
  onBought: () => void;
  onDetails: () => void;
  onQuick: () => void;
  onHide: () => void;
}) {
  const line = checkPriceLine(r, now);
  const sells = checkSellsLine(r);
  const pay = checkPayUpTo(r);
  const category = checkCategoryText(r);
  const actions = checkActions(r);
  const saveBtn = checkSaveButton(saveState, r.id);
  const boughtBtn = boughtButton(bought, r.id);
  const sku = r.sku ?? '';
  // F19: "Price copied, matched to the item you opened." stands in for the service's longer sentence.
  const note = checkPopupNote(r);
  return (
    <>
      <header className="cp-head">
        <h1 className="cp-title">
          <ItemName sku={sku} name={r.name ?? sku} maxTags={2} />
        </h1>
        {category ? <span className="cp-cat muted small">{category}</span> : null}
        <CloseButton onHide={onHide} />
      </header>
      {/* Notes (closest match, sold out…) can add up to several lines: two show, all in the tooltip. */}
      {note ? (
        <p className={`cp-text cp-note small${line.matched ? ' cp-matched' : ' muted'}`} title={r.reason ?? note}>
          {line.matched ? <Icon name="check" size={12} /> : null}
          {note}
        </p>
      ) : null}

      <div className="cp-line" title={line.title}>
        <span className="cp-label">scrap.tf</span>
        {line.price ? <strong className="money">{line.price}</strong> : <span className="muted">no price{line.outOfStock ? ' (sold out)' : ''}</span>}
        {line.source ? <span className="muted small">({line.source})</span> : null}
        {line.stock ? <span className="cp-stock small">· {line.stock}</span> : null}
        {line.full ? <TonePill tone="warn">Full</TonePill> : null}
      </div>

      <div className="cp-line" title={sells.title}>
        <span className="cp-label">Sells for</span>
        {sells.revenue ? (
          <>
            <strong className="money">{sells.revenue}</strong>
            {sells.buyer ? (
              <span className="cp-buyer small" title={sells.buyer}>
                to {sells.buyer}
              </span>
            ) : null}
            {sells.kind ? (
              <span className="buyer-type small">
                <OnlineDot online={sells.online} />
                {sells.kind}
                {sells.online === true ? ', online' : sells.online === false ? ', offline' : ''}
              </span>
            ) : null}
          </>
        ) : (
          <span className="muted">no eligible buy order</span>
        )}
        <span className="muted small cp-count">{sells.count}</span>
      </div>

      <div className={`cp-verdict${pay.prominent ? ' lead-pay' : ''}`}>
        <CheckVerdictPill result={r} />
        <span className={`cp-pay${pay.prominent ? ' prominent' : ''}`} title={pay.title}>
          Pay up to <strong className="money">{pay.text}</strong>
        </span>
        {r.confidence !== null && r.confidenceLevel !== null ? (
          <span className="cp-conf">
            <ConfidenceBadge score={r.confidence} level={r.confidenceLevel} compact />
          </span>
        ) : null}
      </div>

      <div className="cp-actions">
        <button
          type="button"
          className={`btn small${saveBtn.done ? '' : ' primary'}`}
          disabled={!actions.save.enabled || saveBtn.disabled}
          title={actions.save.title}
          aria-keyshortcuts="Enter"
          onClick={onSave}
        >
          <Icon name={saveBtn.done ? 'check' : 'tag'} size={13} />
          <span className="cp-btn-label">{saveBtn.label}</span>
        </button>
        <button type="button" className="btn small" disabled={!actions.bought.enabled || boughtBtn.disabled} title={actions.bought.title} aria-keyshortcuts="B" onClick={onBought}>
          <Icon name={boughtBtn.done ? 'check' : 'cart'} size={13} />
          <span className="cp-btn-label">{boughtBtn.label}</span>
        </button>
        <button type="button" className="btn small ghost" disabled={!actions.details.enabled} title={actions.details.title} aria-keyshortcuts="D" onClick={onDetails}>
          <span className="cp-btn-label">Details</span>
        </button>
        <button type="button" className="btn small ghost" disabled={!actions.quick.enabled} title={actions.quick.title} onClick={onQuick}>
          <span className="cp-btn-label">Quick entry…</span>
        </button>
      </div>
      {/* The window is 220 px tall: with a note the key legend gives way (the buttons' tooltips and
          aria-keyshortcuts still carry the keys), so the buttons are never pushed off the bottom. */}
      {note ? null : (
        <p className="cp-keys muted small" aria-hidden="true">
          <kbd>Enter</kbd> save · <kbd>B</kbd> bought · <kbd>D</kbd> details · <kbd>Esc</kbd> hide
        </p>
      )}
    </>
  );
}
