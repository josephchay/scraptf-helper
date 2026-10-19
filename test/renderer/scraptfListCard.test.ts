// F14 "scrap.tf price list" card (U1): the wiring checked statically (the only app
// methods it calls, the only address it opens, the pushes it refreshes on), every
// state rendered server-side, then the card mounted with react-dom/client into the
// minimal DOM in domShim.ts with the browser mock as the app bridge: import on,
// a folder chosen, a list saved, each reflected without a reload of the page.
// Nothing leaves the process, and nothing here (or in the card) contacts scrap.tf.

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ScraptfListCardView, type ScraptfListCardViewProps } from '../../src/renderer/components/ScraptfListCard';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { LIST_BOUNDARY_NOTE, LIST_PICKUP_TEXT } from '../../src/renderer/scraptfListModel';
import { SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';
import type { ScraptfListStatus } from '../../src/shared/types';
import { installDomShim, ShimEvent, type ShimDocument, type ShimElement } from './domShim';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const noop = () => undefined;

describe('wiring', () => {
  const card = read('components/ScraptfListCard.tsx');

  it('reads scraptf.listStatus and opens the folder dialog, nothing else: no new traffic', () => {
    const methods = new Set([...card.matchAll(/(?:rpc|useRpcQuery)\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
    // 0.7.1 (UX-5): and 'scraptfWindow.open' with the static scrap.tf/items page, from its button's click only.
    expect([...methods].sort()).toEqual(['import.pickWatchFolder', 'scraptf.listStatus', 'scraptfWindow.open']);
    expect([...card.matchAll(/rpc\('scraptfWindow\.open', \{ start: ([^}]+) \}\)/g)].map((m) => m[1]!.trim())).toEqual(['SCRAPTF_ITEMS_URL']);
    for (const m of methods) expect([...SERVICE_METHODS, ...MAIN_METHODS]).toContain(m);
    expect(card).not.toMatch(/https?:\/\//);
    expect(card).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|<webview|<iframe|window\.open/);
  });

  it('hands only scrap.tf/items to the user\'s browser, through links.open (openOrCopy)', () => {
    expect([...card.matchAll(/openOrCopy\(([^,]+),/g)].map((m) => m[1])).toEqual(['SCRAPTF_ITEMS_URL']);
    expect(card).toContain("import { SCRAPTF_ITEMS_URL } from '../../shared/links';");
    expect(SCRAPTF_ITEMS_URL).toBe('https://scrap.tf/items');
  });

  it("refreshes on 'scraptf.listChanged' and 'import.done' (one catch-up when hidden), on import settings and now and then", () => {
    expect(card).toContain("useVisiblePush('scraptf.listChanged', () => void reload());");
    expect(card).toContain("useVisiblePush('import.done', () => void reload());");
    expect(card).toMatch(/settings\.import\.enabled, settings\.import\.acknowledgedAt, settings\.import\.watchFolder/);
    expect(card).toContain('useInterval(() => void reload(), listPollMs(status), visible);');
  });

  it('names the steps region in aria-controls only while it is rendered', () => {
    expect(card).toContain('aria-controls={p.stepsOpen ? stepsId : undefined}');
    expect(card).toContain('<div id={stepsId} className="sl-body">');
  });

  it('sits at the top of the Live market and on both Import page views', () => {
    const market = read('pages/MarketPage.tsx');
    expect(market).toMatch(/<div className="page market-page">\s*(\{\/\*.*\*\/\}\s*)?<ScraptfListCard placement="market" boundaryNote=\{noteDismissed\} \/>/);
    const imp = read('pages/ImportPage.tsx');
    expect(imp.match(/<ScraptfListCard placement="import" \/>/g)).toHaveLength(2);
    expect(imp).toMatch(/<div className="import-grid">[\s\S]*?<div className="span-2">\s*<ScraptfListCard placement="import" \/>/);
  });
});

describe('scraptf-list.css', () => {
  const css = readFileSync(new URL('../../src/renderer/styles/scraptf-list.css', import.meta.url), 'utf8');

  it('takes every colour from the tokens and animates nothing', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/animation|transition/);
  });

  it('is imported after every earlier sheet (only the F15 banks, F16 live check, F17 bank stock, F20 history and F21 window sheets follow it)', () => {
    const index = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8');
    const imports = [...index.matchAll(/@import '\.\/([a-z-]+\.css)';/g)].map((m) => m[1]);
    expect(imports.slice(-6)).toEqual(['scraptf-list.css', 'banks.css', 'check.css', 'bank-stock.css', 'scraptf-history.css', 'scraptf-window.css']);
  });
});

function status(over: Partial<ScraptfListStatus> = {}): ScraptfListStatus {
  return {
    items: 2341,
    newestAt: T0 - 3 * MIN,
    oldestAt: T0 - 3 * MIN,
    pages: 1,
    importEnabled: true,
    watchFolder: 'C:\\Users\\you\\Documents\\scrap.tf pages',
    watchActive: true,
    watchError: null,
    ...over,
  };
}

function view(over: Partial<ScraptfListCardViewProps> = {}): string {
  const props: ScraptfListCardViewProps = {
    placement: 'market',
    boundaryNote: true,
    status: status(),
    error: null,
    now: T0,
    stepsOpen: false,
    picking: false,
    onToggleSteps: noop,
    onOpenList: noop,
    onCopyPath: noop,
    onPickFolder: noop,
    onGoImport: noop,
    onRetry: noop,
    ...over,
  };
  return renderToString(createElement(ScraptfListCardView, props));
}

/** The text a reader sees, without React's comment markers. */
const text = (html: string) => html.replace(/<!-- -->/g, '');

describe('ScraptfListCardView', () => {
  it('on the Live market, once synced: the status line, Open scrap.tf/items and the steps folded away', () => {
    const html = text(view());
    expect(html).toContain('scrap.tf price list');
    expect(html).toContain('All scrap.tf items: 2,341 from your saved price list, saved 3 min ago');
    expect(html).toContain('sl-status tone-good');
    expect(html).toContain('Open scrap.tf/items');
    expect(html).toMatch(/aria-expanded="false"[^>]*>How to sync/);
    expect(html).not.toContain('aria-controls');
    expect(html).not.toContain('sl-steps');
    expect(html).not.toContain('sl-note');
  });

  it('with the steps open: the three steps, the folder and Copy path, and the boundary note', () => {
    const html = text(view({ stepsOpen: true }));
    expect(html).toMatch(/aria-expanded="true"[^>]*>Hide steps/);
    // The toggle controls the region that is now there.
    const controls = /aria-controls="([^"]+)"/.exec(html)![1]!;
    expect(html).toContain(`id="${controls}" class="sl-body"`);
    expect(html.match(/Open scrap\.tf\/items/g)).toHaveLength(1);
    // F18: the save type to choose, and why, before the folder. No Single File for the list: an image per
    // row puts one .mhtml file of it over the import's 20 MB / 2,000-part limits, so it would be refused.
    expect(html).toContain('Ctrl</kbd>+<kbd>S</kbd>, <span class="save-mode"');
    expect(html).toContain('choose <strong>Webpage, Complete</strong> so cards scrap.tf added after the page loaded are included</span>, and save it into your watch folder:');
    expect(html).not.toContain('Single File (.mhtml)</strong>');
    expect(html).toContain('title="&#x27;Webpage, HTML only&#x27; still imports, but it keeps the page as it first loaded and can miss those cards. Not &#x27;Webpage, Single File&#x27;: scrap.tf/items has an image per item, so one .mhtml file of it goes over 20 MB or 2,000 parts and is refused."');
    expect(html).not.toContain('HTML only</strong>');
    expect(html).toContain('C:\\Users\\you\\Documents\\scrap.tf pages');
    expect(html).toContain('Copy path');
    expect(html).toContain(LIST_PICKUP_TEXT);
    expect(html).toContain(LIST_BOUNDARY_NOTE);
    expect(html).not.toContain('aria-disabled');
    // Where the page already states the boundary (the Live market's own note), the card does not repeat it.
    expect(text(view({ stepsOpen: true, boundaryNote: false }))).not.toContain(LIST_BOUNDARY_NOTE);
  });

  it('says "Not saved yet" without a list', () => {
    const html = text(view({ status: status({ items: 0, newestAt: null, oldestAt: null, pages: 0 }) }));
    expect(html).toContain('All scrap.tf items: Not saved yet');
    expect(html).toContain('sl-status tone-muted');
  });

  it('import off: the steps disabled and "Turn on Import first" linking to the Import page', () => {
    const html = text(view({ status: status({ importEnabled: false, watchActive: false }), stepsOpen: true }));
    expect(html).toContain('Saved-page import is off');
    expect(html).toMatch(/<button[^>]*class="link-btn small"[^>]*>Turn on Import first<\/button>/);
    expect(html).toContain('class="sl-steps disabled" aria-disabled="true"');
    // Both step buttons are disabled: nothing to save into yet.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Open scrap\.tf\/items/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Copy path/);
    // On the Import page the acknowledgement is just above: no link.
    const onImport = text(view({ placement: 'import', status: status({ importEnabled: false, watchActive: false }), stepsOpen: true }));
    expect(onImport).toContain('Turn on saved-page import above first');
    expect(onImport).not.toContain('Turn on Import first');
    expect(onImport).not.toContain('How to sync');
  });

  it('no watch folder: "Choose a watch folder", and step 2 says none is chosen', () => {
    const html = text(view({ status: status({ watchFolder: null, watchActive: false }), stepsOpen: true }));
    expect(html).toMatch(/<button[^>]*class="btn small"[^>]*>.*?Choose a watch folder<\/button>/);
    expect(html).toContain('No watch folder chosen yet.');
    expect(html).not.toContain('Copy path');
    expect(text(view({ status: status({ watchFolder: null, watchActive: false }), picking: true }))).toContain('Choosing…');
  });

  it("watch error: the watcher's error, and another folder offered", () => {
    const html = text(view({ status: status({ watchActive: false, watchError: 'Folder not found' }) }));
    expect(html).toContain('sl-note tone-bad');
    expect(html).toContain('Watch error: Folder not found.');
    expect(html).toContain('Choose another folder');
  });

  it('a failed read says so and offers Retry', () => {
    const html = text(view({ status: null, error: 'The service is restarting' }));
    expect(html).toContain('Could not read your saved list: The service is restarting');
    expect(html).toContain('Retry');
    expect(html).toContain('All scrap.tf items: …');
  });
});

