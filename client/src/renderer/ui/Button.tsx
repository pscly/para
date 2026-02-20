import React from 'react';

import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  className,
  type,
  children,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      {...props}
      type={type ?? 'button'}
      className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, loading && 'ui-btn--loading', className)}
      disabled={isDisabled}
      aria-busy={loading ? 'true' : undefined}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : null}
      <span className="ui-btn__label">{children}</span>
    </button>
  );
}
