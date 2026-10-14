// The single 'rpc' IPC channel. Every call is checked for an app://app/ main
// frame sender and a known method; MAIN_METHODS are handled here with zod-
// validated params, SERVICE_METHODS are forwarded to the service host.
// Electron APIs come in through MainRpcDeps, so this module is unit-tested.

import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { Logger } from '../service/contracts';
import { decodeHtmlBuffer } from '../shared/htmlDecode';
import { MAIN_METHODS, SERVICE_METHODS, type AppInfo, type RpcMethod } from '../shared/rpc';
import { validateSettingsPatch } from '../shared/settingsSchema';
import type { SecretName, SecretsStatus, Settings } from '../shared/types';
import { isTrustedSenderUrl, MAX_IMPORT_BYTES, safeErrorMessage, sanitizeFileName } from './paths';
import { MAX_SECRET_LENGTH, secretNameSchema } from './secrets';

export const RPC_CHANNEL = 'rpc';
export const PUSH_CHANNEL = 'push';
export const MAX_SAVE_TEXT_CHARS = 64 * 1024 * 1024;

export interface RpcCallContext {
  /** Window that made the call (dialog parent); opaque here. */
  window: unknown;
  hideWindow(): void;
}

export interface MainRpcDeps {
  settings: { get(): Settings; set(patch: unknown): Settings };
  secrets: { status(): SecretsStatus; set(name: SecretName, value: string | null): SecretsStatus };
  service: { callRaw(method: RpcMethod, params: unknown): Promise<unknown> };
  showQuickEntry(): void;
  /** Shows the dashboard and sends it push 'ui.openItem'. */
  openItemInDashboard(sku: string): void;
  appInfo(): AppInfo;
  isAllowedExternalUrl(url: string): boolean;
  openExternal(url: string): Promise<void>;
  dialogs: {
    openHtmlFile(window: unknown): Promise<string | null>;
    openFolder(window: unknown): Promise<string | null>;
    saveFile(window: unknown, suggestedName: string): Promise<string | null>;
  };
  files: {
    stat(file: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
    /** At most `maxBytes` bytes of the file. */
    readBytes(file: string, maxBytes: number): Promise<Uint8Array>;
    writeText(file: string, text: string): Promise<void>;
  };
  log: Logger;
}

export type RpcRouter = (ctx: RpcCallContext, method: unknown, params: unknown) => Promise<unknown>;

const secretsSetParams = z.object({
  name: secretNameSchema,
  value: z.string().max(MAX_SECRET_LENGTH).nullable(),
});
const linksOpenParams = z.object({ url: z.string().min(1).max(4096) });
const openItemParams = z.object({ sku: z.string().trim().min(1).max(200).regex(/^\d+;\d+(;[a-z0-9-]+)*$/i, 'not a SKU') });
const saveTextParams = z.object({
  suggestedName: z.string().max(255),
  text: z.string().max(MAX_SAVE_TEXT_CHARS),
});
const importHtmlParams = z.looseObject({ html: z.string().max(MAX_IMPORT_BYTES) });

function parseParams<T>(schema: z.ZodType<T>, params: unknown, method: string): T {
  const r = schema.safeParse(params);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
    throw new Error(`Invalid parameters for ${method}: ${where}${issue?.message ?? 'invalid'}`);
  }
  return r.data;
}

/** File types file.saveText may write (the save dialog offers exactly these). */
export const SAVE_EXTENSIONS: ReadonlySet<string> = new Set(['.csv', '.txt']);

