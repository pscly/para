import { useEffect, useMemo, useState } from "react";

import {
  adminAuditLogsList,
  type AdminAuditLogListItem,
  ApiError,
  type AdminAuditLogsListParams,
} from "../lib/api";

const DEFAULT_LIMIT = 50;

function formatDateTime(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

function stringifyMetadata(meta: unknown): string {
  if (meta === null || meta === undefined) return "";
  if (typeof meta === "string") return meta;
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return String(meta);
  }
}

export function AuditLogsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [items, setItems] = useState<AdminAuditLogListItem[]>([]);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [offset, setOffset] = useState<number>(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);

  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");

  const effectiveFilters = useMemo(
    () => ({ actor: actor.trim(), action: action.trim(), target_type: targetType.trim(), target_id: targetId.trim() }),
    [actor, action, targetType, targetId]
  );

  async function runQuery(next: { offset: number; reset?: boolean }) {
    setLoading(true);
    setError(null);
    try {
      const params: AdminAuditLogsListParams = {
        actor: effectiveFilters.actor || undefined,
        action: effectiveFilters.action || undefined,
        target_type: effectiveFilters.target_type || undefined,
        target_id: effectiveFilters.target_id || undefined,
        limit,
        offset: next.offset,
      };
      const resp = await adminAuditLogsList(params);
      setItems(resp.items);
      setNextOffset(resp.next_offset);
      setOffset(next.offset);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("拉取失败，请稍后重试");
      }
      setItems([]);
      setNextOffset(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function init() {
      setLoading(true);
      setError(null);
      try {
        const resp = await adminAuditLogsList({ limit: DEFAULT_LIMIT, offset: 0 });
        if (cancelled) return;
        setItems(resp.items);
        setNextOffset(resp.next_offset);
        setLimit(DEFAULT_LIMIT);
        setOffset(0);
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
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const canPrev = offset > 0 && !loading;
  const prevOffset = Math.max(0, offset - limit);
  const canNext = nextOffset !== null && !loading;

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">审计日志</h1>
        <div className="sub">
          支持 <code>actor</code>/<code>action</code>/<code>target_type</code>/<code>target_id</code> 过滤与分页（operator
          / super_admin 可访问）。
        </div>
      </div>

      <section className="card">
        <div className="card-title">过滤</div>

        {error ? (
          <div className="alert alert--danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        ) : null}

        <div className="filterbar" style={{ marginTop: 12 }}>
          <div className="filterbar-grid">
            <label className="field">
              <div className="field-label">actor</div>
              <input
                className="input"
                placeholder='例如：admin "admin:xxx" 或用户 "user:xxx"'
                value={actor}
                onChange={(e) => setActor(e.target.value)}
                disabled={loading}
              />
            </label>
            <label className="field">
              <div className="field-label">action</div>
              <input
                className="input"
                placeholder="例如：feature_flags.update"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                disabled={loading}
              />
            </label>
            <label className="field">
              <div className="field-label">target_type</div>
              <input
                className="input"
                placeholder="例如：save / feature_flags"
                value={targetType}
                onChange={(e) => setTargetType(e.target.value)}
                disabled={loading}
              />
            </label>
            <label className="field">
              <div className="field-label">target_id</div>
              <input
                className="input"
                placeholder="例如：global 或具体 id"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                disabled={loading}
              />
            </label>
          </div>

          <div className="filterbar-actions">
            <label className="field" style={{ width: 120 }}>
              <div className="field-label">每页</div>
              <input
                className="input"
                inputMode="numeric"
                value={String(limit)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n)) {
                    setLimit(DEFAULT_LIMIT);
                    return;
                  }
                  const clamped = Math.max(1, Math.min(200, Math.floor(n)));
                  setLimit(clamped);
                }}
                disabled={loading}
              />
            </label>

            <button
              className="btn btn--ghost"
              type="button"
              disabled={loading}
              onClick={() => {
                setActor("");
                setAction("");
                setTargetType("");
                setTargetId("");
                setError(null);
              }}
            >
              清空
            </button>
            <button
              className="btn btn--primary"
              type="button"
              disabled={loading}
              onClick={() => {
                void runQuery({ offset: 0, reset: true });
              }}
            >
              {loading ? "查询中..." : "查询"}
            </button>
          </div>
        </div>

        <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 168 }}>created_at</th>
                <th style={{ width: 190 }}>actor</th>
                <th style={{ width: 220 }}>action</th>
                <th style={{ width: 140 }}>target_type</th>
                <th style={{ width: 220 }}>target_id</th>
                <th>metadata</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6}>
                    <div className="muted" style={{ padding: 10 }}>
                      加载中...
                    </div>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="muted" style={{ padding: 10 }}>
                      暂无数据
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((it) => (
                  <tr key={it.id}>
                    <td className="mono" title={it.created_at}>
                      {formatDateTime(it.created_at)}
                    </td>
                    <td>
                      <code title={it.actor}>{it.actor}</code>
                    </td>
                    <td>
                      <code title={it.action}>{it.action}</code>
                    </td>
                    <td>
                      <code title={it.target_type}>{it.target_type}</code>
                    </td>
                    <td className="mono" title={it.target_id}>
                      {it.target_id}
                    </td>
                    <td>
                      <details className="json-details">
                        <summary className="json-summary">查看</summary>
                        <pre className="json-pre">{stringifyMetadata(it.metadata)}</pre>
                      </details>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="pagination" style={{ marginTop: 12 }}>
          <div className="pagination-left">
            <span className="muted">
              offset: <code>{offset}</code> · limit: <code>{limit}</code>
              {nextOffset !== null ? (
                <>
                  {" "}· next_offset: <code>{nextOffset}</code>
                </>
              ) : (
                <>
                  {" "}· next_offset: <code>null</code>
                </>
              )}
            </span>
          </div>
          <div className="pagination-right">
            <button
              className="btn btn--ghost"
              type="button"
              disabled={!canPrev}
              onClick={() => {
                void runQuery({ offset: prevOffset });
              }}
            >
              上一页
            </button>
            <button
              className="btn btn--primary"
              type="button"
              disabled={!canNext}
              onClick={() => {
                if (nextOffset === null) return;
                void runQuery({ offset: nextOffset });
              }}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
