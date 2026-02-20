import React from 'react';

import { cx } from './cx';

export type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: 'section' | 'div' | 'article' | 'main' | 'aside';
};

export function Card({ as: Tag = 'section', className, ...props }: CardProps) {
  return <Tag {...props} className={cx('card', className)} />;
}
