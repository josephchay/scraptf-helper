// F16 Live check wiring, read statically (the renderer tests run in node): the window kind routes to
// the popup, the popup and the Recent checks panel call only local app methods, nothing reads the
// clipboard or the browser, and the style sheet loads nothing (R1, R3).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAIN_METHODS, SERVICE_METHODS } from '../../src/shared/rpc';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const methodsOf = (code: string) => [...new Set([...code.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]!))].sort();

describe('window kind', () => {
  it("Root renders the popup for the 'check' window, titled", () => {
    const app = read('App.tsx');
    expect(app).toMatch(/kind === 'check' \? <CheckPopup \/>/);
    expect(app).toContain("check: 'Live check · TF2 Flip Desk'");
    const api = read('api.ts');
    expect(api).toContain("export type WindowKind = 'dashboard' | 'quick-entry' | 'check';");
    expect(api).toContain("location.hash.startsWith('#/check')");
  });
});

describe('the popup page', () => {
  const page = read('pages/CheckPopup.tsx');

  it('calls only the local methods its buttons need', () => {
    const methods = methodsOf(page);
    // F19: check.arm (main) only to disarm, after Save price or Bought it.
    expect(methods).toEqual(['app.hideWindow', 'app.openItem', 'app.showQuickEntry', 'check.arm', 'journal.add', 'journal.delete', 'prices.upsert']);
    for (const m of methods) expect([...SERVICE_METHODS, ...MAIN_METHODS]).toContain(m);
    expect(MAIN_METHODS).toContain('check.arm');
    expect([...page.matchAll(/rpc\('check\.arm', ([^)]*)\)/g)].map((m) => m[1])).toEqual(['null']);
  });

  it('F19: disarms right after a successful Save price or Bought it, never before the write', () => {
    const save = page.slice(page.indexOf('const savePrice'), page.indexOf('const undoBought'));
    expect(save).toMatch(/await rpc\('prices\.upsert', input\);\s*disarm\(\);/);
    const bought = page.slice(page.indexOf('const boughtIt'), page.indexOf('const details'));
    expect(bought).toMatch(/const entry = await rpc\('journal\.add', input\);\s*disarm\(\);/);
    // A failed write keeps the arm: the user may still save that price.
    for (const block of [save, bought]) expect(block.slice(block.indexOf('catch'))).not.toContain('disarm()');
    // Undo is not a new trip to scrap.tf: nothing re-arms.
    expect(page.slice(page.indexOf('const undoBought'), page.indexOf('const boughtIt'))).not.toContain('check.arm');
  });

  it('listens to main for its result, is a labelled dialog, and has its keys and the Undo toast', () => {
    expect(page).toContain("usePush('ui.checkShow'");
    expect(page).not.toContain("usePush('check.done'");
    expect(page).toContain('role="dialog"');
    expect(page).toContain('aria-label={label}');
    expect(page).toContain("window.addEventListener('keydown', onKey)");
    expect(page).toContain('<ToastStack />');
    expect(page).toContain("{ action: { label: 'Undo', onClick: () => void undoBought(entry.id) } }");
  });

  it('reads no clipboard, opens no address and embeds nothing', () => {
    for (const code of [page, read('checkModel.ts')]) {
      expect(code).not.toMatch(/clipboard\s*\.\s*read|readText\s*\(|navigator\s*\.\s*clipboard|copyText\(/);
      expect(code).not.toMatch(/https?:\/\/|fetch\(|XMLHttpRequest|new WebSocket|<iframe|<webview|window\.open|links\.open|openLink|openOrCopy/);
    }
  });
});

describe('the Recent checks panel', () => {
  it('reads the ring and checks pasted text, both local', () => {
    const page = read('pages/MarketPage.tsx');
    const panel = page.slice(page.indexOf('export function RecentChecks'), page.indexOf('function ManualCheckLine'));
    expect(methodsOf(panel)).toEqual(['check.recent', 'check.text']);
    expect(panel).toContain("rpc('check.text', { text: sent, source: 'manual' })");
    expect(panel).toContain("usePush('check.done'");
    expect(panel).toContain('maxLength={CHECK_MAX_CHARS}');
    // The pasted text is component state only: never a persisted preference.
    expect(panel).not.toMatch(/usePersistentState<string>|writePref\(/);
  });
});

describe('check.css', () => {
  const css = read('styles/check.css');

  it('loads nothing and uses theme tokens only', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/url\(|@import/);
    expect(rules.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
  });

  it('styles the popup, the panel and the settings rows', () => {
    for (const sel of ['.check-popup', '.cp-head', '.cp-line', '.cp-verdict', '.cp-pay.prominent', '.cp-actions', '.recent-checks', '.rc-row', '.lc-hotkey-row']) {
      expect(css).toContain(sel);
    }
    expect(css).toContain("html[data-window='check'] .toasts");
  });
});
