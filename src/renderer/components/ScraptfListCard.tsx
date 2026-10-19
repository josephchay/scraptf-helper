// "scrap.tf price list" card (F14, U1): the user's live link to every item scrap.tf
// trades. It shows the saved scrap.tf/items list ('scraptf.listStatus') and the three
// steps: open scrap.tf/items in the user's own browser (links.open, through
// openOrCopy), save it with Ctrl+S into the watch folder, and Flip Desk picks it up.
// The app never visits scrap.tf (R1); the browser does, when the user chooses. The
// list only arrives through that save, behind the import acknowledgement (R10).
//
// One component for the top of the Live market (compact: the steps fold away once the
// sync works) and the Import page (steps always shown). Pure helpers live in
// scraptfListModel.ts, styles in styles/scraptf-list.css. Its status hook, folder
// picker and setup note also serve the scrap.tf banks page header (F15); its save
// type line (F18) serves every "save it" instruction.

import { useEffect, useId, useRef, useState } from 'react';
import { SCRAPTF_ITEMS_URL } from '../../shared/links';
import type { ScraptfListStatus, UnixMs } from '../../shared/types';
import { rpc } from '../api';
import { copyText } from '../clipboard';
import { errorMessage } from '../format';
import { useApp, type ToastTone } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { useRpcQuery, useVisiblePush } from '../hooks/useRpc';
import { useDocumentVisible, useInterval, useNow } from '../hooks/useTimers';
import { SAVE_MODE, SAVE_MODE_ALT, SAVE_MODE_HTML_ONLY_NOTE, SAVE_MODE_LIST_NOTE, SAVE_MODE_REASON } from '../importModel';
import {
  LIST_BOUNDARY_NOTE,
  LIST_OPEN_HINT,
  LIST_PICKUP_TEXT,
  chooseWatchFolder,
  listPollMs,
  listSetupNote,
  listSetupState,
  listStatusLine,
  listStepsAutoOpen,
  listStepsDisabled,
  listStepsOpen,
  sanitizeStepsPref,
  type ListCardPlacement,
  type ListSetupNote,
} from '../scraptfListModel';
import { openOrCopy } from './ExternalLink';
import { Icon, type IconName } from './Icon';

/** Where the card sits: the top of the Live market page, or the Import page. One component for both. */
export interface ScraptfListCardProps {
  placement: ListCardPlacement;
  /**
   * The one-line boundary note under the steps (default on). The Live market turns it off while its own
   * page note says the same just below, so the two never stack.
   */
  boundaryNote?: boolean;
}

/**
 * The saved list's status and the watch folder's state ('scraptf.listStatus', local IPC only), kept
 * current the way the card needs it. The scrap.tf banks page header (F15) reads its Import and folder
 * hints through this too, so both say the same thing at the same time.
 */
export function useScraptfListStatus(): { status: ScraptfListStatus | null; error: string | null; reload: () => Promise<void> } {
  const { settings } = useApp();
  const list = useRpcQuery('scraptf.listStatus', undefined);
  const reload = list.reload;
  const visible = useDocumentVisible();

  // A saved list (or any import) changes the counts; while hidden, one catch-up when shown.
  useVisiblePush('scraptf.listChanged', () => void reload());
  useVisiblePush('import.done', () => void reload());
  // Import switched on or off, or another folder chosen (here or on the Import page).
  const importKey = settings ? JSON.stringify([settings.import.enabled, settings.import.acknowledgedAt, settings.import.watchFolder]) : null;
  const seenKey = useRef(importKey);
  useEffect(() => {
    if (seenKey.current === importKey) return;
    seenKey.current = importKey;
    void reload();
  }, [importKey, reload]);
  const status = list.data ?? null;
  // A watch that fails later, or comes up after a racing read, pushes nothing: re-read the local
  // status now and then (IPC only), sooner while it is starting.
  useInterval(() => void reload(), listPollMs(status), visible);
  return { status, error: list.error, reload };
}

/** "Choose a watch folder": main's folder dialog, then settings, with a toast either way. */
export function useWatchFolderPicker(): { picking: boolean; pick: () => void } {
  const { toast, updateSettings } = useApp();
  const [picking, setPicking] = useState(false);
  const pickFolder = async () => {
    setPicking(true);
    try {
      const saved = await chooseWatchFolder(() => rpc('import.pickWatchFolder'), updateSettings);
      if (saved) toast(`Watching ${saved}`, 'good');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setPicking(false);
    }
  };
  return { picking, pick: () => void pickFolder() };
}

