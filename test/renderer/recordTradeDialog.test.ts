// F12 Record trade dialog, rendered with react-dom/client into the minimal DOM
// in domShim.ts, with the browser mock as the app bridge (window.flipdesk): a
// sale prefilled from a holding is compared with the next FIFO lot, saved with
// 'journal.add' and undone from the toast with 'journal.delete'; a buy shows Pay
// up to as the price is typed; no price, no save; Esc closes; Tab stays inside;
// focus goes back to the opener. Nothing leaves the process.

import { act, createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordTradeFormProps } from '../../src/renderer/components/RecordTradeDialog';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { fromDateTimeLocal, toDateTimeLocal } from '../../src/renderer/format';
import { tabbablesWithin, type RecordTradeInit } from '../../src/renderer/recordTradeModel';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { ToastOptions } from '../../src/renderer/toastModel';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const KNIFE = { sku: '194;11', name: 'Strange Knife' };

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let RecordTradeForm: typeof import('../../src/renderer/components/RecordTradeDialog').RecordTradeForm;
let bridge: MockBridge;

beforeAll(async () => {
  // Before react-dom loads: it checks for a DOM once, at import. Declaring `oninput` makes it use
  // native input events for onChange, as in a browser, instead of its old-IE keydown polyfill.
  doc = installDomShim();
  if (!('oninput' in doc)) (doc as unknown as Record<string, unknown>)['oninput'] = null;
  ({ createRoot } = await import('react-dom/client'));
  ({ RecordTradeForm } = await import('../../src/renderer/components/RecordTradeDialog'));
});

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeEach(() => {
  bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 });
  // api.ts reads the preload bridge on every call, so the dialog's rpc() reaches the mock.
  win()['flipdesk'] = bridge;
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge.dispose();
});

