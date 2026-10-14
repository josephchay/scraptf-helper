import { forwardRef } from 'react';
import { parsePrice, type ParsedPrice } from '../../shared/currency';
import type { Scrap } from '../../shared/types';
import { fmtKeysDecimal, fmtMoney, fmtRefOnly } from '../format';
import { Segmented } from './Controls';

export type BareUnit = 'ref' | 'scrap' | 'keys';

export function readPrice(text: string, unit: BareUnit): ParsedPrice | null {
  return parsePrice(text, unit);
}

/** Total value of a parsed price in scrap, or null when keys cannot be valued. */
export function parsedValueScrap(p: ParsedPrice | null, keyScrap: Scrap | null): Scrap | null {
  if (!p) return null;
  if (p.keys && !keyScrap) return null;
  return Math.round(p.keys * (keyScrap ?? 0)) + p.scrap;
}

/**
 * Price text field parsed live with parsePrice. Bare numbers ("12") are read in
 * the unit chosen by the toggle; the parsed result is always shown.
 */
export const PriceInput = forwardRef<HTMLInputElement, {
  text: string;
  onText: (t: string) => void;
  unit: BareUnit;
  onUnit: (u: BareUnit) => void;
  keyScrap: Scrap | null;
  id?: string;
  autoFocus?: boolean;
  placeholder?: string;
  onEnter?: () => void;
  compact?: boolean;
}>(function PriceInput({ text, onText, unit, onUnit, keyScrap, id, autoFocus, placeholder = 'e.g. 1.33, 14 scrap, 2 keys 5.11', onEnter, compact }, ref) {
  const parsed = text.trim() ? parsePrice(text, unit) : null;
  const total = parsedValueScrap(parsed, keyScrap);
  const invalid = text.trim() !== '' && !parsed;
  return (
    <div className={`price-input${compact ? ' compact' : ''}`}>
      <div className="price-row">
        <input
          ref={ref}
          id={id}
          className={`input money-input${invalid ? ' invalid' : ''}`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={text}
          aria-invalid={invalid || undefined}
          aria-describedby={id ? `${id}-parsed` : undefined}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
        <Segmented
          small
          ariaLabel="Unit for bare numbers"
          value={unit}
          onChange={onUnit}
          options={[
            { value: 'ref', label: 'ref', title: 'A bare number like 12 means 12 refined' },
            { value: 'scrap', label: 'scrap', title: 'A bare number like 12 means 12 scrap' },
            { value: 'keys', label: 'keys', title: 'A bare number like 2 means 2 keys' },
          ]}
        />
      </div>
      <div className={`parsed${invalid ? ' tone-text-bad' : ''}`} id={id ? `${id}-parsed` : undefined} aria-live="polite">
        {!text.trim() ? (
          <span className="muted">Type a price as traders write it.</span>
        ) : parsed ? (
          <>
            <span className="parsed-main">= {parsed.display}</span>
            {total !== null && parsed.keys ? <span className="muted"> · {fmtRefOnly(total)}</span> : null}
            {total !== null && !parsed.keys && keyScrap && total >= keyScrap ? <span className="muted"> · {fmtMoney(total, keyScrap)}</span> : null}
            {total !== null && keyScrap && total >= keyScrap / 2 ? <span className="muted"> · {fmtKeysDecimal(total, keyScrap)}</span> : null}
            <span className="muted"> · {total ?? '?'} scrap</span>
            {parsed.ambiguous ? <span className="tone-text-warn"> · read as {unit}</span> : null}
          </>
        ) : (
          <span>Can&apos;t read that price. Try 1.33, 14 scrap, 3 rec, 2 keys or 2k 5.11.</span>
        )}
      </div>
    </div>
  );
});
