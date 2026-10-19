// The single 'rpc' IPC channel. Every call is checked for an app://app/ main
// frame sender and a known method; MAIN_METHODS are handled here with zod-
// validated params, SERVICE_METHODS are forwarded to the service host.
// Electron APIs come in through MainRpcDeps, so this module is unit-tested.

import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { Logger } from '../service/contracts';
import { CHECK_ARM_NAME_MAX, CHECK_PRICE_TEXT_MAX } from '../shared/check';
import { decodeHtmlBuffer } from '../shared/htmlDecode';
import { isScraptfBank } from '../shared/links';
import { MAIN_METHODS, SERVICE_METHODS, type AppInfo, type HotkeysStatus, type PushContract, type RpcMethod } from '../shared/rpc';
import { IMPORT_HTML_ORIGIN_REFUSAL, isAllowedWindowStart, SCRAPTF_WINDOW_OFF } from '../shared/scraptfWindowPolicy';
import { validateSettingsPatch } from '../shared/settingsSchema';
import { isValidSku } from '../shared/sku';
import { BANK_STOCK_OPEN_FILTERS } from '../shared/types';
import type { BankStockOpenFilter, CheckArm, ScraptfBank, ScraptfWindowState, SecretName, SecretsStatus, Settings, UnixMs } from '../shared/types';
import { isHttpsUrl, isTrustedSenderUrl, MAX_IMPORT_BYTES, safeErrorMessage, sanitizeFileName } from './paths';
import type { ScraptfWindowManager } from './scraptfWindow';
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
  /**
   * With a SKU, the quick-entry window gets push 'ui.quickPrefill' once its page has loaded; `price`
   * (F16, the check popup) rides along as text for its price field.
   */
  showQuickEntry(sku?: string, price?: string): void;
  /** Shows the dashboard and sends it push 'ui.openItem'. */
  openItemInDashboard(sku: string): void;
  /**
   * 0.7.1 'app.showBankStock' (validated): shows the dashboard and sends it push 'ui.openBankStock'. Loads
   * nothing in the scrap.tf window. Optional, so a router without it (tests) answers with a fixed refusal.
   */
  showBankStock?(bank: ScraptfBank, filter: BankStockOpenFilter): void;
  appInfo(): AppInfo;
  /** The current 'service.state' push (serviceStatePush of the host's status), for a page that loaded after it was sent. */
  serviceState(): PushContract['service.state'] | null;
  /** F16: both global hotkeys as registered now (settingsStore's hotkeyStatus and checkHotkeyStatus). */
  hotkeys(): HotkeysStatus;
  /**
   * F19 'check.arm' (validated): remember the item opened on scrap.tf for CHECK_ARM_MS, replacing any
   * earlier one; null disarms. Memory only; the name is never logged.
   */
  armCheck(arm: CheckArm | null): { armedUntil: UnixMs | null };
  isAllowedExternalUrl(url: string): boolean;
  openExternal(url: string): Promise<void>;
  /**
   * F21: the scrap.tf window (main/scraptfWindow.ts). Optional, so a router without one (tests) answers
   * every 'scraptfWindow.*' call with a fixed refusal and links.open keeps to the browser.
   */
  scraptfWindow?: ScraptfWindowRpc;
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

/** What the router asks of the scrap.tf window. */
export type ScraptfWindowRpc = Pick<ScraptfWindowManager, 'open' | 'back' | 'forward' | 'reload' | 'home' | 'go' | 'readNow' | 'clear' | 'state'>;

const secretsSetParams = z.object({
  name: secretNameSchema,
  value: z.string().max(MAX_SECRET_LENGTH).nullable(),
});
// F21 allowWindow: the caller words its link for the scrap.tf window when openLinksInWindow is on.
const linksOpenParams = z.object({ url: z.string().min(1).max(4096), allowWindow: z.boolean().optional() });
const openItemParams = z.object({ sku: z.string().trim().min(1).max(200).regex(/^\d+;\d+(;[a-z0-9-]+)*$/i, 'not a SKU') });
// Same rule as the service's skuText (rpcHandlers.ts): the SKU is pushed to the renderer as is.
const quickEntrySku = z.string().trim().min(1).max(300).toLowerCase().refine(isValidSku, 'not a SKU');
// Price text for quick entry's field (F16): short, one line, no markup; quick entry parses it like typing.
const quickEntryPrice = z
  .string()
  .trim()
  .min(1)
  .max(CHECK_PRICE_TEXT_MAX)
  .refine((s) => !/[\u0000-\u001f\u007f<>]/.test(s), 'not a price');
