import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretsStore, type SafeStorageLike } from '../../src/main/secrets';

// Audit fu-main-1 (same root cause as mainshell-5): a secrets.json saved with a UTF-8 BOM (a copy written by
// Windows PowerShell 5.1, some editors) was "not valid JSON": every saved key had to be entered again, and the
// next save moved the file with all the encrypted keys aside and wrote one holding only the new key.

/** Reversible stand-in for DPAPI: XOR with a key plus a marker prefix. */
function fakeSafeStorage(): SafeStorageLike {
  const xor = (buf: Buffer) => Buffer.from(buf.map((b) => b ^ 0x5a));
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.concat([Buffer.from('ENC1'), xor(Buffer.from(plain, 'utf8'))]),
    decryptString: (enc) => {
      if (enc.subarray(0, 4).toString() !== 'ENC1') throw new Error('bad blob');
      return xor(enc.subarray(4)).toString('utf8');
    },
  };
}

const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_CHAR = String.fromCharCode(0xfeff);
const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const TOKEN = '0123456789abcdef0123456789abcdef';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-secrets-bom-'));
  file = path.join(dir, 'secrets.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** secrets.json as the app writes it, holding KEY, then rewritten with a BOM in front. */
function savedWithBom(storage: SafeStorageLike): string {
  createSecretsStore({ file, safeStorage: storage, log: quietLog() }).set('bptfApiKey', KEY);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, Buffer.concat([BOM, Buffer.from(text)]));
  return text;
}

describe('secrets store: a secrets.json with a UTF-8 BOM', () => {
  it('loads the saved keys and says nothing about a corrupt file', () => {
    const storage = fakeSafeStorage();
    savedWithBom(storage);
    const log = quietLog();
    const s = createSecretsStore({ file, safeStorage: storage, log });
    expect(s.get('bptfApiKey')).toBe(KEY);
    expect(s.status().bptfApiKey).toBe(true);
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringMatching(/not valid JSON|unexpected shape/));
  });

  it('keeps the saved keys on the next save and never moves the file aside', () => {
    const storage = fakeSafeStorage();
    const before = savedWithBom(storage);
    const cipher = JSON.parse(before).secrets.bptfApiKey as string;
    const renameFile = vi.fn();
    const s = createSecretsStore({ file, safeStorage: storage, log: quietLog(), renameFile, now: () => 42 });
    s.set('bptfAccessToken', TOKEN);
    expect(renameFile).not.toHaveBeenCalled();
    expect(existsSync(`${file}.corrupt-42`)).toBe(false);
    expect(readdirSync(dir)).toEqual(['secrets.json']);
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk.charCodeAt(0)).not.toBe(0xfeff);
    // The stored ciphertext is carried over as is, next to the new one.
    expect(JSON.parse(onDisk).secrets.bptfApiKey).toBe(cipher);
    const again = createSecretsStore({ file, safeStorage: storage, log: quietLog() });
    expect(again.getAll()).toEqual({ bptfApiKey: KEY, bptfAccessToken: TOKEN });
  });

  it('keeps the other keys when one is deleted', () => {
    const storage = fakeSafeStorage();
    const s0 = createSecretsStore({ file, safeStorage: storage, log: quietLog() });
    s0.set('bptfApiKey', KEY);
    s0.set('bptfAccessToken', TOKEN);
    writeFileSync(file, Buffer.concat([BOM, readFileSync(file)]));
    const s = createSecretsStore({ file, safeStorage: storage, log: quietLog() });
    s.delete('bptfAccessToken');
    expect(createSecretsStore({ file, safeStorage: storage, log: quietLog() }).getAll()).toEqual({ bptfApiKey: KEY });
  });

  it('strips it in load(), whatever reader is used', () => {
    const storage = fakeSafeStorage();
    const text = savedWithBom(storage);
    const s = createSecretsStore({ file, safeStorage: storage, log: quietLog(), readFile: () => BOM_CHAR + text });
    expect(s.get('bptfApiKey')).toBe(KEY);
  });

  it('still moves a really corrupt file aside, BOM or not', () => {
    writeFileSync(file, Buffer.concat([BOM, Buffer.from('{ not json')]));
    const s = createSecretsStore({ file, safeStorage: fakeSafeStorage(), log: quietLog(), now: () => 7 });
    s.set('bptfApiKey', KEY);
    expect(existsSync(`${file}.corrupt-7`)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).secrets.bptfApiKey).toEqual(expect.any(String));
  });
});
