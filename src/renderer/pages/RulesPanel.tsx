import { useEffect, useState } from 'react';
import type { Category, PriceRule, PriceRuleInput, RuleFilter } from '../../shared/types';
import { CATEGORIES, CATEGORY_LABELS } from '../../shared/types';
import { rpc } from '../api';
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

export function RulesPanel() {
  const { toast, bumpData } = useApp();
  const rules = useRpcQuery('rules.list', undefined);
  const [editing, setEditing] = useState<PriceRule | 'new' | null>(null);
  const now = useNow(30_000);

  const after = () => {
    void rules.reload();
    bumpData();
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
        Rules are your own observations, such as &quot;unique craftable hats cost 1.77 ref on scrap.tf&quot;. Every matching item with buy orders becomes a{' '}
        <strong>candidate</strong> to check on scrap.tf by hand. The app cannot see scrap.tf&apos;s stock, and rule estimates never reach High confidence.
      </Banner>

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
      ) : (
        <div className="section-actions">
          <button type="button" className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" size={14} /> New rule
          </button>
        </div>
      )}

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
  const [filter, setFilter] = useState<RuleFilter>(rule ? structuredClone(rule.filter) : { categories: ['hats'], qualities: [6], craftable: true, hasEffect: false });
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
