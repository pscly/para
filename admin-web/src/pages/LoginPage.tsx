import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { adminLogin, ApiError } from "../lib/api";
import { isAdminAuthed, saveAdminSessionFromLogin } from "../lib/auth";

type LocationState = { from?: string };

export function LoginPage() {
  const nav = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;
  const from = useMemo(() => state.from ?? "/", [state.from]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdminAuthed()) {
      nav("/", { replace: true });
    }
  }, [nav]);

  return (
    <div className="login">
      <div className="login-panel">
        <div className="login-head">
          <div className="login-title">Para Admin</div>
          <div className="login-sub">安全登录 / RBAC</div>
        </div>

        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            setSubmitting(true);
            setError(null);
            try {
              const resp = await adminLogin({ email, password });
              saveAdminSessionFromLogin(resp);
              nav(from, { replace: true });
            } catch (err) {
              if (err instanceof ApiError) {
                setError(err.message);
              } else {
                setError("登录失败，请稍后重试");
              }
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <label className="field">
            <div className="field-label">Email</div>
            <input
              className="input"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
            />
          </label>

          <label className="field">
            <div className="field-label">Password</div>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
              minLength={8}
              required
            />
          </label>

          {error ? <div className="alert alert--danger">{error}</div> : null}

          <button className="btn btn--primary" type="submit" disabled={submitting}>
            {submitting ? "登录中..." : "登录"}
          </button>

          <div className="login-foot">
            <div className="hint">
              后端地址来自 <code>VITE_SERVER_BASE_URL</code>（可留空使用同源）。
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
