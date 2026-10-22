import { useEffect, useRef, useState } from 'react';
import type { Category, PriceRule, PriceRuleInput, RuleFilter } from '../../shared/types';
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/types';
import { rpc } from '../api';
import { checkRulesFile, RULES_JSON_MAX_CHARS, rulesImportToast, stripBom } from '../bulkModel';
import { ChipGroup, ConfirmButton, Field, TriState } from '../components/Controls';
import { Banner, EmptyState, ErrorBanner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { PriceInput, readPrice, type BareUnit } from '../components/PriceInput';
import { describeRuleFilter, errorMessage, fmtAge, fmtInt, fmtKeysMetal, qualityName } from '../format';
import { useApp } from '../hooks/appContext';
import { useRpcQuery } from '../hooks/useRpc';
import { useDebounced, useNow } from '../hooks/useTimers';

const QUALITY_OPTIONS = [6, 11, 5, 3, 1, 13, 14, 15].map((q) => ({ value: q, label: qualityName(q) }));
const KS_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Killstreak' },
  { value: 2, label: 'Specialized' },
  { value: 3, label: 'Professional' },
];

/**
 * A new rule's filter. 0.7.4 (F79): not australium and not festivized either, so switching the category to
 * stranges or weapons does not price Strange Australiums or Festivized copies at a plain weapon's price
 * (scrap.tf's weapons and stranges banks list neither). Existing rules keep what they were saved with.
 */
export const NEW_RULE_FILTER: Readonly<RuleFilter> = Object.freeze<RuleFilter>({ categories: ['hats'], qualities: [6], craftable: true, hasEffect: false, australium: false, festive: false });

