import { afterEach, describe, expect, it } from 'vitest';
import {
  REDACTED,
  SecretRegistry,
  globalSecrets,
  redactHeaders,
  redactText,
  redactUrl,
  registerSecret,
  scrubText,
  unregisterSecret,
} from '../../src/service/net/redact';

afterEach(() => {
  globalSecrets.clear();
});

describe('redactUrl', () => {
  it('redacts the default secret keys case-insensitively and keeps steamids', () => {
    const url =
      'https://api.backpack.tf/api/IGetPrices/v4?key=abc123&raw=1&TOKEN=t0k&ApiKey=k&api_key=k2&access_token=a&steamid=76561198000000000&steamids=1,2';
    const out = redactUrl(url);
    expect(out).toBe(
      `https://api.backpack.tf/api/IGetPrices/v4?key=${REDACTED}&raw=1&TOKEN=${REDACTED}&ApiKey=${REDACTED}&api_key=${REDACTED}&access_token=${REDACTED}&steamid=76561198000000000&steamids=1,2`,
    );
  });

  it('redacts extra keys and Steam trade tokens', () => {
    const out = redactUrl(
      'https://api.steampowered.com/IEconService/GetTradeHoldDurations/v1/?steamid_target=1&trade_offer_access_token=zzz&x=1&custom=sec',
      ['custom'],
    );
    expect(out).toContain(`trade_offer_access_token=${REDACTED}`);
    expect(out).toContain(`custom=${REDACTED}`);
    expect(out).toContain('steamid_target=1');
    expect(out).toContain('x=1');
  });

  it('keeps non-secret params verbatim (no re-encoding)', () => {
    const out = redactUrl('https://api.backpack.tf/api/classifieds/listings/snapshot?sku=Strange%20Pain%20Train&appid=440&token=x');
    expect(out).toBe(`https://api.backpack.tf/api/classifieds/listings/snapshot?sku=Strange%20Pain%20Train&appid=440&token=${REDACTED}`);
  });

  it('handles encoded keys, array keys, empty values and flags', () => {
    expect(redactUrl('https://pricedb.io/api/x?%74oken=abc')).toContain(`%74oken=${REDACTED}`);
    expect(redactUrl('https://pricedb.io/api/x?token[]=a&token[]=b')).toBe(
      `https://pricedb.io/api/x?token[]=${REDACTED}&token[]=${REDACTED}`,
    );
    expect(redactUrl('https://pricedb.io/api/x?token=&flag&a=b')).toBe(`https://pricedb.io/api/x?token=${REDACTED}&flag&a=b`);
  });

  it('drops userinfo and fragments', () => {
    expect(redactUrl('https://user:pass@pricedb.io/api/x#token=abc')).toBe(`https://${REDACTED}@pricedb.io/api/x`);
  });

  it('returns path + query only on request', () => {
    expect(redactUrl('https://pricedb.io/api/item/5021;6?key=zz', [], { pathOnly: true })).toBe(`/api/item/5021;6?key=${REDACTED}`);
  });

  it('falls back to text redaction for unparseable input', () => {
    const out = redactUrl('/api/IGetPrices/v4?key=SECRETVALUE&raw=1 trailing');
    expect(out).toBe(`/api/IGetPrices/v4?key=${REDACTED}&raw=1 trailing`);
    expect(redactUrl('weird://user:pw@host/x?token=abc')).not.toContain('pw');
  });

  it('applies registered secrets wherever they appear, including the path', () => {
    const secret = 'S3cretValue!/+&= x';
    registerSecret(secret);
    const encoded = encodeURIComponent(secret);
    const out = redactUrl(`https://sku.pricedb.io/api/name/${encoded}?q=${encoded}`);
    expect(out).not.toContain(encoded);
    expect(out).toContain(REDACTED);
  });

  it('removes per-call literal values', () => {
    const out = redactUrl('https://pricedb.io/api/item/abcdef123456', [], { values: ['abcdef123456'] });
    expect(out).toBe(`https://pricedb.io/api/item/${REDACTED}`);
  });
});

