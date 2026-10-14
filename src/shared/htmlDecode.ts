// Decoding of saved web pages, shared by main ("Import file") and the service
// (folder watch) so both paths read the same file the same way. No Node APIs
// and no parser here, so main can import it without pulling in parse5.

/** Decodes a saved page: UTF-8 by default, honouring UTF-8/UTF-16 byte order marks. */
export function decodeHtmlBuffer(buf: Uint8Array): string {
  const b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(b.subarray(3));
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return new TextDecoder('utf-16le', { ignoreBOM: true }).decode(b.subarray(2, 2 + ((b.length - 2) & ~1)));
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return new TextDecoder('utf-16be', { ignoreBOM: true }).decode(b.subarray(2, 2 + ((b.length - 2) & ~1)));
  }
  const s = new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
