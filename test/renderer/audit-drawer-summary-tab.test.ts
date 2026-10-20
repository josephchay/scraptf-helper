// Audit rcomponents-1: the item drawer's focus trap collected tab stops without <summary>, so Tab
// from a focused "Why this confidence" summary was treated as "focus not in the list" and wrapped
// to the drawer's first control: nothing below the first input card could be reached by Tab.
// Pure tests over the real helpers (the DOM shim has no querySelectorAll).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FOCUSABLE, trapFocusTargetIn, withFocused } from '../../src/renderer/components/Drawer';

const parts = () => FOCUSABLE.split(',').map((p) => p.trim());

/** A drawer-shaped panel in document order, each with the FOCUSABLE part that matches it (null: none does). */
const PANEL: readonly (readonly [string, string | null])[] = [
  ['copyName', 'button:not([disabled])'],
  ['recordBuy', 'button:not([disabled])'],
  ['summary', 'details > summary:first-of-type'],
  ['useAsMine', 'button:not([disabled])'],
  ['priceInput', 'input:not([disabled])'],
  ['save', 'button:not([disabled])'],
  ['blockBuyer', 'button:not([disabled])'],
  ['link', 'a[href]'],
];
const TOASTS = ['undo'];

/** Tab presses as the drawer handles them: the trap's target, else the browser's own next stop. */
function walk(panel: readonly (readonly [string, string | null])[], start: string, shift: boolean, presses: number): string[] {
  const dom = panel.map(([n]) => n);
  const before = (a: string, b: string) => dom.indexOf(a) < dom.indexOf(b);
  const found = panel.filter(([, p]) => p !== null && parts().includes(p)).map(([n]) => n);
  const native = [...dom, ...TOASTS];
  const seen: string[] = [];
  let f = start;
  for (let k = 0; k < presses; k++) {
    const items = dom.includes(f) ? withFocused(found, f, before) : found;
    const t = trapFocusTargetIn([items, TOASTS], f, shift);
    f = t ?? native[(native.indexOf(f) + (shift ? -1 : 1) + native.length) % native.length]!;
    seen.push(f);
  }
  return seen;
}

describe('Drawer focus trap: a details summary and other native tab stops', () => {
  it('counts the first <summary> of a <details> as a tab stop', () => {
    expect(parts()).toContain('details > summary:first-of-type');
  });

  it('Tab goes on from "Why this confidence" to everything below it, then the toasts, then wraps', () => {
    const seen = walk(PANEL, 'copyName', false, 12);
    for (const n of ['useAsMine', 'priceInput', 'blockBuyer', 'link', 'undo']) expect(seen).toContain(n);
    expect(seen.slice(0, 9)).toEqual(['recordBuy', 'summary', 'useAsMine', 'priceInput', 'save', 'blockBuyer', 'link', 'undo', 'copyName']);
  });

  it('Shift+Tab goes back the same way', () => {
    const seen = walk(PANEL, 'copyName', true, 12);
    expect(seen.slice(0, 9)).toEqual(['undo', 'link', 'blockBuyer', 'save', 'priceInput', 'useAsMine', 'summary', 'recordBuy', 'copyName']);
  });

  describe('a focused element no selector matches (a keyboard-focusable scroll box)', () => {
    const items = PANEL.map(([n]) => n);
    const withScroller = (at: number): string[] => [...items.slice(0, at), 'sellScroller', ...items.slice(at)];

    it('leaves a step in the middle of the panel to the browser', () => {
      const dom = withScroller(items.indexOf('link'));
      const before = (a: string, b: string) => dom.indexOf(a) < dom.indexOf(b);
      expect(trapFocusTargetIn([withFocused(items, 'sellScroller', before), TOASTS], 'sellScroller', false)).toBeNull();
      expect(trapFocusTargetIn([withFocused(items, 'sellScroller', before), TOASTS], 'sellScroller', true)).toBeNull();
      const seen = walk([...PANEL.slice(0, 7), ['sellScroller', null], PANEL[7]!], 'blockBuyer', false, 3);
      expect(seen).toEqual(['sellScroller', 'link', 'undo']);
    });

    it('steps to the toasts from the end of the panel and wraps from its start', () => {
      const last = withScroller(items.length);
      const beforeLast = (a: string, b: string) => last.indexOf(a) < last.indexOf(b);
      expect(trapFocusTargetIn([withFocused(items, 'sellScroller', beforeLast), TOASTS], 'sellScroller', false)).toBe('undo');
      const first = withScroller(0);
      const beforeFirst = (a: string, b: string) => first.indexOf(a) < first.indexOf(b);
      expect(trapFocusTargetIn([withFocused(items, 'sellScroller', beforeFirst), TOASTS], 'sellScroller', true)).toBe('undo');
    });
  });

  it('withFocused places the focused element at its document position', () => {
    const dom = ['a', 'b', 'x', 'c', 'y'];
    const before = (p: string, q: string) => dom.indexOf(p) < dom.indexOf(q);
    const items = ['b', 'c'];
    const same = withFocused(items, 'b', before);
    expect(same).toEqual(['b', 'c']);
    expect(same).not.toBe(items);
    expect(withFocused(items, 'x', before)).toEqual(['b', 'x', 'c']);
    expect(withFocused(items, 'a', before)).toEqual(['a', 'b', 'c']);
    expect(withFocused(items, 'y', before)).toEqual(['b', 'c', 'y']);
    expect(withFocused([], 'x', before)).toEqual(['x']);
  });

  it('is what the drawer traps with', () => {
    const src = readFileSync(new URL('../../src/renderer/components/Drawer.tsx', import.meta.url), 'utf8');
    expect(src).toContain('withFocused(found, active');
    expect(src).toContain('trapFocusTargetIn([items, toastItems], active, e.shiftKey)');
  });
});
