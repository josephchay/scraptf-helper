import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSecretsStore,
  normalizeSecretValue,
  SecretsUnavailableError,
  SecretValidationError,
  type SafeStorageLike,
} from '../../src/main/secrets';

/** Reversible stand-in for DPAPI: XOR with a key plus a marker prefix. */
function fakeSafeStorage(opts: { available?: boolean; failDecrypt?: boolean } = {}): SafeStorageLike & {
  setAvailable(v: boolean): void;
} {
  let available = opts.available ?? true;
  const xor = (buf: Buffer) => Buffer.from(buf.map((b) => b ^ 0x5a));
  return {
    setAvailable: (v) => {
      available = v;
    },
    isEncryptionAvailable: () => available,
    encryptString: (plain) => {
      if (!available) throw new Error('unavailable');
      return Buffer.concat([Buffer.from('ENC1'), xor(Buffer.from(plain, 'utf8'))]);
    },
    decryptString: (enc) => {
      if (!available || opts.failDecrypt) throw new Error('decrypt failed');
      if (enc.subarray(0, 4).toString() !== 'ENC1') throw new Error('bad blob');
      return xor(enc.subarray(4)).toString('utf8');
    },
  };
}

const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-secrets-'));
  file = path.join(dir, 'secrets.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const TOKEN = '0123456789abcdef0123456789abcdef';

describe('secrets store', () => {
  it('starts empty when there is no file', () => {
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() });
    expect(s.status()).toEqual({ bptfApiKey: false, bptfAccessToken: false, steamApiKey: false });
    expect(s.getAll()).toEqual({});
    expect(s.get('bptfApiKey')).toBeNull();
  });

  it('stores only ciphertext on disk and reads it back after a restart', () => {
    const storage = fakeSafeStorage();
    const s = createSecretsStore({ file, safeStorage: storage, log: quietLog() });
    expect(s.set('bptfApiKey', `  ${KEY}  `)).toEqual({ bptfApiKey: true, bptfAccessToken: false, steamApiKey: false });
    s.set('bptfAccessToken', TOKEN);

    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(TOKEN);
    const json = JSON.parse(text);
    expect(json.version).toBe(1);
    expect(Buffer.from(json.secrets.bptfApiKey, 'base64').subarray(0, 4).toString()).toBe('ENC1');

    const again = createSecretsStore({ file, safeStorage: storage, log: quietLog() });
    expect(again.get('bptfApiKey')).toBe(KEY);
    expect(again.getAll()).toEqual({ bptfApiKey: KEY, bptfAccessToken: TOKEN });
  });

  it('deletes with null, empty string or delete()', () => {
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() });
    s.set('bptfApiKey', KEY);
    s.set('steamApiKey', TOKEN);
    s.set('bptfApiKey', null);
    expect(s.status().bptfApiKey).toBe(false);
    s.set('steamApiKey', '   ');
    expect(s.status().steamApiKey).toBe(false);
    s.set('bptfAccessToken', TOKEN);
    s.delete('bptfAccessToken');
    expect(JSON.parse(readFileSync(file, 'utf8')).secrets).toEqual({});
  });

  it('notifies listeners with the decrypted map, and not for no-op writes', () => {
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() });
    const seen: unknown[] = [];
    const off = s.onChange((m) => seen.push(m));
    s.set('bptfApiKey', KEY);
    s.set('bptfApiKey', KEY);
    s.delete('steamApiKey');
    s.delete('bptfApiKey');
    off();
    s.set('bptfApiKey', KEY);
    expect(seen).toEqual([{ bptfApiKey: KEY }, {}]);
  });

  it('refuses the same value as backpack.tf key and token, and says which one is wanted', () => {
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() });
    s.set('bptfAccessToken', TOKEN);
    expect(() => s.set('bptfApiKey', ` ${TOKEN} `)).toThrow(SecretValidationError);
    expect(() => s.set('bptfApiKey', TOKEN)).toThrow(/access token, not the API key.*next\.backpack\.tf\/account\/api-access.*"API Key"/);
    expect(s.status().bptfApiKey).toBe(false);

    s.set('bptfApiKey', KEY);
    expect(() => s.set('bptfAccessToken', KEY)).toThrow(/API key, not the access token.*"Reveal"/);
    expect(s.get('bptfAccessToken')).toBe(TOKEN);
    // The Steam key is unrelated, and re-saving the same token is still a no-op.
    expect(() => s.set('steamApiKey', KEY)).not.toThrow();
    expect(() => s.set('bptfAccessToken', TOKEN)).not.toThrow();
  });

  it('returns copies so callers cannot mutate the store', () => {
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() });
    s.set('bptfApiKey', KEY);
    const all = s.getAll();
    all.bptfApiKey = 'changed';
    expect(s.get('bptfApiKey')).toBe(KEY);
  });

  it('refuses to store when encryption is unavailable and writes nothing', () => {
    const log = quietLog();
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage({ available: false }), log });
    expect(s.available()).toBe(false);
    expect(() => s.set('bptfApiKey', KEY)).toThrow(SecretsUnavailableError);
    expect(existsSync(file)).toBe(false);
    expect(s.status().bptfApiKey).toBe(false);
  });

  it('keeps unreadable ciphertext when encryption is unavailable at load, without reporting it as set', () => {
    const storage = fakeSafeStorage();
    createSecretsStore({ file, safeStorage: storage, log: quietLog() }).set('bptfApiKey', KEY);
    storage.setAvailable(false);
    const log = quietLog();
    const s = createSecretsStore({ file, safeStorage: storage, log });
    expect(s.status().bptfApiKey).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not available'));
  });

  it('treats undecryptable entries as missing and warns without the value', () => {
    createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() }).set('bptfApiKey', KEY);
    const log = quietLog();
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage({ failDecrypt: true }), log });
    expect(s.status().bptfApiKey).toBe(false);
    const logged = JSON.stringify([log.warn.mock.calls, log.info.mock.calls, log.error.mock.calls]);
    expect(logged).toContain('bptfApiKey');
    expect(logged).not.toContain(KEY);
  });

  it.each(['not json', '[]', '{"secrets":"x"}', '{"secrets":{"bptfApiKey":"%%%"}}', '{"secrets":{"bogus":"QUJD"}}'])(
    'survives a corrupt file: %s',
    (content) => {
      writeFileSync(file, content);
      const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() });
      expect(s.getAll()).toEqual({});
      s.set('steamApiKey', TOKEN);
      expect(createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() }).get('steamApiKey')).toBe(TOKEN);
    },
  );

  it('never logs secret values', () => {
    const log = quietLog();
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log });
    s.set('bptfApiKey', KEY);
    s.set('steamApiKey', TOKEN);
    s.delete('bptfApiKey');
    const all = JSON.stringify([log.debug.mock.calls, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(TOKEN);
  });

  it('rejects unknown names and invalid values', () => {
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog() });
    expect(() => s.set('password' as never, KEY)).toThrow(SecretValidationError);
    expect(() => s.set('bptfApiKey', 'has space inside')).toThrow(SecretValidationError);
    expect(() => s.set('bptfApiKey', 'x'.repeat(513))).toThrow(SecretValidationError);
    expect(() => s.set('bptfApiKey', 'line\nbreak')).toThrow(SecretValidationError);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses to save while secrets.json cannot be read, so the other stored keys survive', () => {
    const storage = fakeSafeStorage();
    createSecretsStore({ file, safeStorage: storage, log: quietLog() }).set('bptfApiKey', KEY);
    const before = readFileSync(file, 'utf8');
    const writeFile = vi.fn();
    const readFile = vi.fn((): string => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    const s = createSecretsStore({ file, safeStorage: storage, log: quietLog(), readFile, writeFile });
    expect(s.status().bptfApiKey).toBe(false);
    expect(() => s.set('bptfAccessToken', TOKEN)).toThrow(SecretValidationError);
    expect(() => s.set('bptfAccessToken', TOKEN)).toThrow(/could not be read/);
    expect(() => s.delete('bptfApiKey')).toThrow(SecretValidationError);
    expect(writeFile).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(s.status().bptfAccessToken).toBe(false);
  });

  it('re-reads secrets.json once it is readable again and keeps the stored keys when saving', () => {
    const storage = fakeSafeStorage();
    createSecretsStore({ file, safeStorage: storage, log: quietLog() }).set('bptfApiKey', KEY);
    let locked = true;
    const readFile = vi.fn((f: string): string => {
      if (locked) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return readFileSync(f, 'utf8');
    });
    const s = createSecretsStore({ file, safeStorage: storage, log: quietLog(), readFile });
    const seen: unknown[] = [];
    s.onChange((all) => seen.push(Object.keys(all).sort()));
    locked = false;
    s.set('bptfAccessToken', TOKEN);
    expect(s.getAll()).toEqual({ bptfApiKey: KEY, bptfAccessToken: TOKEN });
    expect(seen).toEqual([['bptfApiKey'], ['bptfAccessToken', 'bptfApiKey']]);
    const again = createSecretsStore({ file, safeStorage: storage, log: quietLog() });
    expect(again.getAll()).toEqual({ bptfApiKey: KEY, bptfAccessToken: TOKEN });
  });

  it('moves a corrupt secrets.json aside before writing a new one', () => {
    writeFileSync(file, '{ not json');
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog(), now: () => 42 });
    expect(existsSync(file)).toBe(true);
    s.set('bptfApiKey', KEY);
    expect(readFileSync(`${file}.corrupt-42`, 'utf8')).toBe('{ not json');
    expect(JSON.parse(readFileSync(file, 'utf8')).secrets.bptfApiKey).toEqual(expect.any(String));
  });

  it('refuses to save when a corrupt secrets.json cannot be moved aside', () => {
    writeFileSync(file, '{"version":1,"secrets":"nope"');
    const writeFile = vi.fn();
    const renameFile = vi.fn(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog(), writeFile, renameFile });
    expect(() => s.set('bptfApiKey', KEY)).toThrow(/moved aside/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does not change memory when the write fails', () => {
    const s = createSecretsStore({
      file,
      safeStorage: fakeSafeStorage(),
      log: quietLog(),
      writeFile: () => {
        throw new Error('disk full');
      },
    });
    expect(() => s.set('bptfApiKey', KEY)).toThrow('disk full');
    expect(s.status().bptfApiKey).toBe(false);
  });
});

describe('normalizeSecretValue', () => {
  it('trims and accepts printable ASCII', () => {
    expect(normalizeSecretValue(' abc-DEF_123.~ ')).toBe('abc-DEF_123.~');
    expect(normalizeSecretValue('x'.repeat(512))).toHaveLength(512);
  });

  it('maps null and blank to delete', () => {
    expect(normalizeSecretValue(null)).toBeNull();
    expect(normalizeSecretValue('')).toBeNull();
    expect(normalizeSecretValue(' \t ')).toBeNull();
  });

  it('rejects non-ASCII and non-strings', () => {
    expect(() => normalizeSecretValue('kéy')).toThrow(SecretValidationError);
    expect(() => normalizeSecretValue(42 as unknown as string)).toThrow(SecretValidationError);
  });
});
