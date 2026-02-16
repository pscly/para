import { useCallback, useEffect, useMemo, useState } from "react";

import {
  adminLlmChannelsList,
  adminLlmRoutingGet,
  adminLlmRoutingPut,
  type AdminLLMChannel,
  type AdminLLMRoutingGlobal,
  ApiError,
} from "../lib/api";
import { loadAdminSession } from "../lib/auth";

function toOptLabel(ch: AdminLLMChannel): string {
  const bits = [ch.name, ch.enabled ? "on" : "off", ch.purpose];
  return `${bits.join(" · ")}`;
}

export function LlmRoutingPage() {
  const session = loadAdminSession();
  const canWrite = session?.role === "super_admin";

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [channels, setChannels] = useState<AdminLLMChannel[]>([]);
  const [remote, setRemote] = useState<AdminLLMRoutingGlobal | null>(null);
  const [draftChat, setDraftChat] = useState<string>("");
  const [draftEmbedding, setDraftEmbedding] = useState<string>("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const [chResp, routing] = await Promise.all([adminLlmChannelsList(), adminLlmRoutingGet()]);
      setChannels(chResp.items);
      setRemote(routing);
      setDraftChat(routing.default_chat_channel_id ?? "");
      setDraftEmbedding(routing.default_embedding_channel_id ?? "");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("拉取失败，请稍后重试");
      }
      setChannels([]);
      setRemote(null);
      setDraftChat("");
      setDraftEmbedding("");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const chatOptions = useMemo(() => channels.filter((c) => c.purpose === "chat"), [channels]);
  const embeddingOptions = useMemo(() => channels.filter((c) => c.purpose === "embedding"), [channels]);

  const chatSelected = useMemo(() => channels.find((c) => c.id === draftChat) ?? null, [channels, draftChat]);
  const embeddingSelected = useMemo(
    () => channels.find((c) => c.id === draftEmbedding) ?? null,
    [channels, draftEmbedding],
  );

  const dirty = useMemo(() => {
    if (!remote) return false;
    const nextChat = draftChat || null;
    const nextEmb = draftEmbedding || null;
    return remote.default_chat_channel_id !== nextChat || remote.default_embedding_channel_id !== nextEmb;
  }, [remote, draftChat, draftEmbedding]);

  const saveDisabled = !canWrite || loading || saving || !remote || !dirty;

  async function save() {
    if (saveDisabled) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: AdminLLMRoutingGlobal = {
        default_chat_channel_id: draftChat ? draftChat : null,
        default_embedding_channel_id: draftEmbedding ? draftEmbedding : null,
      };
      const next = await adminLlmRoutingPut(payload);
      setRemote(next);
      setDraftChat(next.default_chat_channel_id ?? "");
      setDraftEmbedding(next.default_embedding_channel_id ?? "");
      setSuccess("已保存");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("保存失败，请稍后重试");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">AI / Routing</h1>
        <div className="sub">配置默认的 chat / embedding 渠道（operator 只读，super_admin 可保存）。</div>
      </div>

      {!canWrite ? (
        <div className="alert alert--warn" style={{ marginBottom: 12 }}>
          当前账号为 <code>operator</code>，仅可读取。保存需要 <code>super_admin</code>（Requires super_admin）。
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
            <div className="card-title">默认路由</div>
            <div className="muted" style={{ marginTop: 6 }}>
              下拉框来源于渠道列表，并提示 <code>enabled</code> / <code>purpose</code>。
            </div>
          </div>
          <div className="row">
            <button
              className="btn btn--ghost"
              type="button"
              disabled={loading || saving}
              onClick={() => {
                void loadAll();
              }}
            >
              {loading ? "刷新中..." : "刷新"}
            </button>
          </div>
        </div>

        <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

        <div className="form">
          <label className="field">
            <div className="field-label">default_chat_channel_id</div>
            <select
              className="input"
              value={draftChat}
              onChange={(e) => {
                setDraftChat(e.target.value);
                setSuccess(null);
                setError(null);
              }}
              disabled={loading || saving || !remote || !canWrite}
            >
              <option value="">（未设置）</option>
              {remote && remote.default_chat_channel_id && !chatOptions.some((c) => c.id === remote.default_chat_channel_id) ? (
                <option value={remote.default_chat_channel_id}>
                  （已不存在）{remote.default_chat_channel_id}
                </option>
              ) : null}
              {chatOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {toOptLabel(c)}
                </option>
              ))}
            </select>
            {chatSelected ? (
              <div className="muted" style={{ marginTop: 6 }}>
                当前选择：<code>{chatSelected.name}</code>
                {chatSelected.enabled ? null : (
                  <>
                    {" "}· <code>disabled</code>
                  </>
                )}
              </div>
            ) : draftChat ? (
              <div className="muted" style={{ marginTop: 6 }}>
                当前选择：<code>{draftChat}</code>（未在列表中找到）
              </div>
            ) : null}
          </label>

          <label className="field">
            <div className="field-label">default_embedding_channel_id</div>
            <select
              className="input"
              value={draftEmbedding}
              onChange={(e) => {
                setDraftEmbedding(e.target.value);
                setSuccess(null);
                setError(null);
              }}
              disabled={loading || saving || !remote || !canWrite}
            >
              <option value="">（未设置）</option>
              {remote &&
              remote.default_embedding_channel_id &&
              !embeddingOptions.some((c) => c.id === remote.default_embedding_channel_id) ? (
                <option value={remote.default_embedding_channel_id}>
                  （已不存在）{remote.default_embedding_channel_id}
                </option>
              ) : null}
              {embeddingOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {toOptLabel(c)}
                </option>
              ))}
            </select>
            {embeddingSelected ? (
              <div className="muted" style={{ marginTop: 6 }}>
                当前选择：<code>{embeddingSelected.name}</code>
                {embeddingSelected.enabled ? null : (
                  <>
                    {" "}· <code>disabled</code>
                  </>
                )}
              </div>
            ) : draftEmbedding ? (
              <div className="muted" style={{ marginTop: 6 }}>
                当前选择：<code>{draftEmbedding}</code>（未在列表中找到）
              </div>
            ) : null}
          </label>

          <div className="actions">
            <div className="actions-left">
              {loading ? <span className="muted">加载中...</span> : dirty ? <span className="muted">存在未保存更改</span> : null}
            </div>
            <div className="actions-right">
              <button
                className="btn btn--ghost"
                type="button"
                disabled={loading || saving || !remote || !canWrite}
                onClick={() => {
                  if (!remote) return;
                  setDraftChat(remote.default_chat_channel_id ?? "");
                  setDraftEmbedding(remote.default_embedding_channel_id ?? "");
                  setSuccess(null);
                  setError(null);
                }}
              >
                重置
              </button>
              <button className="btn btn--primary" type="button" disabled={saveDisabled} onClick={() => void save()}>
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
