import type { ReactNode } from 'react';
import { useApp } from '../hooks/appContext';
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

export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast tone-${t.tone}`} role={t.tone === 'bad' ? 'alert' : 'status'}>
          <Icon name={t.tone === 'good' ? 'check' : t.tone === 'bad' || t.tone === 'warn' ? 'warning' : 'info'} />
          <span>{t.text}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
