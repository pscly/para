import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

import { getDesktopApi } from '../../services/desktopApi';
import { cx } from '../../ui/cx';
import { Sidebar } from '../../ui/Sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();

  const [authStatus, setAuthStatus] = React.useState<'checking' | 'loggedIn' | 'loggedOut'>('checking');
  const [loggedInEmail, setLoggedInEmail] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function hydrateAuth() {
      const me = getDesktopApi()?.auth?.me;
      if (typeof me !== 'function') {
        if (!cancelled) {
          setAuthStatus('loggedOut');
          setLoggedInEmail(null);
        }
        return;
      }

      try {
        const ret = await me();
        const email = (ret as { email?: unknown } | null)?.email;
        if (!cancelled && typeof email === 'string' && email.trim()) {
          setAuthStatus('loggedIn');
          setLoggedInEmail(email);
          return;
        }
      } catch {
      }

      if (!cancelled) {
        setAuthStatus('loggedOut');
        setLoggedInEmail(null);
      }
    }

    void hydrateAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onLogout() {
    const logout = getDesktopApi()?.auth?.logout;
    try {
      if (typeof logout === 'function') await logout();
    } catch {
    }
    navigate('/login');
  }

  return (
    <div className="ui-shell">
      <Sidebar className="ui-shell__sidebar" as="nav" aria-label="Primary">
        <div className="ui-shell__brand">Para</div>
        <div className="ui-shell__nav">
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/chat">
            聊天
          </NavLink>
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/settings">
            设置
          </NavLink>
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/plugins">
            插件
          </NavLink>
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/knowledge">
            知识库
          </NavLink>
          <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/updates">
            更新
          </NavLink>
        </div>

        {authStatus === 'checking' ? null : authStatus === 'loggedOut' ? (
          <div className="ui-shell__nav">
            <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/login">
              登录
            </NavLink>
            <NavLink className={({ isActive }) => cx('ui-shell__link', isActive && 'is-active')} to="/register">
              注册
            </NavLink>
          </div>
        ) : (
          <div className="ui-shell__nav">
            <div className="ui-shell__link">已登录：{loggedInEmail ?? ''}</div>
            <button type="button" className="ui-shell__link" onClick={onLogout}>
              退出登录
            </button>
          </div>
        )}
      </Sidebar>

      <main className="ui-shell__main">{children}</main>
    </div>
  );
}
