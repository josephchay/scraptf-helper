// Desktop toasts for the service's 'notify' push. Pure (no Electron import) so the
// shape check, clipping, the user's notification settings and what a click opens are unit-tested.

import { z } from 'zod';
import type { Logger } from '../service/contracts';
import { isAllowedExternalUrl, isScraptfBankUrl } from '../shared/links';
import type { PushContract } from '../shared/rpc';
import { BANK_STOCK_OPEN_FILTERS, SCRAPTF_BANK_IDS, type BankStockOpen, type BankStockOpenFilter, type ScraptfBank, type Settings } from '../shared/types';
import { isHttpsUrl, safeErrorMessage } from './paths';

export const NOTIFY_TITLE_MAX = 120;
export const NOTIFY_BODY_MAX = 400;
/** Same bound as the links allowlist; a longer openUrl is dropped, never clipped. */
export const NOTIFY_URL_MAX = 4096;

const notifySchema = z.looseObject({
  title: z.string().min(1),
  body: z.string(),
  sku: z.string().nullable().catch(null),
  // F20: a bad openUrl costs the toast its link, never the toast itself.
  openUrl: z.string().max(NOTIFY_URL_MAX).optional().catch(undefined),
  // 0.8 (G5): a bad bank stock link costs the toast its link, never the toast itself.
  openBankStock: z
    .object({
      bank: z.enum(SCRAPTF_BANK_IDS as unknown as [ScraptfBank, ...ScraptfBank[]]),
      filter: z.enum(BANK_STOCK_OPEN_FILTERS as unknown as [BankStockOpenFilter, ...BankStockOpenFilter[]]),
    })
    .optional()
    .catch(undefined),
});

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * F20: the URL a notification click may open, or null. Only a static scrap.tf bank page (an exact
 * SCRAPTF_BANKS URL) that the links.open allowlist accepts as well: never another scrap.tf path, another
 * host, a URL built from item data, javascript: or file:. A click is the user's action, and the page goes
 * to their browser (shell.openExternal); the app itself never loads it (R1). Checked when the push
 * arrives and again at click time.
 */
export function notificationOpenUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > NOTIFY_URL_MAX) return null;
  try {
    return isHttpsUrl(url) && isAllowedExternalUrl(url) && isScraptfBankUrl(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * 0.8 (G5): the bank stock page a notification click may show, or null: a plain object naming a known bank
 * (SCRAPTF_BANK_IDS) and an open chip (BANK_STOCK_OPEN_FILTERS), returned as a fresh { bank, filter }. An in-app
 * route, never a URL: nothing loads scrap.tf. Checked when the push arrives and again at click time.
 */
export function notificationBankStock(v: unknown): BankStockOpen | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { bank, filter } = v as { bank?: unknown; filter?: unknown };
  if (typeof bank !== 'string' || typeof filter !== 'string') return null;
  if (!SCRAPTF_BANK_IDS.includes(bank as ScraptfBank) || !BANK_STOCK_OPEN_FILTERS.includes(filter as BankStockOpenFilter)) return null;
  return { bank: bank as ScraptfBank, filter: filter as BankStockOpenFilter };
}

/**
 * The toast for a 'notify' push, clipped to what Windows shows; null when the payload is malformed.
 * `openUrl` is kept only when notificationOpenUrl accepts it, and (0.8, G5) `openBankStock` only when it names a known
 * bank and chip (each key is absent otherwise).
 */
export function notificationContent(payload: unknown): PushContract['notify'] | null {
  const parsed = notifySchema.safeParse(payload);
  if (!parsed.success) return null;
  const openUrl = notificationOpenUrl(parsed.data.openUrl);
  const openBankStock = notificationBankStock(parsed.data.openBankStock);
  return {
    title: clip(parsed.data.title, NOTIFY_TITLE_MAX),
    body: clip(parsed.data.body, NOTIFY_BODY_MAX),
    sku: parsed.data.sku,
    ...(openUrl !== null ? { openUrl } : {}),
    ...(openBankStock !== null ? { openBankStock } : {}),
  };
}

/** True when a push carried an openUrl that notificationContent dropped (main logs that, never the URL). */
export function droppedOpenUrl(payload: unknown, data: PushContract['notify']): boolean {
  if (typeof payload !== 'object' || payload === null || !('openUrl' in payload)) return false;
  return payload.openUrl !== undefined && data.openUrl === undefined;
}

/** Options for Electron's `new Notification(...)`. `silent` (Settings > Notifications) mutes the Windows sound. */
export function notificationOptions(
  data: Pick<PushContract['notify'], 'title' | 'body'>,
  prefs: Pick<Settings['notifications'], 'silent'>,
  icon: string,
): { title: string; body: string; icon: string; silent: boolean } {
  return { title: data.title, body: data.body, icon, silent: prefs.silent === true };
}

/**
 * What a notification click did: opened the bank page in the browser, (0.8, G5) a bank's stock page in the
 * dashboard, an item's drawer, or the dashboard.
 */
export type NotificationClickAction = 'url' | 'bankStock' | 'item' | 'dashboard';

export interface NotificationClickDeps {
  /** shell.openExternal, the opener links.open uses: the user's browser, never an app window. */
  openExternal(url: string): Promise<void> | void;
  /** 0.8 (G5): shows the dashboard on a bank's stock page and chip (main: showBankStock); absent: the click goes on to the item or the dashboard. */
  openBankStock?(open: BankStockOpen): void;
  /** Shows the dashboard and opens the item's drawer. */
  openItem(sku: string): void;
  showDashboard(): void;
  log: Pick<Logger, 'warn'>;
}

/**
 * A toast click, in this order: openUrl, then (0.8, G5) openBankStock, then the SKU's drawer, then the dashboard.
 * An openUrl is checked again here (the data object lives on in a closure, so the check at receipt is not
 * trusted alone) and opened only when it is still a static bank page; any other openUrl is refused and the
 * click goes on. An openBankStock is checked again the same way (notificationBankStock) and shows the bank's
 * stock page in the dashboard; no URL is involved. A browser that fails to open (openExternal throws or rejects)
 * is logged and falls back to the dashboard, so that path never rejects; openBankStock/openItem/showDashboard
 * errors propagate as they did before.
 */
export async function handleNotificationClick(data: PushContract['notify'], deps: NotificationClickDeps): Promise<NotificationClickAction> {
  if (data.openUrl !== undefined) {
    const url = notificationOpenUrl(data.openUrl);
    if (url !== null) {
      try {
        await deps.openExternal(url);
        return 'url';
      } catch (err) {
        deps.log.warn('could not open the scrap.tf bank page from a notification', { error: safeErrorMessage(err) });
        deps.showDashboard();
        return 'dashboard';
      }
    }
    // No URL in the log: a refused one may be built from item data.
    deps.log.warn('a notification click refused a link that is not a static scrap.tf bank page');
  }
  if (data.openBankStock !== undefined && deps.openBankStock) {
    // Checked again at click time, as the URL is; no URL is involved and nothing loads scrap.tf.
    const open = notificationBankStock(data.openBankStock);
    if (open !== null) {
      deps.openBankStock(open);
      return 'bankStock';
    }
  }
  if (data.sku) {
    deps.openItem(data.sku);
    return 'item';
  }
  deps.showDashboard();
  return 'dashboard';
}
