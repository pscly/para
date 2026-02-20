import React from 'react';
import { createPortal } from 'react-dom';

import { cx } from './cx';

export type ModalProps = {
  open: boolean;
  title?: string;
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
};

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
  );
  return Array.from(nodes);
}

export function Modal({ open, title, children, onClose, className }: ModalProps) {
  const dialogRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    el.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="ui-modal__backdrop" role="presentation">
      <div
        ref={dialogRef}
        className={cx('ui-modal__dialog', className)}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Dialog'}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
            return;
          }

          if (e.key !== 'Tab') return;

          const el = dialogRef.current;
          if (!el) return;
          const focusable = getFocusable(el);
          if (focusable.length === 0) return;

          const first = focusable[0]!;
          const last = focusable[focusable.length - 1]!;
          const active = document.activeElement as HTMLElement | null;

          if (e.shiftKey) {
            if (!active || active === first) {
              e.preventDefault();
              last.focus();
            }
            return;
          }

          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="ui-modal__header">
          {title ? <div className="ui-modal__title">{title}</div> : null}
          <button type="button" className="ui-modal__close" onClick={onClose} aria-label="Close">
            X
          </button>
        </div>
        <div className="ui-modal__body">{children}</div>
      </div>
    </div>,
    document.body
  );
}
