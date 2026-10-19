import type { ReactNode } from 'react';
import { openLink } from '../api';
import { copyText } from '../clipboard';
import { useApp, type ToastTone } from '../hooks/appContext';
import { Icon } from './Icon';

/**
 * Opens an https link through main's allowlist ('links.open'). When main
 * refuses (host not allowlisted, mock mode), the address is copied instead
 * and the reason is shown. F21 `allowWindow`: see openLink (only for an open worded for the scrap.tf window).
 */
export async function openOrCopy(url: string, toast: (text: string, tone?: ToastTone) => void, opts: { allowWindow?: boolean } = {}): Promise<void> {
  const r = await openLink(url, opts);
  if (r.opened) return;
  const copied = await copyText(url);
  const why = r.reason ?? 'The link could not be opened.';
  toast(copied ? `${why} The address was copied, paste it into your browser.` : `${why} ${url}`, 'warn');
}

export function ExternalLink({ url, children, className = 'link-btn', showUrl = false }: { url: string; children: ReactNode; className?: string; showUrl?: boolean }) {
  const { toast } = useApp();
  return (
    <span className="ext-link">
      <button type="button" className={className} onClick={() => void openOrCopy(url, toast)} title={url}>
        {children}
        <Icon name="external" size={12} />
      </button>
      {showUrl ? <span className="muted small mono"> {url.replace(/^https:\/\//, '')}</span> : null}
    </span>
  );
}
