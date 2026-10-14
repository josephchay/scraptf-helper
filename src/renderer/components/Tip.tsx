import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Hover/focus tooltip rendered in a portal with fixed positioning, so it is
 * never clipped by scrolling tables or drawers. Pass a function as content to
 * build it only when the tooltip opens (cheap for large tables).
 */
export function Tip({
  content,
  children,
  className,
  delay = 250,
  wide = false,
}: {
  content: ReactNode | (() => ReactNode);
  children: ReactNode;
  className?: string;
  delay?: number;
  wide?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean }>({ left: -9999, top: -9999, below: false });
  const id = useId();

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const a = anchor.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const margin = 8;
    let left = a.left + a.width / 2 - b.width / 2;
    left = Math.max(margin, Math.min(window.innerWidth - b.width - margin, left));
    const above = a.top - b.height - 6;
    const below = above < margin;
    const top = below ? a.bottom + 6 : above;
    setPos({ left, top, below });
  }, [open, content]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open, hide]);

  if (content === null || content === undefined || content === '' || content === false) {
    return <span className={className}>{children}</span>;
  }

  return (
    <>
      <span
        ref={anchor}
        className={className ? `tip-anchor ${className}` : 'tip-anchor'}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={open ? id : undefined}
      >
        {children}
      </span>
      {open
        ? createPortal(
            <div ref={bubble} id={id} role="tooltip" className={`tip-bubble${wide ? ' wide' : ''}${pos.below ? ' below' : ''}`} style={{ left: pos.left, top: pos.top }}>
              {typeof content === 'function' ? content() : content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
