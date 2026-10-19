// DESIGN_BRIEF Appendix B #2 and #3 as a static scan of src/: every network
// call goes through src/service/net (or one of the two policy-checked socket
// connectors), no browser User-Agent, no proxy plumbing, no backpack.tf
// /agent/ or listing-write calls, and scrap.tf URLs appear only where the user
// is shown or sent a link (R1). The runtime side is covered in test/net.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    // Style sheets too: a CSS url() or @import is a request from the dashboard.
    else if (/\.(ts|tsx|js|mjs|cjs|html|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Blanks block comments, keeping line numbers. */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Blanks block and line comments (keeping line numbers); `://` inside strings is left alone. */
function stripComments(src: string): string {
  return stripBlockComments(src)
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\/])\/\/.*$/, '$1'))
    .join('\n');
}

interface SourceFile {
  rel: string;
  code: string;
}

/**
 * A file as the scans read it. CSS has no line comments, and the `//` stripper would blank a
 * protocol-relative `url(//host/...)` (the `//` follows a "("), so style sheets lose block comments only.
 */
function sourceFile(rel: string, src: string): SourceFile {
  return { rel, code: rel.endsWith('.css') ? stripBlockComments(src) : stripComments(src) };
}

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
 * websocket and socket.io factories, and Electron windows and views.
 */
const LOADERS =
  /(?<![\w$.])(?:fetch|fetchImpl|io|socketFactory|wsFactory|factory)\s*\(|\.(?:request|fetch|loadURL|loadFile|openDevTools)\s*\(|\bnew\s+(?:WebSocket|EventSource|Worker|SharedWorker|BrowserWindow|BrowserView|WebContentsView)\s*\(/g;
/** An <img src> (or any src) built from a scrap.tf address. */
const SCRAPTF_IMG_SRC = /\bsrc\s*=\s*\{?[^>}\n]*(scrap\.tf|SCRAPTF_|scraptfPageFor|scraptfBankInfo|seenOn|bankPageUrl)/i;

/** `file:line: call(args)` for every loader call whose arguments carry a scrap.tf address (R1). */
function scraptfLoads(files: readonly SourceFile[] = FILES): string[] {
  const hits: string[] = [];
  for (const f of files) {
    for (const m of f.code.matchAll(LOADERS)) {
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
    expect(offenders(/\b(setUserAgent|userAgentFallback)\b/)).toEqual([]);
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
  });

  it('embeds no web content and loads no image from scrap.tf (no webview, iframe or view; R3)', () => {
    expect(offenders(/<\s*(iframe|webview|embed|object|frame)\b/i)).toEqual([]);
    expect(offenders(/\b(BrowserView|WebContentsView)\b|webviewTag\s*:\s*true/)).toEqual([]);
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
    ].join('\n');
    expect(scraptfLoads([sourceFile('service/Bad.ts', bad)]).map((h) => h.split(':')[1])).toEqual(['1', '2', '3', '4']);
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
    // The plain opens these files make of a scrap.tf page: the header's bank, the drawer's list and bank page.
    const plain = urlOpens(scoped(), 'openOrCopy|openLink').filter((o) => LOOKS_SCRAPTF.test(o.url) || LOOKS_SCRAPTF.test(o.trace.via));
    expect(plain.map((o) => o.url).sort()).toEqual(['SCRAPTF_ITEMS_URL', 'bankLink.url', 'bankPage']);
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
  // shell.openExternal is handed out twice in main: to links.open's deps and to the notification click.
  const shells = [...main.matchAll(/shell\.openExternal\s*\(/g)];
  if (shells.length !== 2) out.push(`main.ts calls shell.openExternal ${shells.length} times`);
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
    expect(notice).toMatch(/^function scraptfResaveNotice\(bank: ScraptfBank,[^]*?const info = scraptfBankInfo\(bank\);[^]*?openUrl: info\.url,/);
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

/** The text of a call's argument list from the "(" at `open` to its matching ")"; quotes are skipped. */
function callArgs(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  const end = Math.min(code.length, open + 4000);
  for (let i = open; i < end; i++) {
    const c = code[i]!;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1, end);
}
