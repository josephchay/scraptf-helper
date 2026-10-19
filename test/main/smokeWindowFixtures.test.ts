// The window test's local router (main/smokeWindowFixtures.ts): which address gets which fixture or page,
// what status, and a 404 with no body for everything else; that it is pure (no file, network or Electron
// access); and that its partial hats page really reads as a partial look of /buy/hats in the service's
// import (DM-2), which step 6 of the window test relies on. Nothing is fetched or launched here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  partialHatsHtml,
  routeSmokeRequest,
  SMOKE_CHALLENGE_AT_HATS_URL,
  SMOKE_CHALLENGE_URL,
  SMOKE_FIXTURE_FILES,
  SMOKE_HATS_URL,
  SMOKE_HOME_URL,
  SMOKE_PARTIAL_AT_HATS_URL,
  SMOKE_PARTIAL_HATS_URL,
  SMOKE_STEAM_LINK_POINT,
  SMOKE_STEAM_LOGIN_URL,
  SMOKE_STEAM_SENTINEL,
  SMOKE_UNUSUALS_URL,
  smokeWindowSettings,
  type SmokeFixtureName,
} from '../../src/main/smokeWindowFixtures';
import { createSettingsStore } from '../../src/main/settingsStore';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createBankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { createScraptfHistory } from '../../src/service/domain/scraptfHistory';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { PARTIAL_READ, PARTIAL_READ_MIN_KEYS } from '../../src/shared/importCodes';
import { SCRAPTF_BANKS, SCRAPTF_HOME_URL } from '../../src/shared/links';
import { scraptfImportablePath } from '../../src/shared/scraptfPaths';
import { isAllowedWindowStart, shouldReadUrl, topLevelNavigationDecision } from '../../src/shared/scraptfWindowPolicy';
import type { ImportResult, KeyPriceState } from '../../src/shared/types';
import { fixture } from '../import/mhtmlFixture';
import { createStubSchema } from '../import/schemaStub';

const FIXTURES = new Map<SmokeFixtureName, string>(SMOKE_FIXTURE_FILES.map((n) => [n, fixture(n)]));
const read = (name: SmokeFixtureName) => FIXTURES.get(name) ?? null;
const get = (url: string, method = 'GET') => routeSmokeRequest(url, method, read);
const path = (p: string) => new URL(p, SCRAPTF_HOME_URL).href;

