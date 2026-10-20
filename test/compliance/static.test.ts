// DESIGN_BRIEF Appendix B #2 and #3 as a static scan of src/: every network
// call goes through src/service/net (or one of the two policy-checked socket
// connectors), no browser User-Agent, no proxy plumbing, no backpack.tf
// /agent/ or listing-write calls, and scrap.tf URLs appear only where the user
// is shown or sent a link (R1), or (F21) in the user's own opt-in scrap.tf window,
// whose module is held to the F21 block at the end. The runtime side is covered in test/net.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkUrl } from '../../src/service/net/policy';
import { READ_SCRIPT, READ_WORLD_ID, readScriptProblems } from '../../src/shared/scraptfWindowPolicy';
// 0.7.3: the source helpers and the dashboard's window scans live in a module the audit tests import too.
import {
  blockEnd,
  callArgs,
  DEFERRED_CALL,
  deferredSpans,
  deferredWindowCalls,
  deferredWindowOpens,
  deferredWindowWrappers,
  enclosing,
  functionSpans,
  lineAt,
  sourceFile,
  walk,
  windowWrappers,
  type SourceFile,
  type Span,
} from './windowWrapperScan';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

const FILES: SourceFile[] = walk(SRC).map((f) => sourceFile(path.relative(SRC, f).split(path.sep).join('/'), readFileSync(f, 'utf8')));

/** `file:line: text` for every match of `re` outside the allowed files (of `files`, else the source tree). */
function offenders(re: RegExp, allowed: (rel: string) => boolean = () => false, files: readonly SourceFile[] = FILES): string[] {
  const out: string[] = [];
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  for (const f of files) {
    if (allowed(f.rel)) continue;
    for (const m of f.code.matchAll(new RegExp(re.source, flags))) {
      const line = f.code.slice(0, m.index).split('\n').length;
      out.push(`${f.rel}:${line}: ${m[0]}`);
    }
  }
  return out;
}

