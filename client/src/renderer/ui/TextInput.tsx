import React from 'react';

import { cx } from './cx';

export type TextInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'className'> & {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
  inputClassName?: string;
};

export function TextInput({
  label,
  hint,
  error,
  id,
  className,
  inputClassName,
  ...props
}: TextInputProps) {
  const reactId = React.useId();
  const inputId = id ?? `ui-${reactId}`;

  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cx('ui-field', className)}>
      {label ? (
        <label className="ui-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        {...props}
        id={inputId}
        className={cx('ui-input', inputClassName)}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
      />
      {hint ? (
        <span id={hintId} className="ui-field__hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="ui-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
