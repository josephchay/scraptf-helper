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
    else if (/\.(ts|tsx|js|mjs|cjs|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Blanks block and line comments (keeping line numbers); `://` inside strings is left alone. */
function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\/])\/\/.*$/, '$1'))
    .join('\n');
}

interface SourceFile {
  rel: string;
  code: string;
}

const FILES: SourceFile[] = walk(SRC).map((f) => ({
  rel: path.relative(SRC, f).split(path.sep).join('/'),
  code: stripComments(readFileSync(f, 'utf8')),
}));

/** `file:line: text` for every match of `re` outside the allowed files. */
function offenders(re: RegExp, allowed: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  for (const f of FILES) {
    if (allowed(f.rel)) continue;
    for (const m of f.code.matchAll(new RegExp(re.source, flags))) {
      const line = f.code.slice(0, m.index).split('\n').length;
      out.push(`${f.rel}:${line}: ${m[0]}`);
    }
  }
  return out;
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
});