/** A CSS url() or @import naming scrap.tf (any scheme, protocol-relative included). */
const CSS_SCRAPTF_LOAD = /url\(\s*['"]?[^)]*scrap\.tf|@import\s+(?:url\()?\s*['"]?[^;]*scrap\.tf/i;

/**
 * The scrap.tf/items address handed to something that loads it in the dashboard: assigned to a src, href
 * or location (JSX attribute, object key or assignment, bare or in a template literal), or passed to
 * window.open / location.assign / location.replace. Only links.open (the user's browser) may take it.
 */
const ITEMS_URL_LOAD =
  /\b(?:src|href|location(?:\.href)?)\s*[=:]\s*\{?\s*(?:`\$\{\s*)?SCRAPTF_ITEMS_URL|\b(?:window\.open|location\.(?:assign|replace))\s*\(\s*(?:`\$\{\s*)?SCRAPTF_ITEMS_URL/;

/** Dashboard lines that load the scrap.tf/items address instead of handing it to links.open. */
function itemsUrlLoads(files: readonly SourceFile[] = FILES): string[] {
  return offenders(ITEMS_URL_LOAD, (r) => !r.startsWith('renderer/'), files);
}

/**
 * Anything that can carry a scrap.tf address: a literal, the link constants and helpers in
 * shared/links.ts (F15's SCRAPTF_BANKS, scraptfBankInfo and ItemDetail.seenOn included), and the
 * fields the service and the dashboard keep them in.
 */
const SCRAPTF_REF =
  /scrap\.tf|SCRAPTF_\w*(URL|PAGES|BANKS?)|scraptfPageFor|scraptfOpenUrl|scraptfBankInfo|scraptfSeenOn|seenOn|bankPageUrl|STATIC_EXTERNAL_URLS|allItems/i;
/**
 * Everything that loads a URL: fetch and its injected stand-in, the policy-checked HttpClient,
 * websocket and socket.io factories, and Electron windows and views. 0.7.3: and a download or a page save
 * (a webContents' or a session's downloadURL, a webContents' savePage).
 */
const LOADERS =
  /(?<![\w$.])(?:fetch|fetchImpl|io|socketFactory|wsFactory|factory)\s*\(|\.(?:request|fetch|loadURL|loadFile|openDevTools|preconnect|resolveHost|downloadURL|savePage)\s*\(|\bnew\s+(?:WebSocket|EventSource|Worker|SharedWorker|BrowserWindow|BrowserView|WebContentsView)\s*\(/g;
/** An <img src> (or any src) built from a scrap.tf address. */
const SCRAPTF_IMG_SRC = /\bsrc\s*=\s*\{?[^>}\n]*(scrap\.tf|SCRAPTF_|scraptfPageFor|scraptfBankInfo|seenOn|bankPageUrl)/i;

/**
 * F21: the one module that may show scrap.tf, in the user's own scrap.tf window. It may hand a scrap.tf page
 * to its window and its view (loadURL, the constructors) and to nothing else: fetch, the HTTP client and
 * every socket factory stay forbidden there too.
 */
const SCRAPTF_WINDOW = 'main/scraptfWindow.ts';
const WINDOW_LOADER = /^(?:\.loadURL\s*\(|new\s+(?:BrowserWindow|WebContentsView)\s*\()$/;

/** `file:line: call(args)` for every loader call whose arguments carry a scrap.tf address (R1; F21's window aside). */
function scraptfLoads(files: readonly SourceFile[] = FILES): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const m of f.code.matchAll(LOADERS)) {
      if (f.rel === SCRAPTF_WINDOW && WINDOW_LOADER.test(m[0])) continue;
      const args = callArgs(f.code, m.index + m[0].length - 1);
      if (SCRAPTF_REF.test(args)) hits.push(`${f.rel}:${f.code.slice(0, m.index).split('\n').length}: ${m[0]}${args.slice(0, 120)}`);
    }
  }
  return hits;
}

const BPTF_SOCKET = 'service/connectors/bptfSocket.ts';
const PRICEDB = 'service/connectors/pricedb.ts';
const HTTP = 'service/net/http.ts';
const INSTANCE_LOCK = 'main/instanceLock.ts';

describe('static compliance scan of src/', () => {
  it('finds the source tree', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel === HTTP)).toBe(true);
  });

  it('makes HTTP requests only in src/service/net (fetch, XHR, Node and Electron clients)', () => {
    expect(offenders(/(?<![\w$])fetch\s*\(/, (r) => r === HTTP)).toEqual([]);
    expect(offenders(/\bXMLHttpRequest\b|\bsendBeacon\s*\(|\bnew\s+EventSource\s*\(/)).toEqual([]);
    expect(offenders(/\bhttps\.(request|get)\s*\(|\bhttp\.get\s*\(/)).toEqual([]);
    // `http.request(...)` is the policy-checked HttpClient everywhere; Node's http/https modules are never imported.
    expect(offenders(/from\s+['"](node:)?(http|https|http2|tls|dgram)['"]|require\(\s*['"](node:)?(http|https|http2|tls|dgram)['"]\s*\)/)).toEqual([]);
    // node:net only for the machine-wide single-instance lock: a local named pipe that listens and never connects.
    expect(offenders(/from\s+['"](node:)?net['"]|require\(\s*['"](node:)?net['"]\s*\)/, (r) => r === INSTANCE_LOCK)).toEqual([]);
    const lock = FILES.find((f) => f.rel === INSTANCE_LOCK)!.code;
    expect(lock).toMatch(/\.listen\(/);
    expect(lock).not.toMatch(/\b(connect|createConnection|Socket)\s*\(|new\s+net\.Socket/);
    expect(offenders(/from\s+['"](undici|axios|node-fetch|got|request|superagent|cross-fetch)['"]/)).toEqual([]);
    // Electron's net module and session-level fetch are not used either.
    expect(offenders(/\bnet\.(request|fetch)\s*\(|\.fetch\s*\(\s*['"`]https?:/)).toEqual([]);
  });

  it('opens websockets only in the two socket connectors, after a policy check', () => {
    expect(offenders(/\bnew\s+WebSocket\s*\(/, (r) => r === BPTF_SOCKET)).toEqual([]);
    expect(offenders(/from\s+['"]ws['"]/, (r) => r === BPTF_SOCKET)).toEqual([]);
    expect(offenders(/from\s+['"]socket\.io-client['"]/, (r) => r === PRICEDB)).toEqual([]);
    expect(offenders(/(?<![\w$.])io\s*\(/, (r) => r === PRICEDB)).toEqual([]);

    const bptf = FILES.find((f) => f.rel === BPTF_SOCKET)!.code;
    const assertAt = bptf.indexOf("assertAllowed(BPTF_WS_URL, 'ws')");
    expect(assertAt).toBeGreaterThan(-1);
    expect(bptf.indexOf('socket = factory(BPTF_WS_URL')).toBeGreaterThan(assertAt);

    const pdb = FILES.find((f) => f.rel === PRICEDB)!.code;
    const pdbAssert = pdb.indexOf("assertAllowed(PRICEDB_SOCKET_POLICY_URL, 'ws')");
    expect(pdbAssert).toBeGreaterThan(-1);
    expect(pdb.indexOf('s = socketFactory(PRICEDB_SOCKET_URL')).toBeGreaterThan(pdbAssert);
  });

  it('never sets a browser-like or hard-coded User-Agent (Appendix B #2)', () => {
    expect(offenders(/mozilla\/\d/i)).toEqual([]);
    expect(offenders(/['"]?user-agent['"]?\s*:\s*['"`]/i)).toEqual([]);
    expect(offenders(UA_SETTERS)).toEqual([]);
  });

  it('has no proxy option plumbing (Appendix B #2, R5)', () => {
    expect(offenders(/\bproxy\w*\s*[:=](?!=)/i)).toEqual([]);
    expect(offenders(/\bsetProxy\s*\(|ProxyAgent|--proxy-server|\bHTTPS?_PROXY\b|\bproxy-bypass/i)).toEqual([]);
  });

  it('never calls backpack.tf /agent/, listing writes or _-prefixed paths (Appendix B #3)', () => {
    expect(offenders(/\/agent\b/i, (r) => r === 'service/net/policy.ts')).toEqual([]);
    expect(offenders(/\/v2\/classifieds/i, (r) => r === 'service/net/policy.ts')).toEqual([]);
    expect(offenders(/https?:\/\/[^'"`\s]*\/_/)).toEqual([]);
    // The only write-method request is PriceDB's read-only bulk lookup (POST /api/items-bulk).
    // renderer/mock*.ts only holds fake request-log rows for the browser preview; the renderer has no network.
    const fakeData = (r: string) => r === 'renderer/mock.ts' || r === 'renderer/mockData.ts';
    expect(offenders(/method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, (r) => r === PRICEDB || fakeData(r))).toEqual([]);
    const pdb = FILES.find((f) => f.rel === PRICEDB)!.code;
    const posts = [...pdb.matchAll(/method\s*:\s*['"]POST['"]/g)];
    expect(posts).toHaveLength(1);
    expect(pdb.slice(Math.max(0, posts[0]!.index - 200), posts[0]!.index)).toContain('/items-bulk');
  });

  it('uses scrap.tf URLs only as links for the user, never as something the app fetches (R1)', () => {
    const allowed = (r: string) =>
      r === 'shared/links.ts' || r === 'service/net/policy.ts' || r.startsWith('service/import/') || r.startsWith('renderer/');
    expect(offenders(/\b(https?|wss?):\/\/([a-z0-9-]+\.)*scrap\.tf\b/i, allowed)).toEqual([]);
    expect(offenders(/['"`]\/\/([a-z0-9-]+\.)*scrap\.tf\b/i, allowed)).toEqual([]);
    // The service never builds a scrap.tf URL from parts either.
    expect(offenders(/['"`]scrap\.tf\/|\+\s*['"`]scrap\.tf/i, allowed)).toEqual([]);
  });

  // F14 links the whole scrap.tf/items list to the app, still without one request (R1, R10): the user's
  // browser opens the page (links.open -> shell.openExternal) and the user saves it into the watch folder.
  it('never passes a scrap.tf address to fetch, an HTTP client, a websocket or a window (R1)', () => {
    expect(scraptfLoads()).toEqual([]);
    // 0.7.3: savePage saves whatever page a webContents shows and re-requests it (HTML only) or its resources
    // (complete) from the cache or the network. It takes a path and a type, never an address, so the argument
    // scan cannot see a scrap.tf target, and main sees the scrap.tf view ('web-contents-created'). The app saves
    // no page; the user does, with Ctrl+S in their own browser (R1, R10). Nor does it download anything itself:
    // downloadURL is a request outside src/service/net.
    expect(offenders(/\.\s*(?:savePage|downloadURL)\s*\(/)).toEqual([]);
  });

  it('embeds no web content and loads no image from scrap.tf (no webview, iframe or view, F21 window aside; R3)', () => {
    expect(offenders(/<\s*(iframe|webview|embed|object|frame)\b/i)).toEqual([]);
    expect(offenders(/\bBrowserView\b|webviewTag\s*:\s*true/)).toEqual([]);
    // F21: the user's own scrap.tf window is the one view, in its own module (its rules: the F21 block below).
    expect(offenders(/\bWebContentsView\b/, (r) => r === SCRAPTF_WINDOW)).toEqual([]);
    // An <img src>, or a CSS url() or @import (style sheets included), pointing at scrap.tf would be a
    // request from the dashboard.
    expect(offenders(SCRAPTF_IMG_SRC)).toEqual([]);
    expect(FILES.some((f) => f.rel === 'renderer/styles/scraptf-list.css')).toBe(true);
    expect(offenders(CSS_SCRAPTF_LOAD)).toEqual([]);
    const paths = FILES.find((f) => f.rel === 'main/paths.ts')!.code;
    const hosts = paths.slice(paths.indexOf('RENDERER_IMAGE_HOSTS'), paths.indexOf('];', paths.indexOf('RENDERER_IMAGE_HOSTS')));
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts).not.toMatch(/scrap\.tf/i);
  });

  it('hands the scrap.tf/items address only to links.open, through the shared constant (F14)', () => {
    // The address lives in shared/links.ts alone (the parser only recognises a saved copy of it);
    // UI copy may name "scrap.tf/items", but no dashboard file writes the URL itself.
    expect(offenders(/\/\/([a-z0-9-]+\.)*scrap\.tf\/items\b/i, (r) => r === 'shared/links.ts' || r.startsWith('service/import/'))).toEqual([]);
    // Every dashboard use of the constant is a link for the user: opened through openOrCopy/openLink
    // (links.open), shown as a title, or compared with; never assigned to a src, href or location.
    expect(offenders(/SCRAPTF_ITEMS_URL/, (r) => !r.startsWith('renderer/')).length).toBeGreaterThan(0);
    expect(itemsUrlLoads()).toEqual([]);
  });
});

// The scans above pass on a clean tree whether or not they can see anything, so each F14 guard is
// also run on files that break it, and on the patterns the dashboard really uses.
describe('the F14 scans catch what they claim to', () => {
  it('flags the scrap.tf/items address assigned to a src, href or location, or opened outside links.open', () => {
    const bad = [
      'export const A = () => <a href={SCRAPTF_ITEMS_URL}>list</a>;',
      'window.location.href = SCRAPTF_ITEMS_URL;',
      'const img = { src: SCRAPTF_ITEMS_URL };',
      'const B = () => <iframe src={`${SCRAPTF_ITEMS_URL}?x=1`} />;',
      'window.open(SCRAPTF_ITEMS_URL);',
      'location.assign(SCRAPTF_ITEMS_URL);',
    ].join('\n');
    const hits = itemsUrlLoads([sourceFile('renderer/Bad.tsx', bad)]);
    expect(hits.map((h) => h.split(':')[1])).toEqual(['1', '2', '3', '4', '5', '6']);
    // Outside the dashboard the constant is not looked for here (the R1 scans above cover the service).
    expect(itemsUrlLoads([sourceFile('service/Bad.ts', bad)])).toEqual([]);

    const good = [
      'onOpenList={() => void openOrCopy(SCRAPTF_ITEMS_URL, toast)}',
      'title={`${SCRAPTF_ITEMS_URL}: open it in your browser`}',
      'const c = coverageChip({ label, url: SCRAPTF_ITEMS_URL, lastSavedAt, items });',
      'const stfUrl = scraptfOpenUrl(d.category, null) ?? SCRAPTF_ITEMS_URL;',
      'if (links === null) return SCRAPTF_ITEMS_URL;',
    ].join('\n');
    expect(itemsUrlLoads([sourceFile('renderer/Good.tsx', good)])).toEqual([]);
  });

  it('reads style sheets, and sees a scrap.tf url() or @import in one, protocol-relative included', () => {
    expect(FILES.filter((f) => f.rel.startsWith('renderer/styles/') && f.rel.endsWith('.css')).length).toBeGreaterThan(5);
    const css = (src: string) => offenders(CSS_SCRAPTF_LOAD, () => false, [sourceFile('renderer/styles/bad.css', src)]);
    expect(css('.x { background: url(//scrap.tf/img/a.png); }')).toHaveLength(1);
    expect(css(".x {\n  background-image: url('https://scrap.tf/img/a.png');\n}")).toEqual(['renderer/styles/bad.css:2: url(\'https://scrap.tf']);
    expect(css("@import 'https://scrap.tf/style.css';")).toHaveLength(1);
    expect(css('@import url(//scrap.tf/style.css);')).toHaveLength(1);
    // A commented-out rule is not a request; the app's own url()s are not scrap.tf.
    expect(css('/* .x { background: url(//scrap.tf/a.png); } */ .y { mask: url("data:image/svg+xml,%3Csvg/%3E"); }')).toEqual([]);
  });
});

// F15 hands every bank page (SCRAPTF_BANKS, scraptfBankInfo, ItemDetail.seenOn) to the user's browser;
// the R1 scans must see those references too.
describe('the F15 scans catch what they claim to', () => {
  it('flags a bank address passed to a loader or used as an image source', () => {
    const bad = [
      'void fetch(SCRAPTF_BANKS[0].url);',
      'await http.request({ url: scraptfBankInfo(bank)!.url, budget: "x" });',
      'win.loadURL(detail.seenOn.url);',
      'const w = new BrowserWindow({ url: SCRAPTF_BANK_PAGES[1].url });',
      // 0.7.3: a download is a request too.
      'contents.downloadURL(SCRAPTF_ITEMS_URL);',
      'session.defaultSession.downloadURL(SCRAPTF_BANKS[0].url);',
    ].join('\n');
    expect(scraptfLoads([sourceFile('service/Bad.ts', bad)]).map((h) => h.split(':')[1])).toEqual(['1', '2', '3', '4', '5', '6']);
    const img = offenders(SCRAPTF_IMG_SRC, () => false, [sourceFile('renderer/Bad.tsx', 'const A = () => <img src={d.seenOn!.url} />;')]);
    expect(img).toHaveLength(1);

    // What the banks page and the drawer really do: hand the URL to links.open.
    const good = [
      'onClick={() => void openOrCopy(bank.url, toast)}',
      "const url = d.seenOn?.url ?? scraptfBankInfo(bankForCategory(d.category))!.url;",
      'await rpc("links.open", { url: SCRAPTF_BANKS[0].url });',
    ].join('\n');
    expect(scraptfLoads([sourceFile('renderer/Good.tsx', good)])).toEqual([]);
  });
});

// F18 reads .mhtml saves too. A saved file is untrusted input that names addresses of its own (the
// parts' Content-Location, Snapshot-Content-Location, image and style sheet URLs): the readers must be
// pure, and the address they pass on (a bank-detection hint) must never reach anything that loads.
const SAVED_PAGE_READERS = ['service/import/mhtml.ts', 'service/import/savedPage.ts', 'service/import/scraptfHtml.ts'];
/** What a saved-page reader may import: the HTML parser, zod, shared rules, service types and the schema names, each other. */
const READER_IMPORT = /^(parse5|zod|\.\.\/\.\.\/shared\/[\w/]+|\.\.\/contracts|\.\.\/connectors\/schemaNames|\.\/(mhtml|savedPage|scraptfHtml))$/;
/** The MHTML address hint, by any of the names it travels under. */
const MHTML_ADDRESS = /contentLocation|Content-Location|snapshotLocation|Snapshot-Content-Location/i;

/** `file:line: specifier` for every import or require in `files` that READER_IMPORT does not allow. */
function readerImports(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const m of f.code.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      if (!READER_IMPORT.test(spec)) out.push(`${f.rel}:${f.code.slice(0, m.index).split('\n').length}: ${spec}`);
    }
  }
  return out;
}

/** `file:line: call(args)` for every loader call whose arguments carry the MHTML address hint. */
function mhtmlAddressLoads(files: readonly SourceFile[] = FILES): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const m of f.code.matchAll(LOADERS)) {
      const args = callArgs(f.code, m.index + m[0].length - 1);
      if (MHTML_ADDRESS.test(args)) hits.push(`${f.rel}:${f.code.slice(0, m.index).split('\n').length}: ${m[0]}${args.slice(0, 120)}`);
    }
  }
  return hits;
}

describe('saved pages, .mhtml included, are read and never followed (F18, R1, R10)', () => {
  const readers = () => SAVED_PAGE_READERS.map((rel) => FILES.find((f) => f.rel === rel)!);

  it('keeps the saved-page readers pure: no file, network, process or Electron access, no code execution', () => {
    expect(readers().every((f) => f !== undefined)).toBe(true);
    expect(readerImports(readers())).toEqual([]);
    const pure = (rel: string) => !SAVED_PAGE_READERS.includes(rel);
    expect(offenders(/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]|\bprocess\.(env|binding|dlopen)\b|\bWebAssembly\b/, pure)).toEqual([]);
    expect(offenders(LOADERS, pure)).toEqual([]);
  });

  it('never lets the address inside an .mhtml leave the import, or reach a loader', () => {
    // The hint is parsed by pageKindFromUrl and nothing else: no other part of src/ even names it.
    expect(offenders(MHTML_ADDRESS, (r) => r.startsWith('service/import/'))).toEqual([]);
    expect(mhtmlAddressLoads()).toEqual([]);
  });

  it('catches what it claims to', () => {
    const bad = [
      "import { readFileSync } from 'node:fs';",
      "import { createHttpClient } from '../net/http';",
      "const e = require('electron');",
      "import { parse } from 'parse5';",
      "import { z } from 'zod';",
      "import { parsePrice } from '../../shared/currency';",
    ].join('\n');
    expect(readerImports([sourceFile('service/import/mhtml.ts', bad)]).map((h) => h.split(': ')[1])).toEqual(['node:fs', '../net/http', 'electron']);
    const loads = [
      'void fetch(r.contentLocation);',
      'await http.request({ url: part.contentLocation ?? "", budget: "x" });',
      "win.loadURL(headers.get('content-location')!);",
      'const ok = pageKindFromUrl(r.contentLocation);',
    ].join('\n');
    expect(mhtmlAddressLoads([sourceFile('service/import/Bad.ts', loads)]).map((h) => h.split(':')[1])).toEqual(['1', '2', '3']);
  });
});

// F19 links the Live market to scrap.tf: the row's scrap.tf button and the one-bank header, the item drawer
// and the row menu hand an item's scrap.tf page to the user's browser (openOnScraptf / openOrCopy ->
// links.open). Each URL must be a static SCRAPTF_BANKS / STATIC_EXTERNAL_URLS page, traced back to one of
// the helpers below: never a URL a row or a detail carries (MarketRow.scraptfLink.url, seenOn.url), and
// never one built from item data. Main's allowlist refuses anything else; this keeps the dashboard from trying.

/** The dashboard files that open an item's scrap.tf page. */
const SCRAPTF_OPEN_FILES = ['renderer/pages/MarketPage.tsx', 'renderer/pages/ItemDrawer.tsx', 'renderer/components/ItemMenu.tsx', 'renderer/itemMenuModel.ts', 'renderer/marketModel.ts'];
/** The helpers whose result is a static page (each reads SCRAPTF_BANKS or a STATIC_EXTERNAL_URLS constant), by file. */
const STATIC_PAGE_HELPERS: Readonly<Record<string, readonly string[]>> = {
  'renderer/marketModel.ts': ['marketScraptfButton', 'marketBankLink', 'marketSingleBank', 'rowBank'],
  'renderer/itemMenuModel.ts': ['scraptfOpenUrl', 'seenBankPageUrl', 'bankPageUrl'],
  'shared/links.ts': ['scraptfLinkFor', 'scraptfBankInfo', 'scraptfPageFor'],
};
/** A call of a helper that returns a static page (or an object holding one in `url`). */
const STATIC_PAGE_CALL = /^(marketScraptfButton|marketBankLink|scraptfOpenUrl|seenBankPageUrl|bankPageUrl|scraptfBankInfo|scraptfPageFor)\s*\(/;
/** An expression that may name a scrap.tf page: a URL, the link constants and helpers, or a variable holding one. */
const LOOKS_SCRAPTF = /scrap\.tf|scraptf|SCRAPTF_|seenOn|bankPage|bankLink|stfUrl/i;
/** Ways to build a URL rather than take one: a template with "//" or around a url, concatenation, URL APIs. */
const URL_BUILDING = [
  /`[^`]*\/\/[^`]*`/,
  /`[^`]*\$\{[^}`]*\burl\b[^}`]*\}[^`]*`/i,
  /['"`][^'"`\n]*(?:scrap\.tf\/|:\/\/)[^'"`\n]*['"`]\s*\+|\+\s*['"`][^'"`\n]*(?:scrap\.tf|:\/\/)/,
  /\bnew\s+URL\s*\(|\bURLSearchParams\b|\bsearchParams\b|\bencodeURI(?:Component)?\s*\(/,
];

/** The text from `start` to the end of its expression: a `;` or `,`, a closing bracket, or a line end, outside brackets and quotes. */
function expressionAt(code: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  const end = Math.min(code.length, start + 2000);
  for (let i = start; i < end; i++) {
    const c = code[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return code.slice(start, i);
      depth--;
    } else if (depth === 0 && (c === ';' || c === ',')) return code.slice(start, i);
    // A line end ends it unless the next line goes on with an operator (prettier's `?? X` on its own line).
    else if (depth === 0 && c === '\n' && !/^\s*(\?\?|\|\||&&|[?:.+])/.test(code.slice(i + 1, i + 40))) return code.slice(start, i);
  }
  return code.slice(start, end);
}

/** The parts of an expression joined by a top-level `??` or `||`. */
function alternatives(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (expr.startsWith('??', i) || expr.startsWith('||', i))) {
      out.push(expr.slice(from, i));
      from = i + 2;
      i++;
    }
  }
  out.push(expr.slice(from));
  return out.map((s) => s.trim());
}

/** SCRAPTF_ITEMS_URL, or a whole call of a static-page helper, then at most `.url`. */
function isStaticPage(expr: string): boolean {
  const e = expr.trim();
  if (e === 'SCRAPTF_ITEMS_URL') return true;
  const m = STATIC_PAGE_CALL.exec(e);
  if (!m) return false;
  const open = e.indexOf('(', m[1]!.length);
  const rest = e.slice(open + callArgs(e, open).length + 2).trim();
  return /^(?:[!?]?\.url|!)?$/.test(rest);
}

interface UrlTrace {
  ok: boolean;
  /** What the URL was traced to (the failing part when not ok). */
  via: string;
}

/**
 * Where a URL argument comes from: a static page, followed back through `const x = …` (and `x.url` of
 * one) in its file, or the row menu's action parameter, whose scrap.tf URLs itemMenuModel.ts sets.
 */
function traceUrl(code: string, expr: string, at: number, depth = 0): UrlTrace {
  const e = expr.trim();
  const alts = alternatives(e);
  if (alts.length > 1) {
    const bad = alts.map((a) => traceUrl(code, a, at, depth)).find((t) => !t.ok);
    return bad ?? { ok: true, via: e };
  }
  if (isStaticPage(e)) return { ok: true, via: e };
  const m = /^([A-Za-z_$][\w$]*)(?:\s*[!?]?\.url)?$/.exec(e);
  if (!m || depth > 4) return { ok: false, via: e };
  const id = m[1]!;
  const decl = [...code.slice(0, at).matchAll(new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=;\\n]+)?=(?![=>])\\s*`, 'g'))].at(-1);
  if (decl) {
    const start = decl.index + decl[0].length;
    return traceUrl(code, expressionAt(code, start), start, depth + 1);
  }
  if (new RegExp(`\\(\\s*${id}\\s*:\\s*ItemMenuAction\\b`).test(code.slice(0, at))) return { ok: true, via: 'ItemMenuAction' };
  return { ok: false, via: e };
}

interface UrlOpen {
  at: string;
  url: string;
  trace: UrlTrace;
}

/** Every call of `fns` (not its definition) in `files`, with its URL (first) argument traced. */
function urlOpens(files: readonly SourceFile[], fns: string): UrlOpen[] {
  const out: UrlOpen[] = [];
  for (const f of files) {
    for (const m of f.code.matchAll(new RegExp(`(?<![\\w$.])(?:${fns})\\s*\\(`, 'g'))) {
      if (/function\s+$/.test(f.code.slice(Math.max(0, m.index - 12), m.index))) continue;
      const open = m.index + m[0].length - 1;
      const url = expressionAt(callArgs(f.code, open), 0).trim();
      out.push({ at: `${f.rel}:${f.code.slice(0, m.index).split('\n').length}`, url, trace: traceUrl(f.code, url, m.index) });
    }
  }
  return out;
}

/** `file:line: url` for every scrap.tf open that is not a static page. */
function nonStaticScraptfOpens(files: readonly SourceFile[]): string[] {
  const scraptf = urlOpens(files, 'openOnScraptf');
  const generic = urlOpens(files, 'openOrCopy|openLink').filter((o) => LOOKS_SCRAPTF.test(o.url) || LOOKS_SCRAPTF.test(o.trace.via));
  return [...scraptf, ...generic].filter((o) => !o.trace.ok).map((o) => `${o.at}: ${o.url}`);
}

/** The menu's scrap.tf actions (`kind: 'scraptf'`) whose url is not a static page. */
function nonStaticMenuActions(f: SourceFile): string[] {
  return [...f.code.matchAll(/kind:\s*'scraptf',\s*url:\s*/g)]
    .map((m) => ({ m, url: expressionAt(f.code, m.index + m[0].length).trim() }))
    .filter(({ m, url }) => !traceUrl(f.code, url, m.index).ok)
    .map(({ m, url }) => `${f.rel}:${f.code.slice(0, m.index).split('\n').length}: ${url}`);
}

/** The text of the block that opens with the "{" at `open`, to its matching "}"; quotes are skipped. */
function blockAt(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/** The body of `function name(…) {…}` in `code`, or null. */
function functionBody(code: string, name: string): string | null {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(code);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  return blockAt(code, code.indexOf('{', open + callArgs(code, open).length + 2));
}

/** The name called by the call whose ")" is at `close`, or null. */
function calleeAt(code: string, close: number): string | null {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === ')') depth++;
    else if (code[i] === '(' && --depth === 0) return /([\w$]+)\s*$/.exec(code.slice(0, i))?.[1] ?? null;
  }
  return null;
}

/**
 * What a static-page helper does that it must not: build a URL, or read `.url` off anything but a
 * SCRAPTF_BANKS entry (`info`, scraptfBankInfo(…)) or a links page gated by BANK_PAGE_URLS (`l`, `page`).
 */
function helperUrlProblems(name: string, body: string): string[] {
  const out = URL_BUILDING.flatMap((re) => [...body.matchAll(new RegExp(re.source, `${re.flags}g`))].map((m) => `${name}: builds ${m[0].slice(0, 80)}`));
  for (const m of body.matchAll(/([\w$]+|\))\s*!?\s*\??\.\s*url\b/g)) {
    const holder = m[1] === ')' ? calleeAt(body, m.index) : m[1];
    if (holder !== 'scraptfBankInfo' && !(m[1] !== ')' && ['info', 'page', 'l'].includes(holder ?? ''))) out.push(`${name}: reads ${m[0]}`);
  }
  return out;
}

describe("the Live market's scrap.tf link opens only static pages (F19, R1)", () => {
  const scoped = () => SCRAPTF_OPEN_FILES.map((rel) => FILES.find((f) => f.rel === rel)!);

  it('passes the market, drawer and menu scrap.tf opens only a SCRAPTF_BANKS / STATIC_EXTERNAL_URLS page', () => {
    expect(scoped().every((f) => f !== undefined)).toBe(true);
    // openOnScraptf (it copies the name and arms the Live check) anywhere in the dashboard.
    const arming = urlOpens(FILES.filter((f) => f.rel.startsWith('renderer/')), 'openOnScraptf');
    expect(arming.map((o) => o.at.split(':')[0]).sort()).toEqual(['renderer/components/ItemMenu.tsx', 'renderer/pages/ItemDrawer.tsx', 'renderer/pages/MarketPage.tsx']);
    expect(nonStaticScraptfOpens(FILES.filter((f) => f.rel.startsWith('renderer/')))).toEqual([]);
    // The plain opens these files make of a scrap.tf page: the header's bank and the drawer's list (0.7.1, UX-11:
    // the drawer's second "Open bank page" is gone; its header opener covers the bank).
    const plain = urlOpens(scoped(), 'openOrCopy|openLink').filter((o) => LOOKS_SCRAPTF.test(o.url) || LOOKS_SCRAPTF.test(o.trace.via));
    expect(plain.map((o) => o.url).sort()).toEqual(['SCRAPTF_ITEMS_URL', 'bankLink.url']);
    expect(nonStaticScraptfOpens(scoped())).toEqual([]);
    // They reach main only through links.open's two helpers, never a 'links.open' call of their own.
    expect(offenders(/['"]links\.open['"]/, (r) => !SCRAPTF_OPEN_FILES.includes(r))).toEqual([]);
  });

  it("takes the row menu's scrap.tf action from a static page, and its links only from bank pages", () => {
    const menu = FILES.find((f) => f.rel === 'renderer/itemMenuModel.ts')!;
    expect([...menu.code.matchAll(/kind:\s*'scraptf',\s*url:/g)].length).toBeGreaterThan(0);
    expect(nonStaticMenuActions(menu)).toEqual([]);
    // scraptfOpenUrl uses a links.forSku page only when it is one of the static bank pages.
    expect(menu.code).toContain('const BANK_PAGE_URLS: ReadonlySet<string> = new Set(SCRAPTF_BANK_PAGES.map((p) => p.url));');
    expect(functionBody(menu.code, 'scraptfOpenUrl')).toContain("l.id === 'scraptf-page' && BANK_PAGE_URLS.has(l.url)");
  });

  it('builds no URL in the static-page helpers, and reads one only off a SCRAPTF_BANKS entry', () => {
    const problems: string[] = [];
    for (const [rel, names] of Object.entries(STATIC_PAGE_HELPERS)) {
      const code = FILES.find((f) => f.rel === rel)!.code;
      for (const name of names) {
        const body = functionBody(code, name);
        expect(body, `${rel}: ${name}`).not.toBeNull();
        problems.push(...helperUrlProblems(name, body!));
      }
    }
    expect(problems).toEqual([]);
  });

  it("never reads the URL a row or a detail carries in the dashboard (MarketRow.scraptfLink, seenOn)", () => {
    expect(offenders(/\b(?:scraptfLink|seenOn)\s*[!?]?\s*\??\.\s*url\b/, (r) => !r.startsWith('renderer/'))).toEqual([]);
  });

  it('catches what it claims to', () => {
    const bad = sourceFile(
      'renderer/pages/MarketPage.tsx',
      [
        'const b = marketScraptfButton(r, Date.now());',
        'void openOnScraptf(r.scraptfLink.url, b.name, toast);',
        'void openOnScraptf(`https://scrap.tf/search?q=${r.name}`, r.name, toast);',
        "const u = 'https://scrap.tf/buy/' + bank;",
        'void openOrCopy(u, toast);',
        'void openOrCopy(detail.seenOn.url, toast);',
        "void openOnScraptf(scraptfOpenUrl(c, null) + '?q=' + name, name, toast);",
        'const stfUrl = scraptfOpenUrl(d.category, null) ?? row.scraptfLink.url;',
        'void openOnScraptf(stfUrl, name, toast);',
      ].join('\n'),
    );
    expect(nonStaticScraptfOpens([bad]).map((h) => h.split(':')[1])).toEqual(['2', '3', '7', '9', '5', '6']);

    const good = sourceFile(
      'renderer/pages/Good.tsx',
      [
        'const b = marketScraptfButton(r, Date.now());',
        'void openOnScraptf(b.url, b.name, toast, { sku: r.sku, settings });',
        'const bankLink = marketBankLink(filters.categories);',
        'onClick={() => void openOrCopy(bankLink.url, toast)}',
        'const stfUrl = scraptfOpenUrl(d.category, null, d.seenOn) ?? SCRAPTF_ITEMS_URL;',
        'onClick={() => void openOnScraptf(stfUrl, scraptfSearchName(d), toast, { sku: d.sku, settings })}',
        'const bankPage = bankPageUrl(d.seenOn, d.category);',
        'onClick={() => void openOrCopy(bankPage, toast)}',
        'const run = (a: ItemMenuAction) => { void openOnScraptf(a.url, a.name, toast); };',
        // A buyer's profile or a link of the links list: not a scrap.tf open by this route.
        'void openOrCopy(l.url, toast);',
      ].join('\n'),
    );
    expect(nonStaticScraptfOpens([good])).toEqual([]);
    expect(urlOpens([good], 'openOnScraptf|openOrCopy').filter((o) => o.trace.ok)).toHaveLength(5);

    const menu = sourceFile('renderer/itemMenuModel.ts', ["const stfUrl = scraptfOpenUrl(c, links);", "action: { kind: 'scraptf', url: stfUrl, name },", "action: { kind: 'scraptf', url: `${base}?q=${name}`, name },"].join('\n'));
    expect(nonStaticMenuActions(menu).map((h) => h.split(':')[1])).toEqual(['3']);

    const helpers = [
      ['marketScraptfButton', '{ const info = rowBank(r); return { url: r.scraptfLink.url, path: bankStockPagePath(info.url) }; }'],
      ['marketBankLink', '{ const info = marketSingleBank(c)!; return { url: `${info.url}?q=${encodeURIComponent(name)}` }; }'],
      ['bankPageUrl', "{ return 'https://scrap.tf/buy/' + bank; }"],
      ['scraptfOpenUrl', '{ const link = row.scraptfLink; return link.url; }'],
    ] as const;
    expect(helpers.map(([name, body]) => helperUrlProblems(name, body).length > 0)).toEqual([true, true, true, true]);
    // The real shapes pass.
    expect(helperUrlProblems('x', '{ const info = rowBank(r); const path = bankStockPagePath(info.url); return { url: info.url, title: `Seen on ${path}. The app never visits scrap.tf.` }; }')).toEqual([]);
    expect(helperUrlProblems('x', '{ return seenBankPageUrl(seenOn) ?? scraptfBankInfo(bankForCategory(category))!.url; }')).toEqual([]);
  });
});

// F20 reads the user's saves as history (price per save, time listed, a change feed) and adds opt-in
// re-save reminders, still without one request (R1, R10). The history modules only read local data and
// open nothing. A reminder only notifies; the one URL a notification may carry, `openUrl`, is a
// SCRAPTF_BANKS page, never built from item data. Main checks it again when the toast is clicked and
// hands it only to the user's browser (shell.openExternal, the opener links.open uses).

/**
 * The F20 modules: history, feed and reminders (service, shared rules, dashboard helpers and blocks: the
 * drawer's history and its step chart, the Live log's changes tab (U3, which shows each event's untrusted
 * `page` as text only), and Settings' reminder fields (U4)).
 */
const F20_FILES = [
  'service/domain/scraptfHistory.ts',
  'service/domain/resaveReminders.ts',
  'shared/scraptfHistory.ts',
  'renderer/historyModel.ts',
  'renderer/changesModel.ts',
  'renderer/components/ScraptfHistory.tsx',
  'renderer/components/Sparkline.tsx',
  'renderer/pages/LogPage.tsx',
  'renderer/settingsFields.ts',
];
/**
 * U4's reminder fields sit in the whole Settings page, whose help text names http://localhost (the request
 * check would read that as a client): it is held to the opener check only.
 */
const F20_OPENER_FREE_FILES = [...F20_FILES, 'renderer/pages/SettingsPage.tsx'];
/** F20 views that do open a page (the bank stock page's "Open on scrap.tf"): only a traced static one. */
const F20_OPENING_FILES = ['renderer/pages/BankStockPage.tsx'];
/**
 * Anything that opens or loads a URL, from the dashboard or main: links.open and its wrappers included,
 * and a JSX or DOM href / src (a local `const src = …` declares a name and loads nothing).
 */
const URL_OPENERS =
  /(?<![\w$])(?:openOrCopy|openLink|openOnScraptf|openExternal|loadURL|window\.open|location\.(?:assign|replace))\s*\(|['"]links\.open['"]|(?<!\b(?:const|let|var)\s+)\b(?:href|src)\s*=(?![=>])/;

/** An assignment operator (`=`, `+=`, `||=`, `&&=`, `??=`), not a comparison or an arrow. */
const ASSIGN = String.raw`\s*(?:\+|\|\||&&|\?\?)?=(?![=>])\s*`;
/**
 * The ways a value is given to a notification's `openUrl`: a key (bare, quoted or computed) or an
 * assignment (`n.openUrl = …`, `n['openUrl'] = …`). Each value is traced to a static bank page.
 */
const OPEN_URL_SETTERS: readonly RegExp[] = [
  /(?<![\w$.?'"])openUrl\s*:\s*/g,
  /['"]openUrl['"]\s*:\s*/g,
  /\[\s*['"]openUrl['"]\s*\]\s*:\s*/g,
  new RegExp(String.raw`\.\s*openUrl` + ASSIGN, 'g'),
  new RegExp(String.raw`\[\s*['"]openUrl['"]\s*\]` + ASSIGN, 'g'),
];
/** `openUrl` named anywhere, as an identifier or a string: each must be one of the known forms. */
const OPEN_URL_NAME = /(?<![\w$])openUrl(?![\w$])/g;
/** A type's member (`openUrl?: string`): names the key, sets nothing. */
const OPEN_URL_TYPE = /(?<![\w$.'"])openUrl\?\s*:\s*string\b/g;
/** A plain read (`n.openUrl === url`): sets nothing. */
const OPEN_URL_READ = new RegExp(String.raw`\??\.\s*openUrl(?![\w$])(?!` + ASSIGN + ')', 'g');

/**
 * `file:line: value` for every notify `openUrl` set to anything but a static bank page (a SCRAPTF_BANKS
 * entry's url, traced as F19's opens are), set by shorthand from a variable, or named in any other way
 * (`const k = 'openUrl'`, say): a helper whose result is spread or Object.assign-ed into a payload has
 * to name the key somewhere in src/, and is caught there. main/notify.ts only reads and checks one; a
 * type annotation (`openUrl: string`) is no value.
 */
function nonStaticOpenUrls(files: readonly SourceFile[] = FILES): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.rel === 'main/notify.ts') continue;
    const hits: { at: number; text: string }[] = [];
    const hit = (at: number, what: string) => hits.push({ at, text: `${f.rel}:${f.code.slice(0, at).split('\n').length}: ${what}` });
    const known = new Set<number>();
    const name = (m: RegExpMatchArray) => m.index! + m[0].indexOf('openUrl');
    for (const re of OPEN_URL_SETTERS) {
      for (const m of f.code.matchAll(re)) {
        known.add(name(m));
        const value = expressionAt(f.code, m.index + m[0].length).trim();
        if (value === 'string') continue;
        // `+=` appends to whatever is there: a URL built, whatever the right-hand side.
        if (/\+=\s*$/.test(m[0])) hit(m.index, `+= ${value.slice(0, 77)}`);
        else if (!traceUrl(f.code, value, m.index).ok) hit(m.index, value.slice(0, 80));
      }
    }
    for (const m of f.code.matchAll(/[{,]\s*openUrl\s*(?=[,}])/g)) {
      known.add(name(m));
      hit(m.index, 'shorthand openUrl');
    }
    for (const m of f.code.matchAll(OPEN_URL_TYPE)) known.add(name(m));
    for (const m of f.code.matchAll(OPEN_URL_READ)) known.add(name(m));
    for (const m of f.code.matchAll(OPEN_URL_NAME)) if (!known.has(m.index)) hit(m.index, 'openUrl named outside a key, an assignment or a read');
    out.push(...hits.sort((a, b) => a.at - b.at).map((h) => h.text));
  }
  return out;
}

/**
 * `file:line: …` for an opener in an F20 view that is not one of links.open's wrappers (openOrCopy,
 * openLink), or whose URL does not trace to a static page. Every call is traced, not only the ones that
 * look like scrap.tf: `openOrCopy(bankUrl + e.page, toast)` names no scrap.tf word (F19's filter skips it).
 */
function nonStaticF20Opens(files: readonly SourceFile[]): string[] {
  const other = offenders(URL_OPENERS, () => false, files).filter((h) => !/: (?:openOrCopy|openLink)\s*\($/.test(h));
  const unchecked = urlOpens(files, 'openOrCopy|openLink').filter((o) => !o.trace.ok);
  return [...other, ...unchecked.map((o) => `${o.at}: ${o.url}`)];
}

/** What main's notification path does that it must not: open a URL without notificationOpenUrl's checks. */
function notifyOpenProblems(notify: string, main: string): string[] {
  const out: string[] = [];
  const check = functionBody(notify, 'notificationOpenUrl') ?? '';
  for (const need of ['isHttpsUrl(url)', 'isAllowedExternalUrl(url)', 'isScraptfBankUrl(url)']) if (!check.includes(need)) out.push(`notificationOpenUrl lacks ${need}`);
  const click = functionBody(notify, 'handleNotificationClick') ?? '';
  const opens = [...click.matchAll(/\bopenExternal\s*\(/g)];
  if (opens.length !== 1) out.push(`handleNotificationClick calls openExternal ${opens.length} times`);
  for (const m of opens) {
    const arg = callArgs(click, m.index + m[0].length - 1).trim();
    const decl = new RegExp(`\\bconst\\s+${arg}\\s*=\\s*notificationOpenUrl\\(`).exec(click.slice(0, m.index));
    if (!/^[A-Za-z_$][\w$]*$/.test(arg) || !decl) out.push(`handleNotificationClick opens ${arg.slice(0, 60)} unchecked`);
    else if (!/if\s*\(\s*\w+\s*!==\s*null\s*\)/.test(click.slice(decl.index, m.index))) out.push(`handleNotificationClick opens ${arg} without its null check`);
  }
  // shell.openExternal is handed out three times in main: to links.open's deps, to the notification click
  // and (F21) to the scrap.tf window for the pages its policy calls 'external'.
  const shells = [...main.matchAll(/shell\.openExternal\s*\(/g)];
  if (shells.length !== 3) out.push(`main.ts calls shell.openExternal ${shells.length} times`);
  for (const m of shells) {
    const before = main.slice(Math.max(0, m.index - 60), m.index);
    if (!/openExternal:\s*\(url\)\s*=>\s*$/.test(before)) out.push(`main.ts calls shell.openExternal outside an openExternal dependency`);
  }
  const clickAt = main.indexOf('handleNotificationClick(data');
  if (clickAt < 0) out.push('main.ts does not route a notification click through handleNotificationClick');
  else if (!/openExternal:\s*\(url\)\s*=>\s*shell\.openExternal\(url\)/.test(main.slice(clickAt, clickAt + 300))) out.push('the click handler opens with something else');
  return out;
}

describe('scrap.tf history and re-save reminders send nothing and open only static bank pages (F20, R1)', () => {
  const scoped = (list: readonly string[] = F20_FILES) => list.map((rel) => FILES.find((f) => f.rel === rel)!);

  it('keeps the history, feed and reminder modules free of requests, loaders and openers', () => {
    expect(scoped().every((f) => f !== undefined)).toBe(true);
    expect(scoped(F20_OPENING_FILES).every((f) => f !== undefined)).toBe(true);
    expect(scoped(F20_OPENER_FREE_FILES).every((f) => f !== undefined)).toBe(true);
    const files = [...scoped(), ...scoped(F20_OPENING_FILES)];
    expect(offenders(/(?<![\w$])fetch\s*\(|\bXMLHttpRequest\b|\bnew\s+(?:WebSocket|EventSource|Worker)\s*\(/, () => false, files)).toEqual([]);
    expect(offenders(/\.request\s*\(|\bhttp\b\s*[.:]/, () => false, files)).toEqual([]);
    expect(offenders(URL_OPENERS, () => false, scoped(F20_OPENER_FREE_FILES))).toEqual([]);
    // The reminders take their timer from ../net/ratelimit (no client); the HTTP client is never imported.
    expect(offenders(/from\s+['"](?:electron|node:(?:http|https|net|child_process)|(?:\.\.\/)+net\/http|(?:\.\.\/)+net)['"]/, () => false, files)).toEqual([]);
    expect(scraptfLoads(files)).toEqual([]);
  });

  it('scans every dashboard file that shows a change event or an item history (the mock aside)', () => {
    // The changes tab renders each event's `page`, which comes from the untrusted saved file.
    const showing = FILES.filter((f) => f.rel.startsWith('renderer/') && f.rel !== 'renderer/mock.ts' && /\b(?:ScraptfChangeEvent|ScraptfItemHistory|StepSparkline)\b/.test(f.code)).map((f) => f.rel);
    expect(showing).toEqual(expect.arrayContaining(['renderer/pages/LogPage.tsx', 'renderer/components/Sparkline.tsx']));
    expect(showing.filter((rel) => !F20_FILES.includes(rel))).toEqual([]);
  });

  it('lets the F20 views that open a page open only a static one, traced (not only what looks like scrap.tf)', () => {
    expect(nonStaticF20Opens(scoped(F20_OPENING_FILES))).toEqual([]);
    // The bank stock page's "Open on scrap.tf" is there, so the check has something to see.
    expect(urlOpens(scoped(F20_OPENING_FILES), 'openOrCopy|openLink').map((o) => o.url)).toEqual(['info.url']);
  });

  it("sets a notification's openUrl only from a SCRAPTF_BANKS entry", () => {
    expect(nonStaticOpenUrls()).toEqual([]);
    // There is one: the re-save reminder's, so the scan has something to see.
    const shared = FILES.find((f) => f.rel === 'shared/scraptfHistory.ts')!.code;
    const notice = shared.slice(shared.indexOf('function scraptfResaveNotice'));
    expect(notice).toMatch(/^function scraptfResaveNotice\(\s*bank: ScraptfBank,[^]*?const info = scraptfBankInfo\(bank\);[^]*?openUrl: info\.url,/);
  });

  it('opens a notification link only after the click-time check, and only in the user browser', () => {
    const notify = FILES.find((f) => f.rel === 'main/notify.ts')!.code;
    const main = FILES.find((f) => f.rel === 'main/main.ts')!.code;
    expect(notifyOpenProblems(notify, main)).toEqual([]);
    // The bank check is exact: one of the SCRAPTF_BANKS URLs, no prefix or pattern.
    const links = FILES.find((f) => f.rel === 'shared/links.ts')!.code;
    const bankUrl = functionBody(links, 'isScraptfBankUrl') ?? '';
    expect(bankUrl).toMatch(/SCRAPTF_BANKS\.some\(\(b\)\s*=>\s*b\.url\s*===\s*url\)/);
    expect(bankUrl).not.toMatch(/startsWith|includes|indexOf|match|test\(|RegExp/);
  });

  it('catches what it claims to', () => {
    const bad = sourceFile(
      'service/domain/Bad.ts',
      [
        "const a = { title: 't', body: 'b', sku: null, openUrl: `https://scrap.tf/buy/hats?q=${name}` };",
        'const b = { title: t, body: x, sku: null, openUrl: e.page };',
        'const c = { title: t, body: x, sku: null, openUrl };',
        'const info = scraptfBankInfo(bank);',
        'const d = { title: t, body: x, sku: null, openUrl: info.url + path };',
        'const ok = { title: t, body: x, sku: null, openUrl: info.url };',
        'type T = { openUrl: string };',
      ].join('\n'),
    );
    expect(nonStaticOpenUrls([bad]).map((h) => h.split(':')[1])).toEqual(['1', '2', '3', '5']);

    // F20-C1: an assignment, a quoted or computed key, and a helper spread or assigned into a payload.
    const forms = sourceFile(
      'service/domain/Forms.ts',
      [
        'const info = scraptfBankInfo(bank);',
        'const n = scraptfResaveNotice(bank, at, now)!; n.openUrl = `https://scrap.tf${e.page}`;',
        "const q = { title: t, body: x, sku: null, 'openUrl': `https://scrap.tf${e.page}` };",
        'const r = { title: t, body: x, sku: null, "openUrl": e.page };',
        "const s = { title: t, body: x, sku: null, ['openUrl']: e.page };",
        "n['openUrl'] = e.page;",
        'function linkOf(e) { return { openUrl: e.page }; }',
        'Object.assign(n, linkOf(e));',
        "const k = 'openUrl'; n[k] = e.page;",
        'n.openUrl += e.page;',
        // The real shapes pass: a static page assigned or keyed, a type, a read with no value.
        'n.openUrl = info.url;',
        "const ok = { title: t, body: x, sku: null, 'openUrl': info.url };",
        'type T = { title: string; openUrl?: string };',
        'if (n.openUrl === info.url && n?.openUrl !== undefined) count++;',
      ].join('\n'),
    );
    expect(nonStaticOpenUrls([forms]).map((h) => h.split(':').slice(1).join(':'))).toEqual([
      '2: `https://scrap.tf${e.page}`',
      '3: `https://scrap.tf${e.page}`',
      '4: e.page',
      '5: e.page',
      '6: e.page',
      '7: e.page',
      '9: openUrl named outside a key, an assignment or a read',
      '10: += e.page',
    ]);

    expect(offenders(URL_OPENERS, () => false, [sourceFile('renderer/historyModel.ts', "openOrCopy(url);\nrpc('links.open', { url });\nconst a = <a href={u} />;")]).length).toBe(3);
    // A DOM src/href and a JSX string attribute are openers; a local name `src` is not (settingsFields.ts).
    const attrs = sourceFile('renderer/X.tsx', ['img.src = url;', 'a.href = `${base}/x`;', '<img src="x.png" />', 'const src = scraptfListKeySources(list, typed);', 'let href = 1;', 'if (src === href) {}'].join('\n'));
    expect(offenders(URL_OPENERS, () => false, [attrs]).map((h) => h.split(':')[1])).toEqual(['1', '2', '3']);

    // F20-C2: an opener in the changes view built from an event's page, which F19's filter would skip.
    const log = sourceFile(
      'renderer/pages/LogPage.tsx',
      ['const bankUrl = scraptfBankInfo(e.bank)!.url;', 'void openOrCopy(bankUrl + e.page, toast);', 'void openLink(e.page, toast);'].join('\n'),
    );
    expect(nonStaticScraptfOpens([log])).toEqual([]);
    expect(offenders(URL_OPENERS, () => false, [log]).map((h) => h.split(':')[1])).toEqual(['2', '3']);
    expect(nonStaticF20Opens([log]).map((h) => h.split(':')[1])).toEqual(['2', '3']);
    const stock = sourceFile(
      'renderer/pages/BankStockPage.tsx',
      ['const info = scraptfBankInfo(bank);', 'if (info) void openOrCopy(info.url, toast);', 'window.open(info.url);', 'void openOrCopy(info.url + r.sku, toast);'].join('\n'),
    );
    expect(nonStaticF20Opens([stock]).map((h) => h.split(':')[1])).toEqual(['3', '4']);

    const notify = [
      'function notificationOpenUrl(url) { return isHttpsUrl(url) && isAllowedExternalUrl(url) ? url : null; }',
      'async function handleNotificationClick(data, deps) { await deps.openExternal(data.openUrl); }',
    ].join('\n');
    const main = 'n.on("click", () => shell.openExternal(data.openUrl));';
    expect(notifyOpenProblems(notify, main)).toEqual([
      'notificationOpenUrl lacks isScraptfBankUrl(url)',
      'handleNotificationClick opens data.openUrl unchecked',
      'main.ts calls shell.openExternal 1 times',
      'main.ts calls shell.openExternal outside an openExternal dependency',
      'main.ts does not route a notification click through handleNotificationClick',
    ]);
    const unguarded = 'async function handleNotificationClick(data, deps) { const url = notificationOpenUrl(data.openUrl); await deps.openExternal(url); }';
    expect(notifyOpenProblems(`function notificationOpenUrl(url) { return isHttpsUrl(url) && isAllowedExternalUrl(url) && isScraptfBankUrl(url) ? url : null; }\n${unguarded}`, '')).toContain(
      'handleNotificationClick opens url without its null check',
    );
  });
});

// ---------------------------------------------------------------------------
// F21: the opt-in scrap.tf window. The user browses scrap.tf themselves; Flip Desk only reads the DOM their
// browsing loaded, with one pinned script, and imports it. Never: an app-initiated load (timer, event or
// promise callback), a cookie, a user agent, a header, a click, a keystroke, a DOM write or a preload in
// the view. Synthetic sources prove each scan sees what it should.
// ---------------------------------------------------------------------------

/** The top-level comma-separated parts of an argument list. */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(from, i));
      from = i + 1;
    }
  }
  out.push(args.slice(from));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** True when the "(" at `open` starts a type signature (`name(a: T): R;`), not a call. */
function isSignature(code: string, open: number): boolean {
  const close = open + callArgs(code, open).length + 1;
  return /^\s*:/.test(code.slice(close + 1, close + 12));
}

/** What moves the view: a load, a reload, a history step (BrowserWindow.restore() is un-minimising, not this). */
const NAV_CALL = /\.\s*(?:loadURL|loadFile|reload|reloadIgnoringCache|goBack|goForward|goToIndex|goToOffset)\s*\(|navigationHistory\s*\.\s*restore\s*\(/g;
/** The window's user actions: the only functions that may call userNavigate. */
const USER_ACTIONS: readonly string[] = ['open', 'back', 'forward', 'reload', 'home', 'go', 'clear'];
/** A bare call of a user action (not a member call such as wc.reload() or pages.clear()). */
const USER_ACTION_CALL = new RegExp(`(?<![\\w$.])(${USER_ACTIONS.join('|')})\\s*\\(`, 'g');

/**
 * F21 navigation rule for the window module: every load or history step sits in `function userNavigate`
 * (the toolbar's own app:// page aside, `loadURL(SCRAPTF_BAR_URL)`), never in a deferred callback;
 * userNavigate is called only from a user action and never from a deferred callback; and it checks
 * isAllowedWindowStart before any loadURL.
 */
function windowNavigationProblems(f: SourceFile): string[] {
  const out: string[] = [];
  const fns = functionSpans(f.code);
  const later = deferredSpans(f.code);
  const deferred = (at: number) => later.some((s) => at > s.start && at < s.end);
  for (const m of f.code.matchAll(NAV_CALL)) {
    const open = m.index + m[0].length - 1;
    if (isSignature(f.code, open)) continue;
    const args = callArgs(f.code, open).trim();
    const where = `${f.rel}:${lineAt(f.code, m.index)}: ${m[0]}${args.slice(0, 60)}`;
    if (deferred(m.index)) out.push(`${where} in a deferred callback`);
    else if (/loadURL/.test(m[0]) && args === 'SCRAPTF_BAR_URL') continue;
    else if (enclosing(fns, m.index)?.name !== 'userNavigate') out.push(`${where} outside userNavigate`);
  }
  for (const m of f.code.matchAll(/(?<![\w$.])userNavigate\s*\(/g)) {
    if (/function\s+$/.test(f.code.slice(Math.max(0, m.index - 12), m.index))) continue;
    const fn = enclosing(fns, m.index);
    const where = `${f.rel}:${lineAt(f.code, m.index)}`;
    if (fn === null || !USER_ACTIONS.includes(fn.name)) out.push(`${where}: userNavigate called from ${fn?.name ?? 'the top level'}`);
    if (deferred(m.index)) out.push(`${where}: userNavigate called in a deferred callback`);
  }
  // A user action reaches userNavigate too, so it may be called only by another user action (home and go
  // open a closed window), never from a listener, a promise callback or any other function. The one other
  // caller is pressKey (F21-11), and only of Back, Forward, Reload and Home (windowKeyProblems holds it).
  for (const m of f.code.matchAll(USER_ACTION_CALL)) {
    if (/function\s+$/.test(f.code.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (isSignature(f.code, m.index + m[0].length - 1)) continue;
    const fn = enclosing(fns, m.index);
    const where = `${f.rel}:${lineAt(f.code, m.index)}: ${m[1]}()`;
    if (deferred(m.index)) out.push(`${where} called in a deferred callback`);
    else if (fn?.name === KEY_ACTION && KEY_MOVES.has(m[1]!)) continue;
    else if (fn === null || !USER_ACTIONS.includes(fn.name)) out.push(`${where} called from ${fn?.name ?? 'the top level'}`);
  }
  const body = functionBody(f.code, 'userNavigate');
  if (body !== null && /\.\s*loadURL\s*\(/.test(body) && !/\bisAllowedWindowStart\s*\(/.test(body)) out.push('userNavigate loads a URL without isAllowedWindowStart');
  return out;
}

/**
 * F21-11: the user's own keys and mouse buttons in the window. pressKey is the one function besides the user
 * actions that may call one, and only Back, Forward, Reload or Home. It may be called only from exactly two
 * listeners, of the input Chromium and Windows raise for the user alone: the view's before-input-event, after
 * windowKeyAction(input) chose the key and event.preventDefault() kept it from the page, and the window's
 * app-command, after appCommandAction(command). Nowhere else: no other listener, function, timer or callback.
 */
const KEY_ACTION = 'pressKey';
const KEY_MOVES: ReadonlySet<string> = new Set(['back', 'forward', 'reload', 'home']);
// The initialiser is pinned whole, with only the current-window guard around the check: a fallback such as
// `windowKeyAction(input) ?? 'reload'` would act on every key down, key up and auto-repeat in the page.
const KEY_LISTENERS: readonly { event: string; handler: RegExp }[] = [
  {
    event: 'before-input-event',
    handler: /^\(\s*event\s*,\s*input\s*\)\s*=>[^]*\bconst\s+action\s*=\s*(?:isCurrent\(\s*wc\s*\)\s*\?\s*)?windowKeyAction\(\s*input\s*\)(?:\s*:\s*null)?\s*;[^]*\bevent\.preventDefault\(\)[^]*\bpressKey\(\s*action\s*\)/,
  },
  {
    event: 'app-command',
    handler: /^\(\s*_event\s*,\s*command\s*\)\s*=>[^]*\bconst\s+action\s*=\s*(?:win\s*===\s*w\s*\?\s*)?appCommandAction\(\s*command\s*\)(?:\s*:\s*null)?\s*;[^]*\bpressKey\(\s*action\s*\)/,
  },
];

function windowKeyProblems(f: SourceFile): string[] {
  const out: string[] = [];
  const later = deferredSpans(f.code);
  const calls = new Map<string, number>();
  for (const m of f.code.matchAll(/(?<![\w$.])pressKey\s*\(/g)) {
    if (/function\s+$/.test(f.code.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (isSignature(f.code, m.index + m[0].length - 1)) continue;
    const where = `${f.rel}:${lineAt(f.code, m.index)}: pressKey()`;
    // The innermost deferred call holding it must be one of the two listeners (a timer inside one is not).
    let span: Span | null = null;
    for (const s of later) if (m.index > s.start && m.index < s.end && (span === null || s.start > span.start)) span = s;
    const [event = '', handler = '', ...rest] = span === null ? [] : topLevelArgs(f.code.slice(span.start + 1, span.end));
    const rule = span !== null && /^\.\s*on\s*\($/.test(span.name) && rest.length === 0 ? KEY_LISTENERS.find((k) => event === `'${k.event}'`) : undefined;
    // The key it acts on is the one the check chose: `action` is assigned once.
    if (rule === undefined || !rule.handler.test(handler) || [...handler.matchAll(/\baction\s*=(?![=>])/g)].length !== 1) {
      out.push(`${where} outside the two input listeners`);
      continue;
    }
    calls.set(rule.event, (calls.get(rule.event) ?? 0) + 1);
  }
  for (const [event, n] of calls) if (n > 1) out.push(`${n} ${event} listeners call pressKey (one allowed)`);
  const body = functionBody(f.code, KEY_ACTION);
  if (body !== null) {
    if (new RegExp(NAV_CALL.source).test(body) || /\buserNavigate\s*\(/.test(body)) out.push('pressKey loads or steps the view itself');
    for (const m of body.matchAll(USER_ACTION_CALL)) if (!KEY_MOVES.has(m[1]!)) out.push(`pressKey calls ${m[1]}()`);
  }
  return out;
}

/** Timers in the window module: the REAL_TIMERS pass-through and the single settle read; nothing else. */
const TIMER_CALL = /(?<![\w$])(?:([\w$]+)\s*\.\s*)?(setTimeout|setInterval|setImmediate|queueMicrotask|requestIdleCallback|requestAnimationFrame)\s*\(/g;
const SETTLE_CALLBACK = /^\(\)\s*=>\s*(?:void\s+)?readPage\(\s*'settle'\s*\)$/;

function windowTimerProblems(f: SourceFile): string[] {
  const out: string[] = [];
  let settles = 0;
  for (const m of f.code.matchAll(TIMER_CALL)) {
    const open = m.index + m[0].length - 1;
    if (isSignature(f.code, open)) continue;
    const where = `${f.rel}:${lineAt(f.code, m.index)}`;
    if (m[2] !== 'setTimeout') {
      out.push(`${where}: ${m[2]} is not allowed`);
      continue;
    }
    const [cb = '', delay = '', ...rest] = topLevelArgs(callArgs(f.code, open));
    const passThrough = m[1] === undefined && cb === 'fn' && delay === 'ms' && /\(fn, ms\)\s*=>\s*$/.test(f.code.slice(Math.max(0, m.index - 20), m.index));
    if (passThrough && rest.length === 0) continue;
    if (SETTLE_CALLBACK.test(cb) && delay === 'READ_SETTLE_MS' && rest.length === 0) {
      settles++;
      continue;
    }
    out.push(`${where}: a timer that is not the settle read: ${cb.slice(0, 60)}`);
  }
  if (settles > 1) out.push(`${settles} settle timers (one allowed)`);
  // The read and what it calls to import a snapshot (also from a listener: endCycle, flushHeld).
  for (const name of READ_FUNCTIONS) {
    const body = functionBody(f.code, name);
    if (body === null) continue;
    if (new RegExp(NAV_CALL.source).test(body) || /\buserNavigate\s*\(/.test(body) || new RegExp(USER_ACTION_CALL.source).test(body)) out.push(`${name} navigates`);
    if (new RegExp(TIMER_CALL.source).test(body)) out.push(`${name} starts a timer`);
  }
  return out;
}

/** The read and the functions that import what it read: none may move the view or start a timer. */
const READ_FUNCTIONS: readonly string[] = ['readPage', 'importRead', 'flushHeld', 'endCycle'];

/**
 * The only script run in the view: READ_SCRIPT in READ_WORLD_ID, from the window module; no main-world script,
 * input or DOM write there. 0.7.3: looked for in every src/ file, because hardenWebContents and main's
 * 'web-contents-created' listener get every webContents, the scrap.tf view's included.
 */
const PAGE_WRITES =
  /\.\s*(?:executeJavaScript|insertCSS|removeInsertedCSS|sendInputEvent|insertText|pasteAndMatchStyle|replaceMisspelling|setIgnoreMenuShortcuts|startDrag)\s*\(|\.\s*(?:paste|selectAll|unselect|undo|redo|cut|delete|scrollToTop|scrollToBottom|replace)\s*\(\s*\)/g;
/** Not a webContents: the settings store rolls back its hotkey change when settings.json cannot be written. */
const NOT_A_PAGE_EDIT = { file: 'main/settingsStore.ts', call: '.undo()', receiver: /hotkeys/ } as const;

function windowExecProblems(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const m of f.code.matchAll(/\.\s*executeJavaScriptInIsolatedWorld\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      if (isSignature(f.code, open)) continue;
      const where = `${f.rel}:${lineAt(f.code, m.index)}`;
      if (f.rel !== SCRAPTF_WINDOW) out.push(`${where}: isolated-world script outside the window module`);
      else if (callArgs(f.code, open).replace(/\s+/g, '') !== 'READ_WORLD_ID,[{code:READ_SCRIPT}]') out.push(`${where}: runs something other than READ_SCRIPT in READ_WORLD_ID`);
    }
    // 0.7.3: the smoke test's bridge check on the dashboard is the one main-world script in the app, pinned by
    // its count, its function, its receiver and "not in a listener, a timer or a promise callback".
    const execs = [...f.code.matchAll(/\.\s*executeJavaScript\s*\(/g)];
    const fns = functionSpans(f.code);
    const later = deferredSpans(f.code);
    for (const m of execs) {
      const bridge =
        f.rel === 'main/main.ts' &&
        execs.length === 1 &&
        enclosing(fns, m.index)?.name === 'runSmokeTest' &&
        enclosing(later, m.index) === null &&
        calledOn(f.code, m.index, /contents/);
      if (!bridge) out.push(`${f.rel}:${lineAt(f.code, m.index)}: executeJavaScript`);
    }
    for (const m of f.code.matchAll(PAGE_WRITES)) {
      if (f.rel !== SCRAPTF_WINDOW) {
        // Pinned above (executeJavaScript) and by smokeWindowProblems (sendInputEvent: the harness, to `wc` only).
        if (/^\.\s*(?:executeJavaScript|sendInputEvent)\b/.test(m[0])) continue;
        if (f.rel === NOT_A_PAGE_EDIT.file && m[0] === NOT_A_PAGE_EDIT.call && calledOn(f.code, m.index, NOT_A_PAGE_EDIT.receiver)) continue;
      }
      out.push(`${f.rel}:${lineAt(f.code, m.index)}: ${m[0]}`);
    }
    for (const m of f.code.matchAll(/\bREAD_SCRIPT\s*=(?!=)/g)) if (f.rel !== 'shared/scraptfWindowPolicy.ts') out.push(`${f.rel}:${lineAt(f.code, m.index)}: READ_SCRIPT defined again`);
  }
  return out;
}

/** The view: one `new WebContentsView({ webPreferences: scraptfViewWebPreferences(…) })`, no preload, locked down. */
const VIEW_FLAGS: readonly string[] = [
  'sandbox: true',
  'contextIsolation: true',
  'nodeIntegration: false',
  'nodeIntegrationInWorker: false',
  'nodeIntegrationInSubFrames: false',
  'webSecurity: true',
  'allowRunningInsecureContent: false',
  'webviewTag: false',
];

function windowViewProblems(f: SourceFile): string[] {
  const out: string[] = [];
  const views = [...f.code.matchAll(/\bnew\s+WebContentsView\s*\(/g)];
  if (views.length > 1) out.push(`${views.length} WebContentsViews (one allowed)`);
  for (const m of views) {
    const args = callArgs(f.code, m.index + m[0].length - 1).replace(/\s+/g, '');
    if (!/^\{webPreferences:scraptfViewWebPreferences\([^()]*\),?\}$/.test(args)) out.push(`the view is not built from scraptfViewWebPreferences: ${args.slice(0, 80)}`);
  }
  const prefs = functionBody(f.code, 'scraptfViewWebPreferences');
  if (prefs === null) out.push('scraptfViewWebPreferences is missing');
  else {
    if (/\bpreload\b/.test(prefs)) out.push('the view has a preload');
    for (const flag of VIEW_FLAGS) if (!prefs.replace(/\s+/g, ' ').includes(flag)) out.push(`the view lacks ${flag}`);
    if (/additionalArguments|\bsession\s*:|\bwebContents\s*:/.test(prefs)) out.push('the view takes extra arguments, a session or a webContents');
  }
  // Each webPreferences in the module is the view's or the toolbar's (the app's own page and preload).
  for (const m of f.code.matchAll(/\bwebPreferences\s*:\s*/g)) {
    const rest = f.code.slice(m.index + m[0].length);
    if (!/^(?:scraptfViewWebPreferences\(|windowWebPreferences\(\s*'scraptf'\s*,)/.test(rest)) out.push(`${f.rel}:${lineAt(f.code, m.index)}: webPreferences not from the two helpers`);
  }
  if (/\bpreload\s*:/.test(f.code)) out.push('a preload key in the window module');
  return out;
}

// The dashboard's window scans (deferredWindowCalls, deferredWindowOpens and, 0.7.3, the wrappers that hold
// such a call) are in ./windowWrapperScan.

/**
 * A main-process call that moves or reads the window: the manager's methods by the names main uses for it
 * (rt.scraptfWindow, deps.scraptfWindow, the router's windowOn() and its w), and the tray's action.
 */
const MAIN_WINDOW_CALL =
  /(?:\bscraptfWindow\??|\bwindowOn\(\)|(?<![\w$.])w)\s*\.\s*(?:open|back|forward|reload|home|go|clear|readNow)\s*\(|(?<![\w$])openScraptfWindow\s*\(/g;
/** Deferred calls as DEFERRED_CALL, plus main's own subscriptions (settings.onChange, host.onStatus…). */
const MAIN_DEFERRED_CALL = new RegExp(`${DEFERRED_CALL.source}|\\.\\s*on[A-Z][\\w$]*\\s*\\(`, 'g');

/** What the "{" at `brace` opens: a function's body, a control block (if, loop, switch, try, case or bare), or a literal. */
function blockKind(code: string, brace: number): 'function' | 'control' | 'literal' {
  const before = code.slice(Math.max(0, brace - 2000), brace).trimEnd();
  if (/=>$|\)\s*:\s*[^(){};=]+$/.test(before)) return 'function';
  if (/(?:\b(?:else|try|finally|do)|[:;{}])$/.test(before)) return 'control';
  if (!before.endsWith(')')) return 'literal';
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i] === ')') depth++;
    else if (before[i] === '(' && --depth === 0) return /\b(?:if|for|while|switch|catch|with)\s*$/.test(before.slice(0, i)) ? 'control' : 'function';
  }
  return 'literal';
}

/**
 * 0.7.3: true when the call at `at` runs after an await: one earlier in its function (through the if, loop, try
 * and case blocks around it), from its switch case on. Functions closed before it and strings do not count, nor
 * the call's own `await deps.scraptfWindow.clear(`.
 */
function awaitedBefore(code: string, at: number): boolean {
  const open: number[] = [];
  const closed: [number, number][] = [];
  let quote: string | null = null;
  for (let i = 0; i < at; i++) {
    const c = code[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') open.push(i);
    else if (c === '}') {
      const o = open.pop();
      if (o !== undefined && blockKind(code, o) === 'function') closed.push([o, i]);
    }
  }
  let from = 0;
  for (let k = open.length - 1; k >= 0; k--) {
    if (blockKind(code, open[k]!) === 'function') {
      from = open[k]! + 1;
      break;
    }
  }
  let text = code.slice(from, at);
  for (const [s, e] of closed) if (s >= from) text = `${text.slice(0, s - from)}${' '.repeat(e - s + 1)}${text.slice(e - from + 1)}`;
  text = text.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  const label = [...text.matchAll(/\b(?:case\b[^:]*|default\s*):/g)].at(-1);
  if (label) text = text.slice(label.index + label[0].length);
  return /\bawait\b/.test(text.replace(/\bawait\s+(?:[\w$]+\s*\??\.\s*)*$/, ''));
}

/**
 * main/*.ts lines (the window module aside) that move or read the window from a timer, a listener or a promise
 * callback, or (0.7.3) after an await in its function or switch case (the harness, a scripted run on local
 * pages, aside).
 */
function mainWindowCallProblems(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!f.rel.startsWith('main/') || f.rel === SCRAPTF_WINDOW) continue;
    const later = [...f.code.matchAll(MAIN_DEFERRED_CALL)].map((m) => {
      const open = m.index + m[0].length - 1;
      return { start: open, end: open + callArgs(f.code, open).length + 1 };
    });
    for (const m of f.code.matchAll(MAIN_WINDOW_CALL)) {
      if (isSignature(f.code, m.index + m[0].length - 1)) continue;
      const where = `${f.rel}:${lineAt(f.code, m.index)}: ${m[0].replace(/\s+/g, '')}`;
      if (later.some((s) => m.index > s.start && m.index < s.end)) out.push(where);
      else if (f.rel !== SMOKE_WINDOW && awaitedBefore(f.code, m.index)) out.push(`${where} (after an await)`);
    }
  }
  return out;
}

/** What sets the user agent: the setters and the writable webContents.userAgent (R6). */
const UA_SETTERS = /\b(?:setUserAgent|userAgentFallback)\b|\.\s*userAgent\s*=(?!=)/;
/** A request of the window module's own: fetch, a client, a socket, a download, a page save (0.7.3), a session preconnect or DNS lookup. */
const WINDOW_REQUEST =
  /(?<![\w$])fetch\s*\(|\.\s*(?:request|fetch|downloadURL|savePage|preconnect|resolveHost)\s*\(|\bnew\s+(?:WebSocket|EventSource|Worker)\s*\(|(?<![\w$.])io\s*\(/;
/**
 * 0.7.3: the Chrome DevTools Protocol on a webContents (`contents.debugger.attach()`/`.sendCommand(…)`): it can run
 * a main-world script, send input, override the user agent and read every cookie (R3, R6, R9). A bare `debugger;`
 * statement is not it.
 */
const PAGE_DEBUGGER = /\.\s*debugger\b|\bsendCommand\s*\(/;

describe('the scrap.tf window loads only what the user asks for and reads only the pinned script (F21, R1, R3, R6, R9)', () => {
  const win = () => FILES.find((f) => f.rel === SCRAPTF_WINDOW)!;

  it('finds the window module and the policy module', () => {
    expect(win()).toBeDefined();
    expect(FILES.some((f) => f.rel === 'shared/scraptfWindowPolicy.ts')).toBe(true);
  });

  it('lets only the window module load scrap.tf in a WebContents, and only into its own window and view', () => {
    // Every other file keeps R1 exactly (the scan above); the window module may load only its window and view.
    expect(scraptfLoads()).toEqual([]);
    expect(offenders(/\bWebContentsView\b/, (r) => r === SCRAPTF_WINDOW)).toEqual([]);
    // No request of its own: no fetch, client, socket, download or session fetch.
    const w = [win()];
    expect(offenders(WINDOW_REQUEST, () => false, w)).toEqual([]);
    expect(offenders(/from\s+['"](?:node:)?(?:http|https|net|tls|dgram|child_process)['"]|from\s+['"](?:ws|socket\.io-client)['"]|from\s+['"](?:\.\.\/)+service\/net/, () => false, w)).toEqual([]);
    // The window's partitions and the 'window' import origin belong to this module alone.
    expect(offenders(/persist:scraptf|\bfromPartition\s*\(/, (r) => r === SCRAPTF_WINDOW)).toEqual([]);
    expect(offenders(/\borigin\s*:\s*['"]window['"]/, (r) => r === SCRAPTF_WINDOW)).toEqual([]);
  });

  it('moves the view only from the user actions, never from a timer, an event or a promise callback', () => {
    expect(windowNavigationProblems(win())).toEqual([]);
    expect(windowTimerProblems(win())).toEqual([]);
    // F21-11: the user's own keys and mouse buttons, through exactly the two input listeners.
    expect(windowKeyProblems(win())).toEqual([]);
    expect([...win().code.matchAll(/\.on\('before-input-event',/g)]).toHaveLength(1);
    expect([...win().code.matchAll(/\.on\('app-command',/g)]).toHaveLength(1);
    // Nor from main's own code: the tray action and the router are clicks, nothing else calls the window.
    expect(mainWindowCallProblems(FILES)).toEqual([]);
    expect(FILES.some((f) => f.rel === 'main/main.ts' && /rt\.scraptfWindow\?\.open\(\)/.test(f.code))).toBe(true);
    // Pages the policy calls 'external' are the only ones the module hands to the browser.
    const code = win().code;
    const opens = [...code.matchAll(/(?<![\w$])(?:[\w$]+\s*\.\s*)?openExternal\s*\(/g)].filter((m) => !isSignature(code, m.index + m[0].length - 1));
    for (const m of opens) expect(code.slice(Math.max(0, m.index - 600), m.index)).toMatch(/topLevelNavigationDecision\([^]*'external'/);
  });

  it('runs READ_SCRIPT, pinned and free of forbidden tokens, and nothing else in the view', () => {
    expect(READ_SCRIPT).toBe(
      "((h) => (typeof h === 'string' && h.length <= 20971520 ? h : null))(document.documentElement ? document.documentElement.outerHTML : null)",
    );
    expect(readScriptProblems(READ_SCRIPT)).toEqual([]);
    expect(READ_WORLD_ID).toBe(1001);
    expect(windowExecProblems(FILES)).toEqual([]);
    // 0.7.3: nor through the DevTools Protocol, anywhere in src/ (every webContents passes hardenWebContents).
    expect(offenders(PAGE_DEBUGGER)).toEqual([]);
    // 0.7.3: the one main-world script the scan lets through is there: the smoke test's bridge check.
    const main = FILES.find((f) => f.rel === 'main/main.ts')!.code;
    const execs = [...main.matchAll(/\.\s*executeJavaScript\s*\(/g)];
    expect(execs).toHaveLength(1);
    expect(enclosing(functionSpans(main), execs[0]!.index)?.name).toBe('runSmokeTest');
  });

  it('gives the view no preload and the locked-down webPreferences', () => {
    expect(windowViewProblems(win())).toEqual([]);
    expect(offenders(/\b(?:setPreloads|registerPreloadScript)\b/)).toEqual([]);
  });

  it('never sets the user agent or headers, and never touches cookies, anywhere', () => {
    expect(offenders(/\b(setUserAgent|userAgentFallback)\b/)).toEqual([]);
    // LoadURLOptions in main: no userAgent, extra headers, referrer or POST body.
    expect(offenders(/\buserAgent\s*:|\bextraHeaders\b|\bhttpReferrer\b|\bpostData\b/, (r) => !r.startsWith('main/'))).toEqual([]);
    expect(offenders(/\b(?:onBeforeSendHeaders|onSendHeaders|onHeadersReceived)\b/)).toEqual([]);
    expect(offenders(/\.\s*cookies\b|\bcookies\s*\.\s*(?:get|set|remove|flushStore)\b|\bdocument\s*\.\s*cookie\b|\bcookieStore\s*\./)).toEqual([]);
  });

  it('keeps the HTTP layer refusing scrap.tf, every subdomain and its socket', () => {
    for (const url of ['https://scrap.tf/', 'https://scrap.tf/buy/hats', 'https://scrap.tf/ajax/', 'https://www.scrap.tf/']) expect(checkUrl(url).allowed).toBe(false);
    expect(checkUrl('wss://ws.scrap.tf/', 'ws').allowed).toBe(false);
  });

  it('moves the window from the dashboard only on a click: never in an effect, a push listener or a timer', () => {
    const dashboard = FILES.filter((f) => f.rel.startsWith('renderer/') && !f.rel.startsWith('renderer/mock'));
    expect(deferredWindowCalls(dashboard)).toEqual([]);
    // 0.7.1 (F21-8): nor an open worded for the window, openOnScraptf or Show flips.
    expect(deferredWindowOpens(dashboard)).toEqual([]);
    // 0.7.3: nor through a local wrapper that holds one (the toolbar's act, a page's openInWindow…).
    expect(deferredWindowWrappers(dashboard)).toEqual([]);
    // The scans see the real calls they hold to that.
    expect(dashboard.some((f) => /\ballowWindow\b/.test(f.code))).toBe(true);
    expect(dashboard.some((f) => /'app\.showBankStock'/.test(f.code))).toBe(true);
    const bar = 'renderer/pages/ScraptfWindowBar.tsx';
    expect(windowWrappers(dashboard).holders).toEqual(
      expect.arrayContaining([
        ...['NAV_METHODS', 'act', 'go', 'readNow', 'clear', 'showFlips'].map((n) => `${bar}:${n}`),
        'renderer/pages/BanksPage.tsx:openInWindow',
        'renderer/App.tsx:open',
        'renderer/pages/SettingsPage.tsx:openWindow',
      ]),
    );
  });

  it('catches what it claims to', () => {
    const w = (code: string) => sourceFile(SCRAPTF_WINDOW, code);
    // Loads: the window module may load its window and view, and nothing may fetch.
    const loads = w(['view.webContents.loadURL(SCRAPTF_HOME_URL);', 'const b = new BrowserWindow({ title: "scrap.tf · Flip Desk" });', 'void fetch(SCRAPTF_HOME_URL);'].join('\n'));
    expect(scraptfLoads([loads]).map((h) => h.split(':')[1])).toEqual(['3']);
    expect(scraptfLoads([sourceFile('main/windows.ts', 'win.loadURL(SCRAPTF_HOME_URL);')])).toHaveLength(1);

    const nav = w(
      [
        'function userNavigate(nav) { if (nav.kind === "start" && isAllowedWindowStart(nav.url)) void wc.loadURL(nav.url); else if (nav.kind === "back") wc.navigationHistory.goBack(); }',
        'function back() { userNavigate({ kind: "back" }); }',
        'function onFail() { wc.reload(); }',
        'function open() { bar.webContents.loadURL(SCRAPTF_BAR_URL); wc.on("did-fail-load", () => userNavigate({ kind: "reload" })); }',
        'function readPage() { userNavigate({ kind: "reload" }); }',
        'function home() { wc.once("dom-ready", () => wc.loadURL(SCRAPTF_HOME_URL)); }',
        'function focus() { if (win.isMinimized()) win.restore(); }',
      ].join('\n'),
    );
    expect(windowNavigationProblems(nav)).toEqual([
      'main/scraptfWindow.ts:3: .reload( outside userNavigate',
      'main/scraptfWindow.ts:6: .loadURL(SCRAPTF_HOME_URL in a deferred callback',
      'main/scraptfWindow.ts:4: userNavigate called in a deferred callback',
      'main/scraptfWindow.ts:5: userNavigate called from readPage',
    ]);
    expect(windowNavigationProblems(w('function userNavigate(nav) { void wc.loadURL(nav.url); }'))).toEqual(['userNavigate loads a URL without isAllowedWindowStart']);
    // A user action reaches userNavigate: called from a listener, a promise callback or another function, it is a move nobody clicked.
    const actions = w(
      [
        'function reload() { userNavigate({ kind: "reload" }); }',
        'function wireView(wc) { wc.on("did-fail-load", () => reload()); wc.on("render-process-gone", () => home()); }',
        'function readPage() { return deps.importHtml(p).then(() => home()); }',
        'function startAutoRead() { go(SCRAPTF_HOME_URL); }',
        'function home() { if (closed) open(); else userNavigate({ kind: "start", url: SCRAPTF_HOME_URL }); }',
        'function go(url) { open(url); }',
        'interface M { open(start?: string): void; clear(): Promise<void> }',
        'function dropView() { pages.clear(); wc.reload; }',
      ].join('\n'),
    );
    expect(windowNavigationProblems(actions)).toEqual([
      'main/scraptfWindow.ts:2: reload() called in a deferred callback',
      'main/scraptfWindow.ts:2: home() called in a deferred callback',
      'main/scraptfWindow.ts:3: home() called in a deferred callback',
      'main/scraptfWindow.ts:4: go() called from startAutoRead',
    ]);
    // F21-11: pressKey moves the view only from the two input listeners, after their checks, and only by Back,
    // Forward, Reload or Home. Any other listener, a listener without the check, a timer inside the listener,
    // another function: flagged.
    const keys = w(
      [
        'function pressKey(action) { if (action === "back") back(); else if (action === "forward") forward(); else if (action === "reload") reload(); else home(); }',
        "wc.on('before-input-event', (event, input) => { const action = isCurrent(wc) ? windowKeyAction(input) : null; if (action === null) return; event.preventDefault(); pressKey(action); });",
        "w.on('app-command', (_event, command) => { const action = appCommandAction(command); if (action !== null) pressKey(action); });",
        "wc.on('did-finish-load', () => pressKey('reload'));",
        "wc.on('before-input-event', (event, input) => { event.preventDefault(); pressKey('reload'); });",
        "function readPage() { pressKey('back'); }",
        "wc.on('before-input-event', (event, input) => { const action = windowKeyAction(input); if (action !== null) { event.preventDefault(); timers.setTimeout(() => pressKey(action), 10); } });",
        "wc.on('before-input-event', (event, input) => { let action = windowKeyAction(input); event.preventDefault(); action = 'reload'; pressKey(action); });",
        'pressKey("home");',
        // BND-1: anything but the check's own choice in the initialiser acts when the check chose nothing
        // (every key down, key up and auto-repeat), or acts on a key of its own.
        "wc.on('before-input-event', (event, input) => { const action = windowKeyAction(input) ?? 'reload'; event.preventDefault(); pressKey(action); });",
        "w.on('app-command', (_event, command) => { const action = appCommandAction(command) || 'back'; pressKey(action); });",
        "wc.on('before-input-event', (event, input) => { const action = 'reload' || windowKeyAction(input); event.preventDefault(); pressKey(action); });",
        "wc.on('before-input-event', (event, input) => { const action = windowKeyAction(input) ? 'reload' : null; if (action === null) return; event.preventDefault(); pressKey(action); });",
      ].join('\n'),
    );
    expect(windowKeyProblems(keys)).toEqual([
      'main/scraptfWindow.ts:4: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:5: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:6: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:7: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:8: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:9: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:10: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:11: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:12: pressKey() outside the two input listeners',
      'main/scraptfWindow.ts:13: pressKey() outside the two input listeners',
    ]);
    // Its own moves are allowed to it alone; anything more is not.
    expect(windowNavigationProblems(keys)).toEqual([]);
    const greedy = w('function pressKey(action) { if (action === "back") back(); else go(SCRAPTF_HOME_URL); clear(); wc.reload(); }');
    expect(windowKeyProblems(greedy)).toEqual(['pressKey loads or steps the view itself', 'pressKey calls go()', 'pressKey calls clear()']);
    expect(windowNavigationProblems(greedy)).toEqual([
      'main/scraptfWindow.ts:1: .reload( outside userNavigate',
      'main/scraptfWindow.ts:1: go() called from pressKey',
      'main/scraptfWindow.ts:1: clear() called from pressKey',
    ]);
    const twice = w(
      [
        "wc.on('before-input-event', (event, input) => { const action = windowKeyAction(input); if (action === null) return; event.preventDefault(); pressKey(action); });",
        "v.on('before-input-event', (event, input) => { const action = windowKeyAction(input); if (action === null) return; event.preventDefault(); pressKey(action); });",
      ].join('\n'),
    );
    expect(windowKeyProblems(twice)).toEqual(['2 before-input-event listeners call pressKey (one allowed)']);
    // In main's other files: the tray action and the router's cases are clicks; a timer, a listener, a
    // subscription or a promise callback is not.
    const mainCalls = [
      sourceFile(
        'main/main.ts',
        [
          'setInterval(() => rt.scraptfWindow?.reload(), 30_000);',
          'settings.onChange(() => rt.scraptfWindow?.open());',
          'host.on("ready", () => runtime.scraptfWindow.home());',
          'load().then(() => actions.openScraptfWindow());',
          'const tray = { openScraptfWindow: () => { rt.scraptfWindow?.open(); } };',
          'app.on("web-contents-created", (_e, c) => rt.scraptfWindow?.ownsContents(c));',
        ].join('\n'),
      ),
      sourceFile(
        'main/ipc.ts',
        [
          "case 'scraptfWindow.back': windowOn().back(); return { ok: true };",
          'const w = windowOn(); w.open(p.start); deps.scraptfWindow.open(url);',
          'queueMicrotask(() => windowOn().reload());',
          'promise.finally(() => w.go(url));',
          'interface T { openScraptfWindow(): void }',
        ].join('\n'),
      ),
    ];
    expect(mainWindowCallProblems(mainCalls)).toEqual([
      'main/main.ts:1: scraptfWindow?.reload(',
      'main/main.ts:2: scraptfWindow?.open(',
      'main/main.ts:3: scraptfWindow.home(',
      'main/main.ts:4: openScraptfWindow(',
      'main/ipc.ts:3: windowOn().reload(',
      'main/ipc.ts:4: w.go(',
    ]);
    // 0.7.3: code after an await is a promise callback too: a loop, a case or an if block that waits and then
    // moves the window is an auto-refresher. The call's own await, an await after it and the harness are not.
    const awaited = (rel: string, code: string) => mainWindowCallProblems([sourceFile(rel, code)]);
    expect(
      awaited('main/ipc.ts', "case 'scraptfWindow.open': { const w = windowOn(); void (async () => { for (;;) { await new Promise((r) => setTimeout(r, 30_000)); windowOn().reload(); } })(); }"),
    ).toEqual(['main/ipc.ts:1: windowOn().reload( (after an await)']);
    expect(awaited('main/ipc.ts', "case 'scraptfWindow.home':\nawait sleep(30_000);\nwindowOn().home();")).toEqual(['main/ipc.ts:3: windowOn().home( (after an await)']);
    expect(awaited('main/ipc.ts', "case 'scraptfWindow.go': {\nawait sleep(30_000);\nif (p.url) {\nw.go(p.url);\n}\n}")).toEqual(['main/ipc.ts:4: w.go( (after an await)']);
    expect(awaited('main/main.ts', 'async function poll() { while (true) { await delay(30_000); rt.scraptfWindow?.reload(); } }')).toEqual(['main/main.ts:1: scraptfWindow?.reload( (after an await)']);
    expect(awaited('main/ipc.ts', "case 'scraptfWindow.clear':\nif (!deps.scraptfWindow) throw new Error(X);\nawait deps.scraptfWindow.clear();\nreturn { ok: true };")).toEqual([]);
    expect(awaited('main/ipc.ts', "case 'links.open': { if (ok) { deps.scraptfWindow.open(url); return x; } await deps.openExternal(url); }")).toEqual([]);
    expect(awaited('main/ipc.ts', "case 'import.pickFile': { const f = await pick(); return f; }\ncase 'scraptfWindow.back':\nwindowOn().back();")).toEqual([]);
    expect(awaited('main/main.ts', "const later = async () => { await x(); };\nlog('await');\nrt.scraptfWindow?.open();")).toEqual([]);
    expect(awaited(SMOKE_WINDOW, 'await quiet(); rt.scraptfWindow.go(url);')).toEqual([]);

    const timers = w(
      [
        'const REAL_TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };',
        "settle = timers.setTimeout(() => void readPage('settle'), READ_SETTLE_MS);",
        'timers.setTimeout(() => wc.reload(), 60_000);',
        "setInterval(() => void readPage('settle'), READ_SETTLE_MS);",
        "timers.setTimeout(() => readPage('settle'), READ_SETTLE_MS);",
        'interface T { setTimeout(fn: () => void, ms: number): unknown }',
        "async function readPage(t) { const html = await wc.executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code: READ_SCRIPT }]); timers.setTimeout(() => void readPage('settle'), READ_SETTLE_MS); }",
      ].join('\n'),
    );
    expect(windowTimerProblems(timers)).toEqual([
      'main/scraptfWindow.ts:3: a timer that is not the settle read: () => wc.reload()',
      'main/scraptfWindow.ts:4: setInterval is not allowed',
      '3 settle timers (one allowed)',
      'readPage starts a timer',
    ]);
    // The read's import helpers run from listeners too (endCycle at a commit): they may not move or wait either.
    expect(
      windowTimerProblems(
        w(['function flushHeld() { home(); }', 'function importRead(s) { wc.navigationHistory.goBack(); }', 'function endCycle() { clearSettle(); flushHeld(); }'].join('\n')),
      ),
    ).toEqual(['importRead navigates', 'flushHeld navigates']);

    const exec = [
      w(
        [
          'await wc.executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code: READ_SCRIPT }]);',
          'await wc.executeJavaScriptInIsolatedWorld(0, [{ code: "document.cookie" }]);',
          'await wc.executeJavaScript("1");',
          'wc.sendInputEvent({ type: "mouseDown" });',
          'wc.paste();',
          'seen.delete(key);',
        ].join('\n'),
      ),
      sourceFile('main/windows.ts', 'await c.executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code: READ_SCRIPT }]);\nconst READ_SCRIPT = "x";'),
    ];
    expect(windowExecProblems(exec).map((h) => h.split(': ').slice(0, 2).join(': '))).toEqual([
      'main/scraptfWindow.ts:2: runs something other than READ_SCRIPT in READ_WORLD_ID',
      'main/scraptfWindow.ts:3: executeJavaScript',
      'main/scraptfWindow.ts:3: .executeJavaScript(',
      'main/scraptfWindow.ts:4: .sendInputEvent(',
      'main/scraptfWindow.ts:5: .paste()',
      'main/windows.ts:1: isolated-world script outside the window module',
      'main/windows.ts:2: READ_SCRIPT defined again',
    ]);
    // 0.7.3: the same outside the window module (hardenWebContents and main's 'web-contents-created' listener
    // see the scrap.tf view too). main.ts keeps one executeJavaScript, in runSmokeTest, not deferred.
    const pageWrites = [
      sourceFile('main/windows.ts', "contents.on('dom-ready', () => void contents.insertCSS('#ad{display:none}'));\ncontents.selectAll(); contents.paste();\ncontents.insertText('x');\ncontents.replace();"),
      sourceFile('main/settingsStore.ts', 'hotkeys.undo();\ncontents.undo();'),
      sourceFile('main/smokeWindow.ts', 'wc.sendInputEvent(e);\nwc.paste();'),
    ];
    expect(windowExecProblems(pageWrites)).toEqual([
      'main/windows.ts:1: .insertCSS(',
      'main/windows.ts:2: .selectAll()',
      'main/windows.ts:2: .paste()',
      'main/windows.ts:3: .insertText(',
      'main/windows.ts:4: .replace()',
      'main/settingsStore.ts:2: .undo()',
      'main/smokeWindow.ts:2: .paste()',
    ]);
    // 0.7.3: the DevTools Protocol does all of that and reads cookies; a `debugger;` statement is not it.
    const cdp = sourceFile(
      'main/windows.ts',
      "contents.debugger.attach('1.3');\nvoid contents.debugger.sendCommand('Runtime.evaluate', { expression: 'document.title' });\nvoid c.webContents.debugger.sendCommand('Network.getAllCookies');\ndebugger;",
    );
    expect(offenders(PAGE_DEBUGGER, () => false, [cdp]).map((h) => h.split(':')[1])).toEqual(['1', '2', '2', '3', '3']);
    const mainExec =(code: string) => windowExecProblems([sourceFile('main/main.ts', code)]).map((h) => h.split(': ').slice(0, 2).join(': '));
    expect(
      mainExec("app.on('web-contents-created', (_e, c) => c.on('dom-ready', () => void c.executeJavaScript('1')));\nasync function runSmokeTest() { const k = await contents.executeJavaScript('2'); }"),
    ).toEqual(['main/main.ts:1: executeJavaScript', 'main/main.ts:2: executeJavaScript']);
    expect(mainExec("async function runSmokeTest() { contents.on('dom-ready', () => contents.executeJavaScript('1')); }")).toEqual(['main/main.ts:1: executeJavaScript']);
    expect(mainExec("async function runSmokeTest() { const k = await view.webContents.executeJavaScript('1'); }")).toEqual(['main/main.ts:1: executeJavaScript']);
    expect(mainExec("async function runSmokeTest() { const k = await contents.executeJavaScript('1'); }")).toEqual([]);
    // The user agent through the webContents property, and a session's own connection or DNS lookup to scrap.tf.
    const sneaky = w(['v.webContents.userAgent = "Mozilla/5.0 Chrome/140";', 'ses.preconnect({ url: SCRAPTF_HOME_URL, numSockets: 1 });', 'void ses.resolveHost("scrap.tf");', 'if (navigator.userAgent === ua) log(ua);'].join('\n'));
    expect(offenders(UA_SETTERS, () => false, [sneaky]).map((h) => h.split(':')[1])).toEqual(['1']);
    expect(offenders(WINDOW_REQUEST, () => false, [sneaky]).map((h) => h.split(':')[1])).toEqual(['2', '3']);
    expect(scraptfLoads([sneaky]).map((h) => h.split(':')[1])).toEqual(['2', '3']);
    expect(scraptfLoads([sourceFile('main/windows.ts', 'ses.preconnect({ url: "https://scrap.tf/" });')])).toHaveLength(1);
    // 0.7.3: a page save or a download of the window module's own, and a page save anywhere (it takes no address).
    const save = w("await wc.savePage(tmpFile, 'HTMLOnly');\nwc.downloadURL(SCRAPTF_HOME_URL);");
    expect(offenders(WINDOW_REQUEST, () => false, [save]).map((h) => h.split(':')[1])).toEqual(['1', '2']);
    expect(offenders(/\.\s*(?:savePage|downloadURL)\s*\(/, () => false, [sourceFile('main/main.ts', "contents.savePage(tmp, 'HTMLComplete');")])).toHaveLength(1);
    expect(readScriptProblems('document.body.innerHTML = ""')).toEqual(['=', 'innerHTML']);
    expect(readScriptProblems("fetch('/ajax/')")).toEqual(['fetch']);
    expect(readScriptProblems('document.querySelector("a").click()')).toEqual(['click']);

    const view = w(
      [
        'function scraptfViewWebPreferences(partition, devTools) { return { partition, preload: p, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }; }',
        'const v = new WebContentsView({ webPreferences: { preload: p } });',
        'const v2 = new WebContentsView({ webPreferences: scraptfViewWebPreferences(partition, dev) });',
      ].join('\n'),
    );
    expect(windowViewProblems(view)).toEqual([
      '2 WebContentsViews (one allowed)',
      'the view is not built from scraptfViewWebPreferences: {webPreferences:{preload:p}}',
      'the view has a preload',
      'the view lacks nodeIntegrationInWorker: false',
      'the view lacks nodeIntegrationInSubFrames: false',
      'the view lacks allowRunningInsecureContent: false',
      'the view lacks webviewTag: false',
      'main/scraptfWindow.ts:2: webPreferences not from the two helpers',
      'a preload key in the window module',
    ]);

    const page = sourceFile(
      'renderer/pages/ScraptfWindowBar.tsx',
      [
        "useEffect(() => { void rpc('scraptfWindow.reload'); }, []);",
        "usePush('scraptfWindow.nav', () => rpc('scraptfWindow.read'));",
        "onClick={() => void rpc('scraptfWindow.reload')}",
        "setInterval(() => rpc('scraptfWindow.go', { url }), 5000);",
        "rpc('scraptfWindow.state').then(() => rpc('scraptfWindow.home'));",
        "usePush('scraptfWindow.read', (r) => setRead(r));",
        "const id = setTimeout(() => void rpc('scraptfWindow.clear'), 5000);",
        "onConfirm={() => rpc('scraptfWindow.clear').then(() => setRead(null))}",
        // 0.7.3: useVisiblePush is a push listener and useRpcQuery calls its method in an effect.
        "useVisiblePush('scraptf.changed', () => void rpc('scraptfWindow.reload'));",
        "const q = useRpcQuery('scraptfWindow.reload', undefined);",
        "useVisiblePush('scraptfWindow.read', () => setBusy(false));",
      ].join('\n'),
    );
    expect(deferredWindowCalls([page]).map((h) => h.split(':')[1])).toEqual(['1', '2', '4', '5', '7', '9', '10']);
    // 0.7.1 (F21-8): an open worded for the window, openOnScraptf and Show flips, from a click only.
    const opens = sourceFile(
      'renderer/pages/BanksPage.tsx',
      [
        'useEffect(() => { void openOrCopy(url, toast, { allowWindow: true }); }, [url]);',
        "usePush('scraptf.changed', () => void openOnScraptf(url, name, toast, arm));",
        "rpc('scraptf.bankStock', q).then(() => rpc('app.showBankStock', { bank, filter: 'new' }));",
        'setTimeout(() => void openLink(url, { allowWindow: true }), 100);',
        'onOpenBank={(c) => void openOrCopy(c.url, toast, { allowWindow: true })}',
        "onClick={() => void rpc('app.showBankStock', { bank, filter: 'flips' })}",
        'onClick={() => void openOnScraptf(url, name, toast, arm)}',
        'useEffect(() => { void openOrCopy(url, toast); }, [url]);',
        "usePush('ui.openBankStock', (p) => navigate(p.bank));",
      ].join('\n'),
    );
    expect(deferredWindowOpens([opens]).map((h) => h.split(':')[1])).toEqual(['1', '2', '3', '4']);
    // 0.7.3: the same calls made through a wrapper, a map or a bare function reference; clicks, a key handler,
    // a prop, a subscription and an effect's dependency list are not calls.
    const wrapped = sourceFile(
      'renderer/pages/ScraptfWindowBar.tsx',
      [
        "const NAV = { reload: 'scraptfWindow.reload' };",
        'export function Bar() {',
        '  const act = (a) => { rpc(NAV[a]); };',
        "  const readNow = () => { rpc('scraptfWindow.read'); };",
        "  useInterval(() => act('reload'), 30_000, true);",
        "  usePush('scraptfWindow.nav', () => void rpc(NAV.reload));",
        '  useEffect(() => { readNow(); }, []);',
        "  rpc('scraptfWindow.state').then(() => act('home'));",
        '  setTimeout(readNow, 1000);',
        "  usePush('scraptfWindow.read', (r) => setRead(r));",
        '  useEffect(() => { if (busy) setBusy(false); }, [act, readNow]);',
        "  useVisiblePush('scraptf.changed', () => act('home'));",
        "  const onKeyDown = (e) => { if (e.key === 'F5') act('reload'); };",
        "  return <div onKeyDown={onKeyDown}><NavButton onAct={act} /><button onClick={() => act('reload')} /></div>;",
        '}',
      ].join('\n'),
    );
    expect(deferredWindowWrappers([wrapped]).map((h) => h.split(':').slice(1).join(':'))).toEqual(['5: act', '6: NAV', '7: readNow', '8: act', '9: readNow', '12: act']);
    expect(deferredWindowCalls([wrapped])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// --smoke-window: the F21 window's hermetic test (diagnostics only). main/smokeWindow.ts is the one file
// besides the window module that drives the window: it calls the manager outside a click, focuses the view,
// sends it input events, loads the fixture pages into it and answers its sessions' requests locally
// (protocol.handle, webRequest). main.ts loads it only in its gated branch, and no production module imports
// it or its router. Nothing else gains an allowance; the scans above hold the harness to the rest.
// ---------------------------------------------------------------------------

const SMOKE_WINDOW = 'main/smokeWindow.ts';
const SMOKE_FIXTURES = 'main/smokeWindowFixtures.ts';
/** A page's own focus (a webContents'); BrowserWindow.focus() (`w`, `win`) is the window's and is not one. */
const CONTENTS_FOCUS = /(?:\bwc|\bview|\bcontents|\bwebContents)\s*\.\s*focus\s*\(/g;
const INPUT_EVENT = /\.\s*sendInputEvent\s*\(/g;
const LOAD_URL = /\.\s*loadURL\s*\(/g;
const PROTOCOL_HANDLE = /\bprotocol\s*\.\s*handle\s*\(/g;
const OLD_PROTOCOL_API = /\b(?:register|intercept)(?:String|Buffer|File|Http|Stream)Protocol\s*\(/g;
const WEB_REQUEST = /\bwebRequest\b/g;
/** A module specifier naming the harness or its router. */
const SMOKE_SPECIFIER = /['"](?:\.{1,2}\/)+(?:[\w.-]+\/)*smokeWindow(Fixtures)?['"]/g;

/** True when the call at `at` (its ".") is made on `receiver` (the view's webContents is `wc` in the harness). */
function calledOn(code: string, at: number, receiver: RegExp): boolean {
  return new RegExp(`(?<![\\w$.])${receiver.source}\\s*$`).test(code.slice(Math.max(0, at - 40), at));
}

/**
 * What only the window test may do, found anywhere else, and the harness's own calls off their pinned shape:
 * input events and focus only to the view (`wc`), loads only of a fixture page (SMOKE_…_URL) into it, a
 * session's https and http answered by the router (`answer`), only the request filter's onBeforeRequest, and
 * the harness imported by main.ts alone (a type, and one import()) and its router by the harness alone.
 */
function smokeWindowProblems(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const at = (i: number) => `${f.rel}:${lineAt(f.code, i)}`;
    const harness = f.rel === SMOKE_WINDOW;
    for (const m of f.code.matchAll(INPUT_EVENT)) {
      if (!harness) out.push(`${at(m.index)}: sendInputEvent outside the window test`);
      else if (!calledOn(f.code, m.index, /wc/)) out.push(`${at(m.index)}: sendInputEvent to something but the view`);
    }
    if (f.rel.startsWith('main/')) {
      for (const m of f.code.matchAll(CONTENTS_FOCUS)) if (!harness || !m[0].startsWith('wc')) out.push(`${at(m.index)}: ${m[0].replace(/\s+/g, '')}) moves a page's focus`);
    }
    for (const m of f.code.matchAll(LOAD_URL)) {
      const open = m.index + m[0].length - 1;
      if (isSignature(f.code, open) || f.rel === 'main/windows.ts' || f.rel === SCRAPTF_WINDOW) continue;
      const args = callArgs(f.code, open).trim();
      if (!harness) out.push(`${at(m.index)}: loadURL(${args.slice(0, 60)}) outside the window modules`);
      else if (!calledOn(f.code, m.index, /wc/) || !/^SMOKE_\w+_URL$/.test(args)) out.push(`${at(m.index)}: loadURL(${args.slice(0, 60)}) is not a fixture page into the view`);
    }
    for (const m of f.code.matchAll(PROTOCOL_HANDLE)) {
      if (f.rel === 'main/protocol.ts') continue;
      const args = topLevelArgs(callArgs(f.code, m.index + m[0].length - 1));
      if (!harness) out.push(`${at(m.index)}: protocol.handle outside the app:// scheme and the window test`);
      else if (!calledOn(f.code, m.index, /ses\./) || args.length !== 2 || !["'https'", "'http'"].includes(args[0]!) || args[1] !== 'answer') {
        out.push(`${at(m.index)}: protocol.handle(${args.join(', ').slice(0, 60)}) is not a window session's http(s) answered by the router`);
      }
    }
    for (const m of f.code.matchAll(OLD_PROTOCOL_API)) out.push(`${at(m.index)}: ${m[0]}`);
    for (const m of f.code.matchAll(WEB_REQUEST)) {
      if (f.rel === 'main/windows.ts') continue;
      if (!harness) out.push(`${at(m.index)}: webRequest outside the app's request filter and the window test`);
      else if (!/^webRequest\s*\.\s*onBeforeRequest\s*\(/.test(f.code.slice(m.index))) out.push(`${at(m.index)}: a webRequest hook other than onBeforeRequest`);
    }
    for (const m of f.code.matchAll(SMOKE_SPECIFIER)) {
      const before = f.code.slice(Math.max(0, m.index - 80), m.index);
      if (m[1] !== undefined) {
        if (!harness) out.push(`${at(m.index)}: imports the window test's router`);
      } else if (f.rel !== 'main/main.ts') out.push(`${at(m.index)}: imports the window test`);
      else if (!/\bimport\s*\(\s*$/.test(before) && !/\bimport\s+type\s*\{[^}]*\}\s*from\s*$/.test(before)) out.push(`${at(m.index)}: main.ts imports the window test outside its gated import()`);
    }
  }
  return out;
}

describe('the window test (--smoke-window) is diagnostics-only and answers every request of the window locally (F21)', () => {
  const file = (rel: string) => FILES.find((f) => f.rel === rel)!;

  it('finds the harness and its router', () => {
    expect(file(SMOKE_WINDOW)).toBeDefined();
    expect(file(SMOKE_FIXTURES)).toBeDefined();
  });

  it('lets only the harness focus the view, send it input, load pages into it and answer its requests', () => {
    expect(smokeWindowProblems(FILES)).toEqual([]);
    // The scans see the harness's real calls.
    const h = file(SMOKE_WINDOW).code;
    expect([...h.matchAll(INPUT_EVENT)].length).toBeGreaterThan(0);
    expect([...h.matchAll(LOAD_URL)].length).toBeGreaterThan(0);
    expect([...h.matchAll(PROTOCOL_HANDLE)]).toHaveLength(2);
    expect([...h.matchAll(WEB_REQUEST)]).toHaveLength(1);
    // The request filter cancels every scheme but http(s), which the router answers, and http(s) too until
    // both handlers are in (fail closed).
    expect(h).toMatch(/onBeforeRequest\(\(details, callback\) => \{[^]*?if \(local && \(scheme === 'https:' \|\| scheme === 'http:'\)\)[^]*?callback\(\{ cancel: true \}\);/);
    expect(h).toMatch(/ses\.protocol\.handle\('https', answer\);\s*ses\.protocol\.handle\('http', answer\);\s*local = true;/);
    // Nothing goes to the user's browser in the run: the opener is replaced, and checked before the window opens.
    expect(h).toContain('shell.openExternal = refuse;');
    expect(h).toContain('outsideRefused = shell.openExternal === refuse;');
    expect(h).toMatch(/if \(!outsideRefused\) return fail\(/);
  });

  it('never reaches the network from the harness or its router', () => {
    const both = [file(SMOKE_WINDOW), file(SMOKE_FIXTURES)];
    expect(offenders(WINDOW_REQUEST, () => false, both)).toEqual([]);
    expect(
      offenders(
        /\bnet\s*\.\s*\w+\s*\(|import\s*\{[^}]*\bnet\b[^}]*\}\s*from\s*['"]electron['"]|from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|child_process)['"]|from\s+['"](?:ws|socket\.io-client)['"]|(?:\.\.\/)+service\/net/,
        () => false,
        both,
      ),
    ).toEqual([]);
    // The router is pure: shared rules only, no Electron, file or process access.
    expect(offenders(/from\s+['"](?!\.\.\/shared\/)[^'"]+['"]|\bprocess\.|\brequire\s*\(/, () => false, [file(SMOKE_FIXTURES)])).toEqual([]);
    // Neither writes a scrap.tf address of its own: every one is built from the shared constants.
    expect(offenders(/\b(?:https?|wss?):\/\/([a-z0-9-]+\.)*scrap\.tf\b|['"`]scrap\.tf\//i, () => false, both)).toEqual([]);
  });

  it('calls the window manager only from the tray, the router and the harness, never deferred', () => {
    // The tray's menu click (tray.ts) and main's action behind it, the router's cases, and the harness.
    const callers = new Set(offenders(MAIN_WINDOW_CALL, (r) => !r.startsWith('main/') || r === SCRAPTF_WINDOW).map((h) => h.split(':')[0]));
    expect([...callers].sort()).toEqual(['main/ipc.ts', 'main/main.ts', SMOKE_WINDOW, 'main/tray.ts']);
    expect(offenders(MAIN_WINDOW_CALL, () => false, [file('main/main.ts')]).map((h) => h.split(': ')[1])).toEqual(['scraptfWindow?.open(']);
    // 0.7.3: the router's too: one call per 'scraptfWindow.*' case (open has two branches) and links.open's one.
    expect(offenders(MAIN_WINDOW_CALL, () => false, [file('main/ipc.ts')]).map((h) => h.split(': ')[1])).toEqual([
      'scraptfWindow.open(',
      'w.open(',
      'w.open(',
      'windowOn().back(',
      'windowOn().forward(',
      'windowOn().reload(',
      'windowOn().home(',
      'w.go(',
      'windowOn().readNow(',
      'scraptfWindow.clear(',
    ]);
    expect(mainWindowCallProblems([file(SMOKE_WINDOW)])).toEqual([]);
    expect(offenders(MAIN_WINDOW_CALL, () => false, [file(SMOKE_WINDOW)]).length).toBeGreaterThanOrEqual(4);
  });

  it('is loaded only by main.ts, behind the diagnostics gate and the profile check, and nothing starts when the gate refuses', () => {
    const main = file('main/main.ts').code;
    expect(main).toContain("const allowDiagnostics = !app.isPackaged || process.env['FLIPDESK_DIAGNOSTICS'] === '1';");
    expect(main).toContain('const args = parseLaunchArgs(process.argv, process.cwd(), { allowDiagnostics });');
    expect(main).toMatch(
      /const smokeWindowRefused = smokeWindowRefusal\(args, \{\s*allowDiagnostics,\s*defaultUserData: \[path\.join\(app\.getPath\('appData'\), app\.getName\(\)\)\],\s*platform: process\.platform,\s*\}\);/,
    );
    // The one import of the harness's code, inside the branch the gate allows.
    const GATE = 'if (args.smokeWindow !== null && smokeWindowRefused === null) {';
    const imports = [...main.matchAll(/\bimport\s*\(\s*['"]\.\/smokeWindow['"]\s*\)/g)];
    expect(imports).toHaveLength(1);
    const branch = main.indexOf(GATE);
    expect(branch).toBeGreaterThan(-1);
    expect(main.indexOf(GATE, branch + 1)).toBe(-1);
    expect(imports[0]!.index).toBeGreaterThan(branch);
    expect(imports[0]!.index).toBeLessThan(blockEnd(main, branch + GATE.length - 1));
    expect([...main.matchAll(/['"]\.\/smokeWindow['"]/g)]).toHaveLength(2);
    expect(main).toContain("import type { SmokeWindowRun } from './smokeWindow';");
    // The run's Chromium resolves no host name and uses no proxy (which would resolve names for it), under the
    // same condition.
    expect(main).toContain("if (args.smokeWindow !== null && smokeWindowRefused === null) app.commandLine.appendSwitch('host-resolver-rules', SMOKE_WINDOW_HOST_RULES);");
    expect(main).toContain('if (args.smokeWindow !== null && smokeWindowRefused === null) app.commandLine.appendSwitch(SMOKE_WINDOW_NO_PROXY);');
    expect([...main.matchAll(/appendSwitch\(/g)]).toHaveLength(2);
    // A refusal exits before the instance lock and bootstrap, which run only in the branches after it.
    const REFUSED = 'if (smokeWindowRefused !== null) {';
    const refusal = main.indexOf(REFUSED);
    expect(refusal).toBeGreaterThan(-1);
    const end = blockEnd(main, refusal + REFUSED.length - 1);
    expect(main.slice(refusal, end)).toContain('app.exit(1);');
    expect(main.slice(refusal, end)).not.toMatch(/bootstrap\(|start\(|requestSingleInstanceLock|setPath/);
    expect(main.slice(end + 1)).toMatch(/^\s*else if \(!app\.requestSingleInstanceLock\(\)\)/);
    const boots = [...main.matchAll(/(?<![\w$.])bootstrap\(\);/g)];
    expect(boots).toHaveLength(1);
    expect(boots[0]!.index).toBeGreaterThan(end);
    // The profile is switched to the run's folder only when the gate let it through.
    expect(main).toContain('if (args.userDataDir && smokeWindowRefused === null) {');
    // And paths.ts reads the report path only with diagnostics, like --smoke-test.
    expect(file('main/paths.ts').code).toContain("const smokeWindow = diag ? flagValue(argv, 'smoke-window') : null;");
  });

  it('catches what it claims to', () => {
    const bad = [
      sourceFile(SCRAPTF_WINDOW, 'wc.sendInputEvent({ type: "keyDown", keyCode: "F5" });\nwc.focus();'),
      sourceFile('main/ipc.ts', 'view.webContents.focus();\nwin.loadURL(DASHBOARD_URL);\nw.focus();'),
      sourceFile('main/windows.ts', 'ses.webRequest.onBeforeRequest(f);\nwin.loadURL(DASHBOARD_URL);'),
      sourceFile('main/tray.ts', "ses.protocol.handle('https', answer);\nses.webRequest.onBeforeRequest(f);\nimport { prepareSmokeWindow } from './smokeWindow';"),
      sourceFile('service/core.ts', "import { routeSmokeRequest } from '../main/smokeWindowFixtures';\nprotocol.registerHttpProtocol('x', h);"),
      sourceFile(
        SMOKE_WINDOW,
        [
          'wc.loadURL(SMOKE_HATS_URL);',
          'wc.loadURL(SCRAPTF_HOME_URL);',
          'other.loadURL(SMOKE_HATS_URL);',
          'other.sendInputEvent(e);',
          "ses.protocol.handle('file', answer);",
          "protocol.handle('https', answer);",
          'ses.webRequest.onHeadersReceived(f);',
          'wc.focus();',
          'wc.sendInputEvent(e);',
          "ses.protocol.handle('https', (r) => fetchOut(r));",
          'view.focus();',
          'notwc.sendInputEvent(e);',
        ].join('\n'),
      ),
      sourceFile('main/main.ts', "import { prepareSmokeWindow } from './smokeWindow';\nconst m = await import('./smokeWindow');\nimport type { SmokeWindowRun } from './smokeWindow';"),
    ];
    expect(smokeWindowProblems(bad).map((h) => h.split(': ')[0])).toEqual([
      // The window module may neither send input nor focus its page.
      'main/scraptfWindow.ts:1',
      'main/scraptfWindow.ts:2',
      // Another main file: a page's focus and a load (a BrowserWindow's own focus is fine).
      'main/ipc.ts:1',
      'main/ipc.ts:2',
      // windows.ts keeps its request filter and its app:// loads.
      'main/tray.ts:1',
      'main/tray.ts:2',
      'main/tray.ts:3',
      'service/core.ts:2',
      'service/core.ts:1',
      // The harness: input to another target, a page that is not a fixture or a load into another view,
      // another scheme, the app's own protocol module or a handler other than the router, another hook.
      'main/smokeWindow.ts:4',
      'main/smokeWindow.ts:12',
      'main/smokeWindow.ts:11',
      'main/smokeWindow.ts:2',
      'main/smokeWindow.ts:3',
      'main/smokeWindow.ts:5',
      'main/smokeWindow.ts:6',
      'main/smokeWindow.ts:10',
      'main/smokeWindow.ts:7',
      // main.ts may import a type and import() the harness, never its code statically.
      'main/main.ts:1',
    ]);
  });
});