describe('redactHeaders', () => {
  it('redacts default and extra secret headers, case-insensitively', () => {
    const out = redactHeaders(
      { Authorization: 'Bearer abc', 'X-Auth-Token': 't', 'x-webapi-key': 'k', Cookie: 'c=1', Accept: 'application/json', 'X-Custom': 'v' },
      ['x-custom'],
    );
    expect(out).toEqual({
      Authorization: REDACTED,
      'X-Auth-Token': REDACTED,
      'x-webapi-key': REDACTED,
      Cookie: REDACTED,
      Accept: 'application/json',
      'X-Custom': REDACTED,
    });
  });

  it('accepts Headers and entry lists and scrubs registered secrets from other values', () => {
    registerSecret('registered-secret-123');
    const h = new Headers({ 'x-note': 'value registered-secret-123 here', authorization: 'x' });
    expect(redactHeaders(h)).toEqual({ authorization: REDACTED, 'x-note': `value ${REDACTED} here` });
    expect(redactHeaders([['Set-Cookie', 'a=b'], ['x-ok', 'fine']])).toEqual({ 'Set-Cookie': REDACTED, 'x-ok': 'fine' });
  });
});

describe('SecretRegistry', () => {
  it('ignores values shorter than the minimum length', () => {
    const r = new SecretRegistry();
    r.register('short');
    r.register('       x');
    r.register(null);
    r.register(undefined);
    expect(r.size).toBe(0);
    expect(r.redactText('short text')).toBe('short text');
  });

  it('replaces every occurrence, longest secret first', () => {
    const r = new SecretRegistry();
    r.register('abcdefgh');
    r.register('abcdefgh-longer');
    expect(r.redactText('x abcdefgh-longer y abcdefgh z')).toBe(`x ${REDACTED} y ${REDACTED} z`);
  });

  it('matches URL-encoded and form-encoded forms (upper or lower hex)', () => {
    const r = new SecretRegistry();
    const s = 'tok/en+with space';
    r.register(s);
    expect(r.redactText(`a=${encodeURIComponent(s)}`)).toBe(`a=${REDACTED}`);
    expect(r.redactText(`a=${new URLSearchParams({ s }).toString().slice(2)}`)).toBe(`a=${REDACTED}`);
    expect(r.redactText('a=tok%2fen%2bwith%20space')).toBe(`a=${REDACTED}`);
  });

  it('treats regex metacharacters literally and supports unregister/clear', () => {
    const r = new SecretRegistry();
    r.register('a.b*c+d?e(f)');
    expect(r.redactText('aXbbbcdde(f) a.b*c+d?e(f)')).toBe(`aXbbbcdde(f) ${REDACTED}`);
    r.unregister('a.b*c+d?e(f)');
    expect(r.redactText('a.b*c+d?e(f)')).toBe('a.b*c+d?e(f)');
    r.register('another-secret');
    r.clear();
    expect(r.size).toBe(0);
  });

  it('global helpers use the global registry', () => {
    registerSecret('global-secret-xyz');
    expect(redactText('the global-secret-xyz value')).toBe(`the ${REDACTED} value`);
    unregisterSecret('global-secret-xyz');
    expect(redactText('the global-secret-xyz value')).toBe('the global-secret-xyz value');
  });

  it('tolerates non-string input', () => {
    const r = new SecretRegistry();
    r.register('abcdefghij');
    expect(r.redactText(undefined as unknown as string)).toBe('');
  });
});

describe('scrubText', () => {
  it('removes key=value secrets, literal values and registered secrets from free text', () => {
    registerSecret('registered-0123456789');
    const msg =
      'fetch failed for https://api.backpack.tf/api/IGetPrices/v4?raw=1&key=LIVEKEY123 (registered-0123456789) literal-value-42';
    const out = scrubText(msg, { values: ['literal-value-42'] });
    expect(out).not.toContain('LIVEKEY123');
    expect(out).not.toContain('registered-0123456789');
    expect(out).not.toContain('literal-value-42');
    expect(out).toContain('raw=1');
  });
});
