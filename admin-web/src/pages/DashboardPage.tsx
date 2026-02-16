import { useEffect, useState } from "react";

import {
  adminConfigGetFeatureFlags,
  adminMetricsGetSummary,
  type AdminFeatureFlags,
  type AdminMetricsSummary,
  ApiError,
} from "../lib/api";
import { loadAdminSession } from "../lib/auth";

export function DashboardPage() {
  const session = loadAdminSession();

  const [flags, setFlags] = useState<AdminFeatureFlags | null>(null);
  const [metrics, setMetrics] = useState<AdminMetricsSummary | null>(null);
  const [loadingFlags, setLoadingFlags] = useState(true);
  const [loadingMetrics, setLoadingMetrics] = useState(true);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFlags() {
      setLoadingFlags(true);
      setFlagsError(null);
      try {
        const resp = await adminConfigGetFeatureFlags();
        if (!cancelled) setFlags(resp);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) setFlagsError(err.message);
        else setFlagsError("拉取失败");
      } finally {
        if (!cancelled) setLoadingFlags(false);
      }
    }

    async function loadMetrics() {
      setLoadingMetrics(true);
      setMetricsError(null);
      try {
        const resp = await adminMetricsGetSummary();
        if (!cancelled) setMetrics(resp);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) setMetricsError(err.message);
        else setMetricsError("拉取失败");
      } finally {
        if (!cancelled) setLoadingMetrics(false);
      }
    }

    void loadFlags();
    void loadMetrics();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="h1">概览</h1>
        <div className="sub">系统状态与关键入口</div>
      </div>

      <div className="grid">
        <section className="card">
          <div className="card-title">当前登录</div>
          <div className="kv">
            <div className="kv-k">admin_user_id</div>
            <div className="kv-v mono">{session?.adminUserId ?? "-"}</div>
          </div>
          <div className="kv">
            <div className="kv-k">role</div>
            <div className="kv-v mono">{session?.role ?? "-"}</div>
          </div>
        </section>

        <section className="card">
          <div className="card-title">Feature Flags 摘要</div>
          <div className="p">快速确认关键开关状态（以便与客户端行为对齐）。</div>

          {flagsError ? <div className="alert alert--danger" style={{ marginTop: 12 }}>{flagsError}</div> : null}

          <div className="kv" style={{ marginTop: 6 }}>
            <div className="kv-k">
              plugins_enabled
            </div>
            <div className="kv-v">
              {loadingFlags ? (
                <span className="muted">加载中...</span>
              ) : flags ? (
                <span className={Boolean(flags.plugins_enabled) ? "badge badge--ok" : "badge badge--off"}>
                  {Boolean(flags.plugins_enabled) ? "ENABLED" : "DISABLED"}
                </span>
              ) : (
                "-"
              )}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-title">Metrics（24h）</div>
          <div className="p">用于快速判断近期审计/调用是否异常。接口失败不影响使用。</div>

          {metricsError ? (
            <div className="alert alert--danger" style={{ marginTop: 12 }}>
              {metricsError}
            </div>
          ) : null}

          <div className="kv" style={{ marginTop: 6 }}>
            <div className="kv-k">generated_at</div>
            <div className="kv-v mono">
              {loadingMetrics ? "加载中..." : metrics?.generated_at ?? "-"}
            </div>
          </div>
          <div className="kv">
            <div className="kv-k">audit_log_count_24h</div>
            <div className="kv-v mono">
              {loadingMetrics ? "加载中..." : typeof metrics?.audit_log_count_24h === "number" ? metrics.audit_log_count_24h : "-"}
            </div>
          </div>
          <div className="kv">
            <div className="kv-k">admin_user_count</div>
            <div className="kv-v mono">
              {loadingMetrics ? "加载中..." : typeof metrics?.admin_user_count === "number" ? metrics.admin_user_count : "-"}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