/** `name` with its extension replaced by .csv (kept when it already is .csv). */
export function withCsvExtension(name: string): string {
  const ext = path.extname(name);
  if (ext.toLowerCase() === '.csv') return name;
  return `${ext ? name.slice(0, -ext.length) : name}.csv`;
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const mainMethods = new Set<string>(MAIN_METHODS);
const serviceMethods = new Set<string>(SERVICE_METHODS);

export function isKnownMethod(method: unknown): method is RpcMethod {
  return typeof method === 'string' && (mainMethods.has(method) || serviceMethods.has(method));
}

export function createRpcRouter(deps: MainRpcDeps): RpcRouter {
  return async (ctx, method, params) => {
    if (!isKnownMethod(method)) {
      throw new Error(typeof method === 'string' ? `Unknown method: ${method.slice(0, 64)}` : 'Invalid method');
    }

    if (serviceMethods.has(method)) {
      // Same 20 MB cap as the file picker; the service re-validates everything else.
      if (method === 'import.html') parseParams(importHtmlParams, params, method);
      return deps.service.callRaw(method, params);
    }

    switch (method) {
      case 'app.info':
        return deps.appInfo();
      case 'app.showQuickEntry':
        deps.showQuickEntry();
        return { ok: true };
      case 'app.hideWindow':
        ctx.hideWindow();
        return { ok: true };
      case 'app.openItem': {
        const { sku } = parseParams(openItemParams, params, method);
        deps.openItemInDashboard(sku);
        return { ok: true };
      }
      case 'settings.get':
        return deps.settings.get();
      case 'settings.set':
        return deps.settings.set(validateSettingsPatch(params));
      case 'secrets.status':
        return deps.secrets.status();
      case 'secrets.set': {
        const p = parseParams(secretsSetParams, params, method);
        return deps.secrets.set(p.name, p.value);
      }
      case 'links.open': {
        const { url } = parseParams(linksOpenParams, params, method);
        let allowed = false;
        try {
          allowed = isHttpsUrl(url) && deps.isAllowedExternalUrl(url);
        } catch {
          allowed = false;
        }
        if (!allowed) {
          deps.log.warn('links.open refused a URL outside the allowlist', { url: url.slice(0, 200) });
          return { opened: false, reason: 'This link is not on the list of sites the app may open.' };
        }
        await deps.openExternal(url);
        return { opened: true, reason: null };
      }
      case 'import.pickFile': {
        if (!deps.settings.get().import.enabled) {
          throw new Error('Saved-page import is turned off. Enable it in Settings first.');
        }
        const file = await deps.dialogs.openHtmlFile(ctx.window);
        if (!file) return null;
        if (!/\.html?$/i.test(file)) throw new Error('Choose a saved .html page.');
        const st = await deps.files.stat(file);
        if (!st.isFile()) throw new Error('Choose a saved .html page.');
        if (st.size > MAX_IMPORT_BYTES) throw new Error('That file is larger than 20 MB.');
        // Bounded read: the file may still be growing (download or sync in progress).
        const bytes = await deps.files.readBytes(file, MAX_IMPORT_BYTES + 1);
        if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error('That file is larger than 20 MB.');
        // Same decoding as the folder watcher (UTF-8, or UTF-16 with a byte order mark).
        const html = decodeHtmlBuffer(bytes);
        return deps.service.callRaw('import.html', {
          html,
          fileName: path.basename(file),
          mtimeMs: Math.round(st.mtimeMs),
        });
      }
      case 'import.pickWatchFolder': {
        const folder = await deps.dialogs.openFolder(ctx.window);
        return { folder: folder ?? null };
      }
      case 'file.saveText': {
        const p = parseParams(saveTextParams, params, method);
        // Exports are CSV: the caller's name never decides the file type (no .bat/.hta/.url).
        const name = withCsvExtension(sanitizeFileName(p.suggestedName, 'export.csv'));
        const target = await deps.dialogs.saveFile(ctx.window, name);
        if (!target) return { saved: false, path: null };
        if (!SAVE_EXTENSIONS.has(path.extname(target).toLowerCase())) {
          throw new Error('Exports can only be saved as .csv or .txt files.');
        }
        await deps.files.writeText(target, p.text);
        return { saved: true, path: target };
      }
      default:
        throw new Error(`Unhandled method: ${method}`);
    }
  };
}

/** URL of the calling frame, or null when it is gone or is not a main frame. */
export function senderUrlOf(event: Pick<IpcMainInvokeEvent, 'senderFrame'>): string | null {
  try {
    const frame = event.senderFrame;
    if (!frame || frame.parent) return null;
    return frame.url;
  } catch {
    return null;
  }
}

/**
 * What the 'rpc' channel resolves with; preload.ts turns `ok: false` into a
 * rejected promise with `new Error(error)`. Returning instead of throwing keeps
 * stacks (with local paths) out of the renderer and out of Electron's console.
 */
export type RpcEnvelope = { ok: true; result: unknown } | { ok: false; error: string };

export function registerRpcHandler(
  ipcMain: Pick<IpcMain, 'handle'>,
  router: RpcRouter,
  contextFor: (event: IpcMainInvokeEvent) => RpcCallContext,
  log: Logger,
): void {
  ipcMain.handle(RPC_CHANNEL, async (event: IpcMainInvokeEvent, method: unknown, params: unknown): Promise<RpcEnvelope> => {
    const url = senderUrlOf(event);
    if (!isTrustedSenderUrl(url)) {
      log.warn('rpc refused from an untrusted frame', {
        url: typeof url === 'string' ? url.slice(0, 200) : null,
        method: typeof method === 'string' ? method.slice(0, 64) : typeof method,
      });
      throw new Error('Untrusted sender');
    }
    try {
      return { ok: true, result: await router(contextFor(event), method, params) };
    } catch (err) {
      const error = safeErrorMessage(err);
      log.debug(`rpc ${typeof method === 'string' ? method.slice(0, 64) : '?'} failed: ${error}`);
      return { ok: false, error };
    }
  });
}
