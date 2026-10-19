// F18 S2: saved .mhtml files ("Webpage, Single File"). The extractor (src/service/import/mhtml.ts)
// reads only the first text/html part and decodes it (quoted-printable with soft breaks and =XX
// escapes, base64, the part's charset); parseSavedPage routes a file by its MIME headers and gives
// the parser the part's Content-Location as an address hint. Synthetic files built from the
// saved-page fixtures (mhtmlFixture.ts); nothing in them is ever fetched or opened (R1, R10).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImportTooLargeError,
  MAX_IMPORT_BYTES,
  MHTML_MAX_PARTS,
  decodeQuotedPrintable,
  extractMhtmlHtml,
  isMhtmlFileName,
  looksLikeMhtml,
  parseSavedPage,
  parseScrapTfHtml,
  readMhtml,
  warningCode,
} from '../../src/service/import';
import { createStubSchema } from './schemaStub';
import { BOUNDARY, PNG_1PX, buildMhtml, encodeBase64, encodeQuotedPrintable, fixture, mhtmlOf, resourceParts, withoutAddress } from './mhtmlFixture';

const HATS = fixture('buy_hats.html');
const codes = (ws: readonly string[]): string[] => ws.map(warningCode);
const bytes = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'latin1'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the synthetic fixture is what Chromium writes', () => {
  const file = mhtmlOf(HATS);

  it('is 7-bit MIME text with CRLF lines of at most 76 characters, "=" escaped and soft breaks in the page', () => {
    expect(file.startsWith('From: <Saved by Blink>\r\n')).toBe(true);
    expect(file).toContain('MIME-Version: 1.0\r\n');
    expect(file).toContain(`boundary="${BOUNDARY}"`);
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(file)).toBe(true);
    // The page's own lines (its part's body) are at most 76 characters.
    const start = file.indexOf('\r\n\r\n', file.indexOf('Content-Type: text/html')) + 4;
    const page = file.slice(start, file.indexOf(`\r\n--${BOUNDARY}`, start));
    expect(page.length).toBeGreaterThan(HATS.length);
    expect(page.split('\r\n').every((l) => l.length <= 76)).toBe(true);
    expect(file.split('\n').every((l, i, all) => i === all.length - 1 || l.endsWith('\r'))).toBe(true);
    expect(file).toContain('=3D');
    expect(file).toMatch(/=\r\n/);
    // The page is the first part; the file holds images, a style sheet and a second (frame) document after it.
    expect(file.indexOf('Content-Type: text/html')).toBeLessThan(file.indexOf('Content-Type: image/png'));
    expect(file.split(`--${BOUNDARY}\r\n`)).toHaveLength(1 + 1 + resourceParts().length);
  });
});

