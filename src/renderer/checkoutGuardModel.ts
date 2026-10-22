// 0.9 (RESEARCH #9): where the dashboard shows the checkout guard (shared/checkoutGuard.ts): only where Flip Desk
// suggests buying. Pure; text only: nothing here opens, loads or joins anything (R1, R4).

import { CHECKOUT_GUARD_POPUP, CHECKOUT_GUARD_SHORT, checkoutGuardTitle } from '../shared/checkoutGuard';
import type { CheckResult, ScraptfTimingBrief } from '../shared/types';

/** 0.9 (#9): the Live check popup's guard line: only on a flip (the popup suggests buying), else null. */
export function checkGuardLine(r: Pick<CheckResult, 'status' | 'verdict'> | null | undefined): { text: string; title: string } | null {
  return r?.status === 'item' && r.verdict === 'flip' ? { text: CHECKOUT_GUARD_POPUP, title: checkoutGuardTitle() } : null;
}

/** 0.9 (#9): the drawer shows the guard under a Buy now verdict only. */
export function timingGuardShown(t: Pick<ScraptfTimingBrief, 'verdict'> | null | undefined): boolean {
  return t?.verdict === 'buy-now';
}

/** 0.9 (#9): the Shopping list's line: the guard's one-line form, the full guard in its title. */
export function shoppingGuardLine(): { text: string; title: string } {
  return { text: CHECKOUT_GUARD_SHORT, title: checkoutGuardTitle() };
}
