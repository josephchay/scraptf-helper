// API keys and tokens, encrypted at rest with Electron safeStorage (DPAPI on
// Windows). secrets.json holds only base64 ciphertext. Plaintext stays in
// memory in main and goes to the service over its private channel; renderers
// only ever see SecretsStatus. Values are never logged.

import { renameSync } from 'node:fs';
import { z } from 'zod';
import type { Logger } from '../service/contracts';
import { BPTF_API_ACCESS_URL } from '../shared/links';
import { SECRET_NAMES, type SecretName, type SecretsStatus } from '../shared/types';
import { readFileRetrySync, writeFileAtomicSync } from './paths';

/** The subset of Electron's safeStorage used here (injected for tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type SecretMap = Partial<Record<SecretName, string>>;

export interface SecretsStore {
  /** False when the OS cannot encrypt; set() then refuses to store anything. */
  available(): boolean;
  status(): SecretsStatus;
  get(name: SecretName): string | null;
  /** Decrypted values, for the service channel only. */
  getAll(): SecretMap;
  /** null or an empty string deletes. Throws SecretsUnavailableError / SecretValidationError. */
  set(name: SecretName, value: string | null): SecretsStatus;
  delete(name: SecretName): SecretsStatus;
  onChange(listener: (secrets: SecretMap) => void): () => void;
}

export class SecretsUnavailableError extends Error {
  override readonly name = 'SecretsUnavailableError';
  constructor() {
    super('Secure storage is not available on this system, so the key was not saved.');
  }
}

export class SecretValidationError extends Error {
  override readonly name = 'SecretValidationError';
}

export const MAX_SECRET_LENGTH = 512;

type BptfCredential = 'bptfApiKey' | 'bptfAccessToken';
const BPTF_TWIN: Partial<Record<SecretName, BptfCredential>> = { bptfApiKey: 'bptfAccessToken', bptfAccessToken: 'bptfApiKey' };
const SAME_VALUE_MESSAGE: Record<BptfCredential, string> = {
  bptfApiKey: `This is your access token, not the API key. On ${BPTF_API_ACCESS_URL}, register a key under "API Key" and paste that one here.`,
  bptfAccessToken: `This is your API key, not the access token. On ${BPTF_API_ACCESS_URL}, click "Reveal" under "Access Token" and paste that one here.`,
};
export const secretNameSchema = z.enum(SECRET_NAMES as [SecretName, ...SecretName[]]);

/** Trims and checks a secret; returns null for "delete". Keys and tokens are printable ASCII without spaces. */
export function normalizeSecretValue(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new SecretValidationError('Secret must be a string.');
  const v = value.trim();
  if (v === '') return null;
  if (v.length > MAX_SECRET_LENGTH) throw new SecretValidationError(`Secret is longer than ${MAX_SECRET_LENGTH} characters.`);
  if (!/^[!-~]+$/.test(v)) throw new SecretValidationError('Secret contains spaces or unsupported characters.');
  return v;
}

const fileSchema = z.looseObject({
  version: z.literal(1).catch(1),
  secrets: z.record(z.string(), z.unknown()).catch({}),
});

interface SecretsFile {
  version: 1;
  secrets: Partial<Record<SecretName, string>>;
}

export interface SecretsStoreOptions {
  file: string;
  safeStorage: SafeStorageLike;
  log: Logger;
  readFile?: (file: string) => string;
  writeFile?: (file: string, data: string) => void;
  renameFile?: (from: string, to: string) => void;
  now?: () => number;
}

