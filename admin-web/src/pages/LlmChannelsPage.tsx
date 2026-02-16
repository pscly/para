import { useCallback, useEffect, useMemo, useState } from "react";

import {
  adminLlmChannelsCreate,
  adminLlmChannelsDelete,
  adminLlmChannelsList,
  adminLlmChannelsTest,
  adminLlmChannelsUpdate,
  type AdminLLMChannel,
  type AdminLLMChannelCreatePayload,
  type AdminLLMChannelPurpose,
  ApiError,
} from "../lib/api";
import { loadAdminSession } from "../lib/auth";

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return Math.max(min, Math.min(max, v));
}

function purposeHint(purpose: AdminLLMChannelPurpose): string {
  return purpose === "chat" ? "chat" : "embedding";
}

type TestResult = {
  ok: boolean;
  latency_ms: number | null;
  detail: string | null;
  tested_at: number;
};

export function LlmChannelsPage() {
  const session = loadAdminSession();
  const canWrite = session?.role === "super_admin";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [items, setItems] = useState<AdminLLMChannel[]>([]);

  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<AdminLLMChannelCreatePayload>({
    name: "",
    base_url: "",
    enabled: true,
    purpose: "chat",
    default_model: "",
    timeout_ms: 60000,
    weight: 100,
    api_key: "",
  });
  const [createShowKey, setCreateShowKey] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = useMemo(() => items.find((x) => x.id === editingId) ?? null, [items, editingId]);
  const [editSaving, setEditSaving] = useState(false);
  const [editDraft, setEditDraft] = useState<{
    name: string;
    base_url: string;
    enabled: boolean;
    purpose: AdminLLMChannelPurpose;
    default_model: string;
    timeout_ms: string;
    weight: string;
    api_key: string;
    rotate_key_confirm: boolean;
    show_key: boolean;
  } | null>(null);

  const [rowBusy, setRowBusy] = useState<Record<string, string | null>>({});
  const [testById, setTestById] = useState<Record<string, TestResult | null>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await adminLlmChannelsList();
      setItems(resp.items);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("拉取失败，请稍后重试");
      }
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function resetCreateDraft() {
    setCreateDraft({
      name: "",
      base_url: "",
      enabled: true,
      purpose: "chat",
      default_model: "",
      timeout_ms: 60000,
      weight: 100,
      api_key: "",
    });
    setCreateShowKey(false);
  }

  function startEdit(ch: AdminLLMChannel) {
    setEditingId(ch.id);
    setEditDraft({
      name: ch.name,
      base_url: ch.base_url,
      enabled: ch.enabled,
      purpose: ch.purpose,
      default_model: ch.default_model,
      timeout_ms: String(ch.timeout_ms),
      weight: String(ch.weight),
      api_key: "",
      rotate_key_confirm: false,
      show_key: false,
    });
    setSuccess(null);
    setError(null);
  }

  const createDisabled = useMemo(() => {
    if (!canWrite) return true;
    if (loading || creating) return true;
    if (!createDraft.name.trim()) return true;
    if (!createDraft.base_url.trim()) return true;
    if (!createDraft.api_key.trim()) return true;
    return false;
  }, [canWrite, loading, creating, createDraft]);

  const saveEditDisabled = useMemo(() => {
    if (!canWrite) return true;
    if (!editing || !editDraft) return true;
    if (editSaving) return true;
    if (!editDraft.name.trim()) return true;
    if (!editDraft.base_url.trim()) return true;
    if (editDraft.api_key.trim() && !editDraft.rotate_key_confirm) return true;
    return false;
  }, [canWrite, editing, editDraft, editSaving]);

  async function createChannel() {
    if (createDisabled) return;
    setCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: AdminLLMChannelCreatePayload = {
        name: createDraft.name.trim(),
        base_url: createDraft.base_url.trim(),
        enabled: Boolean(createDraft.enabled),
        purpose: createDraft.purpose,
        default_model: createDraft.default_model.trim(),
        timeout_ms: clampInt(String(createDraft.timeout_ms), 60000, 1, 300000),
        weight: clampInt(String(createDraft.weight), 100, 0, 1000000),
        api_key: createDraft.api_key.trim(),
      };
      const created = await adminLlmChannelsCreate(payload);
      setSuccess(`已创建渠道：${created.name}`);
      resetCreateDraft();
      await reload();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("创建失败，请稍后重试");
      }
    } finally {
      setCreating(false);
    }
  }

  async function saveEdit() {
    if (!editing || !editDraft) return;
    if (saveEditDisabled) return;
    setEditSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const patch: Record<string, unknown> = {
        name: editDraft.name.trim(),
        base_url: editDraft.base_url.trim(),
        enabled: Boolean(editDraft.enabled),
        purpose: editDraft.purpose,
        default_model: editDraft.default_model.trim(),
        timeout_ms: clampInt(editDraft.timeout_ms, editing.timeout_ms, 1, 300000),
        weight: clampInt(editDraft.weight, editing.weight, 0, 1000000),
      };
      if (editDraft.api_key.trim()) {
        patch.api_key = editDraft.api_key.trim();
      }
      const updated = await adminLlmChannelsUpdate(editing.id, patch);
      setSuccess(`已保存：${updated.name}`);
      await reload();
      setEditingId(updated.id);
      setEditDraft((prev) =>
        prev
          ? {
              ...prev,
              api_key: "",
              rotate_key_confirm: false,
              show_key: false,
            }
          : prev,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("保存失败，请稍后重试");
      }
    } finally {
      setEditSaving(false);
    }
  }

  async function toggleEnabled(ch: AdminLLMChannel) {
    if (!canWrite) return;
    setRowBusy((prev) => ({ ...prev, [ch.id]: "toggle" }));
    setError(null);
    setSuccess(null);
    try {
      const nextEnabled = !ch.enabled;
      const updated = await adminLlmChannelsUpdate(ch.id, { enabled: nextEnabled });
      setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setSuccess(`${updated.name} 已${updated.enabled ? "启用" : "停用"}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("操作失败，请稍后重试");
      }
    } finally {
      setRowBusy((prev) => ({ ...prev, [ch.id]: null }));
    }
  }

  async function testChannel(ch: AdminLLMChannel) {
    setRowBusy((prev) => ({ ...prev, [ch.id]: "test" }));
    setError(null);
    setSuccess(null);
    try {
      const res = await adminLlmChannelsTest(ch.id);
      const out: TestResult = { ...res, tested_at: Date.now() };
      setTestById((prev) => ({ ...prev, [ch.id]: out }));
      const parts = [
        `测试结果：${ch.name}`,
        `ok=${String(res.ok)}`,
        res.latency_ms !== null ? `latency_ms=${res.latency_ms}` : null,
        res.detail ? `detail=${res.detail}` : null,
      ].filter((x): x is string => Boolean(x));
      setSuccess(parts.join(" · "));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("测试失败，请稍后重试");
      }
    } finally {
      setRowBusy((prev) => ({ ...prev, [ch.id]: null }));
    }
  }

  async function deleteChannel(ch: AdminLLMChannel) {
    if (!canWrite) return;
    const ok = window.confirm(`确认删除渠道？\n\nname: ${ch.name}\nid: ${ch.id}\n\n此操作不可撤销。`);
    if (!ok) return;
    setRowBusy((prev) => ({ ...prev, [ch.id]: "delete" }));
    setError(null);
    setSuccess(null);
    try {
      await adminLlmChannelsDelete(ch.id);
      setSuccess(`已删除：${ch.name}`);
      setItems((prev) => prev.filter((x) => x.id !== ch.id));
      if (editingId === ch.id) {
        setEditingId(null);
        setEditDraft(null);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("删除失败，请稍后重试");
      }
    } finally {
      setRowBusy((prev) => ({ ...prev, [ch.id]: null }));
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">AI / Channels</h1>
        <div className="sub">
          管理 OpenAI-compatible 渠道（operator 可读 + 可测试连接；super_admin 可创建/编辑/启停/删除）。
        </div>
      </div>

      {!canWrite ? (
        <div className="alert alert--warn" style={{ marginBottom: 12 }}>
          当前账号为 <code>operator</code>，仅可读取。创建/编辑/启停/删除需要 <code>super_admin</code>（Requires super_admin）。
          <br />
          <span className="muted">提示：连接测试不受影响。</span>
        </div>
      ) : null}

      {error ? (
        <div className="alert alert--danger" style={{ marginBottom: 12 }}>
          {error}
        </div>
      ) : null}

      {success ? (
        <div className="alert alert--success" style={{ marginBottom: 12 }}>
          {success}
        </div>
      ) : null}

      <section className="card">
        <div className="row row--space">
          <div>
            <div className="card-title">渠道列表</div>
            <div className="muted" style={{ marginTop: 6 }}>
              列表永远只展示 <code>api_key_masked</code>；不会显示真实 key。
            </div>
          </div>
          <div className="row">
            <button
              className="btn btn--ghost"
              type="button"
              disabled={loading}
              onClick={() => {
                void reload();
              }}
            >
              {loading ? "刷新中..." : "刷新"}
            </button>
          </div>
        </div>

        <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 170 }}>name</th>
                <th style={{ width: 110 }}>purpose</th>
                <th style={{ width: 120 }}>enabled</th>
                <th style={{ width: 320 }}>base_url</th>
                <th style={{ width: 160 }}>default_model</th>
                <th style={{ width: 120 }}>timeout_ms</th>
                <th style={{ width: 90 }}>weight</th>
                <th style={{ width: 160 }}>api_key</th>
                <th style={{ width: 220 }}>actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9}>
                    <div className="muted" style={{ padding: 10 }}>
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <div className="muted" style={{ padding: 10 }}>
                      暂无渠道
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((ch) => {
                  const busy = rowBusy[ch.id];
                  const t = testById[ch.id] ?? null;
                  return (
                    <tr key={ch.id}>
                      <td>
                        <code title={ch.id}>{ch.name}</code>
                      </td>
                      <td>
                        <span className="badge badge--off">{purposeHint(ch.purpose)}</span>
                      </td>
                      <td>
                        <label className={"switch" + (!canWrite || busy ? " switch--disabled" : "")}
                          title={!canWrite ? "Requires super_admin" : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={ch.enabled}
                            onChange={() => {
                              void toggleEnabled(ch);
                            }}
                            disabled={!canWrite || Boolean(busy)}
                          />
                          <span className="switch-track">
                            <span className="switch-thumb" />
                          </span>
                          <span className="muted">{ch.enabled ? "on" : "off"}</span>
                        </label>
                      </td>
                      <td className="mono" title={ch.base_url}>
                        {ch.base_url}
                      </td>
                      <td className="mono" title={ch.default_model || ""}>
                        {ch.default_model || "-"}
                      </td>
                      <td className="mono">{ch.timeout_ms}</td>
                      <td className="mono">{ch.weight}</td>
                      <td>
                        <div className="mono" title={ch.api_key_masked ?? undefined}>
                          {ch.api_key_present ? ch.api_key_masked ?? "***" : "-"}
                        </div>
                        {t ? (
                          <div className="muted" style={{ marginTop: 4 }}>
                            test: <code>{t.ok ? "ok" : "fail"}</code>
                            {t.latency_ms !== null ? (
                              <>
                                {" "}· <code>{t.latency_ms}ms</code>
                              </>
                            ) : null}
                            {t.detail ? (
                              <>
                                {" "}· <code>{t.detail}</code>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                          <button
                            className="btn btn--ghost"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => {
                              void testChannel(ch);
                            }}
                          >
                            {busy === "test" ? "测试中..." : "测试连接"}
                          </button>
                          <button
                            className="btn btn--ghost"
                            type="button"
                            disabled={!canWrite || Boolean(busy)}
                            onClick={() => {
                              startEdit(ch);
                            }}
                            title={!canWrite ? "Requires super_admin" : undefined}
                          >
                            编辑
                          </button>
                          <button
                            className="btn"
                            type="button"
                            disabled={!canWrite || Boolean(busy)}
                            onClick={() => {
                              void deleteChannel(ch);
                            }}
                            title={!canWrite ? "Requires super_admin" : undefined}
                          >
                            {busy === "delete" ? "删除中..." : "删除"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="card-title">新建渠道</div>
        <div className="muted" style={{ marginTop: 6 }}>
          <code>base_url</code> 需要是完整 URL；后端会自动规范化为以 <code>/v1</code> 结尾。
        </div>

        <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

        <div className="form">
          <div className="form-row">
            <label className="field" style={{ flex: "1 1 220px" }}>
              <div className="field-label">name</div>
              <input
                className="input"
                placeholder="例如：openai-main"
                value={createDraft.name}
                onChange={(e) => setCreateDraft((p) => ({ ...p, name: e.target.value }))}
                disabled={!canWrite || creating}
              />
            </label>

            <label className="field" style={{ width: 160 }}>
              <div className="field-label">purpose</div>
              <select
                className="input"
                value={createDraft.purpose}
                onChange={(e) => setCreateDraft((p) => ({ ...p, purpose: e.target.value as AdminLLMChannelPurpose }))}
                disabled={!canWrite || creating}
              >
                <option value="chat">chat</option>
                <option value="embedding">embedding</option>
              </select>
            </label>

            <label className="field" style={{ width: 150 }}>
              <div className="field-label">enabled</div>
              <select
                className="input"
                value={createDraft.enabled ? "on" : "off"}
                onChange={(e) => setCreateDraft((p) => ({ ...p, enabled: e.target.value === "on" }))}
                disabled={!canWrite || creating}
              >
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            </label>
          </div>

          <label className="field">
            <div className="field-label">base_url</div>
            <input
              className="input"
              placeholder="例如：https://api.openai.com/v1"
              value={createDraft.base_url}
              onChange={(e) => setCreateDraft((p) => ({ ...p, base_url: e.target.value }))}
              disabled={!canWrite || creating}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>

          <div className="form-row">
            <label className="field" style={{ flex: "1 1 280px" }}>
              <div className="field-label">default_model</div>
              <input
                className="input"
                placeholder="例如：gpt-5.2（可选）"
                value={createDraft.default_model}
                onChange={(e) => setCreateDraft((p) => ({ ...p, default_model: e.target.value }))}
                disabled={!canWrite || creating}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <label className="field" style={{ width: 180 }}>
              <div className="field-label">timeout_ms</div>
              <input
                className="input"
                inputMode="numeric"
                value={String(createDraft.timeout_ms)}
                onChange={(e) => setCreateDraft((p) => ({ ...p, timeout_ms: clampInt(e.target.value, 60000, 1, 300000) }))}
                disabled={!canWrite || creating}
              />
            </label>
            <label className="field" style={{ width: 140 }}>
              <div className="field-label">weight</div>
              <input
                className="input"
                inputMode="numeric"
                value={String(createDraft.weight)}
                onChange={(e) => setCreateDraft((p) => ({ ...p, weight: clampInt(e.target.value, 100, 0, 1000000) }))}
                disabled={!canWrite || creating}
              />
            </label>
          </div>

          <label className="field">
            <div className="field-label">api_key（必填）</div>
            <div className="row">
              <input
                className="input"
                type={createShowKey ? "text" : "password"}
                placeholder="不会被回显；仅用于写入/轮换"
                value={createDraft.api_key}
                onChange={(e) => setCreateDraft((p) => ({ ...p, api_key: e.target.value }))}
                disabled={!canWrite || creating}
                autoCapitalize="off"
                autoCorrect="off"
                style={{ flex: 1 }}
              />
              <button
                className="btn btn--ghost"
                type="button"
                disabled={!canWrite || creating}
                onClick={() => setCreateShowKey((v) => !v)}
              >
                {createShowKey ? "隐藏" : "显示"}
              </button>
            </div>
          </label>

          <div className="actions">
            <div className="actions-left">
              {!canWrite ? <span className="muted">Requires super_admin</span> : null}
            </div>
            <div className="actions-right">
              <button
                className="btn btn--ghost"
                type="button"
                disabled={!canWrite || creating}
                onClick={() => resetCreateDraft()}
              >
                重置
              </button>
              <button
                className="btn btn--primary"
                type="button"
                disabled={createDisabled}
                onClick={() => {
                  void createChannel();
                }}
              >
                {creating ? "创建中..." : "创建"}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="row row--space">
          <div>
            <div className="card-title">编辑渠道</div>
            <div className="muted" style={{ marginTop: 6 }}>
              编辑时不会显示旧 key；若输入新 key，必须勾选“确认轮换”才允许保存。
            </div>
          </div>
          <div className="row">
            {editingId ? (
              <button
                className="btn btn--ghost"
                type="button"
                disabled={editSaving}
                onClick={() => {
                  setEditingId(null);
                  setEditDraft(null);
                }}
              >
                取消编辑
              </button>
            ) : null}
          </div>
        </div>

        {!editing || !editDraft ? (
          <div className="p">从上方列表选择一条渠道进行编辑。</div>
        ) : (
          <>
            <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />
            <div className="p">
              当前：<code>{editing.name}</code> · id: <code>{editing.id}</code>
              {editing.api_key_present ? (
                <>
                  {" "}· api_key: <code>{editing.api_key_masked ?? "***"}</code>
                </>
              ) : (
                <>
                  {" "}· api_key: <code>not_set</code>
                </>
              )}
            </div>
            <div className="form" style={{ marginTop: 12 }}>
              <div className="form-row">
                <label className="field" style={{ flex: "1 1 220px" }}>
                  <div className="field-label">name</div>
                  <input
                    className="input"
                    value={editDraft.name}
                    onChange={(e) => setEditDraft((p) => (p ? { ...p, name: e.target.value } : p))}
                    disabled={!canWrite || editSaving}
                  />
                </label>
                <label className="field" style={{ width: 160 }}>
                  <div className="field-label">purpose</div>
                  <select
                    className="input"
                    value={editDraft.purpose}
                    onChange={(e) =>
                      setEditDraft((p) => (p ? { ...p, purpose: e.target.value as AdminLLMChannelPurpose } : p))
                    }
                    disabled={!canWrite || editSaving}
                  >
                    <option value="chat">chat</option>
                    <option value="embedding">embedding</option>
                  </select>
                </label>
                <label className="field" style={{ width: 150 }}>
                  <div className="field-label">enabled</div>
                  <select
                    className="input"
                    value={editDraft.enabled ? "on" : "off"}
                    onChange={(e) => setEditDraft((p) => (p ? { ...p, enabled: e.target.value === "on" } : p))}
                    disabled={!canWrite || editSaving}
                  >
                    <option value="on">on</option>
                    <option value="off">off</option>
                  </select>
                </label>
              </div>

              <label className="field">
                <div className="field-label">base_url</div>
                <input
                  className="input"
                  value={editDraft.base_url}
                  onChange={(e) => setEditDraft((p) => (p ? { ...p, base_url: e.target.value } : p))}
                  disabled={!canWrite || editSaving}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </label>

              <div className="form-row">
                <label className="field" style={{ flex: "1 1 280px" }}>
                  <div className="field-label">default_model</div>
                  <input
                    className="input"
                    value={editDraft.default_model}
                    onChange={(e) => setEditDraft((p) => (p ? { ...p, default_model: e.target.value } : p))}
                    disabled={!canWrite || editSaving}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                </label>
                <label className="field" style={{ width: 180 }}>
                  <div className="field-label">timeout_ms</div>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={editDraft.timeout_ms}
                    onChange={(e) => setEditDraft((p) => (p ? { ...p, timeout_ms: e.target.value } : p))}
                    disabled={!canWrite || editSaving}
                  />
                </label>
                <label className="field" style={{ width: 140 }}>
                  <div className="field-label">weight</div>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={editDraft.weight}
                    onChange={(e) => setEditDraft((p) => (p ? { ...p, weight: e.target.value } : p))}
                    disabled={!canWrite || editSaving}
                  />
                </label>
              </div>

              <label className="field">
                <div className="field-label">轮换 api_key（可选）</div>
                <div className="row">
                  <input
                    className="input"
                    type={editDraft.show_key ? "text" : "password"}
                    placeholder="留空表示不修改"
                    value={editDraft.api_key}
                    onChange={(e) =>
                      setEditDraft((p) =>
                        p
                          ? {
                              ...p,
                              api_key: e.target.value,
                              rotate_key_confirm: false,
                            }
                          : p,
                      )
                    }
                    disabled={!canWrite || editSaving}
                    autoCapitalize="off"
                    autoCorrect="off"
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn--ghost"
                    type="button"
                    disabled={!canWrite || editSaving}
                    onClick={() => setEditDraft((p) => (p ? { ...p, show_key: !p.show_key } : p))}
                  >
                    {editDraft.show_key ? "隐藏" : "显示"}
                  </button>
                </div>
                {editDraft.api_key.trim() ? (
                  <div className="confirm" style={{ marginTop: 10 }}>
                    <label className="row" style={{ alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={editDraft.rotate_key_confirm}
                        onChange={(e) =>
                          setEditDraft((p) => (p ? { ...p, rotate_key_confirm: e.target.checked } : p))
                        }
                        disabled={!canWrite || editSaving}
                      />
                      <span>
                        我确认要轮换该渠道的 API Key（Requires super_admin）。
                      </span>
                    </label>
                  </div>
                ) : null}
              </label>

              <div className="actions">
                <div className="actions-left">
                  {!canWrite ? <span className="muted">Requires super_admin</span> : null}
                </div>
                <div className="actions-right">
                  <button
                    className="btn btn--primary"
                    type="button"
                    disabled={saveEditDisabled}
                    onClick={() => {
                      void saveEdit();
                    }}
                  >
                    {editSaving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
