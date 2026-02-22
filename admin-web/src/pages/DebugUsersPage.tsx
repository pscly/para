import { useMemo, useState } from "react";

import {
  adminUsersDebugAllowedGet,
  adminUsersDebugAllowedPut,
  ApiError,
  type AdminUsersDebugAllowedResponse,
} from "../lib/api";
import { loadAdminSession } from "../lib/auth";

function normalizeEmailInput(raw: string): string {
  return raw.trim();
}

export function DebugUsersPage() {
  const session = loadAdminSession();
  const canEdit = session?.role === "super_admin";

  const [email, setEmail] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [remote, setRemote] = useState<AdminUsersDebugAllowedResponse | null>(null);
  const [debugAllowed, setDebugAllowed] = useState<boolean>(false);

  const dirty = useMemo(() => {
    if (!remote) return false;
    return debugAllowed !== Boolean(remote.debug_allowed);
  }, [debugAllowed, remote]);

  async function query() {
    const e = normalizeEmailInput(email);
    setError(null);
    setSuccess(null);
    setRemote(null);

    if (!e) {
      setError("请输入 email");
      return;
    }

    setLoading(true);
    try {
      const res = await adminUsersDebugAllowedGet(e);
      setRemote(res);
      setDebugAllowed(Boolean(res.debug_allowed));
      setSuccess("已加载");
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("查询失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!remote) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const next = await adminUsersDebugAllowedPut({ email: remote.email, debug_allowed: debugAllowed });
      setRemote(next);
      setDebugAllowed(Boolean(next.debug_allowed));
      setSuccess("已保存");
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">Debug Users</h1>
        <div className="sub">管理用户的 debug_allowed（operator 仅可查询与查看，super_admin 可编辑并保存）</div>
      </div>

      <section className="card">
        <div className="card-title">查询</div>
        <div className="p">按 email 查询当前的 debug_allowed，并在必要时进行切换与保存。</div>

        {!canEdit ? (
          <div className="alert alert--warn" style={{ marginTop: 12 }}>
            当前账号为 <code>operator</code>，仅可读取。修改需要 <code>super_admin</code>（Requires super_admin）。
          </div>
        ) : null}

        {error ? (
          <div className="alert alert--danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        ) : null}

        {success ? (
          <div className="alert alert--success" style={{ marginTop: 12 }}>
            {success}
          </div>
        ) : null}

        <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

        <div className="form-row">
          <label className="field" style={{ minWidth: 360, flex: 1 }}>
            <div className="field-label">Email</div>
            <input
              className="input"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
                setSuccess(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) {
                  void query();
                }
              }}
              disabled={loading || saving}
            />
          </label>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <button
              className="btn btn--primary"
              type="button"
              disabled={loading || saving}
              onClick={() => {
                void query();
              }}
            >
              {loading ? "查询中..." : "查询"}
            </button>
          </div>
        </div>

        {remote ? (
          <>
            <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

            <div className="kv">
              <div className="kv-k">
                debug_allowed <code>users.debug_allowed</code>
              </div>
              <div className="kv-v">
                <div className="row row--space">
                  <div>
                    <div className="muted">email：{remote.email}</div>
                    <div className="muted">用于 packaged 环境的 /dev 授权门控（fail-closed）。</div>
                  </div>
                  <label className={canEdit ? "switch" : "switch switch--disabled"}>
                    <input
                      type="checkbox"
                      checked={debugAllowed}
                      onChange={(e) => {
                        setDebugAllowed(e.target.checked);
                        setError(null);
                        setSuccess(null);
                      }}
                      disabled={loading || saving || !canEdit}
                    />
                    <span className="switch-track" aria-hidden="true">
                      <span className="switch-thumb" aria-hidden="true" />
                    </span>
                    <span className={debugAllowed ? "badge badge--ok" : "badge badge--off"}>
                      {debugAllowed ? "ENABLED" : "DISABLED"}
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <div className="actions">
              <div className="actions-left">
                <span className={dirty ? "muted" : "muted"}>{dirty ? "存在未保存更改" : "与后端一致"}</span>
              </div>
              <div className="actions-right">
                <button
                  className="btn btn--ghost"
                  type="button"
                  disabled={loading || saving || !dirty}
                  onClick={() => {
                    setDebugAllowed(Boolean(remote.debug_allowed));
                    setError(null);
                    setSuccess(null);
                  }}
                >
                  重置
                </button>
                <button
                  className="btn btn--primary"
                  type="button"
                  disabled={loading || saving || !dirty || !canEdit}
                  onClick={() => {
                    void save();
                  }}
                >
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
