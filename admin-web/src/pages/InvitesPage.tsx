import { useEffect, useMemo, useState } from "react";

import {
  adminInvitesCreate,
  adminInvitesList,
  adminInvitesRedemptionsList,
  adminInvitesRevoke,
  ApiError,
  type AdminInviteCodeCreateResponse,
  type AdminInviteCodeListItem,
  type AdminInviteRedemptionListItem,
} from "../lib/api";
import { loadAdminSession } from "../lib/auth";

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

function deriveInviteStatus(it: AdminInviteCodeListItem): {
  label: string;
  kind: "ok" | "off";
} {
  if (it.revoked_at) return { label: "REVOKED", kind: "off" };
  if (typeof it.max_uses === "number" && typeof it.uses_count === "number" && it.uses_count >= it.max_uses) {
    return { label: "EXHAUSTED", kind: "off" };
  }
  if (it.expires_at) {
    const exp = new Date(it.expires_at);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= Date.now()) {
      return { label: "EXPIRED", kind: "off" };
    }
  }
  return { label: "ACTIVE", kind: "ok" };
}

export function InvitesPage() {
  const session = loadAdminSession();
  const canEdit = session?.role === "super_admin";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [items, setItems] = useState<AdminInviteCodeListItem[]>([]);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [offset, setOffset] = useState<number>(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);

  const [creating, setCreating] = useState(false);
  const [maxUses, setMaxUses] = useState<number>(1);
  const [created, setCreated] = useState<AdminInviteCodeCreateResponse | null>(null);
  const createdCode = created?.code ?? null;

  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const [selectedInvite, setSelectedInvite] = useState<AdminInviteCodeListItem | null>(null);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);
  const [redemptionsError, setRedemptionsError] = useState<string | null>(null);
  const [redemptions, setRedemptions] = useState<AdminInviteRedemptionListItem[]>([]);
  const [redemptionsOffset, setRedemptionsOffset] = useState<number>(0);
  const [redemptionsNextOffset, setRedemptionsNextOffset] = useState<number | null>(null);

  const canPrev = offset > 0 && !loading;
  const prevOffset = Math.max(0, offset - limit);
  const canNext = nextOffset !== null && !loading;

  async function loadPage(next: { offset: number }) {
    setLoading(true);
    setError(null);
    try {
      const resp = await adminInvitesList({ limit, offset: next.offset });
      setItems(resp.items);
      setNextOffset(resp.next_offset);
      setOffset(next.offset);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("拉取失败，请稍后重试");
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
        const resp = await adminInvitesList({ limit: DEFAULT_LIMIT, offset: 0 });
        if (cancelled) return;
        setItems(resp.items);
        setNextOffset(resp.next_offset);
        setLimit(DEFAULT_LIMIT);
        setOffset(0);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) setError(err.message);
        else setError("拉取失败，请稍后重试");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  async function openRedemptions(it: AdminInviteCodeListItem) {
    setSelectedInvite(it);
    setRedemptionsLoading(true);
    setRedemptionsError(null);
    setRedemptions([]);
    setRedemptionsOffset(0);
    setRedemptionsNextOffset(null);
    try {
      const resp = await adminInvitesRedemptionsList(it.id, { limit: 50, offset: 0 });
      setRedemptions(resp.items);
      setRedemptionsNextOffset(resp.next_offset);
    } catch (err) {
      if (err instanceof ApiError) setRedemptionsError(err.message);
      else setRedemptionsError("拉取失败，请稍后重试");
    } finally {
      setRedemptionsLoading(false);
    }
  }

  const selectedStatus = useMemo(() => {
    if (!selectedInvite) return null;
    return deriveInviteStatus(selectedInvite);
  }, [selectedInvite]);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">邀请码管理</h1>
        <div className="sub">
          支持创建 / 列表 / 撤销 / 查看使用记录（operator 仅可查看，super_admin 可创建与撤销）。
        </div>
      </div>

      <section className="card">
        <div className="card-title">创建邀请码</div>
        <div className="p">创建接口只会返回一次明文邀请码（code）。请立即保存，刷新/再次进入页面不会再显示。</div>

        {!canEdit ? (
          <div className="alert alert--warn" style={{ marginTop: 12 }}>
            当前账号为 <code>operator</code>，仅可读取。创建/撤销需要 <code>super_admin</code>。
          </div>
        ) : null}

        {createdCode ? (
          <div className="alert alert--warn" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700 }}>邀请码只展示一次，请立即保存。</div>
            <div className="result" style={{ marginTop: 10 }}>
              <div className="result-head">
                <div className="result-title">新邀请码（code）</div>
                <div className="muted">该值不会出现在列表里（列表只显示 code_prefix）。</div>
              </div>
              <pre className="result-pre" data-testid="invite-created-code">
                {createdCode}
              </pre>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="muted">{copyMsg ?? " "}</div>
                <div className="row">
                  <button
                    className="btn btn--ghost"
                    type="button"
                    onClick={async () => {
                      setCopyMsg(null);
                      try {
                        await navigator.clipboard.writeText(createdCode);
                        setCopyMsg("已复制到剪贴板");
                      } catch {
                        setCopyMsg("复制失败：请手动复制");
                      }
                    }}
                  >
                    复制
                  </button>
                  <button
                    className="btn btn--primary"
                    type="button"
                    onClick={() => {
                      setCreated(null);
                      setCopyMsg(null);
                    }}
                  >
                    我已保存，关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

        <div className="form-row">
          <label className="field" style={{ width: 220 }}>
            <div className="field-label">最大使用次数（max_uses）</div>
            <input
              className="input"
              inputMode="numeric"
              value={String(maxUses)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) {
                  setMaxUses(1);
                  return;
                }
                const clamped = Math.max(1, Math.min(10_000, Math.floor(n)));
                setMaxUses(clamped);
              }}
              disabled={creating || !canEdit}
            />
          </label>

          <div className="row" style={{ alignItems: "flex-end" }}>
            <button
              className="btn btn--primary"
              type="button"
              disabled={creating || !canEdit}
              onClick={async () => {
                setCreating(true);
                setError(null);
                setCopyMsg(null);
                try {
                  const resp = await adminInvitesCreate({ max_uses: maxUses });
                  setCreated(resp);
                  await loadPage({ offset: 0 });
                } catch (err) {
                  if (err instanceof ApiError) setError(err.message);
                  else setError("创建失败，请稍后重试");
                } finally {
                  setCreating(false);
                }
              }}
              data-testid="invite-create-btn"
            >
              {creating ? "创建中..." : "创建邀请码"}
            </button>
          </div>
        </div>

        {error ? (
          <div className="alert alert--danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        ) : null}
      </section>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="card-title">邀请码列表</div>
        <div className="p">
          列表不会回显明文 <code>code</code>，只显示 <code>code_prefix</code>。需要分发邀请码请在创建时保存。
        </div>

        <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

        <div className="table-wrap">
          <table className="table" data-testid="invites-table">
            <thead>
              <tr>
                <th style={{ width: 168 }}>created_at</th>
                <th style={{ width: 110 }}>code_prefix</th>
                <th style={{ width: 120 }}>status</th>
                <th style={{ width: 130 }}>uses</th>
                <th style={{ width: 168 }}>expires_at</th>
                <th style={{ width: 220 }}>actions</th>
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
                      暂无邀请码
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((it) => {
                  const st = deriveInviteStatus(it);
                  const isRevoked = Boolean(it.revoked_at);
                  return (
                    <tr key={it.id} data-testid={`invite-row-${it.id}`}>
                      <td className="mono" title={it.created_at}>
                        {formatDateTime(it.created_at)}
                      </td>
                      <td className="mono" title={it.code_prefix}>
                        {it.code_prefix}
                      </td>
                      <td>
                        <span className={st.kind === "ok" ? "badge badge--ok" : "badge badge--off"}>{st.label}</span>
                      </td>
                      <td className="mono">
                        {it.uses_count} / {it.max_uses}
                      </td>
                      <td className="mono" title={it.expires_at ?? undefined}>
                        {it.expires_at ? formatDateTime(it.expires_at) : "-"}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                          <button
                            className="btn btn--ghost"
                            type="button"
                            onClick={() => void openRedemptions(it)}
                            data-testid={`invite-redemptions-${it.id}`}
                          >
                            使用记录
                          </button>
                          <button
                            className="btn btn--ghost"
                            type="button"
                            disabled={!canEdit || isRevoked}
                            onClick={async () => {
                              if (!canEdit) return;
                              if (isRevoked) return;
                              const ok = window.confirm(`确认撤销邀请码 ${it.code_prefix}… ？撤销后不可恢复。`);
                              if (!ok) return;
                              setError(null);
                              try {
                                const next = await adminInvitesRevoke(it.id);
                                setItems((prev) => prev.map((x) => (x.id === next.id ? next : x)));
                                setSelectedInvite((prev) => (prev && prev.id === next.id ? next : prev));
                              } catch (err) {
                                if (err instanceof ApiError) setError(err.message);
                                else setError("撤销失败，请稍后重试");
                              }
                            }}
                            data-testid={`invite-revoke-${it.id}`}
                          >
                            {isRevoked ? "已撤销" : "撤销"}
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
              onClick={() => void loadPage({ offset: 0 })}
            >
              刷新
            </button>
            <button
              className="btn btn--ghost"
              type="button"
              disabled={!canPrev}
              onClick={() => void loadPage({ offset: prevOffset })}
            >
              上一页
            </button>
            <button
              className="btn btn--primary"
              type="button"
              disabled={!canNext}
              onClick={() => {
                if (nextOffset === null) return;
                void loadPage({ offset: nextOffset });
              }}
            >
              下一页
            </button>
          </div>
        </div>
      </section>

      {selectedInvite ? (
        <section className="card" style={{ marginTop: 12 }} data-testid="invite-redemptions-panel">
          <div className="row row--space">
            <div>
              <div className="card-title">使用记录</div>
              <div className="sub" style={{ marginTop: 6 }}>
                invite: <code>{selectedInvite.code_prefix}</code> · status:{" "}
                <span className={selectedStatus?.kind === "ok" ? "badge badge--ok" : "badge badge--off"}>
                  {selectedStatus?.label ?? "-"}
                </span>
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn btn--ghost"
                type="button"
                disabled={redemptionsLoading}
                onClick={async () => {
                  const it = selectedInvite;
                  setRedemptionsLoading(true);
                  setRedemptionsError(null);
                  try {
                    const resp = await adminInvitesRedemptionsList(it.id, { limit: 50, offset: 0 });
                    setRedemptions(resp.items);
                    setRedemptionsOffset(0);
                    setRedemptionsNextOffset(resp.next_offset);
                  } catch (err) {
                    if (err instanceof ApiError) setRedemptionsError(err.message);
                    else setRedemptionsError("拉取失败，请稍后重试");
                  } finally {
                    setRedemptionsLoading(false);
                  }
                }}
              >
                刷新
              </button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => {
                  setSelectedInvite(null);
                  setRedemptionsError(null);
                  setRedemptions([]);
                  setRedemptionsOffset(0);
                  setRedemptionsNextOffset(null);
                }}
              >
                关闭
              </button>
            </div>
          </div>

          {redemptionsError ? (
            <div className="alert alert--danger" style={{ marginTop: 12 }}>
              {redemptionsError}
            </div>
          ) : null}

          <div className="divider" style={{ marginTop: 12, marginBottom: 12 }} />

          <div className="table-wrap">
            <table className="table" data-testid="invite-redemptions-table">
              <thead>
                <tr>
                  <th style={{ width: 168 }}>used_at</th>
                  <th style={{ width: 220 }}>user_email</th>
                  <th style={{ width: 220 }}>user_id</th>
                  <th>id</th>
                </tr>
              </thead>
              <tbody>
                {redemptionsLoading ? (
                  <tr>
                    <td colSpan={4}>
                      <div className="muted" style={{ padding: 10 }}>
                        加载中...
                      </div>
                    </td>
                  </tr>
                ) : redemptions.length === 0 ? (
                  <tr>
                    <td colSpan={4}>
                      <div className="muted" style={{ padding: 10 }}>
                        暂无使用记录
                      </div>
                    </td>
                  </tr>
                ) : (
                  redemptions.map((r) => (
                    <tr key={r.id} data-testid={`invite-redemption-row-${r.id}`}>
                      <td className="mono" title={r.used_at}>
                        {formatDateTime(r.used_at)}
                      </td>
                      <td>
                        <code title={r.user_email}>{r.user_email}</code>
                      </td>
                      <td className="mono" title={r.user_id}>
                        {r.user_id}
                      </td>
                      <td className="mono" title={r.id}>
                        {r.id}
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
                offset: <code>{redemptionsOffset}</code> · limit: <code>50</code>
                {redemptionsNextOffset !== null ? (
                  <>
                    {" "}· next_offset: <code>{redemptionsNextOffset}</code>
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
                disabled={redemptionsLoading || redemptionsOffset <= 0}
                onClick={async () => {
                  const it = selectedInvite;
                  const prev = Math.max(0, redemptionsOffset - 50);
                  setRedemptionsLoading(true);
                  setRedemptionsError(null);
                  try {
                    const resp = await adminInvitesRedemptionsList(it.id, { limit: 50, offset: prev });
                    setRedemptions(resp.items);
                    setRedemptionsOffset(prev);
                    setRedemptionsNextOffset(resp.next_offset);
                  } catch (err) {
                    if (err instanceof ApiError) setRedemptionsError(err.message);
                    else setRedemptionsError("拉取失败，请稍后重试");
                  } finally {
                    setRedemptionsLoading(false);
                  }
                }}
              >
                上一页
              </button>
              <button
                className="btn btn--primary"
                type="button"
                disabled={redemptionsLoading || redemptionsNextOffset === null}
                onClick={async () => {
                  const it = selectedInvite;
                  if (redemptionsNextOffset === null) return;
                  setRedemptionsLoading(true);
                  setRedemptionsError(null);
                  try {
                    const resp = await adminInvitesRedemptionsList(it.id, {
                      limit: 50,
                      offset: redemptionsNextOffset,
                    });
                    setRedemptions(resp.items);
                    setRedemptionsOffset(redemptionsNextOffset);
                    setRedemptionsNextOffset(resp.next_offset);
                  } catch (err) {
                    if (err instanceof ApiError) setRedemptionsError(err.message);
                    else setRedemptionsError("拉取失败，请稍后重试");
                  } finally {
                    setRedemptionsLoading(false);
                  }
                }}
              >
                下一页
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
