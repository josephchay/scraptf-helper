import { useState } from 'react';
import type { ImportResult, PermissionRecord } from '../../shared/types';
import { rpc } from '../api';
import { ConfirmButton, Field } from '../components/Controls';
import { Banner, EmptyState, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { errorMessage, fmtAgo, fmtDateTime, fmtInt } from '../format';
import { useApp } from '../hooks/appContext';
import { usePush, useRpcQuery } from '../hooks/useRpc';
import { useNow } from '../hooks/useTimers';
import { copyText } from '../clipboard';
import { ExternalLink } from '../components/ExternalLink';
import { SaveModeChoice, ScraptfListCard } from '../components/ScraptfListCard';
import { chooseWatchFolder, importListRowsText, importToastText } from '../scraptfListModel';
import { importBankText } from '../banksModel';
import {
  IMPORT_FILE_HINT,
  SAVE_MODE_FILES_NOTE,
  SAVE_MODE_HTML_ONLY_NOTE,
  SAVE_MODE_LIST_ONLY,
  importFailedToast,
  importSavedWithoutCards,
  importWarningsView,
} from '../importModel';

// Kept importable from here: the folder dialog helper moved to scraptfListModel.ts with the price-list card (F14).
export { chooseWatchFolder };

const PAGE_KIND_LABELS: Record<string, string> = { buy: 'Buy page', unusuals: 'Unusuals page', 'items-list': 'Price list (scrap.tf/items)', unknown: 'Unknown page' };

export const PERMISSION_TEMPLATE = `To: admin@scrap.tf
Subject: Question about a personal price-tracking tool and the ToS

Hello,

I use a personal desktop tool that never connects to scrap.tf.
I type in prices I see on scrap.tf, and the tool compares them with backpack.tf buy orders from backpack.tf's official API.
Is this acceptable under your Terms of Service?
Would you permit importing pages I save myself (Ctrl+S in my browser), for personal use only?
I will follow whatever you decide.

Thank you.`;

export function ImportPage() {
  const { settings } = useApp();
  if (!settings) return <LoadingBlock />;
  return <div className="page import-page">{settings.import.enabled ? <ImportEnabled /> : <ImportGate />}</div>;
}

function ImportGate() {
  const { updateSettings, toast } = useApp();
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const enable = async () => {
    setSaving(true);
    const s = await updateSettings({ import: { enabled: true, acknowledgedAt: Date.now() } });
    setSaving(false);
    if (s) toast('Saved-page import is on.', 'good');
  };
  return (
    <div className="narrow">
      <section className="card" aria-labelledby="import-off-title">
        <h2 id="import-off-title">
          <Icon name="import" /> Import pages you saved yourself
        </h2>
        <p>
          This optional feature reads scrap.tf pages that <strong>you</strong> saved from your own browser, so you don&apos;t have to type each price. The app parses the
          file on your computer. It never opens scrap.tf, never logs in, and never runs scripts from the page.
        </p>
        <Banner tone="warn" icon="warning">
          scrap.tf&apos;s Terms of Service forbid gaining an advantage through &quot;automation, scripts, user-scripts, auto-refreshers, external tools&quot;, and reusing
          site content for personal gain without written permission. Importing saved pages may fall under that wording. Whether to use it is your decision.
        </Banner>
        <p className="muted">
          Typing prices by hand (quick entry and the price sheet) stays available either way. If you want certainty, ask scrap.tf first; a ready-to-send email is below.
        </p>
        <label className="ack-row">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I have read scrap.tf&apos;s Terms of Service. I understand importing saved pages may count as an &quot;external tool&quot;, and I accept that decision is mine.</span>
        </label>
        <div className="form-actions">
          <button type="button" className="btn primary" disabled={!ack || saving} onClick={() => void enable()}>
            Turn on saved-page import
          </button>
          <ExternalLink url="https://scrap.tf/terms" className="btn ghost">
            Read the terms
          </ExternalLink>
        </div>
      </section>
      {/* F14: what one save of scrap.tf/items would give once import is on (its steps stay disabled until then). */}
      <ScraptfListCard placement="import" />
      <PermissionTemplate />
    </div>
  );
}

function PermissionTemplate() {
  const { toast } = useApp();
  return (
    <section className="card" aria-labelledby="perm-template-title">
      <h2 id="perm-template-title">Ask scrap.tf (optional)</h2>
      <p className="muted small">Send this from your own email. The app never sends anything for you.</p>
      <pre className="template">{PERMISSION_TEMPLATE}</pre>
      <button
        type="button"
        className="btn small"
        onClick={() => void copyText(PERMISSION_TEMPLATE).then((ok) => toast(ok ? 'Copied the email text.' : 'Could not copy.', ok ? 'good' : 'bad'))}
      >
        <Icon name="copy" size={14} /> Copy text
      </button>
    </section>
  );
}

function ImportEnabled() {
  const { settings, updateSettings, toast, bumpData, lastImport } = useApp();
  const batches = useRpcQuery('import.batches', { limit: 20 });
  // F18: opened from the no-cards toast ("How to save"), the page starts on the import it was about.
  const [last, setLast] = useState<ImportResult | null>(lastImport);
  const [busy, setBusy] = useState(false);
  const now = useNow(30_000);
  usePush('import.done', (r) => {
    setLast(r);
    void batches.reload();
    bumpData();
  });

  const pickFile = async () => {
    setBusy(true);
    try {
      const r = await rpc('import.pickFile');
      if (r) {
        setLast(r);
        // F18: a save without its cards is toasted by the dashboard on 'import.done', once for any import.
        if (!importSavedWithoutCards(r)) {
          const t = importToastText(r);
          toast(t.text, t.tone);
        }
        void batches.reload();
        bumpData();
      }
    } catch (e) {
      // F18: a Single File save over 20 MB is refused before the service sees it; say how to save it instead.
      const t = importFailedToast(errorMessage(e));
      toast(t.text, 'bad', t.timeoutMs === null ? undefined : { timeoutMs: t.timeoutMs });
    } finally {
      setBusy(false);
    }
  };

  const pickFolder = async () => {
    try {
      const saved = await chooseWatchFolder(() => rpc('import.pickWatchFolder'), updateSettings);
      if (saved) toast(`Watching ${saved}`, 'good');
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const ackAt = settings?.import.acknowledgedAt ?? null;
  const folder = settings?.import.watchFolder ?? null;

  return (
    <div className="import-grid">
      {/* F14: every scrap.tf price in one save of scrap.tf/items, the same card as on the Live market. */}
      <div className="span-2">
        <ScraptfListCard placement="import" />
      </div>

      <section className="card" aria-labelledby="import-how">
        <h2 id="import-how">Import a saved page</h2>
        <ol className="steps">
          <li>Open the scrap.tf page you want in your own browser, logged in as usual.</li>
          <li>
            {/* F18: HTML only writes the page as it first loaded, before scrap.tf added its cards. */}
            Press <kbd>Ctrl</kbd>+<kbd>S</kbd> and <SaveModeChoice />.
            <div className="muted small">
              {SAVE_MODE_HTML_ONLY_NOTE} {SAVE_MODE_FILES_NOTE} {SAVE_MODE_LIST_ONLY}
            </div>
          </li>
          <li>Import the file here, or save it into the watched folder.</li>
        </ol>
        <div className="form-actions">
          <button type="button" className="btn primary" disabled={busy} aria-describedby="import-file-hint" onClick={() => void pickFile()}>
            <Icon name="import" size={14} /> {busy ? 'Importing…' : 'Import saved page…'}
          </button>
          <span id="import-file-hint" className="muted small">
            {IMPORT_FILE_HINT}
          </span>
        </div>
        <div className="watch-row">
          <div>
            <div className="field-label">Watch folder</div>
            <div className={folder ? 'mono small' : 'muted small'}>{folder ?? 'Not watching a folder.'}</div>
            <div className="muted small">Pages you save into this folder are imported automatically.</div>
          </div>
          <div className="row-actions">
            <button type="button" className="btn small" onClick={() => void pickFolder()}>
              <Icon name="folder" size={14} /> {folder ? 'Change…' : 'Choose folder…'}
            </button>
            {folder ? (
              <button type="button" className="btn ghost small" onClick={() => void updateSettings({ import: { watchFolder: null } })}>
                Stop watching
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="import-last">
        <h2 id="import-last">Last import</h2>
        {last ? <ImportResultView r={last} /> : <p className="muted">Nothing imported in this session yet.</p>}
      </section>

      <section className="card span-2" aria-labelledby="import-batches">
        <h2 id="import-batches">Recent batches</h2>
        {batches.loading ? (
          <LoadingBlock />
        ) : !batches.data?.length ? (
          <EmptyState icon="import" title="No imports yet" compact />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>File</th>
                  <th>Page</th>
                  <th className="num">Items</th>
                  <th className="num">Saved</th>
                  <th className="num">Imported</th>
                </tr>
              </thead>
              <tbody>
                {batches.data.map((b) => {
                  // A batch from before 0.5 has no bank: nothing to say rather than "not recognised".
                  // F18: a bank page that stored nothing reads "not counted", as the banks page treats it; a batch
                  // keeps no warnings, so whether its save type was to blame is unknown and the remedy is hedged.
                  const bank = b.bank ? importBankText(b.bank, b.itemCount) : null;
                  return (
                    <tr key={b.id}>
                      <td className="num">{b.id}</td>
                      <td className="mono small">{b.fileName}</td>
                      <td>
                        {PAGE_KIND_LABELS[b.pageKind] ?? b.pageKind}
                        {bank ? <span className="muted small" title={bank.title}> · {bank.text}</span> : null}
                      </td>
                      <td className="num">{fmtInt(b.itemCount)}</td>
                      <td className="num" title={fmtDateTime(b.fileMtime)}>
                        {fmtAgo(b.fileMtime, now)}
                      </td>
                      <td className="num" title={fmtDateTime(b.importedAt)}>
                        {fmtAgo(b.importedAt, now)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <PermissionRecordCard />

      <section className="card" aria-labelledby="import-off">
        <h2 id="import-off">Turn import off</h2>
        <p className="muted small">
          You turned this on {ackAt ? `on ${fmtDateTime(ackAt)}` : 'earlier'}. Turning it off stops the folder watch and hides the import buttons. Imported prices stay
          in your price sheet.
        </p>
        <ConfirmButton className="btn small" confirmLabel="Turn off import?" onConfirm={() => void updateSettings({ import: { enabled: false, watchFolder: null } })}>
          Turn off saved-page import
        </ConfirmButton>
      </section>
    </div>
  );
}

/** One import's result. Exported for the render tests only. */
export function ImportResultView({ r }: { r: ImportResult }) {
  const listText = importListRowsText(r);
  // F15: which banks card this save counts for (the parser's recognised page); F18: none when it stored nothing,
  // blaming the save type only when the page came without its cards.
  const bank = importBankText(r.bank, r.stored, importSavedWithoutCards(r));
  // F18: a bank page saved without its cards leads, with what to do; the other warnings follow.
  const warnings = importWarningsView(r);
  return (
    <div className="import-result">
      {warnings.noCards ? (
        <Banner tone="warn" icon="warning">
          <strong>{warnings.noCards.text}</strong> {warnings.noCards.hint}
        </Banner>
      ) : null}
      <dl className="kv">
        <dt>File</dt>
        <dd className="mono small">{r.fileName}</dd>
        <dt>Page</dt>
        <dd>{PAGE_KIND_LABELS[r.pageKind] ?? r.pageKind}</dd>
        {bank ? (
          <>
            <dt>scrap.tf page</dt>
            <dd title={bank.title}>{bank.text}</dd>
          </>
        ) : null}
        <dt>Stored</dt>
        <dd>
          <strong>{r.stored}</strong> of {r.parsed} items read (batch #{r.batchId})
        </dd>
        {listText ? (
          <>
            <dt>Price list</dt>
            <dd>{listText}</dd>
          </>
        ) : null}
      </dl>
      {warnings.rest.length ? (
        <ul className="warn-list">
          {warnings.rest.map((w, i) => (
            <li key={i} className="tone-text-warn">
              <Icon name="warning" size={12} /> {w}
            </li>
          ))}
        </ul>
      ) : null}
      {r.skipped.length ? (
        <details open={r.skipped.length <= 6}>
          <summary>{r.skipped.length} skipped</summary>
          <table className="table compact-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {r.skipped.map((s, i) => (
                <tr key={i}>
                  <td>{s.title}</td>
                  <td className="muted">{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

function PermissionRecordCard() {
  const { settings, updateSettings, toast } = useApp();
  const current = settings?.import.permission ?? null;
  const [draft, setDraft] = useState<PermissionRecord>(current ?? { grantor: '', contact: '', grantedAt: '', scope: '' });
  const dirty = JSON.stringify(draft) !== JSON.stringify(current ?? { grantor: '', contact: '', grantedAt: '', scope: '' });
  const save = async () => {
    const empty = !draft.grantor.trim() && !draft.contact.trim() && !draft.grantedAt.trim() && !draft.scope.trim();
    const s = await updateSettings({ import: { permission: empty ? null : { grantor: draft.grantor.trim(), contact: draft.contact.trim(), grantedAt: draft.grantedAt.trim(), scope: draft.scope.trim() } } });
    if (s) toast(empty ? 'Permission record cleared.' : 'Permission record saved.', 'good');
  };
  const field = (k: keyof PermissionRecord, label: string, placeholder: string) => (
    <Field label={label} htmlFor={`perm-${k}`}>
      <input id={`perm-${k}`} className="input" value={draft[k]} placeholder={placeholder} maxLength={200} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
    </Field>
  );
  return (
    <section className="card" aria-labelledby="perm-title">
      <h2 id="perm-title">Permission record (optional)</h2>
      <p className="muted small">If scrap.tf replies, note it here for your own records. It stays on this computer.</p>
      <div className="form-grid two">
        {field('grantor', 'Who replied', 'e.g. scrap.tf staff member')}
        {field('contact', 'Contact used', 'e.g. admin@scrap.tf')}
        {field('grantedAt', 'Date', 'e.g. 2026-10-20')}
        {field('scope', 'What was allowed', 'e.g. personal use of saved pages')}
      </div>
      <div className="form-actions">
        <button type="button" className="btn small" disabled={!dirty} onClick={() => void save()}>
          Save record
        </button>
      </div>
    </section>
  );
}
