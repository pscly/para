import { useEffect, useMemo, useState } from "react";

import {
  adminConfigGetFeatureFlags,
  adminConfigPutFeatureFlags,
  type AdminFeatureFlags,
  ApiError,
} from "../lib/api";
import { loadAdminSession } from "../lib/auth";

function getRemotePluginsEnabled(flags: AdminFeatureFlags | null): boolean {
  if (!flags) return false;
  return Boolean(flags.plugins_enabled);
}

function getRemoteInviteRegistrationEnabled(flags: AdminFeatureFlags | null): boolean {
  if (!flags) return true;
  const v = flags.invite_registration_enabled;
  return typeof v === "boolean" ? v : true;
}

function getRemoteOpenRegistrationEnabled(flags: AdminFeatureFlags | null): boolean {
  if (!flags) return false;
  const v = flags.open_registration_enabled;
  return typeof v === "boolean" ? v : false;
}

export function FeatureFlagsPage() {
  const session = loadAdminSession();
  const canEdit = session?.role === "super_admin";

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const [remoteFlags, setRemoteFlags] = useState<AdminFeatureFlags | null>(null);
  const [pluginsEnabled, setPluginsEnabled] = useState(false);
  const [inviteRegistrationEnabled, setInviteRegistrationEnabled] = useState(true);
  const [openRegistrationEnabled, setOpenRegistrationEnabled] = useState(false);

  const dirty = useMemo(() => {
    if (!remoteFlags) return false;
    const remotePluginsEnabled = getRemotePluginsEnabled(remoteFlags);
    const remoteInviteEnabled = getRemoteInviteRegistrationEnabled(remoteFlags);
    const remoteOpenEnabled = getRemoteOpenRegistrationEnabled(remoteFlags);
    return (
      pluginsEnabled !== remotePluginsEnabled ||
      inviteRegistrationEnabled !== remoteInviteEnabled ||
      openRegistrationEnabled !== remoteOpenEnabled
    );
  }, [inviteRegistrationEnabled, openRegistrationEnabled, pluginsEnabled, remoteFlags]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      setSavedMsg(null);
      try {
        const flags = await adminConfigGetFeatureFlags();
        if (cancelled) return;
        setRemoteFlags(flags);
        setPluginsEnabled(Boolean(flags.plugins_enabled));
        setInviteRegistrationEnabled(getRemoteInviteRegistrationEnabled(flags));
        setOpenRegistrationEnabled(getRemoteOpenRegistrationEnabled(flags));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("拉取失败，请稍后重试");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">Feature Flags</h1>
        <div className="sub">全局开关（operator 仅可查看，super_admin 可编辑并保存）</div>
      </div>

      <section className="card">
        <div className="card-title">全局开关</div>
        <div className="p">
          这些开关会影响整个系统的运行时行为。建议在变更前完成评估，并在变更后观察概览页的摘要与 metrics。
        </div>

        {!canEdit ? (
          <div className="alert alert--warn" style={{ marginTop: 12 }}>
            当前账号为 <code>operator</code>，仅可读取。保存需要 <code>super_admin</code>（Requires super_admin）。
          </div>
        ) : null}

        {error ? (
          <div className="alert alert--danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        ) : null}

        {savedMsg ? (
          <div className="alert alert--success" style={{ marginTop: 12 }}>
            {savedMsg}
          </div>
        ) : null}

        <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

        <div className="kv">
          <div className="kv-k">
            插件系统总开关 <code>plugins_enabled</code>
          </div>
          <div className="kv-v">
            <div className="row row--space">
              <div>
                <div className="muted">关闭后：所有客户端插件会被远端 kill-switch 立即禁止执行。</div>
                <div className="danger-hint">危险：用于快速止血。请避免在高峰期频繁抖动。</div>
              </div>
              <label className={canEdit ? "switch" : "switch switch--disabled"}>
                <input
                  type="checkbox"
                  checked={pluginsEnabled}
                  onChange={(e) => {
                    setPluginsEnabled(e.target.checked);
                    setSavedMsg(null);
                  }}
                  disabled={loading || saving || !canEdit || !remoteFlags}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" aria-hidden="true" />
                </span>
                <span className={pluginsEnabled ? "badge badge--ok" : "badge badge--off"}>
                  {pluginsEnabled ? "ENABLED" : "DISABLED"}
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className="kv">
          <div className="kv-k">
            开放注册开关 <code>open_registration_enabled</code>
          </div>
          <div className="kv-v">
            <div className="row row--space">
              <div>
                <div className="muted">
                  开启后允许无邀请码注册（但仍建议保留邀请码注册开关作为兼容）。
                </div>
                <div className="muted">
                  注意：当 <code>invite_registration_enabled</code> 为 <code>false</code> 时，无论本开关如何，注册仍会被关闭。
                </div>
              </div>
              <label className={canEdit ? "switch" : "switch switch--disabled"}>
                <input
                  type="checkbox"
                  checked={openRegistrationEnabled}
                  onChange={(e) => {
                    setOpenRegistrationEnabled(e.target.checked);
                    setSavedMsg(null);
                  }}
                  disabled={loading || saving || !canEdit || !remoteFlags}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" aria-hidden="true" />
                </span>
                <span className={openRegistrationEnabled ? "badge badge--ok" : "badge badge--off"}>
                  {openRegistrationEnabled ? "ENABLED" : "DISABLED"}
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className="kv">
          <div className="kv-k">
            邀请码注册开关 <code>invite_registration_enabled</code>
          </div>
          <div className="kv-v">
            <div className="row row--space">
              <div>
                <div className="muted">
                  开启仅表示允许邀请码注册，不代表开放无邀请码注册。
                </div>
                <div className="muted">关闭后：注册会被拒绝（后端返回 403：registration_closed）。</div>
              </div>
              <label className={canEdit ? "switch" : "switch switch--disabled"}>
                <input
                  type="checkbox"
                  checked={inviteRegistrationEnabled}
                  onChange={(e) => {
                    setInviteRegistrationEnabled(e.target.checked);
                    setSavedMsg(null);
                  }}
                  disabled={loading || saving || !canEdit || !remoteFlags}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" aria-hidden="true" />
                </span>
                <span
                  className={inviteRegistrationEnabled ? "badge badge--ok" : "badge badge--off"}
                >
                  {inviteRegistrationEnabled ? "ENABLED" : "DISABLED"}
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className="actions">
          <div className="actions-left">
            {loading ? <span className="muted">加载中...</span> : null}
            {!loading && remoteFlags ? (
              <span className={dirty ? "muted" : "muted"}>
                {dirty ? "存在未保存更改" : "与后端一致"}
              </span>
            ) : null}
          </div>
          <div className="actions-right">
            <button
              className="btn btn--ghost"
              type="button"
              disabled={loading || saving || !remoteFlags || !dirty}
              onClick={() => {
                if (!remoteFlags) return;
                setPluginsEnabled(getRemotePluginsEnabled(remoteFlags));
                setInviteRegistrationEnabled(getRemoteInviteRegistrationEnabled(remoteFlags));
                setOpenRegistrationEnabled(getRemoteOpenRegistrationEnabled(remoteFlags));
                setSavedMsg(null);
                setError(null);
              }}
            >
              重置
            </button>
            <button
              className="btn btn--primary"
              type="button"
              disabled={loading || saving || !remoteFlags || !dirty || !canEdit}
              onClick={async () => {
                if (!remoteFlags) return;

                const remotePluginsEnabled = getRemotePluginsEnabled(remoteFlags);
                const remoteInviteEnabled = getRemoteInviteRegistrationEnabled(remoteFlags);
                const remoteOpenEnabled = getRemoteOpenRegistrationEnabled(remoteFlags);
                const payload: {
                  plugins_enabled?: boolean;
                  invite_registration_enabled?: boolean;
                  open_registration_enabled?: boolean;
                } = {};
                if (pluginsEnabled !== remotePluginsEnabled) payload.plugins_enabled = pluginsEnabled;
                if (inviteRegistrationEnabled !== remoteInviteEnabled) {
                  payload.invite_registration_enabled = inviteRegistrationEnabled;
                }
                if (openRegistrationEnabled !== remoteOpenEnabled) {
                  payload.open_registration_enabled = openRegistrationEnabled;
                }
                if (Object.keys(payload).length === 0) return;

                setSaving(true);
                setError(null);
                setSavedMsg(null);
                try {
                   const next = await adminConfigPutFeatureFlags(payload);
                   setRemoteFlags(next);
                   setPluginsEnabled(Boolean(next.plugins_enabled));
                   setInviteRegistrationEnabled(getRemoteInviteRegistrationEnabled(next));
                   setOpenRegistrationEnabled(getRemoteOpenRegistrationEnabled(next));
                   setSavedMsg("已保存");
                 } catch (err) {
                  if (err instanceof ApiError) {
                    setError(err.message);
                  } else {
                    setError("保存失败，请稍后重试");
                  }
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
