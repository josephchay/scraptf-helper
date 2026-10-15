// H3 toast actions, rendered with react-dom/client into the minimal DOM in
// domShim.ts: the action button runs its action and dismisses the toast, and
// hover or focus on an action toast holds its countdown (plain toasts are not
// held). No network.

import { act, createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inToastStack, topmostModalIn } from '../../src/renderer/itemMenuModel';
import type { ToastItem } from '../../src/renderer/toastModel';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let ToastList: typeof import('../../src/renderer/components/Feedback').ToastList;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import.
  doc = installDomShim();
  ({ createRoot } = await import('react-dom/client'));
  ({ ToastList } = await import('../../src/renderer/components/Feedback'));
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
});

function mount(toasts: ToastItem[]) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const onDismiss = vi.fn();
  const onHold = vi.fn();
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(ToastList, { toasts, onDismiss, onHold })));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, init));
    });
  const toastEls = () => container.descendants().filter((e) => (e.getAttribute('class') ?? '').split(' ').includes('toast'));
  const buttons = (el: ShimElement) => el.descendants().filter((e) => e.tagName === 'BUTTON');
  return { container, onDismiss, onHold, fire, toastEls, buttons };
}

describe('ToastList', () => {
  it('renders an action button that runs the action and dismisses the toast', () => {
    const onClick = vi.fn();
    const m = mount([
      { id: 1, text: 'Saved', tone: 'good', timeoutMs: 4_500 },
      { id: 2, text: 'Recorded buy', tone: 'good', timeoutMs: 12_000, action: { label: 'Undo', onClick } },
    ]);
    const [plain, withAction] = m.toastEls();
    expect(plain!.getAttribute('class')).toBe('toast tone-good');
    expect(withAction!.getAttribute('class')).toBe('toast tone-good has-action');
    expect(m.buttons(plain!).map((b) => b.getAttribute('aria-label'))).toEqual(['Dismiss']);
    const [undo, dismiss] = m.buttons(withAction!);
    expect(undo!.textContent).toBe('Undo');
    expect(dismiss!.getAttribute('aria-label')).toBe('Dismiss');

    m.fire(undo!, 'click', { bubbles: true });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(m.onDismiss).toHaveBeenCalledWith(2);

    m.fire(m.buttons(plain!)[0]!, 'click', { bubbles: true });
    expect(m.onDismiss).toHaveBeenLastCalledWith(1);
  });

  it('holds an action toast while focus is inside it, not while it moves between its buttons', () => {
    const m = mount([
      { id: 1, text: 'plain', tone: 'info', timeoutMs: 4_500 },
      { id: 2, text: 'undo me', tone: 'info', timeoutMs: 12_000, action: { label: 'Undo', onClick: () => undefined } },
    ]);
    const [plain, withAction] = m.toastEls();
    const [undo, dismiss] = m.buttons(withAction!);
    m.fire(undo!, 'focusin', { bubbles: true });
    expect(m.onHold).toHaveBeenLastCalledWith(2, 'focus', true);
    m.fire(undo!, 'focusout', { bubbles: true, relatedTarget: dismiss });
    expect(m.onHold).not.toHaveBeenCalledWith(2, 'focus', false);
    m.fire(dismiss!, 'focusout', { bubbles: true, relatedTarget: doc.body });
    expect(m.onHold).toHaveBeenLastCalledWith(2, 'focus', false);

    m.onHold.mockClear();
    m.fire(m.buttons(plain!)[0]!, 'focusin', { bubbles: true });
    expect(m.onHold).not.toHaveBeenCalled();
  });

  it('holds an action toast while the pointer is over it', () => {
    const m = mount([{ id: 3, text: 'undo me', tone: 'info', timeoutMs: 12_000, action: { label: 'Undo', onClick: () => undefined } }]);
    const el = m.toastEls()[0]!;
    m.fire(el, 'mouseover', { bubbles: true, relatedTarget: null });
    expect(m.onHold).toHaveBeenLastCalledWith(3, 'hover', true);
    m.fire(el, 'mouseout', { bubbles: true, relatedTarget: doc.body });
    expect(m.onHold).toHaveBeenLastCalledWith(3, 'hover', false);
  });
});

describe('focus when a toast goes away (H3 with a modal open)', () => {
  /** A drawer panel (aria-modal) holding a Record trade dialog (aria-modal), as when it is portalled into it. */
  function modals() {
    const drawer = doc.createElement('div');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    const dialog = doc.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    drawer.appendChild(dialog);
    doc.body.appendChild(drawer);
    unmounts.push(() => doc.body.removeChild(drawer));
    return { drawer, dialog };
  }

  it("gives focus to the modal on top when the toast's Undo or Dismiss held it, instead of dropping it to <body>", () => {
    const { dialog } = modals();
    const onClick = vi.fn();
    const m = mount([
      { id: 1, text: 'Recorded sale', tone: 'good', timeoutMs: 12_000, action: { label: 'Undo', onClick } },
      { id: 2, text: 'Blocked Bob', tone: 'info', timeoutMs: 12_000, action: { label: 'Undo', onClick } },
    ]);
    const [first, second] = m.toastEls();
    const [undo] = m.buttons(first!);
    undo!.focus();
    m.fire(undo!, 'click', { bubbles: true });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(m.onDismiss).toHaveBeenCalledWith(1);
    expect(doc.activeElement).toBe(dialog);

    const dismiss = m.buttons(second!)[1]!;
    dismiss.focus();
    m.fire(dismiss, 'click', { bubbles: true });
    expect(m.onDismiss).toHaveBeenLastCalledWith(2);
    expect(doc.activeElement).toBe(dialog);
  });

  it('leaves focus alone when it was elsewhere, or when no modal is open', () => {
    const m = mount([{ id: 1, text: 'Saved', tone: 'good', timeoutMs: 12_000, action: { label: 'Undo', onClick: () => undefined } }]);
    const [undo, dismiss] = m.buttons(m.toastEls()[0]!);
    // No modal: nothing to move to.
    undo!.focus();
    m.fire(undo!, 'click', { bubbles: true });
    expect(doc.activeElement).toBe(undo);
    // A modal is open but focus is in it (a mouse click on Dismiss that did not take focus).
    const { drawer } = modals();
    const field = doc.createElement('input');
    drawer.appendChild(field);
    field.focus();
    m.fire(dismiss!, 'click', { bubbles: true });
    expect(doc.activeElement).toBe(field);
  });

  it('finds the modal on top: the last one in document order', () => {
    const { drawer, dialog } = modals();
    expect(topmostModalIn(doc.body)).toBe(dialog);
    drawer.removeChild(dialog);
    expect(topmostModalIn(doc.body)).toBe(drawer);
    expect(topmostModalIn(doc.createElement('div'))).toBeNull();
    const stack = doc.createElement('div');
    stack.setAttribute('class', 'toast-wrap toasts');
    const btn = doc.createElement('button');
    stack.appendChild(btn);
    expect(inToastStack(btn)).toBe(true);
    expect(inToastStack(drawer)).toBe(false);
    expect(inToastStack(null)).toBe(false);
  });
});
