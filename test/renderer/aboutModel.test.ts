// 0.9 (RESEARCH #25): the About page's "Unsupported by scrap.tf" panel (aboutModel.ts, AboutPage's UnsupportedPanel):
// nine rows from RESEARCH.md §6.1, each with what, why, what Flip Desk does instead and dated, graded sources; the
// sources' addresses are copied, never opened; and the Appendix C email, which no longer says the tool "never
// connects" and asks the three questions. Rendered server-side, then mounted into the minimal DOM in domShim.ts
// with the browser mock as the app bridge (a source click copies its address and calls nothing).

import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BOUNDARY_GRADE_LABELS,
  PERMISSION_QUESTIONS,
  PERMISSION_TEMPLATE,
  SCRAPTF_UNSUPPORTED,
  UNSUPPORTED_CHECKED,
  UNSUPPORTED_INTRO,
  boundarySourceTitle,
  type BoundaryGrade,
} from '../../src/renderer/aboutModel';
import { createMockBridge, type MockBridge } from '../../src/renderer/mock';
import { PERMISSION_TEMPLATE as IMPORT_PAGE_TEMPLATE } from '../../src/renderer/pages/ImportPage';
import { installDomShim, ShimElement, ShimEvent, type ShimDocument } from './domShim';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

describe('0.9 (#25): the Unsupported rows', () => {
  it('has nine rows with unique ids, in RESEARCH §6.1 order, each with what, why, instead and a source', () => {
    expect(SCRAPTF_UNSUPPORTED.map((r) => r.id)).toEqual(['monitoring', 'item-pages', 'auto-queue', 'rejoin', 'queue-state', 'auto-buy', 'repricing', 'limits', 'dev-api']);
    expect(new Set(SCRAPTF_UNSUPPORTED.map((r) => r.id)).size).toBe(9);
    for (const r of SCRAPTF_UNSUPPORTED) {
      expect(r.what.trim(), r.id).not.toBe('');
      expect(r.why.trim(), r.id).not.toBe('');
      expect(r.instead.trim(), r.id).not.toBe('');
      expect(r.sources.length, r.id).toBeGreaterThanOrEqual(1);
      for (const s of r.sources) expect(s.label.trim(), r.id).not.toBe('');
    }
  });

  it('gives every source an https address without a query or fragment, and a known grade', () => {
    const grades = Object.keys(BOUNDARY_GRADE_LABELS) as BoundaryGrade[];
    expect(grades.sort()).toEqual(['community', 'search-copy', 'verified']);
    for (const s of SCRAPTF_UNSUPPORTED.flatMap((r) => r.sources)) {
      expect(s.url, s.label).toMatch(/^https:\/\/[^\s]+$/);
      expect(s.url, s.label).not.toMatch(/[?#]/);
      expect(() => new URL(s.url)).not.toThrow();
      expect(grades, s.label).toContain(s.grade);
    }
  });

  it("uses RESEARCH §6.1's exact addresses, the chat bot's among them (D8)", () => {
    const research = read('docs/RESEARCH.md');
    const section = research.slice(research.indexOf('### 6.1 scrap.tf'), research.indexOf('### 6.2 backpack.tf'));
    expect(section.length).toBeGreaterThan(100);
    const dev = SCRAPTF_UNSUPPORTED.find((r) => r.id === 'dev-api')!;
    expect(dev.sources.map((s) => s.url)).toEqual(['https://raw.githubusercontent.com/Jessecar96/scrap-chat-bot-example/master/index.js']);
    // Every address the panel names that RESEARCH's §6.1 table also names is spelled the same; the 2024 API thread
    // and the Steam Subscriber Agreement come from RESEARCH §4.1 and §4.6.
    const urls = [...new Set(SCRAPTF_UNSUPPORTED.flatMap((r) => r.sources.map((s) => s.url)))];
    const elsewhere = urls.filter((u) => !section.includes(u));
    expect(elsewhere).toEqual(['https://forum.scrap.tf/topic/27296-scraptf-api/']);
    expect(research).toContain('27296');
  });

  it('dates the intro and every grade, and says the sources are copied to be read', () => {
    expect(UNSUPPORTED_CHECKED).toBe('2026-10-22');
    expect(UNSUPPORTED_INTRO).toContain('2026-10-22');
    expect(UNSUPPORTED_INTRO).toContain('docs/RESEARCH.md §6.1');
    expect(UNSUPPORTED_INTRO).toContain('may be out of date');
    expect(UNSUPPORTED_INTRO).toContain("Copy a source's address to read it yourself.");
    expect(BOUNDARY_GRADE_LABELS.verified).toContain('2026-10-22');
    expect(BOUNDARY_GRADE_LABELS['search-copy']).toContain('2026-10-22');
    expect(BOUNDARY_GRADE_LABELS.community).toContain('not confirmed by scrap.tf');
    const s = SCRAPTF_UNSUPPORTED[3]!.sources[0]!;
    expect(boundarySourceTitle(s)).toBe(`${s.url} (${BOUNDARY_GRADE_LABELS.community}). Copies the address.`);
  });

  it('names R1 and R4 where the rules decide, and promises no forecast', () => {
    const all = SCRAPTF_UNSUPPORTED.map((r) => `${r.what} ${r.why} ${r.instead}`).join(' ');
    expect(SCRAPTF_UNSUPPORTED.find((r) => r.id === 'item-pages')!.why).toContain('R1');
    expect(SCRAPTF_UNSUPPORTED.find((r) => r.id === 'auto-buy')!.why).toContain('R4');
    expect(all).not.toMatch(/\bforecast\b|\bguarantee/i);
    // None of exits' automation deny-list tokens.
    for (const t of ['EnterRaffle', 'AutoScrap', 'items/Sell', 'mm-queue-trade-confirmed', 'scr_session', 'ScrapTF.User.Hash', 'nodriver', 'scraptf=']) {
      expect(read('src/renderer/aboutModel.ts')).not.toContain(t);
    }
  });
});

describe('0.9 (#25): the email (DESIGN_BRIEF Appendix C, extended)', () => {
  it('starts with the address, asks the three questions numbered 1-3 in order, and keeps the promise', () => {
    expect(PERMISSION_TEMPLATE.startsWith('To: admin@scrap.tf\n')).toBe(true);
    expect(PERMISSION_QUESTIONS).toHaveLength(3);
    let at = -1;
    PERMISSION_QUESTIONS.forEach((q, i) => {
      const line = `\n${i + 1}. ${q}\n`;
      const next = PERMISSION_TEMPLATE.indexOf(line);
      expect(next, line).toBeGreaterThan(at);
      at = next;
    });
    expect(PERMISSION_TEMPLATE).toContain('I will follow whatever you decide.');
    expect(PERMISSION_TEMPLATE.trimEnd().endsWith('Thank you.')).toBe(true);
  });

  it('no longer says the tool never connects to scrap.tf (untrue since the opt-in window), and names the window', () => {
    expect(PERMISSION_TEMPLATE).not.toMatch(/never connects to scrap\.tf/);
    expect(PERMISSION_TEMPLATE).toContain('never sends requests to scrap.tf on its own');
    expect(PERMISSION_QUESTIONS[0]).toContain('a window that I browse myself');
    expect(PERMISSION_QUESTIONS[1]).toMatch(/queue reservation[\s\S]*trade offer[\s\S]*missed offer/);
    expect(PERMISSION_QUESTIONS[2]).toContain('sanctioned feed');
  });

  it('is the same string the Import page re-exports and shows', () => {
    expect(IMPORT_PAGE_TEMPLATE).toBe(PERMISSION_TEMPLATE);
    const page = read('src/renderer/pages/ImportPage.tsx');
    expect(page).toContain("export { PERMISSION_TEMPLATE } from '../aboutModel';");
    expect(page).toContain('<pre className="template">{PERMISSION_TEMPLATE}</pre>');
  });
});

// ---------------------------------------------------------------------------
// The panel, rendered
// ---------------------------------------------------------------------------

let doc: ShimDocument;
let createRoot: typeof import('react-dom/client').createRoot;
let AppProvider: (p: { children: ReactNode }) => ReactNode;
let AboutPage: () => ReactNode;
let UnsupportedPanel: () => ReactNode;
const win = () => (globalThis as unknown as { window: Record<string, unknown> }).window;

beforeAll(async () => {
  doc = installDomShim();
  const g = globalThis as Record<string, unknown>;
  g['HTMLElement'] ??= ShimElement;
  g['Element'] ??= ShimElement;
  (doc.documentElement as unknown as { dataset: Record<string, string> }).dataset = {};
  win()['location'] = { hash: '#/about' };
  ({ createRoot } = await import('react-dom/client'));
  ({ AppProvider } = await import('../../src/renderer/hooks/appContext'));
  ({ AboutPage, UnsupportedPanel } = await import('../../src/renderer/pages/AboutPage'));
});

let bridge: MockBridge | null = null;
const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length) unmounts.pop()!();
  delete win()['flipdesk'];
  bridge?.dispose();
  bridge = null;
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const html = (c: () => ReactNode) => renderToString(createElement(AppProvider, null, createElement(c))).replace(/<!-- -->/g, '');

describe('0.9 (#25): the panel, rendered', () => {
  it('sits between "What it never does" and "Platform rules", headed "Unsupported by scrap.tf"', () => {
    const h = html(AboutPage);
    const never = h.indexOf('id="about-never"');
    const panel = h.indexOf('<h2 id="about-unsupported">Unsupported by scrap.tf</h2>');
    const terms = h.indexOf('id="about-terms"');
    expect(never).toBeGreaterThan(0);
    expect(panel).toBeGreaterThan(never);
    expect(terms).toBeGreaterThan(panel);
    expect(h).toContain('<section class="card" aria-labelledby="about-unsupported">');
  });

  it('lists every row with its sources as copy buttons (no link), then the email behind "Show the email"', () => {
    const h = html(UnsupportedPanel);
    expect(h).toContain(`<p class="muted small">${UNSUPPORTED_INTRO.replace(/'/g, '&#x27;')}</p>`);
    expect(h.match(/<li>/g)).toHaveLength(9);
    for (const r of SCRAPTF_UNSUPPORTED) expect(h).toContain(`<strong>${r.what.replace(/'/g, '&#x27;')}</strong>`);
    expect(h.match(/>Instead: /g)).toHaveLength(9);
    const sources = SCRAPTF_UNSUPPORTED.flatMap((r) => r.sources);
    expect(h.match(/<button type="button" class="link-btn" title="https:\/\/[^"]+ \([^"]+\)\. Copies the address\.">/g)).toHaveLength(sources.length);
    // No link, no image, no opener.
    expect(h).not.toMatch(/<a\b|href=|<img\b|src=/);
    expect(h).toContain('Want certainty? Ask scrap.tf yourself, from your own email (the app never sends it):');
    expect(h).toMatch(/<details class="unsupported-email"><summary>Show the email<\/summary><pre class="template">To: admin@scrap\.tf/);
    expect(h).toMatch(/<\/svg> Copy the email<\/button>/);
  });

  it('copies a source address on a click, calls no app method, and copies the email', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } });
    const b = (bridge = createMockBridge({ tickMs: 0, latencyMs: 0, now: () => T0 }));
    win()['flipdesk'] = b;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    act(() => root.render(createElement(AppProvider, null, createElement(UnsupportedPanel))));
    unmounts.push(() => {
      act(() => root.unmount());
      doc.body.removeChild(container);
    });
    await settle();
    const rpc = vi.spyOn(b, 'rpc');
    const buttons = container.descendants().filter((e) => e.tagName === 'BUTTON');
    const first = SCRAPTF_UNSUPPORTED[0]!.sources[0]!;
    const source = buttons.find((e) => e.textContent.trim() === first.label)!;
    expect(source).toBeDefined();
    act(() => {
      source.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(copied).toEqual([first.url]);
    expect(rpc.mock.calls.filter((c) => c[0] === 'links.open')).toEqual([]);
    const email = buttons.find((e) => e.textContent.trim() === 'Copy the email')!;
    act(() => {
      email.dispatchEvent(new ShimEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(copied).toEqual([first.url, PERMISSION_TEMPLATE]);
    expect(rpc.mock.calls.filter((c) => c[0] === 'links.open')).toEqual([]);
  });
});
