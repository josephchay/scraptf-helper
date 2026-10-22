// 0.9 (RESEARCH #9): the checkout guard, shown where Flip Desk suggests buying: the full list under the drawer's Buy now
// verdict, one line on the Shopping list. Text only: no link, image or opener, and nothing joins, leaves or watches a
// queue (R1, R4). Texts: src/shared/checkoutGuard.ts (each line names its source and how sure it is); the line form:
// checkoutGuardModel.ts. Styles: styles/components.css (checkout-guard*).

import { CHECKOUT_GUARD_HEAD, CHECKOUT_GUARD_NEVER, checkoutGuardItems } from '../../shared/checkoutGuard';
import { shoppingGuardLine } from '../checkoutGuardModel';
import { Icon } from './Icon';

/** 0.9 (#9): 'list' every guard line with its source (spans, no `<p>`); 'line' the one-line form, the full guard in its title. */
export function CheckoutGuard({ variant }: { variant: 'list' | 'line' }) {
  if (variant === 'line') {
    const line = shoppingGuardLine();
    return (
      <p className="checkout-guard-line small muted" title={line.title}>
        <Icon name="info" size={12} /> {line.text}
      </p>
    );
  }
  return (
    <div className="checkout-guard" role="note" aria-label={CHECKOUT_GUARD_HEAD}>
      <span className="checkout-guard-head small">{CHECKOUT_GUARD_HEAD}</span>
      <ul className="plain-list checkout-guard-list small">
        {checkoutGuardItems().map((i) => (
          <li key={i.id}>
            {i.text} <span className="muted">({i.source})</span>
          </li>
        ))}
      </ul>
      <span className="muted small">{CHECKOUT_GUARD_NEVER}</span>
    </div>
  );
}
