// F21: the scrap.tf window's pure rules, as URL tables: what the window opens on a click, where the user's
// own navigation may go, which frames load, which pages are read, what the toolbar shows, the pinned read
// script and the settings gate. Nothing here loads anything.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_BYTES, SCRAPTF_BAR_URL } from '../../src/main/paths';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, SCRAPTF_HOME_URL, SCRAPTF_ITEMS_URL, STATIC_EXTERNAL_URLS } from '../../src/shared/links';
import {
  appCommandAction,
  gateScraptfWindow,
  isAllowedWindowStart,
  isScraptfPageUrl,
  loadFailureNotice,
  responseNotice,
  SCRAPTF_FAILURE_NOTICES,
  SCRAPTF_LINK_NOTICES,
  SCRAPTF_NOT_READ_AGAIN,
  SCRAPTF_READ_REASONS,
  SCRAPTF_WINDOW_NOTICES,
  windowKeyAction,
  type WindowKeyInput,
  READ_MAX_CHARS,
  READ_SCRIPT,
  READ_SCRIPT_FORBIDDEN,
  READ_SETTLE_MS,
  READ_WORLD_ID,
  readResultHtml,
  readScriptProblems,
  SCRAPTF_BAR_HASH,
  SCRAPTF_WINDOW_NEEDS_ACK,
  SCRAPTF_WINDOW_NEEDS_IMPORT,
  SCRAPTF_WINDOW_START_URLS,
  scraptfPathOf,
  scraptfWindowEnableProblem,
  scraptfWindowStartUrls,
  shouldReadUrl,
  subframeNavigationDecision,
  topLevelNavigationDecision,
  windowDisplayUrl,
  windowReadFileName,
  WINDOW_READ_NAME_MAX,
} from '../../src/shared/scraptfWindowPolicy';
import type { Settings } from '../../src/shared/types';

const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;

/** Spellings that must never pass as a scrap.tf page: other schemes, hosts, ports, userinfo, raw tricks. */
const NOT_SCRAPTF: readonly unknown[] = [
  'http://scrap.tf/buy/hats',
  'https://www.scrap.tf/',
  'https://ws.scrap.tf/',
  'https://scrap.tf.evil.example/',
  'https://evilscrap.tf/',
  'https://scrap.tf:8443/',
  'https://scrap.tf:443x/',
  'https://user@scrap.tf/',
  'https://user:pw@scrap.tf/',
  'https://scrap.tf./',
  'https:\\\\scrap.tf\\buy',
  'https://scrap.tf/buy hats',
  'https://scrap.tf/\u0000',
  ' https://scrap.tf/',
  'wss://scrap.tf/',
  'javascript:alert(1)//scrap.tf',
  'data:text/html,scrap.tf',
  'file:///C:/scrap.tf/index.html',
  'about:blank',
  `https://scrap.tf/${'a'.repeat(4100)}`,
  '',
  null,
  undefined,
  42,
  { href: 'https://scrap.tf/' },
];

