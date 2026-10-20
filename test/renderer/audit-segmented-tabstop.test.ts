// Audit rcomponents-4: Segmented gave tabindex 0 only to the option equal to `value`, so a value
// matching no option (Opportunities "Minimum confidence" once the slider is off a preset: -1) left
// the radiogroup with no Tab stop, and the arrows stepped from index -1. With nothing checked the
// first radio is the Tab stop (WAI-ARIA radiogroup), and the arrows move from the focused radio.
// Mounted with react-dom/client into the minimal DOM in domShim.ts.

import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let Segmented: typeof import('../../src/renderer/components/Controls').Segmented;

beforeAll(async () => {
  // Before react-dom/client loads: it checks for a DOM once, at import.
  doc = installDomShim();
  ({ createRoot } = await import('react-dom/client'));
  ({ Segmented } = await import('../../src/renderer/components/Controls'));
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
});

const OPTIONS = [
  { value: 0, label: 'Any' },
  { value: 45, label: 'Medium+' },
  { value: 70, label: 'High' },
] as const;

function mount(value: number) {
  const onChange = vi.fn();
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(Segmented<number>, { value, options: OPTIONS, onChange, ariaLabel: 'Minimum confidence' })));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const buttons = () => container.descendants().filter((e) => e.tagName === 'BUTTON');
  const button = (label: string) => buttons().find((b) => b.textContent === label)!;
  const stops = () => buttons().filter((b) => b.getAttribute('tabindex') === '0').map((b) => b.textContent);
  const key = (target: ShimElement, k: string) =>
    act(() => {
      target.dispatchEvent(new ShimEvent('keydown', { bubbles: true, cancelable: true, key: k }));
    });
  return { onChange, buttons, button, stops, key };
}

describe('Segmented Tab stop', () => {
  it('is the checked option when the value matches one', () => {
    const t = mount(45);
    expect(t.stops()).toEqual(['Medium+']);
    expect(t.button('Medium+').getAttribute('aria-checked')).toBe('true');
    for (const l of ['Any', 'High']) expect(t.button(l).getAttribute('tabindex')).toBe('-1');
  });

  it('is the first option when the value matches none (minimum confidence 50), with nothing shown checked', () => {
    const t = mount(-1);
    expect(t.stops()).toEqual(['Any']);
    for (const b of t.buttons()) {
      expect(b.getAttribute('aria-checked')).toBe('false');
      expect(b.getAttribute('class') ?? '').not.toContain('active');
    }
  });

  it('with nothing checked, the arrows move from the focused option', () => {
    const t = mount(-1);
    t.key(t.button('Any'), 'ArrowRight');
    expect(t.onChange).toHaveBeenLastCalledWith(45);
    expect(doc.activeElement.textContent).toBe('Medium+');
    t.onChange.mockClear();
    t.key(t.button('Any'), 'ArrowLeft');
    expect(t.onChange).toHaveBeenLastCalledWith(70);
    expect(doc.activeElement.textContent).toBe('High');
  });

  it('steps and wraps as before when an option is checked', () => {
    const mid = mount(45);
    mid.key(mid.button('Medium+'), 'ArrowRight');
    expect(mid.onChange).toHaveBeenLastCalledWith(70);
    const any = mount(0);
    any.key(any.button('Any'), 'ArrowLeft');
    expect(any.onChange).toHaveBeenLastCalledWith(70);
    expect(doc.activeElement.textContent).toBe('High');
  });

  it('is the case Opportunities hits: a non-preset minimum confidence passes -1', () => {
    const src = readFileSync(new URL('../../src/renderer/pages/OpportunitiesPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain('CONFIDENCE_STEPS.some((s) => s.value === filters.minConfidence) ? filters.minConfidence : -1');
  });
});
