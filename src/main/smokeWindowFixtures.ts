// The window test's (--smoke-window, smokeWindow.ts) local stand-in for every site its pages ask for. Pure:
// a URL and a method in, a status, headers and a body out, built from the repo's saved-page fixtures
// (passed in as text) and a few small pages of its own. Nothing here opens a file or a connection; the
// harness hands each request of the scrap.tf window's sessions to routeSmokeRequest and answers with what
// it returns, so no request of the window ever leaves the machine. 0.7.2: also what a read of the killstreaks
// fixture must store (smokeKitProblems), pure as well, so the check itself is tested without Electron.

import { SCRAPTF_BANKS, SCRAPTF_HOME_URL } from '../shared/links';
import { isScraptfPageUrl } from '../shared/scraptfWindowPolicy';

/** The saved-page fixtures the router serves (test/fixtures/import/<name>). */
export const SMOKE_FIXTURE_FILES = Object.freeze([
  'buy_hats.html',
  'buy_weapons.html',
  'buy_stranges.html',
  'buy_killstreaks.html',
  'buy_skins.html',
  'buy_items.html',
  'unusuals.html',
  'items_list.html',
] as const);
export type SmokeFixtureName = (typeof SMOKE_FIXTURE_FILES)[number];

/** The /buy/<slug> pages with a fixture of their own. */
const BUY_SLUGS: ReadonlySet<string> = new Set(['hats', 'weapons', 'stranges', 'killstreaks', 'skins', 'items']);

function bankUrl(bank: string): string {
  const info = SCRAPTF_BANKS.find((b) => b.bank === bank);
  if (info === undefined) throw new Error(`no SCRAPTF_BANKS entry for ${bank}`);
  return info.url;
}

/** The front page: the local home page, with links to the banks and to Steam's sign-in. */
export const SMOKE_HOME_URL = SCRAPTF_HOME_URL;
export const SMOKE_HATS_URL = bankUrl('hats');
export const SMOKE_UNUSUALS_URL = bankUrl('unusuals');
/** 0.7.2: the killstreaks bank, whose fixture ends with kit cards in the real page's shape (K11-K15). */
export const SMOKE_KILLSTREAKS_URL = bankUrl('killstreaks');
/** A Cloudflare-style check: 403 with `cf-mitigated: challenge`. */
export const SMOKE_CHALLENGE_URL = new URL('/smoke/challenge', SCRAPTF_HOME_URL).href;
/**
 * The same check at the hats page's own address. /smoke/challenge is no page the import reads (F21-4), so
 * only here does "a challenge is never read" depend on the window seeing the challenge.
 */
export const SMOKE_CHALLENGE_AT_HATS_URL = `${SMOKE_HATS_URL}?smoke=challenge`;
/** The hats page with all but two cards removed, at an address of its own. */
export const SMOKE_PARTIAL_HATS_URL = new URL('/smoke/partial-hats', SCRAPTF_HOME_URL).href;
/**
 * The same partial page at the hats page's own address. The window reads only the pages the import reads
 * (scraptfImportablePath, F21-4), which /smoke/partial-hats is not; this address is, and its address hint
 * makes the read count as the /buy/hats page (the query is not part of the page key).
 */
export const SMOKE_PARTIAL_AT_HATS_URL = `${SMOKE_HATS_URL}?smoke=partial-hats`;
/** Steam's sign-in, as the window's navigation policy allows it (a local page, never Steam's). */
export const SMOKE_STEAM_LOGIN_URL = 'https://steamcommunity.com/openid/login';
/** On the local Steam page only: it must never reach a read, an import, a log or the report. */
export const SMOKE_STEAM_SENTINEL = 'FLIPDESK-SMOKE-STEAM-SENTINEL-7c41e2';
/** Where the home page's Steam link sits in the view (CSS px from its top left), so a click can land on it. */
export const SMOKE_STEAM_LINK_POINT = Object.freeze({ x: 120, y: 40 });

/**
 * What the window test sets in the profile it runs in, through main's real settings store: saved-page import
 * and the scrap.tf window on with their acknowledgements, reading on load, and the in-memory session (never a
 * sign-in kept on disk). networkPaused is left as it is.
 */
export function smokeWindowSettings(at: number) {
  return {
    import: { enabled: true, acknowledgedAt: at },
    scraptfWindow: { enabled: true, acknowledgedAt: at, readOnLoad: true, keepLoggedIn: false },
  } as const;
}

const PARTIAL_QUERY = 'partial-hats';
const CHALLENGE_QUERY = 'challenge';
/** The cards the partial page keeps (C01 and C02): two plain hats on sale. */
const PARTIAL_KEEP = 2;

export interface SmokeResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  /** '' for an empty body. */
  body: string;
}

const HTML_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
const NOT_FOUND: SmokeResponse = Object.freeze({ status: 404, headers: Object.freeze({}), body: '' });

