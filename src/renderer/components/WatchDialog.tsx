// "Watch on scrap.tf…" from an item's menu (0.8, G1/G3): a modal with the watch form for that item, its copy (the
// row's bank_stock special key, else the SKU's own) and the watches it already has (one local 'watches.list' read).
// Modelled on the Record trade dialog: a portal into the modal around the opener (the drawer) or the body, a focus
// trap, Escape closes, and focus goes back to the opener. It writes only the user's own watch list; nothing is
// fetched, opened or bought (R1, R4).

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ScraptfWatchView } from '../../shared/types';
import { rpc } from '../api';
import { errorMessage } from '../format';
import { useApp } from '../hooks/appContext';
import { modalHostOf } from '../itemMenuModel';
import { afterDialogClose, tabbablesWithin } from '../recordTradeModel';
import { watchesForCopy } from '../watchesModel';
import { trapFocusTarget } from './Drawer';
import { Icon } from './Icon';
import { WatchForm } from './WatchForm';

/** What the dialog watches: an item, and the copy its row shows (null or absent: the SKU's own). */
export interface WatchTarget {
  sku: string;
  name: string;
  special?: string | null;
}

interface OpenState {
  seq: number;
  target: WatchTarget;
  /** Focus goes back here when the dialog closes. */
  opener: Element | null;
}

/** Render `element` once in the page; call open() from any entry point (the item menu). */
export function useWatchDialog(): { open(t: WatchTarget): void; element: ReactNode } {
  const [state, setState] = useState<OpenState | null>(null);
  const seq = useRef(0);
  const open = useCallback((target: WatchTarget) => {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    setState({ seq: ++seq.current, target, opener: active && active !== document.body ? active : null });
  }, []);
  // By seq: a save that lands after its dialog was dismissed must not close a newer one.
  const close = useCallback((which: number) => setState((s) => afterDialogClose(s, which)), []);
  const element = state ? <WatchDialog key={state.seq} target={state.target} opener={state.opener} onClose={() => close(state.seq)} /> : null;
  // Stable while closed, so callers can list the hook's result as a dependency.
  return useMemo(() => ({ open, element }), [open, element]);
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

type Lookup = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; list: ScraptfWatchView[] };

/** The modal: the item's existing watches read once, then the form; saving closes it. */
export function WatchDialog({ target, opener = null, onClose }: { target: WatchTarget; opener?: Element | null; onClose: () => void }) {
  const { keyScrap } = useApp();
  const uid = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [host] = useState<Element | null>(() => modalHostOf(opener) ?? (typeof document !== 'undefined' ? document.body : null));
  const [lookup, setLookup] = useState<Lookup>({ status: 'loading' });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const special = target.special ?? null;

  useEffect(() => {
    let alive = true;
    rpc('watches.list', { sku: target.sku })
      .then((list) => alive && setLookup({ status: 'ready', list }))
      .catch((e: unknown) => alive && setLookup({ status: 'error', message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [target.sku]);

  // Focus the dialog; give focus back on close.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    return () => {
      const back = opener as HTMLElement | null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The page's shortcuts and the drawer's own Esc and Tab handling must not see keys meant for the dialog.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key === 'Tab' && panel.current) {
      const items = tabbablesWithin<HTMLElement>(panel.current);
      const focused = document.activeElement as HTMLElement | null;
      const active = focused && items.includes(focused) ? focused : null;
      const next = trapFocusTarget(items, active, e.shiftKey);
      if (next) {
        e.preventDefault();
        next.focus();
      } else if (!items.length) {
        e.preventDefault();
      }
    }
  };

  if (!host) return null;
  const list = lookup.status === 'ready' ? lookup.list : [];
  const existing = watchesForCopy(list, target.sku, special);
  // A portal still bubbles React events up the component tree: a row around the opener must not see them.
  return createPortal(
    <div className="rt-root watch-dialog-root" onKeyDown={onKeyDown} onClick={stop} onDoubleClick={stop} onMouseDown={stop} onPointerDown={stop} onContextMenu={stop}>
      <div className="rt-backdrop" aria-hidden="true" onClick={() => onCloseRef.current()} />
      <div ref={panel} className="rt-dialog watch-dialog" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} tabIndex={-1}>
        <header className="rt-head">
          <div className="rt-title-wrap">
            <h2 id={`${uid}-title`} className="rt-title">
              Watch {target.name} on scrap.tf
            </h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={() => onCloseRef.current()}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="rt-body">
          {lookup.status === 'loading' ? (
            <p className="muted small">Reading your watches…</p>
          ) : (
            <>
              {lookup.status === 'error' ? <p className="small tone-text-warn">Could not read your watches: {lookup.message}</p> : null}
              <WatchForm
                sku={target.sku}
                name={target.name}
                special={special}
                keyScrap={keyScrap}
                ceiling={null}
                existing={existing}
                autoFocus
                onSaved={() => onCloseRef.current()}
                onCancel={() => onCloseRef.current()}
              />
            </>
          )}
        </div>
      </div>
    </div>,
    host,
  );
}
