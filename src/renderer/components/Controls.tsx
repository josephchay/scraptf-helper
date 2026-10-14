import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface Option<T extends string | number> {
  value: T;
  label: string;
  icon?: IconName;
  title?: string;
}

/** Single-choice button group (radio semantics). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  small = false,
}: {
  value: T;
  options: readonly Option<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  small?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className={`segmented${small ? ' small' : ''}`} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? 'active' : undefined}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Multi-select toggle chips. */
export function ChipGroup<T extends string | number>({
  values,
  options,
  onChange,
  ariaLabel,
}: {
  values: readonly T[];
  options: readonly Option<T>[];
  onChange: (v: T[]) => void;
  ariaLabel: string;
}) {
  return (
    <div className="chip-group" role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            className={`chip${on ? ' on' : ''}`}
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])}
          >
            {on ? <Icon name="check" size={12} /> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Button that opens a small popover; closes on outside click and Esc. */
export function Popover({
  label,
  active = false,
  icon,
  children,
  align = 'left',
  ariaLabel,
}: {
  label: ReactNode;
  active?: boolean;
  icon?: IconName;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className="popover-wrap" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={`btn menu-btn${active ? ' active' : ''}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div className={`popover ${align}`} id={id} role="dialog">
          {typeof children === 'function' ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

/** Checkbox list used inside filter popovers. */
export function CheckList<T extends string | number>({
  values,
  options,
  onChange,
}: {
  values: readonly T[];
  options: readonly (Option<T> & { hint?: string })[];
  onChange: (v: T[]) => void;
}) {
  return (
    <div className="check-list">
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <label key={String(o.value)} className="check-row">
            <input type="checkbox" checked={on} onChange={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])} />
            <span>{o.label}</span>
            {o.hint ? <span className="muted small">{o.hint}</span> : null}
          </label>
        );
      })}
      <div className="check-actions">
        <button type="button" className="link-btn" onClick={() => onChange(options.map((o) => o.value))}>
          All
        </button>
        <button type="button" className="link-btn" onClick={() => onChange([])}>
          Clear
        </button>
      </div>
    </div>
  );
}

/**
 * Plain checkboxes for a multi-choice setting. Reports one toggle at a time so
 * the caller decides the stored order (and can re-read fresh state).
 */
export function CheckGroup<T extends string | number>({
  values,
  options,
  onToggle,
  ariaLabel,
  disabled = false,
}: {
  values: readonly T[];
  options: readonly (Option<T> & { hint?: string })[];
  onToggle: (value: T, on: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="check-list check-group" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <label key={String(o.value)} className="check-row" title={o.title}>
          <input type="checkbox" checked={values.includes(o.value)} disabled={disabled} onChange={(e) => onToggle(o.value, e.target.checked)} />
          <span>{o.label}</span>
          {o.hint ? <span className="muted small">{o.hint}</span> : null}
        </label>
      ))}
    </div>
  );
}

/** Switch-styled checkbox. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`toggle-row${disabled ? ' disabled' : ''}`}>
      <label className="toggle" htmlFor={id}>
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={description ? `${id}-d` : undefined} />
        <span className="toggle-track" aria-hidden="true">
          <span className="toggle-thumb" />
        </span>
        <span className="toggle-label">{label}</span>
      </label>
      {description ? (
        <div className="toggle-desc" id={`${id}-d`}>
          {description}
        </div>
      ) : null}
    </div>
  );
}

/** First click arms, second click within 3 s confirms. */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Confirm?',
  className = 'btn small',
  ariaLabel,
  title,
}: {
  onConfirm: () => void;
  children: ReactNode;
  confirmLabel?: string;
  className?: string;
  ariaLabel?: string;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      className={`${className}${armed ? ' danger' : ''}`}
      aria-label={armed ? `${confirmLabel} ${ariaLabel ?? ''}`.trim() : ariaLabel}
      title={title}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  wide = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
  wide?: boolean;
}) {
  return (
    <div className={`field${wide ? ' wide' : ''}${error ? ' has-error' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="field-hint">{hint}</div>
      ) : null}
    </div>
  );
}

/** Any / Yes / No selector for nullable booleans. */
export function TriState({
  value,
  onChange,
  ariaLabel,
  labels = ['Any', 'Yes', 'No'],
}: {
  value: boolean | null | undefined;
  onChange: (v: boolean | null) => void;
  ariaLabel: string;
  labels?: [string, string, string];
}) {
  const v = value === true ? 'yes' : value === false ? 'no' : 'any';
  return (
    <Segmented
      small
      ariaLabel={ariaLabel}
      value={v}
      options={[
        { value: 'any', label: labels[0] },
        { value: 'yes', label: labels[1] },
        { value: 'no', label: labels[2] },
      ]}
      onChange={(n) => onChange(n === 'yes' ? true : n === 'no' ? false : null)}
    />
  );
}

export const NOT_SAVED_MESSAGE = 'Not saved. The previous value is back.';

/**
 * Whether a commit was saved. `onCommit` may return nothing (fire and forget)
 * or a promise; a promise that resolves to null or false (how updateSettings
 * reports a rejected patch) or rejects means the value was not saved.
 */
export async function commitSucceeded(result: unknown): Promise<boolean> {
  if (!(result instanceof Promise)) return true;
  try {
    const r: unknown = await result;
    return r !== null && r !== false;
  } catch {
    return false;
  }
}

export interface CommitDraft {
  draft: string;
  /** The draft shows the stored value (nothing typed since), so a new stored value replaces it even while focused. */
  mirrors: boolean;
  error: string | null;
  /** Bumped after a save so the stored value is adopted on the next render, when the parent has it. */
  resync: number;
}

export type CommitDraftAction =
  | { type: 'typed'; text: string }
  | { type: 'value'; value: string; focused: boolean }
  | { type: 'saved'; submitted: string }
  | { type: 'rejected'; submitted: string; value: string }
  | { type: 'escape'; value: string }
  | { type: 'error'; error: string | null };

export function initCommitDraft(value: string): CommitDraft {
  return { draft: value, mirrors: true, error: null, resync: 0 };
}

/**
 * CommitInput's draft. A saved value is normalised by the app ("1.5" ref is
 * stored as 14 scrap and shown as "1.55"), so after a save the field takes the
 * stored value, also when that value did not change and also while it keeps
 * focus after Enter; otherwise it would keep showing text that is not in effect.
 */
export function commitDraftReducer(s: CommitDraft, a: CommitDraftAction): CommitDraft {
  switch (a.type) {
    case 'typed':
      return { ...s, draft: a.text, mirrors: false };
    case 'value':
      return (!a.focused || s.mirrors) && s.draft !== a.value ? { ...s, draft: a.value, mirrors: true } : s;
    case 'saved':
      // Only when the user has not typed something else since.
      return s.draft === a.submitted ? { ...s, mirrors: true, resync: s.resync + 1 } : s;
    case 'rejected':
      return s.draft === a.submitted ? { ...s, draft: a.value, mirrors: true, error: NOT_SAVED_MESSAGE } : s;
    case 'escape':
      return { ...s, draft: a.value, mirrors: true, error: null };
    case 'error':
      return s.error === a.error ? s : { ...s, error: a.error };
  }
}

/**
 * Text input that keeps a local draft and commits on blur or Enter, so typing
 * does not fire a settings write per keystroke. Esc restores the saved value,
 * and so does a commit the app rejects, so the field never shows a value that
 * is not in effect.
 */
export function CommitInput({
  value,
  onCommit,
  validate,
  id,
  type = 'text',
  placeholder,
  inputMode,
  className = 'input',
  ariaLabel,
  suffix,
}: {
  value: string;
  /** Return the save's promise (resolving to null or false on failure) to have a rejected value reverted. */
  onCommit: (v: string) => void | Promise<unknown>;
  validate?: (v: string) => string | null;
  id?: string;
  type?: 'text' | 'url' | 'number';
  placeholder?: string;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'url' | 'email';
  className?: string;
  ariaLabel?: string;
  suffix?: ReactNode;
}) {
  const [state, dispatch] = useReducer(commitDraftReducer, value, initCommitDraft);
  const { draft, error, resync } = state;
  const focused = useRef(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // `resync` re-runs this after a save even when the stored text did not change;
  // that render already holds the parent's updated settings.
  useEffect(() => {
    dispatch({ type: 'value', value, focused: focused.current });
  }, [value, resync]);
  const commit = () => {
    if (draft === value) {
      dispatch({ type: 'error', error: null });
      return;
    }
    const err = validate ? validate(draft) : null;
    dispatch({ type: 'error', error: err });
    if (err) return;
    const submitted = draft;
    void commitSucceeded(onCommit(submitted)).then((ok) => {
      if (!mounted.current) return;
      if (ok) dispatch({ type: 'saved', submitted });
      else dispatch({ type: 'rejected', submitted, value: latestValue.current });
    });
  };
  return (
    <div className="commit-input">
      <div className="input-wrap">
        <input
          id={id}
          className={`${className}${error ? ' invalid' : ''}`}
          type={type}
          value={draft}
          placeholder={placeholder}
          inputMode={inputMode}
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => dispatch({ type: 'typed', text: e.target.value })}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              dispatch({ type: 'escape', value });
            }
          }}
        />
        {suffix ? <span className="input-suffix">{suffix}</span> : null}
      </div>
      {error ? (
        <div className="field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  ariaLabel,
}: {
  value: T;
  tabs: readonly { value: T; label: string; count?: number | null }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className={t.value === value ? 'active' : undefined} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count !== null && t.count !== undefined ? <span className="count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