function page(body: string, status = 200, extra: Record<string, string> = {}): SmokeResponse {
  return { status, headers: { ...HTML_HEADERS, ...extra }, body };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The local front page: the Steam link first, as a block at a fixed place, then the banks. */
export function smokeHomeHtml(): string {
  const { x, y } = SMOKE_STEAM_LINK_POINT;
  const banks = SCRAPTF_BANKS.map((b) => `<li><a href="${escapeHtml(new URL(b.url).pathname)}">${escapeHtml(b.label)}</a></li>`).join('');
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>Flip Desk window test: local home page</title></head>',
    '<body id="pid-home" style="margin:0;font-family:sans-serif">',
    // The link covers the point the harness clicks, whatever the window's size.
    `<a id="steam-sign-in" href="${SMOKE_STEAM_LOGIN_URL}" style="display:block;position:absolute;left:0;top:0;width:${x * 4}px;height:${y * 2}px;line-height:${y * 2}px;padding-left:16px;background:#171a21;color:#fff">Sign in through Steam</a>`,
    `<ul style="margin-top:${y * 2 + 16}px">${banks}</ul>`,
    '<p>Served by the Flip Desk window test; not scrap.tf.</p>',
    '</body></html>',
  ].join('');
}

/** A minimal stand-in for a Cloudflare check page (no frame, no script). */
export function smokeChallengeHtml(): string {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>Just a moment...</title></head><body id="challenge-body"><h1>Checking your browser</h1><p>Flip Desk window test: a local stand-in for a challenge page.</p></body></html>';
}

/** The local stand-in for Steam's sign-in page; the sentinel marks anything that leaks from it. */
export function smokeSteamHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>Sign In (local test page)</title></head><body><h1>Sign in</h1><p id="sentinel">${SMOKE_STEAM_SENTINEL}</p></body></html>`;
}

/** One card of a bank fixture: its `<!-- Cnn: … -->` comment and the card's own div, whose `</div>` starts a line. */
const CARD_BLOCK = /<!-- C(\d+):[^\n]*-->\r?\n<div\r?\n[\s\S]*?\r?\n<\/div>\r?\n/g;

/** The hats fixture with every numbered card after the first PARTIAL_KEEP removed (a look caught while cards still arrive). */
export function partialHatsHtml(full: string): string {
  return full.replace(CARD_BLOCK, (block, n: string) => (Number(n) <= PARTIAL_KEEP ? block : ''));
}

// ---------------------------------------------------------------------------
// 0.7.2: the kits of buy_killstreaks.html, as a read of the page must store them
// ---------------------------------------------------------------------------

/** K11 and K12: one Professional Rocket Launcher Kit, keyed by its weapon (205) and Non-Craftable. */
export const SMOKE_KIT_ROCKET_LAUNCHER = '6526;6;uncraftable;kt-3;td-205';
/** The fixture's kits by weapon: K11 and K12, K13 (a Specialized Scattergun Kit), K14 (a Killstreak Shotgun Kit). */
export const SMOKE_KIT_SKUS = Object.freeze([SMOKE_KIT_ROCKET_LAUNCHER, '6523;6;uncraftable;kt-2;td-200', '6527;6;uncraftable;kt-1;td-199'] as const);
/** K11's and K12's sheen/killstreaker: Team Shine and Hypno-Beam, Mean Green and Cerebral Discharge. */
const ROCKET_LAUNCHER_COPIES = Object.freeze(['1/2008', '4/2003']);
/** K15's title: it names no weapon, so the import skips it (needs-target) rather than store the bare kit. */
export const SMOKE_WEAPONLESS_KIT_TITLE = 'Professional Kit';

/** A stored price as 'prices.list' returns it: the fields the kit check reads. */
export interface SmokeKitPrice {
  sku: string;
  importBatch: number | null;
  special: { sheen: number | null; killstreaker: number | null } | null;
}

/** A card of a read's parser report ('import.report' items: the refused ones, and stored ones with a guess). */
export interface SmokeKitCard {
  title: string | null;
  sku: string | null;
  warnings: readonly string[];
}

/** A kit stored without its weapon: a kit defindex (6523, 6526, 6527) with no target, "6526;6" say. */
export function isBareKitSku(sku: string): boolean {
  return /^652[367](?:;|$)/.test(sku) && !/;td-\d+(?:;|$)/.test(sku);
}

/**
 * What is wrong with what a read of the killstreaks fixture stored ([] when nothing): `batchId` the read's
 * import batch, `prices` every stored price, `stockSkus` the SKU of every bank stock row, `cards` the read's
 * parser report (null: none). The read must store each kit by its weapon and both Rocket Launcher Kit copies
 * (the sheen and killstreaker set them apart), store no bare kit anywhere, and skip K15 with needs-target.
 */
export function smokeKitProblems(batchId: number, prices: readonly SmokeKitPrice[], stockSkus: readonly string[], cards: readonly SmokeKitCard[] | null): string[] {
  const out: string[] = [];
  const read = prices.filter((p) => p.importBatch === batchId);
  const missing = SMOKE_KIT_SKUS.filter((sku) => !read.some((p) => p.sku === sku));
  if (missing.length > 0) out.push(`the read stored no price of ${missing.join(', ')}`);
  const copies = read
    .filter((p) => p.sku === SMOKE_KIT_ROCKET_LAUNCHER)
    .map((p) => `${p.special?.sheen ?? '-'}/${p.special?.killstreaker ?? '-'}`)
    .sort();
  if (copies.join(',') !== ROCKET_LAUNCHER_COPIES.join(',')) {
    out.push(`the read stored ${copies.length} copies of ${SMOKE_KIT_ROCKET_LAUNCHER} (sheen/killstreaker ${copies.join(', ') || 'none'}), not ${ROCKET_LAUNCHER_COPIES.join(' and ')}`);
  }
  const stockCopies = stockSkus.filter((sku) => sku === SMOKE_KIT_ROCKET_LAUNCHER).length;
  if (stockCopies !== ROCKET_LAUNCHER_COPIES.length) out.push(`the bank stock lists ${stockCopies} copies of ${SMOKE_KIT_ROCKET_LAUNCHER}, not ${ROCKET_LAUNCHER_COPIES.length}`);
  const barePrices = [...new Set(prices.map((p) => p.sku).filter(isBareKitSku))];
  if (barePrices.length > 0) out.push(`kits stored without their weapon: ${barePrices.join(', ')}`);
  const bareStock = [...new Set(stockSkus.filter(isBareKitSku))];
  if (bareStock.length > 0) out.push(`the bank stock lists kits without their weapon: ${bareStock.join(', ')}`);
  if (cards === null) out.push('no parser report of the read');
  else {
    const k15 = cards.find((c) => c.title === SMOKE_WEAPONLESS_KIT_TITLE);
    if (k15 === undefined) out.push(`'${SMOKE_WEAPONLESS_KIT_TITLE}' is not in the read's parser report`);
    else if (k15.sku !== null) out.push(`'${SMOKE_WEAPONLESS_KIT_TITLE}' was keyed ${k15.sku}, not skipped`);
    else if (!k15.warnings.some((w) => /^needs-target(?::|$)/.test(w))) out.push(`'${SMOKE_WEAPONLESS_KIT_TITLE}' was skipped without needs-target (${k15.warnings.join('; ') || 'no warning'})`);
  }
  return out;
}

