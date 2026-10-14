// Service log: <dataDir>/../logs/service.log, rotated at 5 MB to service.log.1
// and service.log.2. Every line passes secret redaction (the net layer's
// SecretRegistry plus key=value scrubbing) before it is written or forwarded
// to main over the 'log' wire message.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FromService } from '../shared/rpc';
import type { Logger } from './contracts';
import { scrubText } from './net';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Rotated files kept next to service.log (service.log.1, service.log.2). */
export const SERVICE_LOG_KEEP = 2;
const FLUSH_DELAY_MS = 250;
const MAX_LINE_CHARS = 8_000;
/** After this many failed writes in a row, lines are dropped and a write is tried again only every LOG_RETRY_MS. */
export const LOG_MAX_FAILURES = 20;
export const LOG_RETRY_MS = 60_000;

export interface ServiceLogger extends Logger {
  readonly file: string;
  /** Writes buffered lines now (shutdown, fatal errors). */
  flush(): void;
}

export interface CreateLoggerOptions {
  dataDir: string;
  /** Forwards lines to main (utilityProcess parentPort). */
  post?: (msg: Extract<FromService, { type: 'log' }>) => void;
  /** Lowest level written to the file (default 'debug'). */
  fileLevel?: LogLevel;
  /** Lowest level forwarded to main (default 'info'). */
  postLevel?: LogLevel;
  maxBytes?: number;
  now?: () => Date;
  /** Also print to stdout/stderr (tests and development). */
  echo?: boolean;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.name}: ${meta.message}`;
  try {
    const json = JSON.stringify(meta, (_k, v: unknown) =>
      v instanceof Error ? { name: v.name, message: v.message } : typeof v === 'bigint' ? String(v) : v,
    );
    if (json === undefined) return '';
    return ` ${json.length > 2000 ? `${json.slice(0, 2000)}...` : json}`;
  } catch {
    return ' [unserialisable meta]';
  }
}

export function serviceLogPath(dataDir: string): string {
  return path.join(path.dirname(path.resolve(dataDir)), 'logs', 'service.log');
}

export function createLogger(opts: CreateLoggerOptions): ServiceLogger {
  const file = serviceLogPath(opts.dataDir);
  const maxBytes = opts.maxBytes ?? SERVICE_LOG_MAX_BYTES;
  const fileLevel = LEVEL_ORDER[opts.fileLevel ?? 'debug'];
  const postLevel = LEVEL_ORDER[opts.postLevel ?? 'info'];
  const now = opts.now ?? (() => new Date());
  let buffer: string[] = [];
  let size: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  /** While failing: no write is attempted before this time (a disk-full or locked folder can recover). */
  let retryAt = 0;
  let dropped = 0;

  const rotate = (): void => {
    try {
      rmSync(`${file}.${SERVICE_LOG_KEEP}`, { force: true });
      for (let i = SERVICE_LOG_KEEP - 1; i >= 1; i--) {
        try {
          renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        } catch {
          // that generation does not exist yet
        }
      }
      renameSync(file, `${file}.1`);
    } catch {
      // keep appending to the current file if rotation is blocked
    }
    size = 0;
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const lines = buffer.length;
    let chunk = buffer.join('');
    buffer = [];
    const t = now().getTime();
    if (failures > LOG_MAX_FAILURES && t < retryAt) {
      dropped += lines; // memory stays bounded while the log folder is unwritable
      return;
    }
    if (dropped > 0) chunk = `${now().toISOString()} WARN  [${dropped} log lines dropped: the log folder was not writable]\n${chunk}`;
    try {
      if (size === null) {
        mkdirSync(path.dirname(file), { recursive: true });
        try {
          size = statSync(file).size;
        } catch {
          size = 0;
        }
      }
      const bytes = Buffer.byteLength(chunk);
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(file, chunk);
      size = (size ?? 0) + bytes;
      failures = 0;
      dropped = 0;
    } catch {
      failures++;
      size = null;
      dropped += lines;
      // Not a permanent give-up: a later flush tries again after a cooldown.
      if (failures > LOG_MAX_FAILURES) retryAt = t + LOG_RETRY_MS;
    }
  };

  const write = (level: LogLevel, msg: string, meta?: unknown): void => {
    const rank = LEVEL_ORDER[level];
    if (rank < fileLevel && rank < postLevel) return;
    let text: string;
    try {
      text = scrubText(`${String(msg)}${formatMeta(meta)}`).replace(/\r?\n/g, '\n    ');
    } catch {
      text = '[log line could not be redacted and was dropped]';
    }
    if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)}...`;
    if (rank >= fileLevel) {
      buffer.push(`${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`);
      if (!timer) {
        timer = setTimeout(flush, FLUSH_DELAY_MS);
        (timer as { unref?: () => void }).unref?.();
      }
    }
    if (opts.echo) (rank >= LEVEL_ORDER.warn ? console.error : console.log)(`[service] ${level} ${text}`);
    if (opts.post && rank >= postLevel) {
      try {
        opts.post({ type: 'log', level, msg: text });
      } catch {
        // the parent port is gone (shutdown)
      }
    }
  };

  return {
    file,
    flush,
    debug: (m, meta) => write('debug', m, meta),
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}