export function createSecretsStore(opts: SecretsStoreOptions): SecretsStore {
  const { safeStorage, log } = opts;
  const readFile = opts.readFile ?? ((f: string) => readFileRetrySync(f));
  const writeFile = opts.writeFile ?? ((f: string, d: string) => writeFileAtomicSync(f, d));
  const renameFile = opts.renameFile ?? ((from: string, to: string) => renameSync(from, to));
  const now = opts.now ?? Date.now;
  const listeners = new Set<(s: SecretMap) => void>();
  /**
   * Why secrets.json could not be used at load. Saving then would replace every
   * stored key with just the one being saved, so set()/delete() recover first.
   */
  let loadProblem: 'unreadable' | 'corrupt' | null = null;

  const available = (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  // Ciphertext as stored, and the decrypted values that could be read.
  const cipher: Partial<Record<SecretName, string>> = {};
  const plain: SecretMap = {};

  function load(): void {
    loadProblem = null;
    let raw: string;
    try {
      raw = readFile(opts.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        loadProblem = 'unreadable';
        log.warn('could not read secrets.json; starting without saved keys');
      }
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      loadProblem = 'corrupt';
      log.warn('secrets.json is not valid JSON; saved keys must be entered again');
      return;
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      loadProblem = 'corrupt';
      log.warn('secrets.json has an unexpected shape; saved keys must be entered again');
      return;
    }
    const canDecrypt = available();
    for (const name of SECRET_NAMES) {
      const b64 = parsed.data.secrets[name];
      if (typeof b64 !== 'string' || b64 === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
      cipher[name] = b64;
      if (!canDecrypt) continue;
      try {
        const value = normalizeSecretValue(safeStorage.decryptString(Buffer.from(b64, 'base64')));
        if (value !== null) plain[name] = value;
      } catch {
        // Typically a profile copied from another Windows account (DPAPI is per user).
        log.warn(`saved ${name} could not be decrypted; enter it again in Settings`);
      }
    }
    if (!canDecrypt && Object.keys(cipher).length > 0) {
      log.warn('secure storage is not available; saved keys cannot be read');
    }
  }

  function persist(next: Partial<Record<SecretName, string>>): void {
    const body: SecretsFile = { version: 1, secrets: next };
    writeFile(opts.file, `${JSON.stringify(body, null, 2)}\n`);
  }

  function status(): SecretsStatus {
    const out = {} as SecretsStatus;
    for (const name of SECRET_NAMES) out[name] = typeof plain[name] === 'string';
    return out;
  }

  function emit(): void {
    const snapshot = { ...plain };
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch (err) {
        log.error('secrets listener failed', err instanceof Error ? { name: err.name } : undefined);
      }
    }
  }

  /** Before a write: re-read a file that was unreadable at start, or move a corrupt one aside. Throws if it still cannot be read. */
  function recover(): void {
    if (loadProblem === 'unreadable') {
      load();
      if (loadProblem === 'unreadable') {
        throw new SecretValidationError('secrets.json could not be read, so nothing was saved. Restart the app and try again.');
      }
      if (Object.keys(plain).length > 0) {
        log.info('secrets.json can be read again; saved keys restored');
        emit();
      }
    }
    if (loadProblem === 'corrupt') {
      // Keep the unusable file for the user instead of overwriting it.
      const backup = `${opts.file}.corrupt-${now()}`;
      try {
        renameFile(opts.file, backup);
        log.warn(`moved the unusable secrets.json to ${backup}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new SecretValidationError('secrets.json could not be moved aside, so nothing was saved. Restart the app and try again.');
        }
      }
      loadProblem = null;
    }
  }

  function remove(name: SecretName): SecretsStatus {
    if (cipher[name] === undefined && plain[name] === undefined) return status();
    const next = { ...cipher };
    delete next[name];
    persist(next);
    delete cipher[name];
    delete plain[name];
    log.info(`secret ${name} removed`);
    emit();
    return status();
  }

  load();

  return {
    available,
    status,
    get: (name) => plain[name] ?? null,
    getAll: () => ({ ...plain }),
    set(name, value) {
      const parsedName = secretNameSchema.safeParse(name);
      if (!parsedName.success) throw new SecretValidationError('Unknown secret name.');
      const v = normalizeSecretValue(value);
      recover();
      if (v === null) return remove(name);
      if (plain[name] === v) return status();
      // backpack.tf issues two different values on one page; pasting one into both fields is the usual mix-up.
      const twin = BPTF_TWIN[name];
      if (twin && plain[twin] === v) throw new SecretValidationError(SAME_VALUE_MESSAGE[name as BptfCredential]);
      if (!available()) throw new SecretsUnavailableError();
      let encoded: string;
      try {
        encoded = safeStorage.encryptString(v).toString('base64');
      } catch {
        throw new SecretsUnavailableError();
      }
      persist({ ...cipher, [name]: encoded });
      cipher[name] = encoded;
      plain[name] = v;
      log.info(`secret ${name} saved`);
      emit();
      return status();
    },
    delete(name) {
      recover();
      return remove(name);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
