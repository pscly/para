import React from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { App } from './App';
import { DevDiagnosticsPage } from './pages/DevDiagnosticsPage';
import { DevRegisterPage } from './pages/DevRegisterPage';
import { ChatPage } from './pages/ChatPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { LoginPage } from './pages/LoginPage';
import { PluginsPage } from './pages/PluginsPage';
import { SettingsPage } from './pages/SettingsPage';
import { UpdatesPage } from './pages/UpdatesPage';
import { ShellPreviewPage } from './pages/ShellPreviewPage';
import { getDesktopApi } from '../services/desktopApi';

function DevModeGuard() {
  const [state, setState] = React.useState<'checking' | 'allowed' | 'denied'>('checking');

  React.useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const security = getDesktopApi()?.security;
        if (!security?.getDevOptionsStatus) {
          if (!cancelled) setState('denied');
          return;
        }

        const s = await security.getDevOptionsStatus();
        const allowed = s?.effectiveEnabled === true;
        if (!cancelled) setState(allowed ? 'allowed' : 'denied');
      } catch {
        if (!cancelled) setState('denied');
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'checking') return null;
  if (state === 'denied') return <Navigate to="/settings" replace />;
  return <Outlet />;
}

export function RouterApp() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/shell" element={<Navigate to="/dev/shell" replace />} />

        <Route path="/dev/*" element={<DevModeGuard />}>
          <Route path="debug" element={<App />} />
          <Route path="diagnostics" element={<DevDiagnosticsPage />} />
          <Route path="register" element={<DevRegisterPage />} />
          <Route path="shell" element={<ShellPreviewPage />} />
          <Route path="*" element={<Navigate to="/settings" replace />} />
        </Route>

        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/updates" element={<UpdatesPage />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
