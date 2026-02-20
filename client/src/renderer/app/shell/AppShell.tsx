import React from 'react';
import { NavLink } from 'react-router-dom';

import { cx } from '../../ui/cx';
import { Sidebar } from '../../ui/Sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="ui-shell">
      <Sidebar className="ui-shell__sidebar" as="nav" aria-label="Primary">
        <div className="ui-shell__brand">Para</div>
        <div className="ui-shell__nav">
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/chat">
            Chat
          </NavLink>
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/settings">
            Settings
          </NavLink>
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/plugins">
            Plugins
          </NavLink>
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/knowledge">
            Knowledge
          </NavLink>
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/updates">
            Updates
          </NavLink>
        </div>
      </Sidebar>

      <main className="ui-shell__main">{children}</main>
    </div>
  );
}