/**
 * F18: the save type to pick in the browser's save dialog, and why, inside a sentence: "choose
 * Webpage, Complete (or Webpage, Single File (.mhtml)) so cards scrap.tf added after the page loaded
 * are included". HTML only writes the page as it first loaded, before scrap.tf added its cards.
 * `alt={false}` (scrap.tf/items) leaves the Single File alternative out: an image per row puts a
 * Single File save of the list over the import's 20 MB / 2,000-part limits, so it is refused.
 */
export function SaveModeChoice({ alt = true }: { alt?: boolean }) {
  if (!alt) {
    return (
      <span className="save-mode" title={`${SAVE_MODE_HTML_ONLY_NOTE} ${SAVE_MODE_LIST_NOTE}`}>
        choose <strong>{SAVE_MODE}</strong> {SAVE_MODE_REASON}
      </span>
    );
  }
  return (
    <span className="save-mode" title={SAVE_MODE_HTML_ONLY_NOTE}>
      choose <strong>{SAVE_MODE}</strong> (or <strong>{SAVE_MODE_ALT}</strong>) {SAVE_MODE_REASON}
    </span>
  );
}

/** Copies the watch folder's path, to paste into the browser's save dialog. */
export function copyFolderPath(path: string, toast: (text: string, tone?: ToastTone) => void): void {
  void copyText(path).then((ok) => toast(ok ? 'Copied the folder path.' : 'Could not copy the folder path.', ok ? 'good' : 'bad'));
}

export function ScraptfListCard({ placement, boundaryNote = true }: ScraptfListCardProps) {
  const { navigate, toast } = useApp();
  const { status, error, reload } = useScraptfListStatus();
  const folder = useWatchFolderPicker();
  const now = useNow(15_000);
  const [pref, setPref] = usePersistentState<boolean | null>('scraptfList.stepsOpen', null, sanitizeStepsPref);

  // Without a toggle of the user's, the first status read decides, once per visit: steps the user is
  // following do not fold away the moment the sync starts working.
  const autoOpen = useRef<boolean | null>(null);
  if (autoOpen.current === null && status) autoOpen.current = listStepsAutoOpen(status);
  const open = listStepsOpen(placement, pref, autoOpen.current);

  return (
    <ScraptfListCardView
      placement={placement}
      boundaryNote={boundaryNote}
      status={status}
      error={error}
      now={now}
      stepsOpen={open}
      picking={folder.picking}
      onToggleSteps={() => setPref(!open)}
      onOpenList={() => void openOrCopy(SCRAPTF_ITEMS_URL, toast)}
      onCopyPath={(path) => copyFolderPath(path, toast)}
      onPickFolder={folder.pick}
      onGoImport={() => navigate('import')}
      onRetry={() => void reload()}
    />
  );
}

export interface ScraptfListCardViewProps {
  placement: ListCardPlacement;
  boundaryNote: boolean;
  /** null until the first 'scraptf.listStatus' answer. */
  status: ScraptfListStatus | null;
  error: string | null;
  now: UnixMs;
  stepsOpen: boolean;
  /** The folder dialog is open. */
  picking: boolean;
  onToggleSteps(): void;
  onOpenList(): void;
  onCopyPath(path: string): void;
  onPickFolder(): void;
  onGoImport(): void;
  onRetry(): void;
}

const NOTE_ICONS: Record<'warn' | 'info' | 'bad' | 'muted', IconName> = { warn: 'warning', info: 'info', bad: 'warning', muted: 'clock' };

