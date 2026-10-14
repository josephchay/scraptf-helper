// utilityProcess entry (dist/service.cjs). Speaks the ToService/FromService
// protocol from src/shared/rpc.ts over process.parentPort: 'init' creates the
// core and answers 'ready' at once (slow work such as the schema download and
// the PriceDB list continues in the background), 'rpc' calls are answered with
// 'rpc-result', and 'shutdown' stops everything and exits within 2 s.

import type { FromService, ToService } from '../shared/rpc';
import type { Settings } from '../shared/types';
import { createServiceCore, type ServiceCore } from './core';
import { createLogger, type ServiceLogger } from './logger';
import { scrubText } from './net';

interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

declare const __APP_VERSION__: string | undefined;

const SHUTDOWN_BUDGET_MS = 1_500;
const MAX_ERROR_CHARS = 500;

/** An error message fit for the dashboard: no stack, no local paths, no secrets. */
export function cleanErrorMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Request failed';
  msg = msg.split(/\r?\n\s+at\s/)[0] ?? msg;
  msg = msg
    .replace(/file:\/\/\S+/g, '<path>')
    .replace(/\b[A-Za-z]:[\\/][^\s'"`<>|]*/g, '<path>')
    .replace(/\\\\[^\s'"`<>|]+/g, '<path>')
    .replace(/(?<![\w.:/])\/(?:home|Users|tmp|var|usr|opt|private|mnt|root|etc|snap|app|data)\/[^\s'"`<>|]*/g, '<path>');
  msg = scrubText(msg).trim();
  return (msg || 'Request failed').slice(0, MAX_ERROR_CHARS);
}

/**
 * True when Node would send fetch() through HTTP(S)_PROXY (NODE_USE_ENV_PROXY,
 * --use-env-proxy). Main strips these from the service environment; this is
 * the backstop. Deleting the variables here would not help: Node installed the
 * proxy dispatcher before any of our code ran.
 */
export function envProxyEnabled(env: NodeJS.ProcessEnv = process.env, execArgv: readonly string[] = process.execArgv): boolean {
  const flag = env['NODE_USE_ENV_PROXY'];
  if (flag !== undefined && flag.trim() !== '' && flag.trim() !== '0') return true;
  if (execArgv.includes('--use-env-proxy')) return true;
  return /(^|\s)--use-env-proxy(\s|=|$)/.test(env['NODE_OPTIONS'] ?? '');
}

/** R5 (no proxies): with an environment proxy the service stays offline, whatever the user's pause switch says. */
export function effectiveSettings(settings: Settings, envProxy: boolean): Settings {
  return envProxy && !settings.networkPaused ? { ...settings, networkPaused: true } : settings;
}

function main(): void {
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (!port) {
    console.error('TF2 Flip Desk service must run in an Electron utilityProcess');
    process.exit(1);
    return;
  }
  const post = (msg: FromService): void => {
    try {
      port.postMessage(msg);
    } catch {
      // the channel is closed during shutdown
    }
  };

  let logger: ServiceLogger | null = null;
  let core: ServiceCore | null = null;
  let shuttingDown = false;
  const envProxy = envProxyEnabled();
  let uncaught: number[] = [];

  const report = (what: string, err: unknown): void => {
    const text = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    if (logger) logger.error(`${what}: ${text}`);
    else post({ type: 'log', level: 'error', msg: scrubText(`${what}: ${text}`) });
  };

  process.on('unhandledRejection', (reason) => report('unhandled rejection in the service', reason));
  process.on('uncaughtException', (err) => {
    report('uncaught exception in the service', err);
    // Keep serving after a stray error, but let the host restart a process that keeps failing.
    const now = Date.now();
    uncaught = [...uncaught.filter((t) => now - t < 60_000), now];
    if (uncaught.length >= 5) {
      logger?.error('too many uncaught exceptions; exiting so the app restarts the service');
      logger?.flush();
      process.exit(1);
    }
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const hardExit = setTimeout(() => {
      logger?.flush();
      process.exit(0);
    }, SHUTDOWN_BUDGET_MS + 300);
    try {
      await Promise.race([core?.stop(), new Promise((r) => setTimeout(r, SHUTDOWN_BUDGET_MS))]);
    } catch (err) {
      report('shutdown failed', err);
    }
    clearTimeout(hardExit);
    logger?.info('service exiting');
    logger?.flush();
    process.exit(0);
  };

  port.on('message', (e) => {
    const msg = (e && typeof e === 'object' ? e.data : undefined) as ToService | undefined;
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return;
    switch (msg.type) {
      case 'init': {
        if (core) return;
        logger = createLogger({ dataDir: msg.dataDir, post });
        const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : msg.version;
        if (envProxy) logger.warn('an environment proxy is set (NODE_USE_ENV_PROXY / --use-env-proxy); network stays paused (R5: no proxies)');
        try {
          core = createServiceCore({
            dataDir: msg.dataDir,
            version: msg.version || version,
            settings: effectiveSettings(msg.settings as Settings, envProxy),
            secrets: msg.secrets ?? {},
            log: logger,
          });
        } catch (err) {
          report('service init failed', err);
          logger.flush();
          process.exit(1);
          return;
        }
        core.onPush((event, payload) => post({ type: 'push', event, payload }));
        // Ready before the slow work, so RPC calls do not queue behind downloads.
        post({ type: 'ready' });
        core.start().catch((err: unknown) => report('service start failed', err));
        return;
      }
      case 'rpc': {
        const { id, method, params } = msg;
        if (!core) {
          post({ type: 'rpc-result', id, ok: false, error: 'The service is still starting' });
          return;
        }
        core
          .handle(method, params)
          .then((result) => post({ type: 'rpc-result', id, ok: true, result: result === undefined ? null : result }))
          .catch((err: unknown) => {
            logger?.debug(`rpc ${String(method).slice(0, 64)} failed: ${err instanceof Error ? err.message : String(err)}`);
            post({ type: 'rpc-result', id, ok: false, error: cleanErrorMessage(err) });
          });
        return;
      }
      case 'settings':
        core?.updateSettings(effectiveSettings(msg.settings, envProxy));
        return;
      case 'secrets':
        core?.updateSecrets(msg.secrets ?? {});
        return;
      case 'shutdown':
        void shutdown();
        return;
    }
  });
}

if ((process as unknown as { parentPort?: unknown }).parentPort) main();