/** Lets the mock's zero-latency answers land and React render them. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const cls = (e: ShimElement) => e.getAttribute('class') ?? '';

async function mount(
  init: RecordTradeInit,
  opener: ShimElement | null = null,
  wrap?: (child: ReturnType<typeof createElement>) => ReturnType<typeof createElement>,
  over: Partial<Pick<RecordTradeFormProps, 'keyScrap'>> = {},
) {
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const toast = vi.fn((_text: string, _tone?: string, _opts?: ToastOptions) => 1);
  const onClose = vi.fn();
  const root = createRoot(container as unknown as Element);
  const props: RecordTradeFormProps = { init, opener: opener as unknown as Element | null, onClose, keyScrap: 568, profit: DEFAULT_SETTINGS.profit, toast, now: () => T0, ...over };
  const el = createElement(RecordTradeForm, props);
  act(() => root.render(wrap ? wrap(el) : el));
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => root.unmount());
    doc.body.removeChild(container);
  };
  unmounts.push(unmount);
  await settle();
  // Portalled to document.body (no aria-modal opener), outside the container.
  const all = () => doc.body.descendants();
  const dialog = () => all().find((e) => e.getAttribute('role') === 'dialog');
  const by = (pred: (e: ShimElement) => boolean) => dialog()!.descendants().find(pred);
  const fire = (target: ShimElement, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      target.dispatchEvent(new ShimEvent(type, init));
    });
  const priceInput = () => by((e) => e.tagName === 'INPUT' && cls(e).includes('money-input'))!;
  return {
    toast,
    onClose,
    unmount,
    dialog,
    by,
    fire,
    priceInput,
    form: () => by((e) => e.tagName === 'FORM')!,
    compare: () => by((e) => cls(e).includes('rt-compare'))!,
    buttons: () => dialog()!.descendants().filter((e) => e.tagName === 'BUTTON'),
    type: async (input: ShimElement, text: string) => {
      // React's change detection reads the input's type property, which the minimal DOM leaves unset.
      (input as unknown as { type: string; value: string }).type = 'text';
      (input as unknown as { value: string }).value = text;
      fire(input, 'input', { bubbles: true });
      await settle();
    },
    submit: async () => {
      fire(dialog()!.descendants().find((e) => e.tagName === 'FORM')!, 'submit', { bubbles: true, cancelable: true });
      await settle();
    },
  };
}

async function journalRows() {
  return bridge.rpc('journal.list', { limit: 1000 });
}

describe('RecordTradeForm', () => {
  it('records a sale prefilled from a holding, compared with the next lot, and Undo removes it', async () => {
    const pushes: number[] = [];
    bridge.on('journal.changed', (p) => pushes.push(p.at));
    const before = await journalRows();
    const t = await mount({ side: 'sell', ...KNIFE, venue: 'backpack.tf', keys: 0, scrap: 60, note: 'Sold to Test Bot' });

    const dialog = t.dialog()!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = doc.getElementById(dialog.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toBe('Record sale');
    expect((t.priceInput() as unknown as { value: string }).value).toBe('6.66 ref');
    expect(doc.activeElement).toBe(t.priceInput());
    const compare = t.compare().textContent;
    expect(compare).toContain('Next lot');
    expect(compare).toContain('oldest of 2 open units');
    expect(compare).toMatch(/on the lot you bought/);

    await t.submit();
    expect(t.onClose).toHaveBeenCalledTimes(1);
    expect(t.toast).toHaveBeenCalledTimes(1);
    const [text, tone, opts] = t.toast.mock.calls[0]!;
    expect(text).toBe('Recorded sale of Strange Knife at 6.66 ref.');
    expect(tone).toBe('good');
    expect(opts?.action?.label).toBe('Undo');

    const after = await journalRows();
    expect(after).toHaveLength(before.length + 1);
    const added = after.find((e) => !before.some((b) => b.id === e.id))!;
    expect(added).toMatchObject({ side: 'sell', venue: 'backpack.tf', sku: '194;11', name: 'Strange Knife', keys: 0, scrap: 60, note: 'Sold to Test Bot', ts: fromDateTimeLocal(toDateTimeLocal(T0)) });
    expect(pushes).toHaveLength(1);

    opts!.action!.onClick();
    await settle();
    expect((await journalRows()).some((e) => e.id === added.id)).toBe(false);
    expect(t.toast).toHaveBeenLastCalledWith('Removed the sale of Strange Knife from your journal.', 'info');
    expect(pushes).toHaveLength(2);
  });

  it('shows Pay up to for a buy, and the verdict follows the typed price', async () => {
    const t = await mount({ side: 'buy', ...KNIFE, venue: 'scrap.tf' });
    expect(doc.getElementById(t.dialog()!.getAttribute('aria-labelledby')!)!.textContent).toBe('Record buy');
    expect(t.compare().textContent).toContain('Pay up to');
    expect(t.compare().textContent).toContain('Type the price you paid');

    await t.type(t.priceInput(), '0.11');
    expect(t.compare().textContent).toMatch(/under Pay up to: a flip/);
    expect(cls(t.compare())).toContain('tone-good');

    await t.submit();
    const added = (await journalRows())[0]!;
    expect(added).toMatchObject({ side: 'buy', venue: 'scrap.tf', sku: '194;11', keys: 0, scrap: 1, note: null });
    expect(t.toast.mock.calls[0]![0]).toBe('Recorded buy of Strange Knife at 0.11 ref.');
  });

  it('switching to Sold moves the default venue and compares with your open lots', async () => {
    const t = await mount({ side: 'buy', ...KNIFE });
    const sold = t.buttons().find((b) => b.getAttribute('role') === 'radio' && b.textContent === 'Sold')!;
    t.fire(sold, 'click', { bubbles: true });
    await settle();
    const venue = t.by((e) => e.tagName === 'INPUT' && e.getAttribute('list') !== null)!;
    expect((venue as unknown as { value: string }).value).toBe('backpack.tf');
    expect(doc.getElementById(t.dialog()!.getAttribute('aria-labelledby')!)!.textContent).toBe('Record sale');
    expect(t.compare().textContent).toContain('Next lot');
  });

  it('will not save without a price, and says why', async () => {
    const before = (await journalRows()).length;
    const t = await mount({ side: 'buy', ...KNIFE });
    await t.submit();
    const alert = t.by((e) => e.getAttribute('role') === 'alert');
    expect(alert?.textContent).toMatch(/Enter the price/);
    expect((await journalRows()).length).toBe(before);
    expect(t.toast).not.toHaveBeenCalled();
    expect(t.onClose).not.toHaveBeenCalled();
  });

  it('closes on Esc, and no key reaches the page or the drawer behind it', async () => {
    const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 });
    const behind = vi.fn();
    doc.addEventListener('keydown', behind as never);
    try {
      t.fire(t.priceInput(), 'keydown', { bubbles: true, cancelable: true, key: 'j' });
      expect(t.onClose).not.toHaveBeenCalled();
      t.fire(t.priceInput(), 'keydown', { bubbles: true, cancelable: true, key: 'Escape' });
      expect(t.onClose).toHaveBeenCalledTimes(1);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      doc.removeEventListener('keydown', behind as never);
    }
  });

  it('saves with Ctrl+Enter from any field, once however fast it is pressed', async () => {
    const before = (await journalRows()).length;
    const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 });
    const note = t.by((e) => e.tagName === 'INPUT' && e.getAttribute('maxlength') === '500')!;
    t.fire(note, 'keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true });
    t.fire(note, 'keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true });
    await settle();
    expect((await journalRows()).length).toBe(before + 1);
    expect(t.onClose).toHaveBeenCalledTimes(1);
    expect(t.toast.mock.calls[0]![0]).toBe('Recorded sale of Strange Knife at 6.66 ref.');
  });

  it('keeps Tab inside the dialog', async () => {
    const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 });
    const buttons = t.buttons();
    const close = buttons.find((b) => b.getAttribute('aria-label') === 'Close')!;
    const save = buttons.find((b) => b.getAttribute('type') === 'submit')!;
    save.focus();
    t.fire(save, 'keydown', { bubbles: true, cancelable: true, key: 'Tab' });
    expect(doc.activeElement).toBe(close);
    t.fire(close, 'keydown', { bubbles: true, cancelable: true, key: 'Tab', shiftKey: true });
    expect(doc.activeElement).toBe(save);
  });

  describe('after a toast took focus and went away (focus on <body>)', () => {
    // The drawer's own Esc, behind the dialog: it closes the drawer unless something handled the key.
    const drawerClose = vi.fn();
    const drawerKey = (e: ShimEvent) => {
      if (e['key'] === 'Escape' && !e.defaultPrevented) drawerClose();
    };
    const pageKeys = vi.fn();
    beforeEach(() => {
      drawerClose.mockReset();
      pageKeys.mockReset();
      doc.addEventListener('keydown', drawerKey as never);
      doc.addEventListener('keydown', pageKeys as never);
    });
    afterEach(() => {
      doc.removeEventListener('keydown', drawerKey as never);
      doc.removeEventListener('keydown', pageKeys as never);
    });
    const onBody = (t: Awaited<ReturnType<typeof mount>>, key: string, more: Record<string, unknown> = {}) => {
      doc.body.focus();
      t.fire(doc.body, 'keydown', { bubbles: true, cancelable: true, key, ...more });
    };

    it('Esc closes the dialog, not the drawer behind it; other keys still reach the page', async () => {
      const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 });
      onBody(t, 'j');
      expect(pageKeys).toHaveBeenCalledTimes(1);
      expect(t.onClose).not.toHaveBeenCalled();
      onBody(t, 'Escape');
      expect(t.onClose).toHaveBeenCalledTimes(1);
      expect(drawerClose).not.toHaveBeenCalled();
      expect(pageKeys).toHaveBeenCalledTimes(1);
    });

    it('Tab and Shift+Tab go back into the dialog', async () => {
      const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 });
      const items = tabbablesWithin(t.dialog()!);
      expect(items.length).toBeGreaterThan(2);
      onBody(t, 'Tab');
      expect(doc.activeElement).toBe(items[0]);
      onBody(t, 'Tab', { shiftKey: true });
      expect(doc.activeElement).toBe(items[items.length - 1]);
      expect(pageKeys).not.toHaveBeenCalled();
    });

    it('Ctrl+Enter still saves, once', async () => {
      const before = (await journalRows()).length;
      const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 });
      onBody(t, 'Enter', { ctrlKey: true });
      onBody(t, 'Enter', { ctrlKey: true });
      await settle();
      expect((await journalRows()).length).toBe(before + 1);
      expect(t.onClose).toHaveBeenCalledTimes(1);
    });

    it('focus that lands behind the dialog comes back to it; a toast button keeps it (its Undo stays reachable)', async () => {
      const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 });
      // e.g. "/" focusing the Holdings search behind the backdrop.
      const behind = doc.createElement('input');
      doc.body.appendChild(behind);
      const stack = doc.createElement('div');
      stack.setAttribute('class', 'toasts');
      const undo = doc.createElement('button');
      stack.appendChild(undo);
      doc.body.appendChild(stack);
      try {
        behind.focus();
        t.fire(behind, 'focusin', { bubbles: true });
        expect(doc.activeElement).toBe(t.priceInput());
        undo.focus();
        t.fire(undo, 'focusin', { bubbles: true });
        expect(doc.activeElement).toBe(undo);
        // Esc from the toast closes the dialog on top.
        t.fire(undo, 'keydown', { bubbles: true, cancelable: true, key: 'Escape' });
        expect(t.onClose).toHaveBeenCalledTimes(1);
        expect(drawerClose).not.toHaveBeenCalled();
      } finally {
        doc.body.removeChild(behind);
        doc.body.removeChild(stack);
      }
    });

    it('stops listening once closed', async () => {
      const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 });
      t.unmount();
      doc.body.focus();
      doc.body.dispatchEvent(new ShimEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
      expect(t.onClose).not.toHaveBeenCalled();
      expect(drawerClose).toHaveBeenCalledTimes(1);
    });
  });

  it('gives focus back to the opener when it closes', async () => {
    const opener = doc.createElement('button');
    doc.body.appendChild(opener);
    opener.focus();
    const t = await mount({ side: 'sell', ...KNIFE }, opener);
    expect(doc.activeElement).toBe(t.priceInput());
    t.unmount();
    expect(doc.activeElement).toBe(opener);
    doc.body.removeChild(opener);
  });

  it('keeps its clicks and submit to itself when rendered inside another form or row', async () => {
    const outerSubmit = vi.fn();
    const outerClick = vi.fn();
    const t = await mount({ side: 'sell', ...KNIFE, scrap: 60 }, null, (child) => createElement('form', { onSubmit: outerSubmit, onClick: outerClick }, child));
    const cancel = t.buttons().find((b) => b.textContent === 'Cancel')!;
    t.fire(cancel, 'click', { bubbles: true });
    expect(t.onClose).toHaveBeenCalledTimes(1);
    await t.submit();
    expect(t.toast).toHaveBeenCalledTimes(1);
    expect(outerSubmit).not.toHaveBeenCalled();
    expect(outerClick).not.toHaveBeenCalled();
  });

  it('before a key price arrives, a price in keys is not compared but still saves as keys', async () => {
    const t = await mount({ side: 'sell', ...KNIFE, venue: 'backpack.tf' }, null, undefined, { keyScrap: null });
    await t.type(t.priceInput(), '2 keys');
    expect(t.compare().textContent).toContain("No key price yet, so a price in keys can't be compared.");
    expect(t.compare().textContent).not.toContain('Type the price');
    await t.submit();
    expect((await journalRows())[0]).toMatchObject({ side: 'sell', sku: '194;11', keys: 2, scrap: 0 });
    expect(t.toast.mock.calls[0]![0]).toBe('Recorded sale of Strange Knife at 2 keys.');
  });

  it('explains a sale of something not held', async () => {
    const t = await mount({ side: 'sell', sku: '5021;6', name: 'Mann Co. Supply Crate Key', scrap: 500 });
    expect(t.compare().textContent).toMatch(/No open buy of this item in your journal/);
  });
});