/** What to fix before the sync works, with its one action (the card, and the banks page header, F15). */
export function SetupNoteView({ note, picking, onGoImport, onPickFolder }: { note: ListSetupNote; picking: boolean; onGoImport(): void; onPickFolder(): void }) {
  return (
    <div className={`sl-note tone-${note.tone}`}>
      <Icon name={NOTE_ICONS[note.tone]} size={14} />
      <span className="sl-note-text">{note.text}</span>
      {note.action === 'go-import' ? (
        <button type="button" className="link-btn small" onClick={onGoImport}>
          {note.actionLabel}
        </button>
      ) : note.action === 'pick-folder' ? (
        <button type="button" className="btn small" disabled={picking} onClick={onPickFolder}>
          <Icon name="folder" size={13} /> {picking ? 'Choosing…' : note.actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/** The card without its data hooks. Exported for the render tests only. */
export function ScraptfListCardView(p: ScraptfListCardViewProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const stepsId = `${ids}-steps`;
  const { status, now } = p;
  const line = listStatusLine(status, now);
  const setup = status ? listSetupState(status) : null;
  const note = setup ? listSetupNote(setup, p.placement, status?.watchError ?? null) : null;
  const disabled = listStepsDisabled(status);
  const folder = status?.watchFolder ?? null;
  const market = p.placement === 'market';
  const openBtn = (primary: boolean) => (
    <button
      type="button"
      className={`btn small${primary ? ' primary' : ''}`}
      disabled={disabled}
      onClick={p.onOpenList}
      title={disabled ? 'Turn on saved-page import first' : `Opens ${SCRAPTF_ITEMS_URL} in your own browser; the app never visits it`}
    >
      <Icon name="external" size={13} /> Open scrap.tf/items
    </button>
  );

  return (
    <section className={`card scraptf-list-card placement-${p.placement}${p.stepsOpen ? ' open' : ''}`} aria-labelledby={titleId}>
      <div className="sl-head">
        <h2 id={titleId} className="sl-title">
          <Icon name="tag" size={15} /> scrap.tf price list
        </h2>
        <span className={`sl-status tone-${line.tone}`} title={line.title}>
          <span className="status-dot" aria-hidden="true" />
          <span className="sl-status-text">{line.text}</span>
          {line.detail ? <span className="sl-status-detail">({line.detail})</span> : null}
        </span>
        <span className="sl-head-actions">
          {p.stepsOpen ? null : openBtn(false)}
          {market ? (
            // aria-controls only while the steps are rendered: it must name an element that exists.
            <button type="button" className="btn ghost small" aria-expanded={p.stepsOpen} aria-controls={p.stepsOpen ? stepsId : undefined} onClick={p.onToggleSteps}>
              {p.stepsOpen ? 'Hide steps' : 'How to sync'}
              <Icon name={p.stepsOpen ? 'chevronUp' : 'chevronDown'} size={13} />
            </button>
          ) : null}
        </span>
      </div>

      {p.error ? (
        <div className="sl-note tone-bad" role="alert">
          <Icon name="warning" size={14} />
          <span className="sl-note-text">Could not read your saved list: {p.error}</span>
          <button type="button" className="link-btn small" onClick={p.onRetry}>
            Retry
          </button>
        </div>
      ) : null}

      {note ? <SetupNoteView note={note} picking={p.picking} onGoImport={p.onGoImport} onPickFolder={p.onPickFolder} /> : null}

      {p.stepsOpen ? (
        <div id={stepsId} className="sl-body">
          <ol className={`sl-steps${disabled ? ' disabled' : ''}`} aria-disabled={disabled || undefined}>
            <li>
              <span className="sl-step-n" aria-hidden="true">
                1
              </span>
              <span className="sl-step-text">
                {openBtn(true)} <span>{LIST_OPEN_HINT}</span>
              </span>
            </li>
            <li>
              <span className="sl-step-n" aria-hidden="true">
                2
              </span>
              <span className="sl-step-text">
                <span>
                  Press <kbd>Ctrl</kbd>+<kbd>S</kbd>, <SaveModeChoice alt={false} />, and save it into your watch folder{folder ? ':' : '.'}
                </span>
                {folder ? (
                  <span className="sl-folder">
                    <span className="sl-path mono" title={folder}>
                      {folder}
                    </span>
                    <button type="button" className="btn ghost small" disabled={disabled} onClick={() => p.onCopyPath(folder)} title="Copy the folder path, to paste into the save dialog">
                      <Icon name="copy" size={13} /> Copy path
                    </button>
                  </span>
                ) : (
                  <span className="muted">No watch folder chosen yet.</span>
                )}
              </span>
            </li>
            <li>
              <span className="sl-step-n" aria-hidden="true">
                3
              </span>
              <span className="sl-step-text">{LIST_PICKUP_TEXT}</span>
            </li>
          </ol>
          {p.boundaryNote ? (
            <p className="sl-boundary">
              <Icon name="shield" size={13} />
              <span>{LIST_BOUNDARY_NOTE}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
