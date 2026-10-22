import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { SCRAPTF_BOUNDARY_SHORT } from '../../shared/boundaryText';
import type { BulkPriceRow, Scrap, ScrapPrice } from '../../shared/types';
import { rpc, saveCsv } from '../api';
import { BULK_MAX_LINES, bulkCommitMessage, bulkInputStats, bulkPlanSummary, isSkipped, planBulkCommit, type BulkLineState, type BulkPlan } from '../bulkModel';
import { ConfirmButton, Field, Segmented, Tabs, type Option } from '../components/Controls';
import { EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { useItemMenu } from '../components/ItemMenu';
import { ItemName } from '../components/ItemName';
import { ItemPicker, type ItemPickerHandle, type PickedItem } from '../components/ItemPicker';
import { PriceInput, readPrice, type BareUnit } from '../components/PriceInput';
import { DASH, errorMessage, fmtAge, fmtDateTime, fmtKeysMetal, fmtMoney } from '../format';
import { useApp } from '../hooks/appContext';
import { usePersistentState } from '../hooks/usePersistentState';
import { useRpcQuery, useThrottled, useVisiblePush } from '../hooks/useRpc';
import { useDebounced, useNow } from '../hooks/useTimers';
import { priceMenuTarget } from '../watchesModel';
import { RulesPanel } from './RulesPanel';

function sanitizeUnit(v: unknown): BareUnit {
  return v === 'scrap' || v === 'keys' ? v : 'ref';
}

// Same wording as PriceInput's toggle.
const UNIT_OPTIONS: readonly Option<BareUnit>[] = [
  { value: 'ref', label: 'ref', title: 'A bare number like 12 means 12 refined' },
  { value: 'scrap', label: 'scrap', title: 'A bare number like 12 means 12 scrap' },
  { value: 'keys', label: 'keys', title: 'A bare number like 2 means 2 keys' },
];

export function PricesPage() {
  const { segments, navigate } = useApp();
  const tab = segments[1] === 'rules' ? 'rules' : 'prices';
  return (
    <div className="page prices-page">
      <Tabs
        ariaLabel="Price sheet"
        value={tab}
        tabs={[
          { value: 'prices', label: 'Prices' },
          { value: 'rules', label: 'Rules' },
        ]}
        onChange={(t) => navigate(t === 'rules' ? 'prices/rules' : 'prices')}
      />
      {tab === 'prices' ? <PriceSheet /> : <RulesPanel />}
    </div>
  );
}

type SortCol = 'name' | 'price' | 'age';

function PriceSheet() {
  const { keyScrap, settings, openItem, toast, bumpData } = useApp();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const list = useRpcQuery('prices.list', dq.trim() ? { q: dq.trim() } : {});
  // Saves from the quick-entry window and imports change the sheet behind this page. 0.7.3: only while
  // visible (a read is the whole list); closed to the tray, it reloads once when shown again.
  const reloadSoon = useThrottled(() => void list.reload(), 1000);
  useVisiblePush('prices.changed', reloadSoon);
  const [editing, setEditing] = useState<ScrapPrice | null>(null);
  const [sort, setSort] = useState<{ col: SortCol; asc: boolean }>({ col: 'age', asc: true });
  const [pasteOpen, setPasteOpen] = usePersistentState<boolean>('prices.pasteOpen', false, (v) => v === true);
  // Focus the paste box only when the user opens it, not when it was left open last time.
  const [pasteFocus, setPasteFocus] = useState(false);
  const pasteBtn = useRef<HTMLButtonElement>(null);
  const [exporting, setExporting] = useState(false);
  const menu = useItemMenu();
  const now = useNow(10_000);
  const staleMs = settings?.profit.inputStaleMs ?? 2 * 3_600_000;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await saveCsv(() => rpc('prices.exportCsv'));
      if (r.saved) toast(`Saved ${r.path ?? 'CSV'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    } finally {
      setExporting(false);
    }
  };

  // Right-click, or Shift+F10 / the ContextMenu key on the focused row link: the menu
  // places a keyboard event's 0,0 next to that link (ItemMenu resolveMenuPoint).
  const openMenu = (p: ScrapPrice, e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    // 0.8: on the copy the price is for, so Watch on scrap.tf… watches that copy (priceMenuTarget).
    menu.open(priceMenuTarget(p), { x: e.clientX, y: e.clientY });
  };

  const rows = useMemo(() => {
    const k = keyScrap ?? 0;
    const value = (p: ScrapPrice) => Math.round(p.costKeys * k) + p.costScrap;
    const arr = [...(list.data ?? [])];
    arr.sort((a, b) => {
      const d = sort.col === 'name' ? a.name.localeCompare(b.name) : sort.col === 'price' ? value(a) - value(b) : b.observedAt - a.observedAt;
      return sort.asc ? d : -d;
    });
    return arr;
  }, [list.data, sort, keyScrap]);

  const after = () => {
    void list.reload();
    bumpData();
  };

  const reconfirm = async (p: ScrapPrice) => {
    try {
      await rpc('prices.upsert', { id: p.id, sku: p.sku, name: p.name, costKeys: p.costKeys, costScrap: p.costScrap, source: p.source, observedAt: Date.now() });
      toast(`Marked ${p.name} as seen now`, 'good');
      after();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const remove = async (p: ScrapPrice) => {
    try {
      await rpc('prices.delete', { id: p.id });
      toast(`Deleted ${p.name}`, 'info');
      if (editing?.id === p.id) setEditing(null);
      after();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const header = (col: SortCol, label: string, cls?: string) => (
    <th className={cls} aria-sort={sort.col === col ? (sort.asc ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`sort-btn${sort.col === col ? ' active' : ''}`} onClick={() => setSort((s) => (s.col === col ? { col, asc: !s.asc } : { col, asc: true }))}>
        {label}
        {sort.col === col ? <Icon name={sort.asc ? 'arrowUp' : 'arrowDown'} size={12} /> : null}
      </button>
    </th>
  );

  return (
    <div className="stack">
      <section className="card form-card" aria-labelledby="price-form-title">
        <div className="section-head">
          <h2 id="price-form-title">{editing ? `Edit price #${editing.id}` : 'Add a scrap.tf price'}</h2>
          <button
            ref={pasteBtn}
            type="button"
            className={`btn small${pasteOpen ? ' active' : ''}`}
            aria-expanded={pasteOpen}
            aria-controls={pasteOpen ? 'bulk-panel' : undefined}
            title="Paste many item and price lines at once"
            onClick={() => {
              setPasteFocus(!pasteOpen);
              setPasteOpen(!pasteOpen);
            }}
          >
            <Icon name="plus" size={14} /> Paste a list
          </button>
        </div>
        <p className="muted small">Type what you see on scrap.tf. {SCRAPTF_BOUNDARY_SHORT}</p>
        <PriceForm
          key={editing?.id ?? 'new'}
          editing={editing}
          onSaved={(p) => {
            toast(`${editing ? 'Updated' : 'Added'} ${p.name} at ${fmtKeysMetal(p.costKeys, p.costScrap)}`, 'good');
            setEditing(null);
            after();
          }}
          onCancel={editing ? () => setEditing(null) : undefined}
        />
      </section>

      {pasteOpen ? (
        <BulkPastePanel
          autoFocus={pasteFocus}
          onClose={() => {
            setPasteOpen(false);
            // The close button unmounts with the panel; keep keyboard focus nearby.
            pasteBtn.current?.focus();
          }}
          onSaved={after}
        />
      ) : null}

      <section className="card table-card" aria-labelledby="price-list-title">
        <div className="section-head">
          <h2 id="price-list-title">
            Your prices <span className="count-badge">{list.data?.length ?? 0}</span>
          </h2>
          <div className="sheet-tools">
            <button type="button" className="btn small" disabled={exporting} onClick={() => void exportCsv()} title="Save the whole price sheet as a CSV file">
              <Icon name="download" size={14} /> Export CSV
            </button>
            <div className="search-box small">
              <Icon name="search" size={14} />
              <input type="search" className="input" placeholder="Filter" aria-label="Filter prices" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
        </div>
        {list.error ? <ErrorBanner message={list.error} onRetry={() => void list.reload()} /> : null}
        {list.loading ? (
          <LoadingBlock />
        ) : list.error && !list.data ? null : rows.length === 0 ? (
          <EmptyState icon="tag" title={q ? 'No prices match' : 'No prices yet'} compact>
            {q ? 'Try a different filter.' : 'Add the first price with the form, the quick-entry window, or a price-sheet rule.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {header('name', 'Item')}
                  {header('price', 'Price', 'num')}
                  <th>Source</th>
                  {header('age', 'Seen', 'num')}
                  <th>Note</th>
                  <th className="actions-col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const age = now - p.observedAt;
                  const stale = age > staleMs;
                  return (
                    <tr key={p.id} className={editing?.id === p.id ? 'selected' : undefined} onContextMenu={(e) => openMenu(p, e)}>
                      <td>
                        <div className="cell-clip">
                          <button type="button" className="row-link" onClick={() => openItem(p.sku)} title="Open item">
                            <ItemName sku={p.sku} name={p.name} maxTags={3} />
                          </button>
                          <div className="muted small ellipsis">
                            <code>{p.sku}</code>
                          </div>
                        </div>
                      </td>
                      <td className="num">
                        <span className="money">{fmtKeysMetal(p.costKeys, p.costScrap)}</span>
                        {p.costKeys && keyScrap ? <div className="muted small">{fmtMoney(Math.round(p.costKeys * keyScrap) + p.costScrap, null)}</div> : null}
                      </td>
                      <td>
                        {p.source === 'import' ? (
                          <span title={p.importBatch ? `Import batch ${p.importBatch}` : undefined}>
                            Imported{p.importBatch ? ` #${p.importBatch}` : ''}
                            {p.stock !== null ? <span className="muted small"> · stock {p.stock}</span> : null}
                          </span>
                        ) : (
                          'Typed'
                        )}
                      </td>
                      <td className={`num${stale ? ' tone-text-warn' : ''}`} title={`${fmtDateTime(p.observedAt)}${stale ? ' (stale: check scrap.tf again)' : ''}`}>
                        {stale ? <Icon name="clock" size={12} /> : null} {fmtAge(age)}
                      </td>
                      <td>
                        <div className="note-clip" title={p.note ?? undefined}>
                          {p.note ?? <span className="muted">—</span>}
                        </div>
                      </td>
                      <td className="actions-col">
                        <div className="row-actions">
                          <button type="button" className="icon-btn" title="Still this price (mark as seen now)" aria-label={`Mark ${p.name} as seen now`} onClick={() => void reconfirm(p)}>
                            <Icon name="check" size={14} />
                          </button>
                          <button type="button" className="icon-btn" title="Edit" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                            <Icon name="edit" size={14} />
                          </button>
                          <ConfirmButton className="icon-btn" ariaLabel={`Delete ${p.name}`} title="Delete" confirmLabel="Delete?" onConfirm={() => void remove(p)}>
                            <Icon name="trash" size={14} />
                          </ConfirmButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {menu.element}
    </div>
  );
}

const BULK_PLACEHOLDER = ['Team Captain, 1 key 5 ref', 'Strange Rocket Launcher = 3.33', '5021;6 @ 52 ref', '# lines starting with # are skipped'].join('\n');

interface BulkPreview {
  /** The text and unit this preview was made from; editing either makes it stale. */
  text: string;
  unit: BareUnit;
  rows: BulkPriceRow[];
  plan: BulkPlan;
}

/**
 * Paste many "<item> <separator> <price>" lines, preview how each one parses,
 * then save the valid ones in one 'prices.bulkUpsert'. Nothing is written by
 * Preview. Page content is refused by the service (R10: saved pages go through
 * the opt-in import only).
 */
function BulkPastePanel({ autoFocus, onClose, onSaved }: { autoFocus: boolean; onClose: () => void; onSaved: () => void }) {
  const { keyScrap, toast } = useApp();
  const [text, setText] = useState('');
  const [unit, setUnit] = usePersistentState<BareUnit>('bulk.unit', 'ref', sanitizeUnit);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [onlySkipped, setOnlySkipped] = useState(false);
  const stats = useMemo(() => bulkInputStats(text), [text]);
  const stale = preview !== null && (preview.text !== text || preview.unit !== unit);
  const overLimit = stats.overLines || stats.overBytes;

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      // The full list, so a pasted item the user already priced updates that price instead of adding a second one.
      const [parsed, existing] = await Promise.all([rpc('prices.parseBulk', { text, bareUnit: unit }), rpc('prices.list', {})]);
      setPreview({ text, unit, rows: parsed.rows, plan: planBulkCommit(parsed.rows, existing) });
      setOnlySkipped(false);
    } catch (e) {
      setPreview(null);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!preview || stale) return;
    setBusy('save');
    try {
      // Fresh ids: one price deleted since the preview would fail the whole call.
      const plan = planBulkCommit(preview.rows, await rpc('prices.list', {}));
      if (!plan.inputs.length) {
        toast('Nothing to save: every line has a problem.', 'warn');
        return;
      }
      const r = await rpc('prices.bulkUpsert', { rows: plan.inputs });
      toast(bulkCommitMessage(r, plan.skipped), 'good');
      setText('');
      setPreview(null);
      onSaved();
    } catch (e) {
      toast(`Not saved: ${errorMessage(e)}`, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const plan = preview?.plan ?? null;
  const ready = plan ? plan.added + plan.updated : 0;
  const shownRows = preview ? (onlySkipped ? preview.rows.filter((r) => isSkipped(plan?.states.get(r.line))) : preview.rows) : [];

  return (
    <section className="card bulk-card" id="bulk-panel" aria-labelledby="bulk-title">
      <div className="section-head">
        <h2 id="bulk-title">Paste a list</h2>
        <button type="button" className="icon-btn" aria-label="Close paste a list" title="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <p className="muted small">
        One item per line: a name, SKU or backpack.tf / marketplace.tf link, then a tab, comma, semicolon, <code>=</code>, <code>@</code> or <code> - </code>, then the price you
        saw on scrap.tf. At most {BULK_MAX_LINES} lines. Saved pages go through Import instead.
      </p>
      <form
        className="bulk-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runPreview();
        }}
      >
        <textarea
          id="bulk-text"
          className="input mono bulk-text"
          rows={7}
          autoFocus={autoFocus}
          // A successful save clears the box, which would also wipe lines typed while it ran.
          readOnly={busy === 'save'}
          spellCheck={false}
          autoComplete="off"
          aria-label="Lines to paste"
          aria-describedby="bulk-stats"
          placeholder={BULK_PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl+Enter previews without leaving the keyboard.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (stats.lines && !overLimit && !busy) void runPreview();
            }
          }}
        />
        <div className="form-actions">
          <span className="muted small">Bare numbers mean</span>
          <Segmented small ariaLabel="Unit for bare numbers" value={unit} onChange={setUnit} options={UNIT_OPTIONS} />
          <button type="submit" className="btn primary" disabled={!stats.lines || overLimit || busy !== null}>
            <Icon name="search" size={14} /> {busy === 'preview' ? 'Reading…' : 'Preview'}
          </button>
          {text ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy !== null}
              onClick={() => {
                setText('');
                setPreview(null);
                setError(null);
              }}
            >
              Clear
            </button>
          ) : null}
          <span id="bulk-stats" className={`small${overLimit ? ' tone-text-bad' : ' muted'}`} aria-live="polite">
            {stats.overBytes
              ? 'Larger than 100 KB. Split it into smaller pastes.'
              : `${stats.lines} of ${BULK_MAX_LINES} lines${stats.overLines ? '. Split it into smaller pastes.' : ''}`}
          </span>
        </div>
      </form>

      {/* role="alert": the refusal or failure is announced, not only shown. */}
      {error ? <ErrorBanner message={error} /> : null}

      {preview && plan ? (
        <div className="bulk-preview">
          <div className="bulk-summary">
            <span role="status" className={ready ? undefined : 'tone-text-warn'}>
              {bulkPlanSummary(plan)}
            </span>
            {plan.skipped ? (
              <label className="check-inline small">
                <input type="checkbox" checked={onlySkipped} onChange={(e) => setOnlySkipped(e.target.checked)} /> Only skipped lines
              </label>
            ) : null}
            {stale ? <span className="tone-text-warn small">The text or unit changed. Preview again before saving.</span> : null}
          </div>
          {preview.rows.length === 0 ? (
            <p className="muted small">No item lines found.</p>
          ) : (
            <div className="table-wrap bulk-table-wrap">
              <table className="table compact-table">
                <thead>
                  <tr>
                    <th className="num">Line</th>
                    <th>Pasted</th>
                    <th>Item</th>
                    <th className="num">Price</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((r) => (
                    <BulkRow key={r.line} row={r} state={plan.states.get(r.line)} keyScrap={keyScrap} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="btn primary" disabled={!ready || stale || busy !== null} onClick={() => void save()}>
              <Icon name="check" size={14} /> {busy === 'save' ? 'Saving…' : ready === 1 ? 'Save 1 price' : `Save ${ready} prices`}
            </button>
            <span className="muted small">Saved as typed prices, seen now. Lines with problems are left out.</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BulkRow({ row, state, keyScrap }: { row: BulkPriceRow; state: BulkLineState | undefined; keyScrap: Scrap | null }) {
  const bad = state?.kind === 'error';
  const muted = state?.kind === 'superseded';
  return (
    <tr className={bad ? 'bulk-bad' : muted ? 'excluded' : undefined}>
      <td className="num muted">{row.line}</td>
      <td>
        <div className="bulk-raw mono small" title={row.raw}>
          {row.raw.trim()}
        </div>
      </td>
      <td>
        {row.sku && row.name ? (
          <div className="cell-clip">
            <ItemName sku={row.sku} name={row.name} maxTags={3} />
            <div className="muted small ellipsis">
              <code>{row.sku}</code>
            </div>
          </div>
        ) : (
          <span className="muted">{DASH}</span>
        )}
      </td>
      <td className="num">
        {/* An unparsed line carries 0/0; show that as missing, not as a free item. */}
        {bad && !row.costKeys && !row.costScrap ? (
          <span className="muted">{DASH}</span>
        ) : (
          <>
            <span className="money">{fmtKeysMetal(row.costKeys, row.costScrap)}</span>
            {row.costKeys && keyScrap ? <div className="muted small">{fmtMoney(Math.round(row.costKeys * keyScrap) + row.costScrap, null)}</div> : null}
          </>
        )}
      </td>
      <td>
        <BulkResult state={state} />
      </td>
    </tr>
  );
}

function BulkResult({ state }: { state: BulkLineState | undefined }) {
  if (!state) return null;
  switch (state.kind) {
    case 'error':
      return (
        <span className="tone-text-bad small">
          <Icon name="warning" size={12} /> {state.message}
        </span>
      );
    case 'superseded':
      return <span className="muted small">Repeated on line {state.byLine}, which is used</span>;
    case 'add':
      return <span className="pill tone-good">New</span>;
    case 'update':
      return (
        <span className="small">
          <span className="pill tone-info">Update</span>{' '}
          <span className="muted">{state.samePrice ? 'same price, marks it seen now' : `was ${fmtKeysMetal(state.previous.costKeys, state.previous.costScrap)}`}</span>
        </span>
      );
  }
}

export function PriceForm({
  editing,
  onSaved,
  onCancel,
}: {
  editing: ScrapPrice | null;
  onSaved: (p: ScrapPrice) => void;
  onCancel?: () => void;
}) {
  const { keyScrap } = useApp();
  const [item, setItem] = useState<PickedItem | null>(editing ? { sku: editing.sku, name: editing.name, category: 'other', match: 'exact' } : null);
  const [text, setText] = useState(editing ? fmtKeysMetal(editing.costKeys, editing.costScrap) : '');
  const [unit, setUnit] = usePersistentState<BareUnit>('price.unit', 'ref', sanitizeUnit);
  const [note, setNote] = useState(editing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const picker = useRef<ItemPickerHandle>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setError(null);
    const it = item ?? (await picker.current?.resolvePending()) ?? null;
    if (!it) {
      setError('Pick an item first.');
      picker.current?.focus();
      return;
    }
    const parsed = readPrice(text, unit);
    if (!parsed) {
      setError('Enter a price, for example 1.33 or 2 keys 5.11.');
      priceRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const saved = await rpc('prices.upsert', {
        ...(editing ? { id: editing.id } : {}),
        sku: it.sku,
        name: it.name,
        costKeys: parsed.keys,
        costScrap: parsed.scrap,
        // 0.7.3: a hand edit is a typed price (as the drawer saves it), so the next save of an imported
        // row's page never rewrites or deletes it; the row keeps its batch id. Seen now keeps the source.
        source: 'user',
        observedAt: Date.now(),
        note: note.trim() || null,
      });
      onSaved(saved);
      if (!editing) {
        setItem(null);
        setText('');
        setNote('');
        picker.current?.focus();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="form-grid price-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Item" htmlFor="pf-item">
        <ItemPicker ref={picker} id="pf-item" value={item} onChange={setItem} onEnterPicked={() => priceRef.current?.focus()} />
      </Field>
      <Field label="scrap.tf price" htmlFor="pf-price">
        <PriceInput ref={priceRef} id="pf-price" text={text} onText={setText} unit={unit} onUnit={setUnit} keyScrap={keyScrap} />
      </Field>
      <Field label="Note (optional)" htmlFor="pf-note">
        <input id="pf-note" className="input" type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 2 in stock" />
      </Field>
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={saving}>
          <Icon name={editing ? 'check' : 'plus'} size={14} /> {editing ? 'Save changes' : 'Add price'}
        </button>
        {onCancel ? (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <span className="muted small">Saved as seen now.</span>
      </div>
    </form>
  );
}