const showQuickEntryParams = z.object({ sku: quickEntrySku.optional(), price: quickEntryPrice.optional() }).nullish();
// F19. Fixed messages only: the name is item data the user is about to paste, and a failed call's
// message reaches main's debug log (registerRpcHandler), so no issue may quote it.
const checkArmParams = z
  .object(
    {
      sku: z
        .string({ error: 'not a SKU' })
        .trim()
        .min(1, { error: 'not a SKU' })
        .max(300, { error: 'not a SKU' })
        .toLowerCase()
        .refine(isValidSku, { error: 'not a SKU' }),
      name: z
        .string({ error: 'must be a string' })
        .trim()
        .min(1, { error: 'an item name is required' })
        .max(CHECK_ARM_NAME_MAX, { error: `at most ${CHECK_ARM_NAME_MAX} characters` })
        .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), { error: 'not an item name' }),
    },
    { error: 'expected { sku, name } or null' },
  )
  .nullable();
// 0.7.1. Fixed messages only, as above: a failed call's message reaches main's debug log, so no issue
// may quote the params.
const showBankStockParams = z.object(
  {
    bank: z.custom<ScraptfBank>((v) => isScraptfBank(v), { error: 'not a scrap.tf bank' }),
    filter: z.enum(BANK_STOCK_OPEN_FILTERS as unknown as [BankStockOpenFilter, ...BankStockOpenFilter[]], { error: 'must be flips or new' }),
  },
  { error: 'expected { bank, filter }' },
);
const saveTextParams = z.object({
  suggestedName: z.string().max(255),
  text: z.string().max(MAX_SAVE_TEXT_CHARS),
});
const importHtmlParams = z.looseObject({ html: z.string().max(MAX_IMPORT_BYTES) });
/** The saved pages "Import file" reads: .html/.htm, and .mhtml/.mht (F18, "Webpage, Single File"). */
const PICKABLE_PAGE = /\.(?:html?|mht(?:ml)?)$/i;
export const PICK_PAGE_REFUSAL = 'Choose a saved .html or .mhtml page.';

/**
 * F16: a page's 'check.text' is text the user typed or pasted ('manual'). 'hotkey' and 'watch' mean
 * main read the clipboard and filtered it (liveCheck.ts), so a page may not claim them. Fixed text:
 * the message never echoes the params.
 */
export const CHECK_TEXT_SOURCE_REFUSAL = 'Invalid parameters for check.text: source: a page can only send manual checks';
/** F19: only main adds a 'check.text' hint (from its own 'check.arm'); a page may not. Fixed text, like the above. */
export const CHECK_TEXT_HINT_REFUSAL = 'Invalid parameters for check.text: hint: only the check hotkey and the clipboard watcher send one';
// F21: a page's 'import.html' may not carry address or origin (main's window read calls the service directly).
export { IMPORT_HTML_ORIGIN_REFUSAL };
/** F21: a router built without the scrap.tf window (tests). */
export const SCRAPTF_WINDOW_UNAVAILABLE = 'The scrap.tf window is not available.';
/** 0.7.1: a router built without showBankStock (tests). */
export const SHOW_BANK_STOCK_UNAVAILABLE = 'The dashboard is not available.';
// F21. Fixed text: the URL is never quoted (a failed call's message reaches main's debug log).
const START_REFUSAL = 'not a scrap.tf page the window opens';
const windowStartUrl = z
  .string({ error: START_REFUSAL })
  .max(4096, { error: START_REFUSAL })
  .refine((u) => isAllowedWindowStart(u), { error: START_REFUSAL });
