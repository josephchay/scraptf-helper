import { describe, expect, it } from 'vitest';
import { NOT_SAVED_MESSAGE, commitDraftReducer, initCommitDraft, type CommitDraft, type CommitDraftAction } from '../../src/renderer/components/Controls';

/**
 * Drives the reducer the way CommitInput does: the [value, resync] effect
 * dispatches 'value' after every render that changed either of them.
 */
function field(initial: string) {
  let s: CommitDraft = initCommitDraft(initial);
  let value = initial;
  let focused = false;
  const effect = () => {
    s = commitDraftReducer(s, { type: 'value', value, focused });
  };
  const act = (a: CommitDraftAction) => {
    const before = s.resync;
    s = commitDraftReducer(s, a);
    if (s.resync !== before) effect();
  };
  return {
    get draft() {
      return s.draft;
    },
    get error() {
      return s.error;
    },
    focus: () => {
      focused = true;
    },
    blur: () => {
      focused = false;
    },
    type: (text: string) => act({ type: 'typed', text }),
    /** The parent re-rendered with a new stored value. */
    stored: (v: string) => {
      const changed = v !== value;
      value = v;
      if (changed) effect();
    },
    saved: (submitted: string) => act({ type: 'saved', submitted }),
    rejected: (submitted: string) => act({ type: 'rejected', submitted, value }),
    escape: () => act({ type: 'escape', value }),
  };
}

describe('CommitInput draft', () => {
  it('shows the normalised stored value after Enter, while the field keeps focus', () => {
    // "1.5" ref is stored as 14 scrap, which shows as 1.55.
    const f = field('1.33');
    f.focus();
    f.type('1.5');
    // Enter commits without blurring; main answers with the normalised value.
    f.stored('1.55');
    expect(f.draft).toBe('1.5');
    f.saved('1.5');
    expect(f.draft).toBe('1.55');
  });

  it('shows the stored value when the typed text normalises to the value already in effect (value unchanged)', () => {
    const f = field('1.55');
    f.focus();
    f.type('1.5');
    f.blur();
    // Same 14 scrap: settings do not change, so `value` never changes either.
    f.saved('1.5');
    expect(f.draft).toBe('1.55');
  });

  it('keeps what the user typed after the save was sent', () => {
    const f = field('1.33');
    f.focus();
    f.type('1.5');
    f.type('1.6');
    f.stored('1.55');
    f.saved('1.5');
    expect(f.draft).toBe('1.6');
  });

  it('keeps a draft being edited while focused, but follows the stored value otherwise', () => {
    const f = field('10');
    f.focus();
    f.type('12');
    f.stored('11');
    expect(f.draft).toBe('12');
    f.blur();
    f.stored('13');
    expect(f.draft).toBe('13');
    // Focused without typing: an outside change still shows.
    f.focus();
    f.stored('14');
    expect(f.draft).toBe('14');
  });

  it('reverts a rejected save unless the user typed again, and Esc restores the stored value', () => {
    const f = field('8');
    f.focus();
    f.type('150');
    f.rejected('150');
    expect(f.draft).toBe('8');
    expect(f.error).toBe(NOT_SAVED_MESSAGE);

    const g = field('8');
    g.focus();
    g.type('150');
    g.type('9');
    g.rejected('150');
    expect(g.draft).toBe('9');
    g.escape();
    expect(g.draft).toBe('8');
    expect(g.error).toBeNull();
  });
});