describe('readMhtml', () => {
  it('decodes the quoted-printable page back to the saved HTML (line breaks as CRLF)', () => {
    const r = readMhtml(mhtmlOf(HATS));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toBe(HATS.replace(/\r?\n/g, '\r\n'));
    expect(r.contentLocation).toBe('https://scrap.tf/buy/hats');
    expect(r.notes).toEqual([]);
  });

  it('reads the same page from bytes (one byte per char) as from the text', () => {
    const file = mhtmlOf(HATS);
    const fromBytes = readMhtml(bytes(file));
    const fromText = readMhtml(file);
    expect(fromBytes).toEqual(fromText);
    expect(extractMhtmlHtml(bytes(file))).toEqual({ html: HATS.replace(/\r?\n/g, '\r\n'), contentLocation: 'https://scrap.tf/buy/hats' });
  });

  it('decodes a base64 page, and LF-only files too', () => {
    const b64 = readMhtml(mhtmlOf(HATS, { encoding: 'base64' }));
    expect(b64).toMatchObject({ ok: true, html: HATS });
    const lf = readMhtml(mhtmlOf(HATS, { eol: '\n' }).replace(/\r\n/g, '\n'));
    expect(lf).toMatchObject({ ok: true, html: HATS.replace(/\r\n/g, '\n') });
  });

  it("decodes the part's charset (UTF-8 by default), and reads an unknown one as UTF-8 with a note", () => {
    const page = (type: string, encoding: string, body: string) => buildMhtml({ parts: [{ type, encoding, body }] });
    // "Café" in windows-1252 (é = E9), quoted-printable and base64.
    expect(readMhtml(page('text/html; charset=windows-1252', 'quoted-printable', '<p>Caf=E9</p>'))).toMatchObject({ ok: true, html: '<p>Café</p>' });
    expect(readMhtml(page('text/html; charset="ISO-8859-1"', 'base64', encodeBase64(Buffer.from('<p>Café</p>', 'latin1'))))).toMatchObject({ ok: true, html: '<p>Café</p>' });
    // UTF-8 by default: é is C3 A9, ★ is E2 98 85.
    expect(readMhtml(page('text/html', 'quoted-printable', '<p>Caf=C3=A9 =E2=98=85</p>'))).toMatchObject({ ok: true, html: '<p>Café ★</p>' });
    const unknown = readMhtml(page('text/html; charset=x-made-up', 'quoted-printable', '<p>Caf=C3=A9</p>'));
    expect(unknown).toMatchObject({ ok: true, html: '<p>Café</p>' });
    expect(unknown.ok && codes(unknown.notes)).toEqual(['mhtml-charset']);
  });

  it('takes the first text/html part only: never the frame document after it, and never decodes the other parts', () => {
    const r = readMhtml(mhtmlOf('<html><body>page</body></html>'));
    expect(r).toMatchObject({ ok: true, html: '<html><body>page</body></html>' });
    // The broken base64 image after the page is not even looked at; the same image as the page fails.
    const broken = buildMhtml({ parts: [{ type: 'text/html', encoding: 'base64', body: '!!! not base64 at all ***' }] });
    expect(readMhtml(broken)).toMatchObject({ ok: false, reason: 'mhtml-invalid' });
    // Resources before the page are skipped, not decoded.
    const late = buildMhtml({ parts: [...resourceParts().slice(0, 3), { type: 'text/html', encoding: 'quoted-printable', body: '<p>late</p>' }] });
    expect(readMhtml(late)).toMatchObject({ ok: true, html: '<p>late</p>' });
  });

  it('reads 7bit, 8bit and binary parts as they are, and a single-part file whose own type is text/html', () => {
    for (const encoding of ['7bit', '8bit', 'binary']) {
      expect(readMhtml(buildMhtml({ parts: [{ type: 'text/html', encoding, body: '<p>Café</p>' }] }))).toMatchObject({ ok: true, html: '<p>Café</p>' });
    }
    expect(readMhtml(buildMhtml({ parts: [{ type: 'text/html', body: '<p>none</p>' }] }))).toMatchObject({ ok: true, html: '<p>none</p>' });
    // Bytes in a charset: an 8bit windows-1252 part from a byte buffer.
    const latin = Buffer.concat([
      Buffer.from(`MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html; charset=windows-1252\r\nContent-Transfer-Encoding: 8bit\r\n\r\n<p>Caf`),
      Buffer.from([0xe9]),
      Buffer.from('</p>\r\n--b--\r\n'),
    ]);
    expect(readMhtml(Uint8Array.from(latin))).toMatchObject({ ok: true, html: '<p>Café</p>' });
    const single = 'MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: https://scrap.tf/unusuals/378\r\n\r\n<p class=3D"x">one</p>\r\n';
    expect(readMhtml(single)).toMatchObject({ ok: true, html: '<p class="x">one</p>\r\n', contentLocation: 'https://scrap.tf/unusuals/378' });
  });

  it("returns the page's Content-Location, else the file's Snapshot-Content-Location, else null, as text only", () => {
    expect(readMhtml(mhtmlOf('<p/>', { location: 'https://scrap.tf/unusuals/378', snapshot: 'https://scrap.tf/unusuals' }))).toMatchObject({ contentLocation: 'https://scrap.tf/unusuals/378' });
    expect(readMhtml(mhtmlOf('<p/>', { location: null, snapshot: 'https://scrap.tf/buy/stranges' }))).toMatchObject({ contentLocation: 'https://scrap.tf/buy/stranges' });
    expect(readMhtml(mhtmlOf('<p/>', { location: null, snapshot: null }))).toMatchObject({ ok: true, contentLocation: null });
    // Clipped like every header value before anything reads it.
    const long = readMhtml(mhtmlOf('<p/>', { location: `https://scrap.tf/buy/hats/${'x'.repeat(10_000)}` }));
    expect(long.ok && long.contentLocation!.length).toBe(4096);
  });

  it('reads folded header lines, keeps the first of a repeated field (its folds dropped) and ignores junk in a part header', () => {
    const file = [
      'MIME-Version: 1.0',
      'Content-Type: multipart/related;',
      '\ttype="text/html";',
      '\tboundary="b"',
      'Content-Type: text/plain;',
      '\tcharset=x',
      '',
      '--b',
      'not a header line',
      'Content-Type: text/html;',
      ' charset=windows-1252',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Location: https://scrap.tf/buy/hats',
      '',
      '<p>Caf=E9</p>',
      '--b--',
      '',
    ].join('\r\n');
    expect(readMhtml(file)).toMatchObject({ ok: true, html: '<p>Café</p>', contentLocation: 'https://scrap.tf/buy/hats' });
  });

  it('refuses a page cut short (it runs to the end of the file without its closing </html>), and reads a whole one', () => {
    const cut = buildMhtml({ parts: [{ type: 'text/html', encoding: 'quoted-printable', body: '<html><body><p>cut' }], unterminated: true });
    expect(readMhtml(cut)).toMatchObject({ ok: false, reason: 'mhtml-truncated' });
    for (const encoding of ['base64', '7bit']) {
      const body = encoding === 'base64' ? encodeBase64(Buffer.from('<html><body><p>cut')) : '<html><body><p>cut';
      expect(readMhtml(buildMhtml({ parts: [{ type: 'text/html', encoding, body }], unterminated: true }))).toMatchObject({ ok: false, reason: 'mhtml-truncated' });
    }
    // Only the closing delimiter is missing: the page itself is whole.
    const whole = buildMhtml({ parts: [{ type: 'text/html', encoding: 'quoted-printable', body: '<html><body><p>whole</p></body></HTML >' }], unterminated: true });
    expect(readMhtml(whole)).toMatchObject({ ok: true, html: '<html><body><p>whole</p></body></HTML >\r\n', notes: [] });
    // A file cut inside a later resource lost nothing of the page.
    const later = buildMhtml({ parts: [{ type: 'text/html', encoding: 'quoted-printable', body: '<p>whole</p>' }, { type: 'image/png', encoding: 'base64', body: 'iVBOR' }], unterminated: true });
    expect(readMhtml(later)).toMatchObject({ ok: true, html: '<p>whole</p>', notes: [] });
  });

  it('rejects malformed files with a reason: no MIME headers, not multipart, no boundary, no parts, bad encodings', () => {
    const cases: [string, string][] = [
      ['<!DOCTYPE html><html></html>', 'mhtml-invalid'],
      ['just some text\r\n\r\n', 'mhtml-invalid'],
      ['MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nhello', 'mhtml-invalid'],
      ['MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\n--x\r\n', 'mhtml-invalid'],
      [`MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${'b'.repeat(71)}"\r\n\r\n`, 'mhtml-invalid'],
      ['MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\nno delimiter anywhere', 'mhtml-invalid'],
      // Headers that never end (no blank line) are not headers.
      [`MIME-Version: 1.0\r\n${'X-Pad: y\r\n'.repeat(3000)}`, 'mhtml-invalid'],
      [buildMhtml({ parts: [{ type: 'text/html', encoding: 'x-uuencode', body: 'begin 644 x' }] }), 'mhtml-invalid'],
      [buildMhtml({ parts: [{ type: 'image/png', encoding: 'base64', body: encodeBase64(PNG_1PX) }] }), 'mhtml-no-html'],
      // Only the closing boundary: no part, so no page.
      [buildMhtml({ parts: [] }), 'mhtml-no-html'],
    ];
    for (const [file, reason] of cases) {
      const r = readMhtml(file);
      expect(r, file.slice(0, 60)).toMatchObject({ ok: false, reason });
      expect(extractMhtmlHtml(file)).toBeNull();
    }
  });

  it(`rejects more than ${MHTML_MAX_PARTS} parts, counting every part (none decoded)`, () => {
    const tiny = { type: 'image/gif', encoding: 'base64', body: 'R0lGOD' };
    const page = { type: 'text/html', encoding: 'quoted-printable', body: '<p>ok</p>' };
    expect(readMhtml(buildMhtml({ parts: [page, ...Array.from({ length: MHTML_MAX_PARTS - 1 }, () => tiny)] }))).toMatchObject({ ok: true, html: '<p>ok</p>' });
    const over = readMhtml(buildMhtml({ parts: [page, ...Array.from({ length: MHTML_MAX_PARTS }, () => tiny)] }));
    expect(over).toMatchObject({ ok: false, reason: 'mhtml-too-many-parts' });
    expect(readMhtml(buildMhtml({ parts: [page, tiny, tiny] }), { maxParts: 2 })).toMatchObject({ ok: false, reason: 'mhtml-too-many-parts' });
  });

  it('splits parts only at delimiter lines: never mid-line, never at a longer "--boundaryX" line; transport padding allowed', () => {
    const file = (body: string, close = '--b--') =>
      `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b \t\r\nContent-Type: text/html\r\n\r\n${body}\r\n${close}\r\n`;
    expect(readMhtml(file('<p>x --b y</p>\r\n--bogus\r\n--b-- not the end\r\n<p>z</p>'))).toMatchObject({
      ok: true,
      html: '<p>x --b y</p>\r\n--bogus\r\n--b-- not the end\r\n<p>z</p>',
      notes: [],
    });
    expect(readMhtml(file('<p>x</p>', '--b-- \t'))).toMatchObject({ ok: true, html: '<p>x</p>', notes: [] });
  });

  it('never descends into a nested multipart (no recursion): a page only inside one is no page', () => {
    const nested = buildMhtml({
      parts: [{ type: 'multipart/alternative; boundary="inner"', body: '--inner\r\nContent-Type: text/html\r\n\r\n<p>inner</p>\r\n--inner--' }],
    });
    expect(readMhtml(nested)).toMatchObject({ ok: false, reason: 'mhtml-no-html' });
    // The inner boundary means nothing to the outer message: the page after the nested part is read.
    const after = buildMhtml({
      parts: [
        { type: 'multipart/alternative; boundary="inner"', body: '--inner\r\nContent-Type: text/html\r\n\r\n<p>inner</p>\r\n--inner--' },
        { type: 'text/html', encoding: 'quoted-printable', body: '<p>outer</p>' },
      ],
    });
    expect(readMhtml(after)).toMatchObject({ ok: true, html: '<p>outer</p>' });
  });

  it("reads a part's headers only up to the next delimiter, so a part without a blank line takes nothing from the next one", () => {
    const file = [
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="b"',
      '',
      '--b',
      'Content-Type: text/html',
      'Content-Location: https://scrap.tf/buy/stranges',
      '--b',
      'Content-Type: text/html',
      'Content-Location: https://scrap.tf/buy/hats',
      '',
      '<p>two</p>',
      '--b--',
      '',
    ].join('\r\n');
    expect(readMhtml(file)).toMatchObject({ ok: true, html: '<p>two</p>', contentLocation: 'https://scrap.tf/buy/hats' });
  });

  it('keeps an empty first page as the page: the frame document after it is never read in its place', () => {
    // The page's blank line runs straight into the next delimiter: no body line at all.
    const file = [
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="b"',
      '',
      '--b',
      'Content-Type: text/html',
      'Content-Location: https://scrap.tf/buy/hats',
      '',
      '--b',
      'Content-Type: text/html',
      'Content-Location: https://example.com/frame',
      '',
      '<html><body>frame</body></html>',
      '--b--',
      '',
    ].join('\r\n');
    expect(readMhtml(file)).toEqual({ ok: true, html: '', contentLocation: 'https://scrap.tf/buy/hats', notes: [] });
    // With a body line that is empty, too.
    expect(readMhtml(file.replace('hats\r\n\r\n', 'hats\r\n\r\n\r\n'))).toMatchObject({ ok: true, html: '', contentLocation: 'https://scrap.tf/buy/hats' });
    // So the import says the bank page holds no card, rather than reading the frame.
    const parsed = parseSavedPage(file, 'hats.mhtml', createStubSchema());
    expect(parsed).toMatchObject({ format: 'mhtml', bank: 'hats', items: [] });
    expect(codes(parsed.warnings)).toEqual(['no-cards-saved']);
  });

  it('rejects hostile structures without reading them as a page: a boundary of dashes over a body of dashes, a million delimiters', () => {
    const dashes = '-'.repeat(70);
    const head = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${dashes}"\r\n\r\n`;
    expect(readMhtml(head + '-'.repeat(1_000_000))).toMatchObject({ ok: false, reason: 'mhtml-invalid' });
    expect(readMhtml(head + `${'-'.repeat(100)}\n`.repeat(10_000))).toMatchObject({ ok: false, reason: 'mhtml-invalid' });
    const many = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="x"\r\n\r\n${'--x\n'.repeat(1_000_000)}`;
    expect(readMhtml(many)).toMatchObject({ ok: false, reason: 'mhtml-too-many-parts' });
  });

  it('rejects a file over the import size limit, in UTF-8 bytes, before reading it', () => {
    const big = mhtmlOf(`<p>${'a'.repeat(MAX_IMPORT_BYTES)}</p>`);
    expect(readMhtml(big)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(readMhtml(bytes(big))).toMatchObject({ ok: false, reason: 'too-large' });
    expect(extractMhtmlHtml(big)).toBeNull();
    // Two bytes per character: under the limit in characters, over it in bytes.
    const wide = `MIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n${'é'.repeat(MAX_IMPORT_BYTES / 2)}`;
    expect(wide.length).toBeLessThan(MAX_IMPORT_BYTES);
    expect(readMhtml(wide)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(readMhtml('MIME-Version: 1.0\r\nContent-Type: text/html\r\n\r\n<p>x</p>', { maxBytes: 20 })).toMatchObject({ ok: false, reason: 'too-large' });
  });
});

describe('decodeQuotedPrintable', () => {
  const qp = (s: string): string => Buffer.from(decodeQuotedPrintable(bytes(s))).toString('latin1');

  it('turns =XX escapes (either case) into bytes and removes soft line breaks, CRLF or LF, spaces after "=" included', () => {
    expect(qp('a=3Db=3db')).toBe('a=b=b');
    expect(qp('class=3D"item hover=\r\nable"')).toBe('class="item hoverable"');
    expect(qp('one=\ntwo')).toBe('onetwo');
    expect(qp('one= \t\r\ntwo')).toBe('onetwo');
    expect(qp('end=')).toBe('end');
    expect(qp('=E9=e9')).toBe('\xe9\xe9');
  });

  it('keeps hard line breaks, drops spaces the transport left before them, and keeps a stray "=" as is', () => {
    expect(qp('a  \r\nb\t\nc')).toBe('a\r\nb\nc');
    expect(qp('a=20\r\nb')).toBe('a \r\nb');
    expect(qp('a = b =G1 =')).toBe('a = b =G1 ');
    expect(qp('100%=')).toBe('100%');
  });

  it('round-trips the fixture encoder byte for byte, every byte value included', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('latin1').replace(/[\r\n]/g, '');
    const text = `${all}\n  trailing  \n${'x'.repeat(300)}=\n`;
    expect(qp(encodeQuotedPrintable(text, 'latin1'))).toBe(text.replace(/\n/g, '\r\n'));
  });
});

describe('looksLikeMhtml and isMhtmlFileName', () => {
  it('tells MHTML from a web page by its MIME headers', () => {
    expect(looksLikeMhtml(mhtmlOf('<p/>'))).toBe(true);
    expect(looksLikeMhtml(`﻿${mhtmlOf('<p/>')}`)).toBe(true);
    expect(looksLikeMhtml('MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=x\r\n\r\n')).toBe(true);
    expect(looksLikeMhtml('Content-Type: multipart/related; boundary=x\n\n')).toBe(true);
    expect(looksLikeMhtml(HATS)).toBe(false);
    expect(looksLikeMhtml('<b>Note:</b> MIME-Version: 1.0\r\n\r\n')).toBe(false);
    expect(looksLikeMhtml('Subject: hello\r\n\r\nbody')).toBe(false);
    expect(looksLikeMhtml('')).toBe(false);
  });

  it('names .mhtml and .mht files', () => {
    expect(['a.mhtml', 'A.MHT', 'Buy Hats - Scrap.TF.mhtml'].map(isMhtmlFileName)).toEqual([true, true, true]);
    expect(['a.html', 'a.mhtml.crdownload', 'a.mhtmlx', 'mhtml'].map(isMhtmlFileName)).toEqual([false, false, false, false]);
  });
});

describe('parseSavedPage', () => {
  const schema = createStubSchema();
  const html = parseScrapTfHtml(HATS, schema);

  it('imports exactly the same items, page and bank from the MHTML as from the HTML fixture', () => {
    for (const file of [mhtmlOf(HATS), mhtmlOf(HATS, { encoding: 'base64' })]) {
      const r = parseSavedPage(file, 'Hat Trading - TF2 - Scrap.TF.mhtml', schema);
      expect(r.format).toBe('mhtml');
      expect(r.items).toEqual(html.items);
      expect([r.pageKind, r.bank, r.page]).toEqual([html.pageKind, html.bank, html.page]);
      expect(r.warnings).toEqual(html.warnings);
    }
    // The frame document's own card (asset 9999999999) is not on the page.
    expect(html.items.some((i) => i.assetId === '9999999999')).toBe(false);
  });

  it('reads the bank from Content-Location when the page inside names no address (as a Chromium save has none)', () => {
    const bare = withoutAddress(HATS);
    expect(parseScrapTfHtml(bare, schema).warnings[0]).toMatch(/^page-kind-guessed/);
    const r = parseSavedPage(mhtmlOf(bare, { location: 'https://scrap.tf/buy/hats', snapshot: null }), 'x.mhtml', schema);
    expect([r.pageKind, r.bank, r.page]).toEqual(['buy', 'hats', '/buy/hats']);
    expect(codes(r.warnings)).not.toContain('page-kind-guessed');
    expect(r.items).toEqual(html.items);
    // A sub-page of the unusuals is its own page of that bank (F17-C1).
    const u = parseSavedPage(mhtmlOf(withoutAddress(fixture('unusuals.html')), { location: 'https://scrap.tf/unusuals/378' }), 'u.mhtml', schema);
    expect([u.pageKind, u.bank, u.page]).toEqual(['unusuals', 'unusuals', '/unusuals/378']);
    // An address from another site is no scrap.tf page, as a saved-from comment from there would be.
    const other = parseSavedPage(mhtmlOf(bare, { location: 'https://example.com/mirror/hats', snapshot: null }), 'x.mhtml', schema);
    expect([other.pageKind, other.bank]).toEqual(['unknown', null]);
    expect(codes(other.warnings)[0]).toBe('not-scraptf');
  });

  it('never fetches or opens anything named in the file', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    parseSavedPage(mhtmlOf(HATS), 'x.mhtml', schema);
    readMhtml(mhtmlOf(HATS, { location: 'https://scrap.tf/buy/hats?x=1' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads HTML as HTML whatever the name, MHTML by its headers whatever the name', () => {
    expect(parseSavedPage(HATS, 'page.html', schema)).toEqual({ format: 'html', ...html });
    // A page saved as .mht that is plain HTML (some tools do) still imports.
    expect(parseSavedPage(HATS, 'page.mht', schema)).toMatchObject({ format: 'html', items: html.items });
    // An .mhtml file renamed to .html is still unpacked.
    expect(parseSavedPage(mhtmlOf(HATS), 'renamed.html', schema)).toMatchObject({ format: 'mhtml', items: html.items });
  });

  it('imports nothing from a malformed file, with one clear warning', () => {
    const cases: [string, string, string][] = [
      ['garbage', 'x.mhtml', 'mhtml-invalid'],
      [buildMhtml({ parts: [{ type: 'image/png', encoding: 'base64', body: encodeBase64(PNG_1PX) }, ...resourceParts().slice(0, 2)] }), 'x.mhtml', 'mhtml-no-html'],
      [buildMhtml({ parts: [{ type: 'text/html', encoding: 'base64', body: '%%%' }] }), 'x.mhtml', 'mhtml-invalid'],
    ];
    for (const [file, name, code] of cases) {
      const r = parseSavedPage(file, name, schema);
      expect(r).toMatchObject({ format: 'mhtml', pageKind: 'unknown', bank: null, page: '', items: [] });
      expect(codes(r.warnings)).toEqual([code]);
      expect(r.warnings[0]).toMatch(/save the page again$/);
    }
  });

  it("tells a Single File save with too many parts (a list's images) to save as 'Webpage, Complete', not the same way again", () => {
    const page = { type: 'text/html', encoding: 'quoted-printable', location: 'https://scrap.tf/items', body: encodeQuotedPrintable('<html><body></body></html>') };
    const icons = Array.from({ length: MHTML_MAX_PARTS }, () => ({ type: 'image/png', encoding: 'base64', body: encodeBase64(PNG_1PX) }));
    const r = parseSavedPage(buildMhtml({ parts: [page, ...icons] }), 'Item Trading - TF2 - Scrap.TF.mhtml', schema);
    expect(r).toMatchObject({ format: 'mhtml', pageKind: 'unknown', bank: null, page: '', items: [] });
    expect(r.warnings).toEqual([
      `mhtml-too-many-parts: the file has more than ${MHTML_MAX_PARTS.toLocaleString('en-US')} parts; save the page again as 'Webpage, Complete', which keeps its images out of the page file`,
    ]);
  });

  it('throws ImportTooLargeError for a file over the limit, as for an HTML page', () => {
    expect(() => parseSavedPage(mhtmlOf(`<p>${'a'.repeat(MAX_IMPORT_BYTES)}</p>`), 'big.mhtml', schema)).toThrow(ImportTooLargeError);
    expect(() => parseSavedPage(`<p>${'a'.repeat(MAX_IMPORT_BYTES)}</p>`, 'big.html', schema)).toThrow(ImportTooLargeError);
  });

  it('carries the extractor notes ahead of the page warnings', () => {
    const odd = buildMhtml({ parts: [{ type: 'text/html; charset=x-made-up', encoding: 'quoted-printable', location: 'https://scrap.tf/buy/hats', body: encodeQuotedPrintable(HATS) }] });
    const r = parseSavedPage(odd, 'odd.mhtml', schema);
    expect(codes(r.warnings)[0]).toBe('mhtml-charset');
    expect(r.items).toEqual(html.items);
  });

  it('imports nothing from a page cut short, so no partial look at a bank is stored; a page missing only its closing delimiter imports whole', () => {
    const cut = buildMhtml({
      parts: [{ type: 'text/html', encoding: 'quoted-printable', location: 'https://scrap.tf/buy/hats', body: encodeQuotedPrintable(HATS.slice(0, HATS.indexOf('<!-- C20'))) }],
      unterminated: true,
    });
    const r = parseSavedPage(cut, 'cut.mhtml', schema);
    expect(r).toMatchObject({ format: 'mhtml', pageKind: 'unknown', bank: null, page: '', items: [] });
    expect(codes(r.warnings)).toEqual(['mhtml-truncated']);
    expect(r.warnings[0]).toMatch(/save the page again$/);
    const whole = buildMhtml({ parts: [{ type: 'text/html', encoding: 'quoted-printable', body: encodeQuotedPrintable(HATS) }], unterminated: true });
    const w = parseSavedPage(whole, 'whole.mhtml', schema);
    expect(codes(w.warnings)).not.toContain('mhtml-truncated');
    expect(w.items).toEqual(html.items);
  });
});

describe('every saved-page fixture reads the same from .html and from .mhtml', () => {
  const schema = createStubSchema();
  const FIXTURES = ['buy_hats.html', 'buy_items.html', 'buy_killstreaks.html', 'buy_skins.html', 'buy_stranges.html', 'buy_weapons.html', 'items_list.html', 'unusuals.html'];
  /** The first address the page names, in the parser's order: saved-from comment, canonical link, og:url. */
  const addressOf = (html: string): string => {
    const m = /saved from url=\(\s*\d+\s*\)\s*(\S+?)\s*-->/i.exec(html) ?? /<link rel="canonical" href="([^"]+)"/i.exec(html) ?? /<meta property="og:url" content="([^"]+)"/i.exec(html);
    expect(m).not.toBeNull();
    return m![1]!;
  };

  it.each(FIXTURES)('%s', (name) => {
    const html = fixture(name);
    const want = parseScrapTfHtml(html, schema);
    expect(want.bank).not.toBeNull();
    const same = (r: ReturnType<typeof parseSavedPage>): void => {
      expect(r.format).toBe('mhtml');
      expect({ pageKind: r.pageKind, bank: r.bank, page: r.page, items: r.items, warnings: r.warnings }).toEqual({
        pageKind: want.pageKind,
        bank: want.bank,
        page: want.page,
        items: want.items,
        warnings: want.warnings,
      });
    };
    // Content-Location is read first, so each file carries its page's own address there, as Chromium writes it.
    const location = addressOf(html);
    for (const encoding of ['quoted-printable', 'base64'] as const) {
      for (const eol of ['\r\n', '\n']) same(parseSavedPage(mhtmlOf(html, { encoding, eol, location }), 'saved.mhtml', schema));
    }
    // A Chromium page names no address of its own: only its part's Content-Location does.
    same(parseSavedPage(mhtmlOf(withoutAddress(html), { location, snapshot: null }), 'saved.mhtml', schema));
    // Nor its part, when only the file's Snapshot-Content-Location does.
    same(parseSavedPage(mhtmlOf(withoutAddress(html), { location: null, snapshot: location }), 'saved.mhtml', schema));
  });
});