const scraptfOpenParams = z.object({ start: windowStartUrl.optional() }, { error: 'expected { start? }' }).nullish();
const scraptfGoParams = z.object({ url: windowStartUrl }, { error: 'expected { url }' });
const CLOSED_WINDOW: ScraptfWindowState = { open: false, url: null, canGoBack: false, canGoForward: false, lastRead: null };

function hasWindowImportKeys(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  // 0.7.1: `settled` too, which only main's window read sets (a page could otherwise skip a stock save).
  const p = params as { address?: unknown; origin?: unknown; settled?: unknown };
  return p.address !== undefined || p.origin !== undefined || p.settled !== undefined;
}

function isManualCheck(params: unknown): boolean {
  return typeof params === 'object' && params !== null && (params as { source?: unknown }).source === 'manual';
}

function hasHint(params: unknown): boolean {
  return typeof params === 'object' && params !== null && (params as { hint?: unknown }).hint !== undefined;
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown, method: string): T {
  const r = schema.safeParse(params);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
    throw new Error(`Invalid parameters for ${method}: ${where}${issue?.message ?? 'invalid'}`);
  }
  return r.data;
}

/** File types file.saveText may write for a CSV export (the save dialog offers exactly these). */
export const SAVE_EXTENSIONS: ReadonlySet<string> = new Set(['.csv', '.txt']);
/** File types for a JSON backup (rules export), offered when the suggested name ends in .json. */
export const JSON_SAVE_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.txt']);

/** `name` with its extension replaced by .csv (kept when it already is .csv). */
export function withCsvExtension(name: string): string {
  const ext = path.extname(name);
  if (ext.toLowerCase() === '.csv') return name;
  return `${ext ? name.slice(0, -ext.length) : name}.csv`;
}

/** True for a JSON backup name; anything else is offered as .csv. */
export function isJsonExportName(name: string): boolean {
  return path.extname(name).toLowerCase() === '.json';
}

const mainMethods = new Set<string>(MAIN_METHODS);
const serviceMethods = new Set<string>(SERVICE_METHODS);

export function isKnownMethod(method: unknown): method is RpcMethod {
  return typeof method === 'string' && (mainMethods.has(method) || serviceMethods.has(method));
}

