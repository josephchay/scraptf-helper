// Desktop toasts for the service's 'notify' push. Pure (no Electron import) so the
// shape check, clipping and the user's notification settings are unit-tested.

import { z } from 'zod';
import type { PushContract } from '../shared/rpc';
import type { Settings } from '../shared/types';

export const NOTIFY_TITLE_MAX = 120;
export const NOTIFY_BODY_MAX = 400;

const notifySchema = z.looseObject({
  title: z.string().min(1),
  body: z.string(),
  sku: z.string().nullable().catch(null),
});

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** The toast for a 'notify' push, clipped to what Windows shows; null when the payload is malformed. */
export function notificationContent(payload: unknown): PushContract['notify'] | null {
  const parsed = notifySchema.safeParse(payload);
  if (!parsed.success) return null;
  return { title: clip(parsed.data.title, NOTIFY_TITLE_MAX), body: clip(parsed.data.body, NOTIFY_BODY_MAX), sku: parsed.data.sku };
}

/** Options for Electron's `new Notification(...)`. `silent` (Settings > Notifications) mutes the Windows sound. */
export function notificationOptions(
  data: Pick<PushContract['notify'], 'title' | 'body'>,
  prefs: Pick<Settings['notifications'], 'silent'>,
  icon: string,
): { title: string; body: string; icon: string; silent: boolean } {
  return { title: data.title, body: data.body, icon, silent: prefs.silent === true };
}
