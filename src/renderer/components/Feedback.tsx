import type { FocusEvent, MouseEvent, ReactNode } from 'react';
import { useApp } from '../hooks/appContext';
import { topmostModalIn } from '../itemMenuModel';
import type { ToastHold, ToastItem } from '../toastModel';
import { Icon, type IconName } from './Icon';

export function EmptyState({
  icon = 'info',
  title,
  children,
  actions,
  compact = false,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`} role="status">
      <div className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={compact ? 18 : 22} />
      </div>
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner tone-bad" role="alert">
      <Icon name="warning" />
      <span className="banner-text">{message}</span>
      {onRetry ? (
        <button type="button" className="btn small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Banner({ tone = 'info', icon = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; icon?: IconName; children: ReactNode }) {
  return (
    <div className={`banner tone-${tone}`}>
      <Icon name={icon} />
      <div className="banner-text">{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span aria-hidden="true" />
    </span>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner label={label} />
      <span>{label}</span>
    </div>
  );
}

/**
 * A toast leaving while it holds focus (its Undo or Dismiss was pressed) would drop focus to <body>,
 * behind an open modal: the Record trade dialog's keys and focus trap, and the drawer's, would stop
 * working, and Esc would reach the drawer. Focus goes to the modal on top instead, if one is open.
 */
function keepFocusInModal(e: MouseEvent<HTMLButtonElement>): void {
  const toast = e.currentTarget.parentElement;
  const active = document.activeElement;
  if (!toast || !active || !toast.contains(active)) return;
  topmostModalIn<HTMLElement>(document.body)?.focus({ preventScroll: true });
}

export function ToastStack() {
  const { toasts, dismissToast, holdToast } = useApp();
  return <ToastList toasts={toasts} onDismiss={dismissToast} onHold={holdToast} />;
}

/**
 * The toasts themselves (exported for tests). An action button (H3) runs the action and dismisses
 * the toast; hover and focus on an action toast hold its countdown so an Undo stays reachable.
 */
export function ToastList({
  toasts,
  onDismiss,
  onHold,
}: {
  toasts: readonly ToastItem[];
  onDismiss: (id: number) => void;
  onHold?: (id: number, why: ToastHold, on: boolean) => void;
}) {
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => {
        const action = t.action;
        const hold = action && onHold ? (why: ToastHold, on: boolean) => onHold(t.id, why, on) : null;
        return (
          <div
            key={t.id}
            className={`toast tone-${t.tone}${action ? ' has-action' : ''}`}
            role={t.tone === 'bad' ? 'alert' : 'status'}
            onMouseEnter={hold ? () => hold('hover', true) : undefined}
            onMouseLeave={hold ? () => hold('hover', false) : undefined}
            onFocus={hold ? () => hold('focus', true) : undefined}
            onBlur={
              hold
                ? (e: FocusEvent<HTMLDivElement>) => {
                    // Moving between the toast's own buttons keeps the hold.
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold('focus', false);
                  }
                : undefined
            }
          >
            <Icon name={t.tone === 'good' ? 'check' : t.tone === 'bad' || t.tone === 'warn' ? 'warning' : 'info'} />
            <span>{t.text}</span>
            {action ? (
              <button
                type="button"
                className="btn small toast-action"
                onClick={(e) => {
                  try {
                    action.onClick();
                  } finally {
                    onDismiss(t.id);
                    keepFocusInModal(e);
                  }
                }}
              >
                {action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn"
              aria-label="Dismiss"
              onClick={(e) => {
                onDismiss(t.id);
                keepFocusInModal(e);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
