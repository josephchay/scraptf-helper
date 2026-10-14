import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { Category, ItemSuggestion } from '../../shared/types';
import { rpc } from '../api';
import { categoryLabel, errorMessage, qualityClass, qualityOf } from '../format';
import { useDebounced } from '../hooks/useTimers';

export interface PickedItem {
  sku: string;
  name: string;
  category: Category;
  /** Shown under the input, e.g. "Closest match". */
  warnings?: string[];
  match?: 'sku' | 'exact' | 'fuzzy' | 'suggestion';
}

export interface ItemPickerHandle {
  focus(): void;
  /** Resolves typed text when nothing was picked; returns the item or null. */
  resolvePending(): Promise<PickedItem | null>;
}

/**
 * Item autocomplete over 'item.search', with 'item.resolve' for pasted SKUs,
 * full names and marketplace.tf links.
 */
export const ItemPicker = forwardRef<ItemPickerHandle, {
  value: PickedItem | null;
  onChange: (v: PickedItem | null) => void;
  id?: string;
  autoFocus?: boolean;
  placeholder?: string;
  /** Called on Enter when an item is already picked (e.g. move to the price field). */
  onEnterPicked?: () => void;
  compact?: boolean;
}>(function ItemPicker({ value, onChange, id, autoFocus, placeholder = 'Item name, SKU or marketplace.tf link', onEnterPicked, compact }, ref) {
  const [text, setText] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ItemSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const q = useDebounced(text, 140);
  const seq = useRef(0);

  // Typing clears the pick while the text is already new; a parent reset clears
  // the pick while the text still shows the old name. Only the latter wipes it.
  const prevValue = useRef(value);
  useEffect(() => {
    const was = prevValue.current;
    prevValue.current = value;
    if (value) {
      setText(value.name);
    } else if (was && text === was.name) {
      setText('');
      setItems([]);
      setOpen(false);
    }
    // Runs on value changes only; text is read from the same render.
  }, [value]);

  useEffect(() => {
    const t = q.trim();
    if (!open || t.length < 2 || (value && value.name === t)) {
      setItems([]);
      return;
    }
    const id = ++seq.current;
    rpc('item.search', { q: t, limit: 8 })
      .then((res) => {
        if (id !== seq.current) return;
        setItems(res);
        setActive(res.length ? 0 : -1);
      })
      .catch(() => {
        if (id === seq.current) setItems([]);
      });
  }, [q, open, value]);

  const pick = (s: ItemSuggestion) => {
    onChange({ sku: s.sku, name: s.name, category: s.category, match: 'suggestion' });
    setText(s.name);
    setOpen(false);
    setItems([]);
    setNote(null);
  };

  const resolveText = async (): Promise<PickedItem | null> => {
    const t = text.trim();
    if (!t) return null;
    setBusy(true);
    try {
      const r = await rpc('item.resolve', { text: t });
      if (!r) {
        setNote(`No item matches "${t}".`);
        return null;
      }
      const picked: PickedItem = { sku: r.sku, name: r.name, category: r.category, warnings: r.warnings, match: r.match };
      onChange(picked);
      setText(r.name);
      setOpen(false);
      setNote(null);
      return picked;
    } catch (e) {
      setNote(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    resolvePending: async () => (value ? value : resolveText()),
  }));

  const showList = open && items.length > 0;

  return (
    <div className={`picker${compact ? ' compact' : ''}`}>
      <input
        ref={input}
        id={id}
        className="input"
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setNote(null);
          if (value) onChange(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Let a click on an option land before closing.
          setTimeout(() => setOpen(false), 120);
          if (!value && text.trim().length >= 3 && !items.length) void resolveText();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            if (showList && active >= 0 && items[active]) {
              e.preventDefault();
              e.stopPropagation();
              pick(items[active]!);
              onEnterPicked?.();
            } else if (value) {
              if (onEnterPicked) {
                e.preventDefault();
                e.stopPropagation();
                onEnterPicked();
              }
            } else if (text.trim()) {
              e.preventDefault();
              e.stopPropagation();
              void resolveText().then((r) => {
                if (r) onEnterPicked?.();
              });
            }
          } else if (e.key === 'Escape' && showList) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {busy ? <span className="picker-busy" aria-hidden="true" /> : null}
      {showList ? (
        <ul className="picker-list" id={listId} role="listbox">
          {items.map((s, i) => (
            <li
              key={`${s.sku}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`item-name ${qualityClass(qualityOf(s.sku))}`}>{s.name}</span>
              <span className="picker-meta">
                {categoryLabel(s.category)} · <code>{s.sku}</code>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {value && !compact ? (
        <div className="picker-picked">
          <code>{value.sku}</code>
          {value.match === 'fuzzy' ? <span className="tone-text-warn"> closest match, check it</span> : null}
          {value.warnings?.length ? <span className="tone-text-warn"> · {value.warnings.join(' ')}</span> : null}
        </div>
      ) : null}
      {value && compact && (value.match === 'fuzzy' || value.warnings?.length) ? (
        <div className="picker-picked tone-text-warn">{value.warnings?.join(' ') || 'Closest match, check it.'}</div>
      ) : null}
      {note ? <div className="field-error">{note}</div> : null}
    </div>
  );
});