export function createRpcRouter(deps: MainRpcDeps): RpcRouter {
  /** F21: the window, for an action the user may take only while it is on. */
  const windowOn = (): ScraptfWindowRpc => {
    if (!deps.scraptfWindow) throw new Error(SCRAPTF_WINDOW_UNAVAILABLE);
    if (!deps.settings.get().scraptfWindow.enabled) throw new Error(SCRAPTF_WINDOW_OFF);
    return deps.scraptfWindow;
  };

  return async (ctx, method, params) => {
    if (!isKnownMethod(method)) {
      throw new Error(typeof method === 'string' ? `Unknown method: ${method.slice(0, 64)}` : 'Invalid method');
    }

    if (serviceMethods.has(method)) {
      // F21: only main's own call for a scrap.tf window read carries these.
      if (method === 'import.html' && hasWindowImportKeys(params)) throw new Error(IMPORT_HTML_ORIGIN_REFUSAL);
      // Same 20 MB cap as the file picker; the service re-validates everything else.
      if (method === 'import.html') parseParams(importHtmlParams, params, method);
      if (method === 'check.text' && !isManualCheck(params)) throw new Error(CHECK_TEXT_SOURCE_REFUSAL);
      if (method === 'check.text' && hasHint(params)) throw new Error(CHECK_TEXT_HINT_REFUSAL);
      return deps.service.callRaw(method, params);
    }

    switch (method) {
      case 'app.info':
        return deps.appInfo();
      case 'app.serviceState':
        // Answered by main itself: the service may be exactly what is down.
        return deps.serviceState();
      case 'app.hotkeys':
        // Copies: the status objects are main's own and must not be changed through IPC.
        return structuredClone(deps.hotkeys());
      case 'check.arm':
        return deps.armCheck(parseParams(checkArmParams, params, method));
      case 'app.showQuickEntry': {
        const p = parseParams(showQuickEntryParams, params, method);
        if (p?.sku === undefined) deps.showQuickEntry();
        else if (p.price === undefined) deps.showQuickEntry(p.sku);
        // A price means nothing without its item, so it is only passed on with a SKU.
        else deps.showQuickEntry(p.sku, p.price);
        return { ok: true };
      }
      case 'app.hideWindow':
        ctx.hideWindow();
        return { ok: true };
      case 'app.openItem': {
        const { sku } = parseParams(openItemParams, params, method);
        deps.openItemInDashboard(sku);
        return { ok: true };
      }
      case 'app.showBankStock': {
        const { bank, filter } = parseParams(showBankStockParams, params, method);
        if (!deps.showBankStock) throw new Error(SHOW_BANK_STOCK_UNAVAILABLE);
        deps.showBankStock(bank, filter);
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
        const { url, allowWindow } = parseParams(linksOpenParams, params, method);
        // F21: the user chose to open the app's static scrap.tf pages in the scrap.tf window. Only a caller
        // that says so (allowWindow) sends one there: a button that promises the browser keeps its word.
        const sw = deps.settings.get().scraptfWindow;
        if (allowWindow === true && deps.scraptfWindow && sw.enabled && sw.openLinksInWindow && isAllowedWindowStart(url)) {
          deps.scraptfWindow.open(url);
          return { opened: true, reason: null, openedIn: 'window' };
        }
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
        // F18: an .mhtml/.mht save is passed on as text too; the service unpacks its web page.
        if (!PICKABLE_PAGE.test(file)) throw new Error(PICK_PAGE_REFUSAL);
        const st = await deps.files.stat(file);
        if (!st.isFile()) throw new Error(PICK_PAGE_REFUSAL);
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
        // Exports are CSV, or a JSON backup: the caller's name never picks any other type (no .bat/.hta/.url).
        const safe = sanitizeFileName(p.suggestedName, 'export.csv');
        const json = isJsonExportName(safe);
        const name = json ? safe : withCsvExtension(safe);
        const target = await deps.dialogs.saveFile(ctx.window, name);
        if (!target) return { saved: false, path: null };
        if (!(json ? JSON_SAVE_EXTENSIONS : SAVE_EXTENSIONS).has(path.extname(target).toLowerCase())) {
          throw new Error(json ? 'Backups can only be saved as .json or .txt files.' : 'Exports can only be saved as .csv or .txt files.');
        }
        await deps.files.writeText(target, p.text);
        return { saved: true, path: target };
      }
      // ----- F21: the scrap.tf window. Every call is a user's click (dashboard, tray, toolbar). -----
      case 'scraptfWindow.open': {
        const w = windowOn();
        const p = parseParams(scraptfOpenParams, params, method);
        if (p?.start === undefined) w.open();
        else w.open(p.start);
        return { ok: true };
      }
      case 'scraptfWindow.back':
        windowOn().back();
        return { ok: true };
      case 'scraptfWindow.forward':
        windowOn().forward();
        return { ok: true };
      case 'scraptfWindow.reload':
        windowOn().reload();
        return { ok: true };
      case 'scraptfWindow.home':
        windowOn().home();
        return { ok: true };
      case 'scraptfWindow.go': {
        const w = windowOn();
        w.go(parseParams(scraptfGoParams, params, method).url);
        return { ok: true };
      }
      case 'scraptfWindow.read':
        return windowOn().readNow();
      case 'scraptfWindow.clear':
        // Allowed while off: the user may want the session gone after turning the window off.
        if (!deps.scraptfWindow) throw new Error(SCRAPTF_WINDOW_UNAVAILABLE);
        await deps.scraptfWindow.clear();
        return { ok: true };
      case 'scraptfWindow.state':
        // A copy: main's own state must not change through IPC.
        return deps.scraptfWindow ? structuredClone(deps.scraptfWindow.state()) : { ...CLOSED_WINDOW };
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
