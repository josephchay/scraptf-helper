// Audit rcomponents-2: Esc on an open tooltip (a flag chip's help, a confidence badge) inside the
// item drawer closed the whole drawer, and in quick entry hid the window: the tip's window keydown
// listener ran after the drawer's (added later, same bubble phase) and never claimed the key.
// Mounted with react-dom/client into the minimal DOM in domShim.ts. The shim's window is not in
// an event's path, so `press` runs window capture listeners, the target's path, then window
// bubble listeners, as a browser does.

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

type WinListener = { type: string; fn: (e: ShimEvent) => void; capture: boolean };

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let Drawer: typeof import('../../src/renderer/components/Drawer').Drawer;
let FlagChip: typeof import('../../src/renderer/components/Pills').FlagChip;
const registry: WinListener[] = [];

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;
const captureOf = (opts: unknown) => (typeof opts === 'boolean' ? opts : (opts as { capture?: boolean } | undefined)?.capture === true);

beforeAll(async () => {
  doc = installDomShim();
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  win()['innerWidth'] = 1280;
  win()['addEventListener'] = (type: string, fn: (e: ShimEvent) => void, opts?: unknown) => {
    const capture = captureOf(opts);
    if (!registry.some((l) => l.type === type && l.fn === fn && l.capture === capture)) registry.push({ type, fn, capture });
  };
  win()['removeEventListener'] = (type: string, fn: (e: ShimEvent) => void, opts?: unknown) => {
    const capture = captureOf(opts);
    const at = registry.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (at >= 0) registry.splice(at, 1);
  };
  ({ createRoot } = await import('react-dom/client'));
  ({ Drawer } = await import('../../src/renderer/components/Drawer'));
  ({ FlagChip } = await import('../../src/renderer/components/Pills'));
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  registry.length = 0;
});

function mount(node: ReactNode) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(node));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const chip = () => container.descendants().find((e) => (e.getAttribute('class') ?? '').includes('chip-flag'))!;
  const tooltip = () => doc.body.descendants().find((e) => e.getAttribute('role') === 'tooltip') ?? null;
  return { chip, tooltip };
}

/** A keydown as the browser delivers it: window capture, the target's own path, window bubble. */
function press(target: ShimElement, key: string): ShimEvent {
  const e = new ShimEvent('keydown', { bubbles: true, cancelable: true, key });
  act(() => {
    e.target = target;
    for (const l of registry.filter((x) => x.type === 'keydown' && x.capture)) if (!e.stopped) l.fn(e);
    if (!e.stopped) target.dispatchEvent(e);
    for (const l of registry.filter((x) => x.type === 'keydown' && !x.capture)) if (!e.stopped) l.fn(e);
  });
  return e;
}

/** Keyboard focus on the chip opens its tip after the 250 ms delay. */
async function openTip(t: ReturnType<typeof mount>): Promise<void> {
  const chip = t.chip();
  chip.focus();
  act(() => {
    chip.dispatchEvent(new ShimEvent('focusin', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
  expect(t.tooltip()).not.toBeNull();
}

describe('Esc on an open tooltip', () => {
  it('in the item drawer closes the tip, not the drawer; the next Esc closes the drawer', async () => {
    const onClose = vi.fn();
    const t = mount(createElement(Drawer, { open: true, onClose, labelledBy: 'x', children: createElement(FlagChip, { flag: 'outlier' }) }));
    await openTip(t);
    const e = press(t.chip(), 'Escape');
    expect(t.tooltip()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    press(t.chip(), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Esc to the drawer when no tip is open', () => {
    const onClose = vi.fn();
    const t = mount(createElement(Drawer, { open: true, onClose, labelledBy: 'x', children: createElement(FlagChip, { flag: 'outlier' }) }));
    press(t.chip(), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is claimed before quick entry's window Esc (which hides the window unless the key was used)", async () => {
    const hideWindow = vi.fn();
    registry.push({ type: 'keydown', capture: false, fn: (e) => void (e['key'] === 'Escape' && !e.defaultPrevented && hideWindow()) });
    const t = mount(createElement(FlagChip, { flag: 'outlier' }));
    await openTip(t);
    press(t.chip(), 'Escape');
    expect(hideWindow).not.toHaveBeenCalled();
    expect(t.tooltip()).toBeNull();
    press(t.chip(), 'Escape');
    expect(hideWindow).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys, and removes its listener once the tip closes', async () => {
    const t = mount(createElement(FlagChip, { flag: 'outlier' }));
    await openTip(t);
    expect(registry.some((l) => l.type === 'keydown' && l.capture)).toBe(true);
    const e = press(t.chip(), 'j');
    expect(e.defaultPrevented).toBe(false);
    expect(t.tooltip()).not.toBeNull();
    press(t.chip(), 'Escape');
    expect(t.tooltip()).toBeNull();
    expect(registry.filter((l) => l.type === 'keydown')).toEqual([]);
  });
});
