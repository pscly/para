import { type ReactNode, useMemo } from "react";
import {
  NavLink,
  Navigate,
  Outlet,
  createBrowserRouter,
  useLocation,
  useNavigate,
} from "react-router-dom";

import { clearAdminSession, isAdminAuthed, loadAdminSession } from "./auth";

import { AuditLogsPage } from "../pages/AuditLogsPage";
import { DashboardPage } from "../pages/DashboardPage";
import { DebugUsersPage } from "../pages/DebugUsersPage";
import { FeatureFlagsPage } from "../pages/FeatureFlagsPage";
import { InvitesPage } from "../pages/InvitesPage";
import { LoginPage } from "../pages/LoginPage";
import { LlmChannelsPage } from "../pages/LlmChannelsPage";
import { LlmRoutingPage } from "../pages/LlmRoutingPage";
import { ModelsPage } from "../pages/ModelsPage";
import { PluginsReviewPage } from "../pages/PluginsReviewPage";
import { PromptsPage } from "../pages/PromptsPage";
import { UgcReviewPage } from "../pages/UgcReviewPage";

function RequireAdminAuth(props: { children: ReactNode }) {
  const location = useLocation();
  if (!isAdminAuthed()) {
    // 关键：受保护路由统一跳转登录页（保留原始去向）。
    const from = `${location.pathname}${location.search}`;
    return <Navigate to="/login" replace state={{ from }} />;
  }
  return <>{props.children}</>;
}

function AppLayout() {
  const nav = useNavigate();
  const session = loadAdminSession();

  const items = useMemo(
    () =>
        [
          { to: "/", label: "概览" },
          { to: "/config/feature-flags", label: "Feature Flags" },
          { to: "/config/invites", label: "邀请码" },
          { to: "/config/debug-users", label: "Debug Users" },
          { to: "/config/audit-logs", label: "审计日志" },
          { to: "/ai/models", label: "Models" },
          { to: "/ai/channels", label: "Channels" },
          { to: "/ai/routing", label: "Routing" },
        { to: "/ai/prompts", label: "Prompts" },
        { to: "/review/ugc", label: "UGC 审核" },
        { to: "/review/plugins", label: "插件审核" },
      ] as const,
    []
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div className="brand-text">
            <div className="brand-title">Para Admin</div>
            <div className="brand-sub">ops console</div>
          </div>
        </div>

        <nav className="nav">
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              className={({ isActive }) => (isActive ? "nav-link nav-link--active" : "nav-link")}
              end={it.to === "/"}
            >
              {it.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="meta">
            <div className="meta-k">admin_user_id</div>
            <div className="meta-v">{session?.adminUserId ?? "-"}</div>
          </div>
          <div className="meta">
            <div className="meta-k">role</div>
            <div className="meta-v">{session?.role ?? "-"}</div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="crumb">/ admin</div>
          </div>
          <div className="topbar-right">
            <div className="pill">
              <span className="pill-dot" aria-hidden="true" />
              <span className="pill-text">{session ? `${session.adminUserId} (${session.role})` : "-"}</span>
            </div>
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => {
                clearAdminSession();
                nav("/login", { replace: true });
              }}
            >
              退出登录
            </button>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function deriveBasenameFromPathname(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/") ? "/admin" : "/";
}

const basename =
  typeof window === "undefined" ? "/" : deriveBasenameFromPathname(window.location.pathname || "/");

const routes = [
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/",
    element: (
      <RequireAdminAuth>
        <AppLayout />
      </RequireAdminAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "config/feature-flags", element: <FeatureFlagsPage /> },
      { path: "config/invites", element: <InvitesPage /> },
      { path: "config/debug-users", element: <DebugUsersPage /> },
      { path: "config/audit-logs", element: <AuditLogsPage /> },
      { path: "ai/models", element: <ModelsPage /> },
      { path: "ai/channels", element: <LlmChannelsPage /> },
      { path: "ai/routing", element: <LlmRoutingPage /> },
      { path: "ai/prompts", element: <PromptsPage /> },
      { path: "review/ugc", element: <UgcReviewPage /> },
      { path: "review/plugins", element: <PluginsReviewPage /> },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
];

export const router = createBrowserRouter(routes, { basename });