export function RulesPanel() {
  const { toast, bumpData } = useApp();
  const rules = useRpcQuery('rules.list', undefined);
  const [editing, setEditing] = useState<PriceRule | 'new' | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [skipped, setSkipped] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const now = useNow(30_000);

  const after = () => {
    void rules.reload();
    bumpData();
  };

  // saveCsv() forces .csv; main writes a suggested *.json name as a JSON backup.
  const exportRules = async () => {
    setBackupBusy(true);
    try {
      const { json, suggestedName } = await rpc('rules.exportJson');
      const r = await rpc('file.saveText', { suggestedName, text: json });
      if (r.saved) toast(`Saved ${r.path ?? 'rules backup'}`, 'good');
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'bad');
    } finally {
      setBackupBusy(false);
    }
  };

  // The file is read locally from the user's pick; only its text goes to the service.
  const importRules = async (file: File) => {
    const problem = checkRulesFile(file);
    if (problem) {
      toast(problem, 'bad');
      return;
    }
    setBackupBusy(true);
    // The list from an earlier import would read as this file's result.
    setSkipped(null);
    try {
      const json = stripBom(await file.text());
      if (json.length > RULES_JSON_MAX_CHARS) throw new Error('That file is larger than 5 MB, so it is not a rules backup.');
      const r = await rpc('rules.importJson', { json });
      const t = rulesImportToast(r);
      toast(t.text, t.tone);
      setSkipped(r.skipped.length ? r.skipped : null);
      if (r.added) after();
    } catch (e) {
      toast(`Import failed: ${errorMessage(e)}`, 'bad');
    } finally {
      setBackupBusy(false);
    }
  };

  const toggle = async (r: PriceRule, enabled: boolean) => {
    try {
      await rpc('rules.upsert', { id: r.id, name: r.name, filter: r.filter, costKeys: r.costKeys, costScrap: r.costScrap, observedAt: r.observedAt, enabled });
      after();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  const remove = async (r: PriceRule) => {
    try {
      await rpc('rules.delete', { id: r.id });
      toast(`Deleted rule "${r.name}"`);
      if (editing !== 'new' && editing?.id === r.id) setEditing(null);
      after();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    }
  };

  return (
    <div className="rules-panel">
      <Banner icon="info">
        Rules are your own observations, such as &quot;unique craftable hats cost 1.77 ref on scrap.tf&quot;. Every matching item with buy orders and no price of yours becomes a{' '}
        <strong>candidate</strong> to check on scrap.tf by hand. Your saves show only what was on sale when you saved; where they or your saved scrap.tf/items list showed an item for
        more than the rule, that price is used instead. Rule estimates never reach High confidence.
      </Banner>

      <div className="section-actions">
        {editing ? null : (
          <button type="button" className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> New rule
          </button>
        )}
        <span className="section-actions-spacer" />
        <button
          type="button"
          className="btn"
          disabled={backupBusy || !rules.data?.length}
          title={rules.data?.length ? 'Save every rule to a .json file, e.g. to move to another computer' : 'No rules to export yet'}
          onClick={() => void exportRules()}
        >
          <Icon name="download" size={14} /> Export rules
        </button>
        <button type="button" className="btn" disabled={backupBusy} title="Add the rules from a backup made with Export rules. Existing rules are kept." onClick={() => fileRef.current?.click()}>
          <Icon name="folder" size={14} /> Import rules
        </button>
        <input
          ref={fileRef}
          type="file"
          // Export rules can also be saved as .txt (main's Text filter).
          accept=".json,.txt,application/json,text/plain"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Cleared so picking the same file again fires a change.
            e.target.value = '';
            if (f) void importRules(f);
          }}
        />
      </div>

      {editing ? (
        <RuleEditor
          key={editing === 'new' ? 'new' : editing.id}
          rule={editing === 'new' ? null : editing}
          onDone={(saved) => {
            if (saved) {
              toast(`Saved rule "${saved.name}"`, 'good');
              after();
            }
            setEditing(null);
          }}
        />
      ) : null}

      {skipped ? (
        <Banner tone="warn" icon="warning">
          <div className="import-skipped">
            <div className="section-head">
              <strong>
                {skipped.length === 1 ? '1 rule was' : `${skipped.length} rules were`} skipped from the backup
              </strong>
              <button type="button" className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => setSkipped(null)}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <ul className="skipped-list small">
              {skipped.slice(0, 50).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
              {skipped.length > 50 ? <li className="muted">…and {skipped.length - 50} more</li> : null}
            </ul>
          </div>
        </Banner>
      ) : null}

      {rules.error ? <ErrorBanner message={rules.error} onRetry={() => void rules.reload()} /> : null}
      {rules.loading ? (
        <LoadingBlock />
      ) : !rules.data?.length ? (
        <EmptyState icon="filter" title="No rules yet" compact>
          A rule prices a whole group of items at once. Use it for things scrap.tf prices at a flat rate.
        </EmptyState>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>On</th>
                  <th>Rule</th>
                  <th>Matches</th>
                  <th className="num">Price</th>
                  <th className="num">Seen</th>
                  <th className="actions-col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rules.data.map((r) => (
                  <tr key={r.id} className={r.enabled ? undefined : 'disabled-row'}>
                    <td>
                      <input type="checkbox" role="switch" aria-label={`Enable ${r.name}`} checked={r.enabled} onChange={(e) => void toggle(r, e.target.checked)} />
                    </td>
                    <td>
                      <strong>{r.name}</strong>
                    </td>
                    <td className="muted">{describeRuleFilter(r.filter)}</td>
                    <td className="num money">{fmtKeysMetal(r.costKeys, r.costScrap)}</td>
                    <td className="num">{fmtAge(now - r.observedAt)}</td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <button type="button" className="icon-btn" title="Edit" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                          <Icon name="edit" size={14} />
                        </button>
                        <ConfirmButton className="icon-btn" ariaLabel={`Delete ${r.name}`} title="Delete" confirmLabel="Delete?" onConfirm={() => void remove(r)}>
                          <Icon name="trash" size={14} />
                        </ConfirmButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleEditor({ rule, onDone }: { rule: PriceRule | null; onDone: (saved: PriceRule | null) => void }) {
  const { keyScrap } = useApp();
  const [name, setName] = useState(rule?.name ?? '');
  const [filter, setFilter] = useState<RuleFilter>(() => structuredClone<RuleFilter>(rule ? rule.filter : NEW_RULE_FILTER));
  const [text, setText] = useState(rule ? fmtKeysMetal(rule.costKeys, rule.costScrap) : '');
  const [unit, setUnit] = useState<BareUnit>('ref');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ matchingSkus: number; sample: { sku: string; name: string }[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const debouncedFilter = useDebounced(filter, 300);

  useEffect(() => {
    let alive = true;
    rpc('rules.preview', { name: name || 'preview', filter: debouncedFilter, costScrap: 0 })
      .then((p) => {
        if (alive) {
          setPreview(p);
          setPreviewError(null);
        }
      })
      .catch((e: unknown) => alive && setPreviewError(errorMessage(e)));
    return () => {
      alive = false;
    };
    // Preview depends on the filter only; the name is cosmetic.
  }, [debouncedFilter]);

  const set = <K extends keyof RuleFilter>(k: K, v: RuleFilter[K]) =>
    setFilter((f) => {
      const next = { ...f, [k]: v };
      if (Array.isArray(v) && v.length === 0) delete next[k];
      if (v === null || v === '') delete next[k];
      return next;
    });

  const save = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Give the rule a name.');
      return;
    }
    const parsed = readPrice(text, unit);
    if (!parsed) {
      setError('Enter the scrap.tf price these items cost.');
      return;
    }
    setSaving(true);
    try {
      const input: PriceRuleInput = {
        ...(rule ? { id: rule.id } : {}),
        name: name.trim(),
        filter,
        costKeys: parsed.keys,
        costScrap: parsed.scrap,
        observedAt: Date.now(),
        enabled,
      };
      onDone(await rpc('rules.upsert', input));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card rule-editor" aria-labelledby="rule-editor-title">
      <h2 id="rule-editor-title">{rule ? `Edit rule "${rule.name}"` : 'New rule'}</h2>
      <form
        className="rule-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" htmlFor="rule-name">
          <input id="rule-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Unique craftable hats" />
        </Field>
        <Field label="scrap.tf price for each matching item" htmlFor="rule-price">
          <PriceInput id="rule-price" text={text} onText={setText} unit={unit} onUnit={setUnit} keyScrap={keyScrap} />
        </Field>
        <Field label="Categories" wide>
          <ChipGroup<Category> ariaLabel="Categories" values={filter.categories ?? []} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))} onChange={(v) => set('categories', v)} />
        </Field>
        <Field label="Qualities" wide>
          <ChipGroup<number> ariaLabel="Qualities" values={filter.qualities ?? []} options={QUALITY_OPTIONS} onChange={(v) => set('qualities', v)} />
        </Field>
        <Field label="Killstreak" wide>
          <ChipGroup<number> ariaLabel="Killstreak tiers" values={filter.killstreak ?? []} options={KS_OPTIONS} onChange={(v) => set('killstreak', v)} />
        </Field>
        <div className="tri-row wide">
          <Field label="Craftable">
            <TriState ariaLabel="Craftable" value={filter.craftable} onChange={(v) => set('craftable', v)} />
          </Field>
          <Field label="Unusual effect">
            <TriState ariaLabel="Has an unusual effect" value={filter.hasEffect} onChange={(v) => set('hasEffect', v)} />
          </Field>
          <Field label="Australium">
            <TriState ariaLabel="Australium" value={filter.australium} onChange={(v) => set('australium', v)} />
          </Field>
          {/* 0.7.4 (F79): Festivized copies and elevated Strange (a Strange Unusual, say) can be left out. */}
          <Field label="Festivized">
            <TriState ariaLabel="Festivized" value={filter.festive} onChange={(v) => set('festive', v)} />
          </Field>
          <Field label="Elevated Strange">
            <TriState ariaLabel="Elevated Strange (Strange on another quality)" value={filter.elevated} onChange={(v) => set('elevated', v)} />
          </Field>
        </div>
        <Field label="Name contains" htmlFor="rule-contains">
          <input id="rule-contains" className="input" value={filter.nameContains ?? ''} onChange={(e) => set('nameContains', e.target.value || null)} placeholder="optional" />
        </Field>
        <label className="check-inline">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <div className="rule-preview wide" aria-live="polite">
          <span className="muted">{describeRuleFilter(filter)}</span>
          {previewError ? (
            <span className="tone-text-bad"> · preview failed: {previewError}</span>
          ) : preview ? (
            <>
              <span>
                {' '}
                · matches <strong>{fmtInt(preview.matchingSkus)}</strong> known {preview.matchingSkus === 1 ? 'item' : 'items'}
              </span>
              {preview.sample.length ? <div className="muted small sample">e.g. {preview.sample.map((s) => s.name).join(', ')}</div> : null}
            </>
          ) : null}
        </div>
        {error ? (
          <div className="field-error wide" role="alert">
            {error}
          </div>
        ) : null}
        <div className="form-actions wide">
          <button type="submit" className="btn primary" disabled={saving}>
            <Icon name="check" size={14} /> {rule ? 'Save rule' : 'Create rule'}
          </button>
          <button type="button" className="btn ghost" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