/** The path without trailing slashes ('/' stays). */
function trimmedPath(u: URL): string {
  return u.pathname.replace(/\/+$/, '') || '/';
}

/**
 * The answer to one request of the scrap.tf window's sessions. GET only; scrap.tf pages over https as
 * isScraptfPageUrl takes them (exact host, no port, no userinfo): `/`, `/buy/<slug>` for the six fixture
 * banks (`/buy/hats?smoke=partial-hats` and `?smoke=challenge` the two test pages at the hats address),
 * `/unusuals` and `/unusuals/<n>`, `/items`, `/smoke/challenge` and `/smoke/partial-hats`; Steam's
 * `/openid/login`; anything else (other hosts and paths, http, a bad URL, a missing fixture) a 404 with
 * no body.
 */
export function routeSmokeRequest(url: string, method: string, fixture: (name: SmokeFixtureName) => string | null): SmokeResponse {
  if (method.toUpperCase() !== 'GET') return NOT_FOUND;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return NOT_FOUND;
  }
  const from = (name: SmokeFixtureName, edit: (html: string) => string = (h) => h): SmokeResponse => {
    const html = fixture(name);
    return html === null ? NOT_FOUND : page(edit(html));
  };
  if (isScraptfPageUrl(url)) {
    const p = trimmedPath(u);
    const challenge = () => page(smokeChallengeHtml(), 403, { 'cf-mitigated': 'challenge' });
    if (p === '/') return page(smokeHomeHtml());
    if (p === '/smoke/challenge') return challenge();
    if (p === '/smoke/partial-hats') return from('buy_hats.html', partialHatsHtml);
    if (p === '/unusuals' || /^\/unusuals\/\d+$/.test(p)) return from('unusuals.html');
    if (p === '/items') return from('items_list.html');
    const slug = /^\/buy\/([a-z]+)$/.exec(p)?.[1];
    if (slug !== undefined && BUY_SLUGS.has(slug)) {
      if (slug === 'hats' && u.searchParams.get('smoke') === PARTIAL_QUERY) return from('buy_hats.html', partialHatsHtml);
      if (slug === 'hats' && u.searchParams.get('smoke') === CHALLENGE_QUERY) return challenge();
      return from(`buy_${slug}.html` as SmokeFixtureName);
    }
    return NOT_FOUND;
  }
  if (u.protocol === 'https:' && u.hostname === 'steamcommunity.com' && u.port === '' && u.username === '' && u.password === '' && trimmedPath(u) === '/openid/login') {
    return page(smokeSteamHtml());
  }
  return NOT_FOUND;
}