describe('isScraptfPageUrl / shouldReadUrl', () => {
  it('accepts https pages on exactly scrap.tf, any path or query', () => {
    for (const url of ['https://scrap.tf/', 'https://scrap.tf/buy/hats', 'https://SCRAP.TF/buy/hats', 'https://scrap.tf/items/2?sort=1#x', 'https://scrap.tf/cdn-cgi/challenge-platform/h/b']) {
      expect(isScraptfPageUrl(url), url).toBe(true);
      expect(shouldReadUrl(url), url).toBe(true);
    }
  });

  it('refuses everything else', () => {
    for (const url of NOT_SCRAPTF) {
      expect(isScraptfPageUrl(url), String(url)).toBe(false);
      expect(shouldReadUrl(url), String(url)).toBe(false);
    }
    // Steam's sign-in and Cloudflare's challenge frame load in the window but are never read.
    for (const url of ['https://steamcommunity.com/openid/login?openid.mode=checkid_setup', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x']) {
      expect(shouldReadUrl(url)).toBe(false);
    }
  });
});

describe('start pages', () => {
  it('are scrap.tf home, every SCRAPTF_BANKS page and scrap.tf/items, nothing else', () => {
    expect(scraptfWindowStartUrls()).toBe(SCRAPTF_WINDOW_START_URLS);
    expect([...SCRAPTF_WINDOW_START_URLS].sort()).toEqual([...new Set([SCRAPTF_HOME_URL, ...SCRAPTF_BANKS.map((b) => b.url), SCRAPTF_ITEMS_URL])].sort());
    expect(SCRAPTF_WINDOW_START_URLS[0]).toBe('https://scrap.tf/');
    expect(Object.isFrozen(SCRAPTF_WINDOW_START_URLS)).toBe(true);
    for (const url of SCRAPTF_WINDOW_START_URLS) expect(isAllowedWindowStart(url), url).toBe(true);
    // Home is opened only by the window, never handed to the browser.
    expect(STATIC_EXTERNAL_URLS).not.toContain(SCRAPTF_HOME_URL);
  });

  it('match exactly: no other path, query, hash, case, slash or spelling', () => {
    const bad: unknown[] = [
      `${HATS}/`,
      `${HATS}?sort=price`,
      `${HATS}#top`,
      HATS.toUpperCase(),
      'https://scrap.tf',
      'https://scrap.tf/buy',
      'https://scrap.tf/items/2',
      'https://scrap.tf/search?q=team+captain',
      'https://scrap.tf/terms',
      'http://scrap.tf/buy/hats',
      'https://www.scrap.tf/buy/hats',
      ' https://scrap.tf/buy/hats',
      ...NOT_SCRAPTF,
      '__proto__',
      'constructor',
    ];
    for (const url of bad) expect(isAllowedWindowStart(url), String(url)).toBe(false);
  });
});

describe('topLevelNavigationDecision (the user clicking in the page)', () => {
  const cases: [unknown, 'allow' | 'external' | 'block'][] = [
    ['https://scrap.tf/', 'allow'],
    ['https://scrap.tf/buy/hats', 'allow'],
    ['https://scrap.tf/login', 'allow'],
    ['https://scrap.tf/profile/76561198000000001', 'allow'],
    ['https://scrap.tf/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=1', 'allow'],
    ['https://steamcommunity.com/openid/login?openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0', 'allow'],
    ['https://steamcommunity.com/openid', 'allow'],
    ['https://steamcommunity.com/login/home/?goto=', 'allow'],
    ['https://steamcommunity.com/login', 'allow'],
    // Other Steam pages and allowlisted sites go to the default browser.
    ['https://steamcommunity.com/profiles/76561198000000001', 'external'],
    ['https://steamcommunity.com/openidx/login', 'external'],
    ['https://steamcommunity.com/tradeoffer/new/?partner=1', 'external'],
    ['https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable', 'external'],
    ['https://marketplace.tf/items/tf2/378;6', 'external'],
    ['https://scrap.tf/terms', 'allow'],
    // Steam's link filter forwards anywhere, so it is dropped.
    ['https://steamcommunity.com/linkfilter/?url=https://evil.example/', 'block'],
    ['https://challenges.cloudflare.com/turnstile/v0/api.js', 'block'],
    ['https://www.scrap.tf/', 'block'],
    ['https://evil.example/', 'block'],
    ['http://scrap.tf/', 'block'],
    ['https://scrap.tf:8443/', 'block'],
    ['https://user@scrap.tf/', 'block'],
    ['javascript:alert(1)', 'block'],
    ['data:text/html,<p>x</p>', 'block'],
    ['file:///C:/x.html', 'block'],
    ['app://app/index.html', 'block'],
    ['about:blank', 'block'],
    ['', 'block'],
    [null, 'block'],
  ];
  it.each(cases)('%s -> %s', (url, want) => {
    expect(topLevelNavigationDecision(url)).toBe(want);
  });
});

describe('subframeNavigationDecision', () => {
  const cases: [unknown, 'allow' | 'block'][] = [
    ['https://scrap.tf/frame', 'allow'],
    ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal', 'allow'],
    ['https://steamcommunity.com/openid/login', 'allow'],
    ['https://steamcommunity.com/login/home/', 'allow'],
    ['about:blank', 'allow'],
    ['about:srcdoc', 'allow'],
    ['https://steamcommunity.com/profiles/1', 'block'],
    ['https://www.youtube.com/embed/x', 'block'],
    ['https://googleads.g.doubleclick.net/pagead/ads', 'block'],
    ['https://cloudflare.com/', 'block'],
    ['https://challenges.cloudflare.com.evil.example/', 'block'],
    ['http://challenges.cloudflare.com/', 'block'],
    ['https://backpack.tf/', 'block'],
    ['about:blank#x', 'block'],
    ['data:text/html,x', 'block'],
    ['blob:https://scrap.tf/1', 'block'],
    ['javascript:void(0)', 'block'],
    [undefined, 'block'],
  ];
  it.each(cases)('%s -> %s', (url, want) => {
    expect(subframeNavigationDecision(url)).toBe(want);
  });
});

describe('what the toolbar and the import see of a URL', () => {
  it('windowDisplayUrl keeps origin and path only', () => {
    expect(windowDisplayUrl('https://scrap.tf/buy/hats?sort=price#top')).toBe('https://scrap.tf/buy/hats');
    expect(windowDisplayUrl('https://steamcommunity.com/openid/login?openid.return_to=https%3A%2F%2Fscrap.tf%2Flogin')).toBe('https://steamcommunity.com/openid/login');
    expect(windowDisplayUrl('https://scrap.tf')).toBe('https://scrap.tf/');
    for (const url of ['http://scrap.tf/', 'about:blank', 'https://u:p@scrap.tf/', null, '']) expect(windowDisplayUrl(url)).toBeNull();
  });

  it('scraptfPathOf and windowReadFileName name the scrap.tf path only', () => {
    expect(scraptfPathOf('https://scrap.tf/buy/hats?x=1')).toBe('/buy/hats');
    expect(scraptfPathOf('https://scrap.tf/items/2')).toBe('/items/2');
    expect(scraptfPathOf('https://steamcommunity.com/openid/login')).toBe('/');
    expect(scraptfPathOf(undefined)).toBe('/');
    expect(windowReadFileName('https://scrap.tf/buy/hats?q=secret')).toBe('scrap.tf window /buy/hats');
    // Within the service's 'import.html' fileName cap, so a long path's read is never refused by zod.
    const long = windowReadFileName('https://scrap.tf/buy/hats/' + 'x'.repeat(400));
    expect(WINDOW_READ_NAME_MAX).toBe(260);
    expect(long).toHaveLength(WINDOW_READ_NAME_MAX);
    expect(long.startsWith('scrap.tf window /buy/hats/xxx')).toBe(true);
  });

  it('pins the service cap the window read names keep to', () => {
    const handlers = readFileSync(new URL('../../src/service/rpcHandlers.ts', import.meta.url), 'utf8');
    const params = handlers.slice(handlers.indexOf('const importParams = z.object({'));
    expect(params.slice(0, 400)).toContain(`fileName: z.string().max(${WINDOW_READ_NAME_MAX}),`);
  });
});

describe('READ_SCRIPT', () => {
  it('is the pinned constant, with no forbidden token', () => {
    expect(READ_SCRIPT).toBe(
      "((h) => (typeof h === 'string' && h.length <= 20971520 ? h : null))(document.documentElement ? document.documentElement.outerHTML : null)",
    );
    expect(readScriptProblems(READ_SCRIPT)).toEqual([]);
    expect(READ_WORLD_ID).toBe(1001);
    expect(READ_SETTLE_MS).toBe(4_000);
  });

  it('caps at the import limit', () => {
    expect(READ_MAX_CHARS).toBe(MAX_IMPORT_BYTES);
    expect(READ_SCRIPT).toContain(`h.length <= ${READ_MAX_CHARS} `);
  });

  it('returns the serialised DOM, or null without one or over the cap (run against a stand-in document)', () => {
    // Test-only evaluation with a fake `document`; the app runs it only through executeJavaScriptInIsolatedWorld.
    const run = (document: unknown): unknown => new Function('document', `return ${READ_SCRIPT};`)(document);
    expect(run({ documentElement: { outerHTML: '<html><body>48 cards</body></html>' } })).toBe('<html><body>48 cards</body></html>');
    expect(run({ documentElement: null })).toBeNull();
    expect(run({ documentElement: { outerHTML: 'x'.repeat(READ_MAX_CHARS + 1) } })).toBeNull();
    expect(run({ documentElement: { outerHTML: 'x'.repeat(READ_MAX_CHARS) } })).toHaveLength(READ_MAX_CHARS);
  });

  it('the forbidden-token check sees assignments, requests, events and page state', () => {
    const bad: [string, string][] = [
      ['document.title = "x"', '='],
      ['a += 1', '='],
      ['i++', '++'],
      ['fetch("/ajax/")', 'fetch'],
      ['new XMLHttpRequest()', 'XMLHttpRequest'],
      ['new WebSocket("wss://ws.scrap.tf")', 'WebSocket'],
      ['window.postMessage(1)', 'postMessage'],
      ['el.click()', 'click'],
      ['form.submit()', 'submit'],
      ['el.focus()', 'focus'],
      ['window.scrollTo(0, 0)', 'scrollTo'],
      ['el.dispatchEvent(new Event("x"))', 'dispatchEvent'],
      ['document.cookie', 'cookie'],
      ['localStorage.getItem("k")', 'localStorage'],
      ['location.reload()', 'location'],
      ['document.write("x")', 'write'],
      ['el.innerHTML', 'innerHTML'],
      ['el.remove()', 'remove'],
      ['eval("1")', 'eval'],
      ['setTimeout(f, 1)', 'setTimeout'],
    ];
    for (const [code, token] of bad) expect(readScriptProblems(code), code).toContain(token);
    // Comparisons and arrows are not assignments.
    expect(readScriptProblems("((h) => h === 'a' || h !== 'b' || h.length <= 1 || h.length >= 0 || h == 1 || h != 2)")).toEqual([]);
    expect(READ_SCRIPT_FORBIDDEN.every((re) => !re.global)).toBe(true);
  });

  it('readResultHtml keeps a non-empty string within the cap only', () => {
    expect(readResultHtml('<html></html>')).toBe('<html></html>');
    for (const v of ['', null, undefined, 42, {}, ['<html>'], 'x'.repeat(READ_MAX_CHARS + 1)]) expect(readResultHtml(v)).toBeNull();
  });
});

describe('the toolbar route', () => {
  it('is the hash of main SCRAPTF_BAR_URL', () => {
    expect(SCRAPTF_BAR_HASH).toBe('#/scraptf-bar');
    expect(SCRAPTF_BAR_URL).toBe(`app://app/index.html${SCRAPTF_BAR_HASH}`);
  });
});

describe('the settings gate', () => {
  const base = (over: { importOn?: boolean; importAck?: number | null; windowAck?: number | null; enabled?: boolean } = {}): Settings => ({
    ...structuredClone(DEFAULT_SETTINGS),
    import: { ...DEFAULT_SETTINGS.import, enabled: over.importOn ?? true, acknowledgedAt: over.importAck === undefined ? 1 : over.importAck },
    scraptfWindow: { ...DEFAULT_SETTINGS.scraptfWindow, enabled: over.enabled ?? true, acknowledgedAt: over.windowAck === undefined ? 2 : over.windowAck },
  });

  it('names what is missing', () => {
    expect(scraptfWindowEnableProblem(base())).toBeNull();
    expect(scraptfWindowEnableProblem(base({ importOn: false }))).toBe(SCRAPTF_WINDOW_NEEDS_IMPORT);
    expect(scraptfWindowEnableProblem(base({ importAck: null }))).toBe(SCRAPTF_WINDOW_NEEDS_IMPORT);
    expect(scraptfWindowEnableProblem(base({ windowAck: null }))).toBe(SCRAPTF_WINDOW_NEEDS_ACK);
  });

  it('refuses turning on without the gates, and turns off when a gate goes', () => {
    expect(gateScraptfWindow(base(), true)).toEqual({ ok: true, settings: base() });
    expect(gateScraptfWindow(base({ importOn: false }), true)).toEqual({ ok: false, message: SCRAPTF_WINDOW_NEEDS_IMPORT });
    expect(gateScraptfWindow(base({ windowAck: null }), true)).toEqual({ ok: false, message: SCRAPTF_WINDOW_NEEDS_ACK });
    const off = gateScraptfWindow(base({ importOn: false }), false);
    expect(off.ok && off.settings.scraptfWindow.enabled).toBe(false);
    const input = base({ windowAck: null });
    const off2 = gateScraptfWindow(input, false);
    expect(off2.ok && off2.settings.scraptfWindow).toEqual({ ...input.scraptfWindow, enabled: false });
    // The input is not changed.
    expect(input.scraptfWindow.enabled).toBe(true);
    const disabled = base({ enabled: false, importOn: false, windowAck: null });
    expect(gateScraptfWindow(disabled, false)).toEqual({ ok: true, settings: disabled });
  });
});

describe('0.7.1: notices, keys and the reasons', () => {
  it('names a challenge, error or rate-limit page by its status, and nothing else', () => {
    expect(responseNotice(403)).toBe(SCRAPTF_WINDOW_NOTICES.challenge);
    expect(responseNotice(503)).toBe(SCRAPTF_WINDOW_NOTICES.challenge);
    expect(responseNotice(429)).toBe(SCRAPTF_WINDOW_NOTICES.rateLimited);
    for (const status of [200, 204, 301, 304, 404, 500, 502, 0, -1, null, undefined, '403']) expect(responseNotice(status), String(status)).toBeNull();
    expect(SCRAPTF_WINDOW_NOTICES.challenge).toBe('Cloudflare check or error page on screen: solve it in the page; it is read once the real page loads.');
    expect(SCRAPTF_WINDOW_NOTICES.rateLimited).toBe('scrap.tf is rate-limiting this window: wait a minute before reloading.');
  });

  it("groups a failed load by Chromium's net error, each ending in press Reload", () => {
    const cases: [unknown, string][] = [
      [-105, SCRAPTF_WINDOW_NOTICES.offline],
      [-106, SCRAPTF_WINDOW_NOTICES.offline],
      [-118, SCRAPTF_WINDOW_NOTICES.offline],
      [-7, SCRAPTF_WINDOW_NOTICES.offline],
      [-21, SCRAPTF_WINDOW_NOTICES.offline],
      [-837, SCRAPTF_WINDOW_NOTICES.offline],
      [-200, SCRAPTF_WINDOW_NOTICES.insecure],
      [-202, SCRAPTF_WINDOW_NOTICES.insecure],
      [-310, SCRAPTF_WINDOW_NOTICES.badResponse],
      [-324, SCRAPTF_WINDOW_NOTICES.badResponse],
      [-2, SCRAPTF_WINDOW_NOTICES.loadFailed],
      [-501, SCRAPTF_WINDOW_NOTICES.loadFailed],
      ['x', SCRAPTF_WINDOW_NOTICES.loadFailed],
      [Number.NaN, SCRAPTF_WINDOW_NOTICES.loadFailed],
    ];
    for (const [code, notice] of cases) expect(loadFailureNotice(code), String(code)).toBe(notice);
    for (const n of [SCRAPTF_WINDOW_NOTICES.offline, SCRAPTF_WINDOW_NOTICES.insecure, SCRAPTF_WINDOW_NOTICES.badResponse, SCRAPTF_WINDOW_NOTICES.loadFailed, SCRAPTF_WINDOW_NOTICES.crashed]) {
      expect(n).toMatch(/: press Reload\.$/);
    }
    // Link notices are about one link; a page notice is not one of them.
    expect([...SCRAPTF_LINK_NOTICES].sort()).toEqual([SCRAPTF_WINDOW_NOTICES.blocked, SCRAPTF_WINDOW_NOTICES.needsClick, SCRAPTF_WINDOW_NOTICES.popup].sort());
    // A page that did not load or crashed (a dashboard link loads it again): exactly the "press Reload" ones,
    // never a challenge or rate limit (solved or waited out on screen) and never a link notice.
    expect([...SCRAPTF_FAILURE_NOTICES].sort()).toEqual(Object.values(SCRAPTF_WINDOW_NOTICES).filter((n) => n.endsWith(': press Reload.')).sort());
    for (const n of SCRAPTF_FAILURE_NOTICES) expect(SCRAPTF_LINK_NOTICES.has(n)).toBe(false);
    // Fixed text: no address, query or page content in any of them.
    for (const n of Object.values(SCRAPTF_WINDOW_NOTICES)) expect(n).not.toMatch(/https?:|www\.|\?|#|\/\//);
  });

  it('takes the toolbar keys from a key going down in the page, never its repeats or a key up', () => {
    const k = (input: WindowKeyInput) => windowKeyAction({ type: 'keyDown', alt: false, control: false, meta: false, shift: false, isAutoRepeat: false, ...input });
    expect(k({ key: 'F5' })).toBe('reload');
    expect(k({ key: 'r', control: true })).toBe('reload');
    expect(k({ key: 'R', control: true })).toBe('reload');
    expect(k({ key: 'ArrowLeft', alt: true })).toBe('back');
    expect(k({ key: 'ArrowRight', alt: true })).toBe('forward');
    expect(k({ key: 'Home', alt: true })).toBe('home');
    for (const input of [
      { key: 'F5', isAutoRepeat: true },
      { key: 'F5', type: 'keyUp' },
      { key: 'F5', type: 'rawKeyDown' },
      { key: 'F5', shift: true },
      { key: 'F5', control: true },
      { key: 'r' },
      { key: 'r', control: true, alt: true },
      { key: 'ArrowLeft' },
      { key: 'ArrowLeft', alt: true, meta: true },
      { key: 'Home' },
      { key: 'Enter', alt: true },
      { key: 5 },
    ] as WindowKeyInput[]) {
      expect(k(input), JSON.stringify(input)).toBeNull();
    }
    expect(windowKeyAction(null)).toBeNull();
    expect(windowKeyAction(undefined)).toBeNull();
    // The window's app-command: the mouse's back and forward buttons only.
    expect(appCommandAction('browser-backward')).toBe('back');
    expect(appCommandAction('browser-forward')).toBe('forward');
    for (const c of ['browser-refresh', 'browser-home', 'media-play-pause', '', null]) expect(appCommandAction(c)).toBeNull();
  });

  it('keeps the new read reasons and the gap code fixed text', () => {
    expect(SCRAPTF_READ_REASONS.notImportable).toBe('Nothing to import on this page.');
    expect(SCRAPTF_READ_REASONS.schemaLoading).toBe('Item data is still loading; press Read page now in a moment.');
    expect(SCRAPTF_NOT_READ_AGAIN).toBe('not-read-again');
  });
});
