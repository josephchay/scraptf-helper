// Desktop toasts for the service's 'notify' push. Pure (no Electron import) so the
// shape check, clipping, the user's notification settings and what a click opens are unit-tested.

import { z } from 'zod';
import type { Logger } from '../service/contracts';
import { isAllowedExternalUrl, isScraptfBankUrl } from '../shared/links';
import type { PushContract } from '../shared/rpc';
import type { Settings } from '../shared/types';
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
 * The toast for a 'notify' push, clipped to what Windows shows; null when the payload is malformed.
 * `openUrl` is kept only when notificationOpenUrl accepts it (the key is absent otherwise).
 */
export function notificationContent(payload: unknown): PushContract['notify'] | null {
  const parsed = notifySchema.safeParse(payload);
  if (!parsed.success) return null;
  const openUrl = notificationOpenUrl(parsed.data.openUrl);
  return {
    title: clip(parsed.data.title, NOTIFY_TITLE_MAX),
    body: clip(parsed.data.body, NOTIFY_BODY_MAX),
    sku: parsed.data.sku,
    ...(openUrl !== null ? { openUrl } : {}),
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

/** What a notification click did: opened the bank page in the browser, an item's drawer, or the dashboard. */
export type NotificationClickAction = 'url' | 'item' | 'dashboard';

export interface NotificationClickDeps {
  /** shell.openExternal, the opener links.open uses: the user's browser, never an app window. */
  openExternal(url: string): Promise<void> | void;
  /** Shows the dashboard and opens the item's drawer. */
  openItem(sku: string): void;
  showDashboard(): void;
  log: Pick<Logger, 'warn'>;
}

/**
 * A toast click. An openUrl is checked again here (the data object lives on in a closure, so the check
 * at receipt is not trusted alone) and opened only when it is still a static bank page; any other
 * openUrl is refused and the click does what it always did: the SKU's drawer, else the dashboard.
 * A browser that fails to open (openExternal throws or rejects) is logged and falls back to the
 * dashboard, so that path never rejects; openItem/showDashboard errors propagate as they did before.
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
  if (data.sku) {
    deps.openItem(data.sku);
    return 'item';
  }
  deps.showDashboard();
  return 'dashboard';
}
