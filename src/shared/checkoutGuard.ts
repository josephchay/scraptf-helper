// 0.9 (RESEARCH #9): what to know before joining a scrap.tf bank's queue, shown where Flip Desk suggests buying (the Buy
// now tag and the item panel, the Live check, the Shopping list, watch and Buy now toasts). Text only: the app never
// joins, leaves or watches a queue (R1, R4), and scrap.tf publishes none of these timings, so each line names its source
// and how sure it is. Shared by the dashboard, the service's S3 notifier and the engine's watch toast. Pure and zod-free;
// it holds no address (an F20 file).

/** Where a guard line comes from: scrap.tf's help pages, its forum, an inference, or Flip Desk's own rule. */
export type CheckoutGuardSource = 'help' | 'community' | 'inferred' | 'rule';
/** The guard lines, by id. */
export type CheckoutGuardId = 'queue-reserves' | 'accept-promptly' | 'lapse-lock' | 'one-request' | 'no-rejoin';
/** One guard line and its source. */
export interface CheckoutGuardLine {
  id: CheckoutGuardId;
  text: string;
  source: CheckoutGuardSource;
}

/** When the sources were read (RESEARCH.md §4.1). */
export const CHECKOUT_GUARD_CHECKED = '2026-10-22';
/** The guard's heading. */
export const CHECKOUT_GUARD_HEAD = 'Before you buy on scrap.tf';
/** How sure each source is, as the lists and titles say it. */
export const CHECKOUT_GUARD_SOURCE_LABELS: Readonly<Record<CheckoutGuardSource, string>> = Object.freeze({
  help: "scrap.tf's help pages, read from search-engine copies",
  community: "community reports on scrap.tf's forum (2024), not confirmed by scrap.tf",
  inferred: 'inferred from third-party code and one forum report',
  rule: "reportedly penalised; Flip Desk's rule R4",
});
/** The guard lines, in the order they are shown. */
export const CHECKOUT_GUARD_LINES: readonly CheckoutGuardLine[] = Object.freeze([
  { id: 'queue-reserves', source: 'help', text: "Joining the bank's queue is what reserves the items you picked; nothing reserves them before that, and scrap.tf publishes no reservation length." },
  { id: 'accept-promptly', source: 'help', text: "Accept the bot's trade offer promptly: scrap.tf cancels offers after a time it does not publish." },
  { id: 'lapse-lock', source: 'community', text: 'Letting an offer lapse can lock you out of buying for about 2 hours.' },
  { id: 'one-request', source: 'inferred', text: 'Keep one queue request pending at a time.' },
  { id: 'no-rejoin', source: 'rule', text: 'Never leave and rejoin the queue to wait for a lower price.' },
]);
/** The boundary line every full guard ends with. */
export const CHECKOUT_GUARD_NEVER = 'Flip Desk never joins, leaves or watches a queue for you.';
/** One line (Shopping list). */
export const CHECKOUT_GUARD_SHORT =
  "Before you buy: joining scrap.tf's queue reserves the items, so accept the bot's offer promptly; a lapsed offer can lock buying for about 2 h (community-reported). Keep one request pending, and never leave and rejoin for a lower price.";
/** Appended to a Buy now tag's title (timingBadge). */
export const CHECKOUT_GUARD_TAG =
  "Before you buy: joining scrap.tf's queue reserves it; accept the bot's offer promptly (a lapsed offer can lock buying for about 2 h, community-reported).";
/** The Live check popup's one line on a flip (its title holds checkoutGuardTitle()). */
export const CHECKOUT_GUARD_POPUP = "Before you buy: accept the bot's offer promptly";
/** The toast suffix (withCheckoutGuard). */
export const CHECKOUT_GUARD_TOAST = "Accept the bot's offer promptly.";
/** The longest toast body the suffix may make; a longer result keeps the body as it was. */
export const CHECKOUT_GUARD_TOAST_BODY_MAX = 200;

/** Each line with its source label, in order (the drawer's list). */
export function checkoutGuardItems(): { id: CheckoutGuardId; text: string; source: string }[] {
  return CHECKOUT_GUARD_LINES.map((l) => ({ id: l.id, text: l.text, source: CHECKOUT_GUARD_SOURCE_LABELS[l.source] }));
}

/** "Before you buy on scrap.tf (sources read 2026-10-22): <line> (<label>). … Flip Desk never joins, leaves or watches a queue for you." */
export function checkoutGuardTitle(): string {
  return `${CHECKOUT_GUARD_HEAD} (sources read ${CHECKOUT_GUARD_CHECKED}): ${checkoutGuardItems()
    .map((i) => `${i.text} (${i.source})`)
    .join(' ')} ${CHECKOUT_GUARD_NEVER}`;
}

/**
 * A toast body with CHECKOUT_GUARD_TOAST appended ('. ' after a body not ending in . ! or ?, else ' '), only when the
 * result is at most `max` characters; the body unchanged otherwise (also an empty or non-string body).
 */
export function withCheckoutGuard(body: string, max: number = CHECKOUT_GUARD_TOAST_BODY_MAX): string {
  const b = typeof body === 'string' ? body.trimEnd() : '';
  if (b === '') return body;
  const joined = `${b}${/[.!?]$/.test(b) ? ' ' : '. '}${CHECKOUT_GUARD_TOAST}`;
  return joined.length <= max ? joined : body;
}
