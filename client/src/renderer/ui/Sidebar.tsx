import React from 'react';

import { cx } from './cx';

export type SidebarProps = React.HTMLAttributes<HTMLElement> & {
  as?: 'aside' | 'nav';
};

export function Sidebar({ as: Tag = 'aside', className, ...props }: SidebarProps) {
  return <Tag {...props} className={cx('ui-sidebar', className)} />;
}