// ---------------------------------------------------------------------------
// Mounted against the browser mock
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let ScraptfListCard: typeof import('../../src/renderer/components/ScraptfListCard').ScraptfListCard;

const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  // Before react-dom/client loads: it checks for a DOM once, at import.
  doc = installDomShim();
  // What AppProvider reads beyond the shim: the hash route and the theme attributes on <html>.
  win()['location'] = { hash: '#/market' };
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ ScraptfListCard } = await import('../../src/renderer/components/ScraptfListCard'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.useRealTimers();
});

/**
 * Lets the mock's zero-latency answers and pushes land and React render them. Several act() rounds:
 * an answer can render, run an effect, and that effect ask again (settings saved -> status re-read).
 */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(placement: 'market' | 'import', before?: (b: MockBridge) => Promise<unknown>) {
  // Only the clock is fixed (the card's ages read Date.now()); timers stay real for settle().
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
  if (before) await before(b);
  const rpc = vi.spyOn(b, 'rpc');
  win()['flipdesk'] = b;
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  act(() => root.render(createElement(AppProvider, null, createElement(ScraptfListCard, { placement }))));
  unmounts.push(() => {
    act(() => root.unmount());
    doc.body.removeChild(container);
  });
  await settle();
  const calls = (method: string) => rpc.mock.calls.filter((c) => c[0] === method);
  const buttons = () => container.descendants().filter((e) => e.tagName === 'BUTTON');
  const button = (label: RegExp) => buttons().find((e) => label.test(e.textContent));
  const click = async (el: ShimElement | undefined) => {
    expect(el).toBeDefined();
    act(() => {
      el!.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  return { b, calls, button, click, content: () => container.textContent };
}

describe('ScraptfListCard against the mock', () => {
  it('walks from import off to a synced list: each step shows without reloading the page', async () => {
    const t = await mount('market');
    expect(t.calls('scraptf.listStatus').length).toBeGreaterThan(0);
    // The mock starts with import off and a seeded list.
    expect(t.content()).toContain('Saved-page import is off');
    expect(t.button(/Turn on Import first/)).toBeDefined();
    expect(t.button(/Open scrap\.tf\/items/)!.hasAttribute('disabled')).toBe(true);

    // Turned on elsewhere (the Import page): the settings push re-reads the status.
    const before = t.calls('scraptf.listStatus').length;
    await act(async () => {
      await t.b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0 } });
    });
    await settle();
    expect(t.calls('scraptf.listStatus').length).toBeGreaterThan(before);
    expect(t.content()).toContain('No watch folder yet');

    // Choose a watch folder: main's dialog, then settings.
    await t.click(t.button(/Choose a watch folder/));
    expect(t.calls('import.pickWatchFolder')).toHaveLength(1);
    expect(t.calls('settings.set').some((c) => JSON.stringify(c[1]).includes('watchFolder'))).toBe(true);
    expect(t.content()).not.toContain('No watch folder yet');
    expect(t.content()).toContain('scrap.tf pages');

    // The user saves scrap.tf/items into the folder: the service's push refreshes the line.
    const reads = t.calls('scraptf.listStatus').length;
    await act(async () => {
      await t.b.rpc('import.html', { html: '<html></html>', fileName: 'Items.html', mtimeMs: T0 - 1000 });
    });
    await settle();
    expect(t.calls('scraptf.listStatus').length).toBeGreaterThan(reads);
    expect(t.content()).toMatch(/All scrap\.tf items: [\d,]+ from your saved price list, saved just now/);

    // Open scrap.tf/items goes to links.open (the user's browser), and only that address.
    await t.click(t.button(/Open scrap\.tf\/items/));
    const opens = t.calls('links.open');
    expect(opens).toHaveLength(1);
    expect(opens[0]![1]).toEqual({ url: SCRAPTF_ITEMS_URL });
  });

  it('starts folded on the Live market once the sync works, and the toggle unfolds it', async () => {
    const t = await mount('market', (b) => b.rpc('settings.set', { import: { enabled: true, acknowledgedAt: T0, watchFolder: 'D:\\saves' } }));
    expect(t.content()).toMatch(/All scrap\.tf items: [\d,]+ from your saved price list, saved 3 min ago/);
    expect(t.content()).not.toContain(LIST_PICKUP_TEXT);
    expect(t.button(/Open scrap\.tf\/items/)!.hasAttribute('disabled')).toBe(false);
    const toggle = t.button(/How to sync/);
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    await t.click(toggle);
    expect(t.content()).toContain(LIST_PICKUP_TEXT);
    expect(t.content()).toContain('D:\\saves');
    expect(t.button(/Hide steps/)!.getAttribute('aria-expanded')).toBe('true');
  });

  it('on the Import page always shows the steps, with no toggle', async () => {
    const t = await mount('import');
    expect(t.content()).toContain(LIST_PICKUP_TEXT);
    expect(t.content()).toContain(LIST_BOUNDARY_NOTE);
    expect(t.button(/How to sync|Hide steps/)).toBeUndefined();
  });
});