describe('routeSmokeRequest', () => {
  it('serves each /buy/<slug> fixture as HTML, a trailing slash and a query aside', () => {
    for (const slug of ['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'items']) {
      const want = fixture(`buy_${slug}.html`);
      for (const url of [path(`/buy/${slug}`), path(`/buy/${slug}/`), `${path(`/buy/${slug}`)}?sort=price#top`]) {
        const r = get(url);
        expect(r.status, url).toBe(200);
        expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(r.body).toBe(want);
      }
    }
  });

  it('serves the unusuals fixture at /unusuals and /unusuals/<n>, and the list at /items', () => {
    for (const url of [SMOKE_UNUSUALS_URL, path('/unusuals/'), path('/unusuals/378')]) expect(get(url)).toMatchObject({ status: 200, body: fixture('unusuals.html') });
    expect(get(path('/items'))).toMatchObject({ status: 200, body: fixture('items_list.html') });
  });

  it('serves a local home page linking every bank and Steam sign-in, the Steam link over the point the harness clicks', () => {
    const r = get(SMOKE_HOME_URL);
    expect(r.status).toBe(200);
    for (const b of SCRAPTF_BANKS) expect(r.body).toContain(`href="${new URL(b.url).pathname}"`);
    const link = /<a id="steam-sign-in" href="([^"]+)" style="([^"]+)"/.exec(r.body);
    expect(link?.[1]).toBe(SMOKE_STEAM_LOGIN_URL);
    const px = (prop: string) => Number(new RegExp(`(?:^|;)${prop}:(\\d+)px`).exec(link![2]!)?.[1]);
    expect(link![2]).toContain('position:absolute;left:0;top:0');
    expect(px('width')).toBeGreaterThan(SMOKE_STEAM_LINK_POINT.x);
    expect(px('height')).toBeGreaterThan(SMOKE_STEAM_LINK_POINT.y);
    // Nothing on it loads anything: no script, frame, image or style sheet.
    expect(r.body).not.toMatch(/<script|<iframe|<img|<link|src=/i);
  });

  it('answers /smoke/challenge as a Cloudflare-style check: 403, cf-mitigated, a small page with no frame or script', () => {
    const r = get(SMOKE_CHALLENGE_URL);
    expect(r.status).toBe(403);
    expect(r.headers['cf-mitigated']).toBe('challenge');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.body).toContain('<title>Just a moment...</title>');
    expect(r.body).not.toMatch(/<script|<iframe|src=/i);
    // The same answer at the hats address (step 5's second page); another query there, or another bank, is the page.
    expect(get(SMOKE_CHALLENGE_AT_HATS_URL)).toEqual(r);
    expect(get(`${SMOKE_HATS_URL}?smoke=challenges`)).toMatchObject({ status: 200, body: fixture('buy_hats.html') });
    expect(get(`${SMOKE_UNUSUALS_URL}?smoke=challenge`)).toMatchObject({ status: 200, body: fixture('unusuals.html') });
  });

  it('serves the partial hats page at /smoke/partial-hats and at /buy/hats?smoke=partial-hats', () => {
    const want = partialHatsHtml(fixture('buy_hats.html'));
    expect(get(SMOKE_PARTIAL_HATS_URL)).toMatchObject({ status: 200, body: want });
    expect(get(SMOKE_PARTIAL_AT_HATS_URL)).toMatchObject({ status: 200, body: want });
    // Another query is the full page.
    expect(get(`${SMOKE_HATS_URL}?smoke=other`).body).toBe(fixture('buy_hats.html'));
  });

  it('keeps the first two numbered cards of the hats fixture and drops the rest', () => {
    const full = fixture('buy_hats.html');
    const partial = partialHatsHtml(full);
    const cards = (html: string) => [...html.matchAll(/<!-- C(\d+):/g)].map((m) => m[1]);
    expect(cards(full).length).toBeGreaterThanOrEqual(30);
    expect(cards(partial)).toEqual(['01', '02']);
    expect(partial).toContain('data-title="Team Captain"');
    expect(partial).toContain('data-title="Bill&apos;s Hat"');
    expect(partial).not.toContain('data-title="Wise Whiskers"');
    // The page around the cards stays: its address marks, body id and closing tags.
    expect(partial).toContain('<meta property="og:url" content="https://scrap.tf/buy/hats" />');
    expect(partial).toContain('id="pid-buy-hats"');
    expect(partial.trimEnd().endsWith('</html>')).toBe(true);
    // Saved with Windows line ends, the same cut.
    expect(partialHatsHtml(full.replace(/\n/g, '\r\n'))).toBe(partial.replace(/\n/g, '\r\n'));
  });

  it("serves the local Steam sign-in page, sentinel included, at Steam's /openid/login only", () => {
    const r = get(SMOKE_STEAM_LOGIN_URL);
    expect(r.status).toBe(200);
    expect(r.body).toContain(SMOKE_STEAM_SENTINEL);
    expect(get(`${SMOKE_STEAM_LOGIN_URL}/`).status).toBe(200);
    for (const url of ['https://steamcommunity.com/', 'https://steamcommunity.com/openid', 'https://steamcommunity.com/login/home', 'http://steamcommunity.com/openid/login', 'https://steamcommunity.com:444/openid/login']) {
      expect(get(url), url).toEqual({ status: 404, headers: {}, body: '' });
    }
  });

  it('answers everything else with a 404 and no body', () => {
    const others = [
      path('/buy/unusual'),
      path('/buy/Hats'),
      path('/buy/hats/2'),
      path('/buy'),
      path('/items/2'),
      path('/unusuals/abc'),
      path('/ajax/buy/hats'),
      path('/smoke'),
      path('/raffles'),
      path('/css/styles.1791488770.css'),
      'http://scrap.tf/buy/hats',
      'https://www.scrap.tf/buy/hats',
      'https://scrap.tf:8443/buy/hats',
      'https://user@scrap.tf/buy/hats',
      'https://ws.scrap.tf/',
      'wss://ws.scrap.tf/',
      'https://community.akamai.steamstatic.com/economy/image/FIXTURE-378/96fx96f',
      'https://challenges.cloudflare.com/turnstile/v0/api.js',
      'https://backpack.tf/',
      'file:///C:/Windows/win.ini',
      'data:text/html,hi',
      'not a url',
      '',
    ];
    for (const url of others) expect(get(url), url).toEqual({ status: 404, headers: {}, body: '' });
    for (const method of ['POST', 'HEAD', 'PUT', 'OPTIONS']) expect(get(SMOKE_HATS_URL, method), method).toMatchObject({ status: 404, body: '' });
  });

  it('serves no page with a preconnect or DNS hint or an IP address: the only ways around the handlers and the host rules', () => {
    const urls = [
      SMOKE_HOME_URL,
      SMOKE_CHALLENGE_URL,
      SMOKE_PARTIAL_HATS_URL,
      SMOKE_STEAM_LOGIN_URL,
      SMOKE_UNUSUALS_URL,
      path('/items'),
      ...['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'items'].map((s) => path(`/buy/${s}`)),
    ];
    for (const url of urls) {
      const { status, body } = get(url);
      expect(status, url).not.toBe(404);
      expect(body, url).not.toMatch(/\brel\s*=\s*["']?[^"'>]*\b(?:preconnect|dns-prefetch)\b/i);
      expect(body, url).not.toMatch(/\b(?:https?|wss?|ftp):\/\/(?:[^/\s"'@]*@)?(?:\d{1,3}(?:\.\d{1,3}){3}|\[)/i);
    }
  });

  it('answers 404 for a fixture it was not given', () => {
    expect(routeSmokeRequest(SMOKE_HATS_URL, 'GET', () => null)).toEqual({ status: 404, headers: {}, body: '' });
    expect(routeSmokeRequest(SMOKE_PARTIAL_HATS_URL, 'GET', () => null).status).toBe(404);
    // Its own pages need none.
    expect(routeSmokeRequest(SMOKE_HOME_URL, 'GET', () => null).status).toBe(200);
  });
});

describe('the window test addresses', () => {
  it('are scrap.tf pages from the shared constants: the start pages the window opens, the others only the harness loads', () => {
    expect(SMOKE_HOME_URL).toBe(SCRAPTF_HOME_URL);
    expect(SMOKE_HATS_URL).toBe(SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url);
    expect(SMOKE_UNUSUALS_URL).toBe(SCRAPTF_BANKS.find((b) => b.bank === 'unusuals')!.url);
    for (const url of [SMOKE_HOME_URL, SMOKE_HATS_URL, SMOKE_UNUSUALS_URL]) expect(isAllowedWindowStart(url), url).toBe(true);
    for (const url of [SMOKE_CHALLENGE_URL, SMOKE_CHALLENGE_AT_HATS_URL, SMOKE_PARTIAL_HATS_URL, SMOKE_PARTIAL_AT_HATS_URL]) {
      expect(isAllowedWindowStart(url), url).toBe(false);
      expect(shouldReadUrl(url), url).toBe(true);
    }
  });

  it('reads the partial page only at the hats address (F21-4), and lets Steam sign-in stay in the window', () => {
    expect(scraptfImportablePath(SMOKE_PARTIAL_HATS_URL)).toBe(false);
    expect(scraptfImportablePath(SMOKE_CHALLENGE_URL)).toBe(false);
    expect(scraptfImportablePath(SMOKE_PARTIAL_AT_HATS_URL)).toBe(true);
    // Step 5's second challenge sits where the window would read, were it not a challenge.
    expect(scraptfImportablePath(SMOKE_CHALLENGE_AT_HATS_URL)).toBe(true);
    expect(topLevelNavigationDecision(SMOKE_STEAM_LOGIN_URL)).toBe('allow');
    expect(shouldReadUrl(SMOKE_STEAM_LOGIN_URL)).toBe(false);
  });
});

describe('smokeWindowSettings', () => {
  it("is accepted whole by main's strict settings setter: import and the window on, reading on load, not signed in", () => {
    const missing = () => {
      throw Object.assign(new Error('no settings file yet'), { code: 'ENOENT' });
    };
    const quiet = () => undefined;
    const written: string[] = [];
    const store = createSettingsStore({ file: 'settings.json', log: { debug: quiet, info: quiet, warn: quiet, error: quiet }, readFile: missing, writeFile: (_f, data) => void written.push(data) });
    const at = 1_800_000_000_000;
    store.set(smokeWindowSettings(at));
    const s = store.get();
    expect(s.import).toMatchObject({ enabled: true, acknowledgedAt: at });
    expect(s.scraptfWindow).toMatchObject({ enabled: true, acknowledgedAt: at, readOnLoad: true, keepLoggedIn: false });
    // Everything else as the defaults: the network switch is left alone.
    expect(s.networkPaused).toBe(DEFAULT_SETTINGS.networkPaused);
    expect(written.length).toBeGreaterThan(0);
  });
});

describe('smokeWindowFixtures.ts is pure', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('../../src/main/smokeWindowFixtures.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

  it('imports only the shared link and window rules', () => {
    const imports = [...SOURCE.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    expect(imports).toEqual(['../shared/links', '../shared/scraptfWindowPolicy']);
  });

  it('names no network, file, process or Electron API', () => {
    expect(SOURCE).not.toMatch(/\bfetch\b|\bnet\b|XMLHttpRequest|WebSocket|EventSource|\bhttps?\.(?:get|request)\b|\.request\s*\(|electron|node:|\bprocess\.|readFile|writeFile|\bsocket/i);
  });
});

// Step 6 of the window test reads the partial page at the hats address after a full read of /buy/hats.
// The real import, bank stock and history over an in-memory repo show that this is a partial look: prices
// stored, no bank stock save, no gone event.
describe('the partial hats page in the import (DM-2)', () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;
  const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };
  const repos: Repo[] = [];
  afterEach(() => {
    while (repos.length) repos.pop()!.close();
  });

  function importer() {
    const repo = openRepo(':memory:');
    repos.push(repo);
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      import: { enabled: true, acknowledgedAt: NOW - 60 * MIN },
      scraptfWindow: { enabled: true, acknowledgedAt: NOW - 60 * MIN },
    });
    const quiet = () => undefined;
    const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
    const clock = { now: () => NOW };
    const o = { listingId: 'l1', steamid: '76561198000000002', userName: 'KeyBot', keys: 0, metalScrap: 1e6, valueScrap: 1e6, isBot: true, online: true, lastEventAt: NOW - MIN, bumpedAt: null, details: '', flags: [], eligible: true };
    const e: MarketEval = { bestScrap: 1e6, consScrap: 1e6, instantScrap: 1e6, revenueScrap: 1e6, revenueOrder: o, bestOrder: o, buyerCount: 3, eligibleCount: 3, maxCostScrap: 1e6 - 100, confidence: 80, confidenceLevel: 'high', flags: [], lastOrderChangeAt: NOW - MIN, referenced: true };
    const stock = createBankStock({ clock, log, repo, market: { entryFor: () => e }, keyPrice: () => KEY, settings: () => settings, categoryOf: () => 'hats' });
    const history = createScraptfHistory({ clock, log, repo, market: { entryFor: () => e }, keyPrice: () => KEY });
    const ctx = {
      clock,
      log,
      repo,
      http: {},
      schema: createStubSchema(),
      engine: { keyPrice: () => KEY, markDirty: quiet } as unknown as Engine,
      settings: () => settings,
      push: quiet,
      pricesChanged: quiet,
      scraptfListChanged: quiet,
      bankStock: stock,
      scraptfHistory: history,
      bankStockChanged: () => {
        stock.refresh();
        history.refresh();
      },
    } as unknown as HandlerContext;
    const handle = createRpcHandlers(ctx);
    const windowRead = (url: string, at: number) =>
      handle('import.html', { html: get(url).body, fileName: `scrap.tf window ${new URL(url).pathname}`, mtimeMs: at, address: url, origin: 'window' }) as Promise<ImportResult>;
    return { repo, windowRead };
  }

  it('after a full read of /buy/hats, stores prices but no bank stock save and no gone event', async () => {
    const h = importer();
    const full = await h.windowRead(SMOKE_HATS_URL, NOW - 10 * MIN);
    expect(full).toMatchObject({ bank: 'hats', stockSave: 'written' });
    const onSale = h.repo.bankStockRows(full.batchId).length;
    expect(onSale).toBeGreaterThanOrEqual(PARTIAL_READ_MIN_KEYS);

    const partial = await h.windowRead(SMOKE_PARTIAL_AT_HATS_URL, NOW - 5 * MIN);
    expect(partial).toMatchObject({ bank: 'hats', stockSave: 'partial' });
    expect(partial.batchId).toBeGreaterThan(full.batchId);
    expect(partial.stored).toBeGreaterThan(0);
    const counts = new RegExp(`^${PARTIAL_READ}: (\\d+) of ~(\\d+) items on screen`).exec(partial.warnings[0] ?? '');
    expect(counts?.[1]).toBe('2');
    expect(Number(counts?.[2])).toBeGreaterThanOrEqual(PARTIAL_READ_MIN_KEYS);
    expect(h.repo.bankStockSaves('hats').map((s) => s.batchId)).toEqual([full.batchId]);
    expect(h.repo.scraptfEvents({ bank: 'hats', kinds: ['gone'] })).toEqual([]);
  });
});
