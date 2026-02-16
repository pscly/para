import { useCallback, useEffect, useMemo, useState } from "react";

import {
  adminReviewPluginApprove,
  adminReviewPluginDetail,
  adminReviewPluginReject,
  adminReviewPluginSetNote,
  adminReviewPluginsQueueList,
  ApiError,
  type AdminReviewPluginDetail,
  type AdminReviewPluginQueueItem,
} from "../lib/api";
import { loadAdminSession } from "../lib/auth";
type QueueStatus = "pending" | "approved" | "rejected";

function stringifyJsonSafe(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function PluginsReviewPage() {
  const session = loadAdminSession();
  const canAct = session?.role === "super_admin";

  const [status, setStatus] = useState<QueueStatus>("pending");
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [items, setItems] = useState<AdminReviewPluginQueueItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);

  const [selected, setSelected] = useState<{ id: string; version: string } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminReviewPluginDetail | null>(null);

  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [acting, setActing] = useState<"approve" | "reject" | null>(null);

  const noteTrimmed = useMemo(() => noteDraft.trim(), [noteDraft]);
  const noteTooLong = noteDraft.length > 2000;

  const loadQueue = useCallback(
    async (next: { offset: number }) => {
      setQueueError(null);
      setQueueLoading(true);
      try {
        const res = await adminReviewPluginsQueueList({ status, limit, offset: next.offset });
        setItems(res.items);
        setNextOffset(res.next_offset);
        setOffset(next.offset);
      } catch (err) {
        if (err instanceof ApiError) setQueueError(err.message);
        else setQueueError("拉取队列失败，请稍后重试");
      } finally {
        setQueueLoading(false);
      }
    },
    [status, limit],
  );

  const loadDetail = useCallback(async (id: string, version: string) => {
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await adminReviewPluginDetail(id, version);
      setDetail(res);
      setNoteDraft(res.review_note ?? "");
    } catch (err) {
      setDetail(null);
      if (err instanceof ApiError) setDetailError(err.message);
      else setDetailError("拉取详情失败，请稍后重试");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue({ offset: 0 });
    setSelected(null);
    setDetail(null);
    setNoteDraft("");
  }, [loadQueue]);

  async function saveNote() {
    if (!selected) return;
    if (!canAct) {
      setDetailError("当前账号权限不足：需要 super_admin（Requires super_admin）");
      return;
    }
    if (noteTooLong) {
      setDetailError("备注过长：最多 2000 字符");
      return;
    }

    setNoteSaving(true);
    setDetailError(null);
    try {
      const normalized = noteTrimmed ? noteTrimmed : null;
      const res = await adminReviewPluginSetNote(selected.id, selected.version, normalized);
      setDetail(res);
      setNoteDraft(res.review_note ?? "");
    } catch (err) {
      if (err instanceof ApiError) setDetailError(err.message);
      else setDetailError("保存备注失败，请稍后重试");
    } finally {
      setNoteSaving(false);
    }
  }

  async function act(kind: "approve" | "reject") {
    if (!selected) return;
    if (!canAct) {
      setDetailError("当前账号权限不足：需要 super_admin（Requires super_admin）");
      return;
    }
    setActing(kind);
    setDetailError(null);
    try {
      if (kind === "approve") await adminReviewPluginApprove(selected.id, selected.version);
      else await adminReviewPluginReject(selected.id, selected.version);
      await loadQueue({ offset: 0 });
      setSelected(null);
      setDetail(null);
      setNoteDraft("");
    } catch (err) {
      if (err instanceof ApiError) setDetailError(err.message);
      else setDetailError("操作失败，请稍后重试");
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">插件审核</h1>
        <div className="sub">
          可浏览待审队列、查看详情、写备注，并执行 approve/reject。<code>operator</code> 允许只读浏览，审核动作需要
          <code>super_admin</code>。
        </div>
      </div>

      {!canAct ? (
        <div className="alert alert--warn" style={{ marginBottom: 12 }}>
          当前账号角色为 <code>{session?.role ?? "unknown"}</code>：可只读浏览队列/详情；审核与备注写入需要
          <code>super_admin</code>（Requires super_admin）。
        </div>
      ) : null}

      <div className="grid">
        <section className="card">
          <div className="card-title">待审队列</div>

          {queueError ? (
            <div className="alert alert--danger" style={{ marginTop: 12 }}>
              {queueError}
            </div>
          ) : null}

          <div className="form" style={{ marginTop: 12 }}>
            <div className="form-row">
              <label className="field" style={{ width: 220 }}>
                <div className="field-label">status</div>
                <select
                  className="input"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as QueueStatus)}
                  disabled={queueLoading}
                >
                  <option value="pending">pending</option>
                  <option value="approved">approved</option>
                  <option value="rejected">rejected</option>
                </select>
              </label>
              <label className="field" style={{ width: 160 }}>
                <div className="field-label">limit</div>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={200}
                  value={limit}
                  onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 50)))}
                  disabled={queueLoading}
                />
              </label>
            </div>

            <div className="row row--space">
              <span className="muted">
                offset: <code>{offset}</code> · next_offset: <code>{String(nextOffset)}</code>
              </span>
              <div className="row">
                <button
                  className="btn btn--ghost"
                  type="button"
                  disabled={queueLoading}
                  onClick={() => {
                    void loadQueue({ offset: 0 });
                  }}
                >
                  {queueLoading ? "刷新中..." : "刷新"}
                </button>
                <button
                  className="btn btn--ghost"
                  type="button"
                  disabled={queueLoading || offset <= 0}
                  onClick={() => {
                    void loadQueue({ offset: Math.max(0, offset - limit) });
                  }}
                >
                  上一页
                </button>
                <button
                  className="btn btn--ghost"
                  type="button"
                  disabled={queueLoading || nextOffset === null}
                  onClick={() => {
                    if (nextOffset !== null) void loadQueue({ offset: nextOffset });
                  }}
                >
                  下一页
                </button>
              </div>
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>version</th>
                  <th>name</th>
                  <th>created_at</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      {queueLoading ? "加载中..." : "暂无数据"}
                    </td>
                  </tr>
                ) : (
                  items.map((it) => {
                    const isSel = selected?.id === it.id && selected?.version === it.version;
                    return (
                      <tr
                        key={`${it.id}:${it.version}`}
                        style={{ cursor: "pointer", background: isSel ? "rgba(15, 118, 110, 0.06)" : undefined }}
                        onClick={() => {
                          setSelected({ id: it.id, version: it.version });
                          void loadDetail(it.id, it.version);
                        }}
                      >
                        <td>
                          <code>{it.id}</code>
                        </td>
                        <td>
                          <code>{it.version}</code>
                        </td>
                        <td>{it.name}</td>
                        <td className="mono">{it.created_at}</td>
                        <td>
                          <span className="badge badge--off">{it.status}</span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-title">详情</div>

          {detailError ? (
            <div className="alert alert--danger" style={{ marginTop: 12 }}>
              {detailError}
            </div>
          ) : null}

          {!selected ? (
            <div className="p">从左侧队列选择一条记录查看详情。</div>
          ) : detailLoading ? (
            <div className="p">加载详情中...</div>
          ) : !detail ? (
            <div className="p">未加载到详情。</div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div className="kv">
                <div className="kv-k">id</div>
                <div className="kv-v">
                  <code>{detail.id}</code>
                </div>
              </div>
              <div className="kv">
                <div className="kv-k">version</div>
                <div className="kv-v">
                  <code>{detail.version}</code>
                </div>
              </div>
              <div className="kv">
                <div className="kv-k">status</div>
                <div className="kv-v">
                  <code>{detail.status}</code>
                </div>
              </div>
              <div className="kv">
                <div className="kv-k">sha256</div>
                <div className="kv-v mono">{detail.sha256}</div>
              </div>
              <div className="kv">
                <div className="kv-k">reviewed_at</div>
                <div className="kv-v mono">{detail.reviewed_at ?? "-"}</div>
              </div>
              <div className="kv">
                <div className="kv-k">reviewed_by</div>
                <div className="kv-v mono">{detail.reviewed_by ?? "-"}</div>
              </div>

              <details className="json-details" style={{ marginTop: 12 }}>
                <summary className="json-summary">manifest</summary>
                <pre className="json-pre">{stringifyJsonSafe(detail.manifest ?? detail.manifest_json)}</pre>
              </details>

              <details className="json-details" style={{ marginTop: 10 }}>
                <summary className="json-summary">code</summary>
                <pre className="json-pre" style={{ maxHeight: 360 }}>
                  {detail.code}
                </pre>
              </details>

              <div className="form" style={{ marginTop: 12 }}>
                <label className="field">
                  <div className="field-label">备注（最多 2000 字符）</div>
                  <textarea
                    className="json-editor"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    disabled={noteSaving || acting !== null || !canAct}
                    style={{ minHeight: 160 }}
                  />
                  <div className="row row--space">
                    <span className={noteTooLong ? "danger-hint" : "muted"}>
                      {noteDraft.length}/2000
                    </span>
                    <button
                      className="btn btn--ghost"
                      type="button"
                      disabled={!canAct || noteSaving || acting !== null || noteTooLong}
                      onClick={() => {
                        void saveNote();
                      }}
                    >
                      {noteSaving ? "保存中..." : "保存备注"}
                    </button>
                  </div>
                </label>

                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button
                    className="btn"
                    type="button"
                    disabled={!canAct || acting !== null || noteSaving}
                    onClick={() => {
                      void act("reject");
                    }}
                  >
                    {acting === "reject" ? "驳回中..." : "驳回"}
                  </button>
                  <button
                    className="btn btn--primary"
                    type="button"
                    disabled={!canAct || acting !== null || noteSaving}
                    onClick={() => {
                      void act("approve");
                    }}
                  >
                    {acting === "approve" ? "通过中..." : "通过"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
