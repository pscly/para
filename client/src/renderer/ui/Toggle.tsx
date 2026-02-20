import React from 'react';

import { cx } from './cx';

export type ToggleProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string;
};

export function Toggle({ label, className, id, ...props }: ToggleProps) {
  const reactId = React.useId();
  const inputId = id ?? `toggle-${reactId}`;

  return (
    <div className={cx('ui-toggle', className)}>
      <input {...props} id={inputId} className="ui-toggle__input" type="checkbox" />
      <label className="ui-toggle__label" htmlFor={inputId}>
        <span className="ui-toggle__track" aria-hidden="true">
          <span className="ui-toggle__thumb" />
        </span>
        <span className="ui-toggle__text">{label}</span>
      </label>
    </div>
  );
}
