import { getAdminAccessToken } from "./auth";

export type ApiErrorCode =
  | "NETWORK"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "SERVER"
  | "PARSE"
  | "UNKNOWN";

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status?: number;

  constructor(message: string, opts: { code: ApiErrorCode; status?: number }) {
    super(message);
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
  }
}

function baseUrlFromEnv(): string {
  const raw = (import.meta.env.VITE_SERVER_BASE_URL as string | undefined) ?? "";
  return raw.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  if (!path) return baseUrl;
  if (path.startsWith("/")) return `${baseUrl}${path}`;
  return `${baseUrl}/${path}`;
}

function mapHttpError(status: number): ApiError {
  // 注意：错误信息保持“脱敏”，不要拼接响应体/请求头（可能含 token）。
  if (status === 401) return new ApiError("未登录或登录已过期", { code: "UNAUTHORIZED", status });
  if (status === 403) return new ApiError("权限不足", { code: "FORBIDDEN", status });
  if (status === 404) return new ApiError("接口不存在", { code: "NOT_FOUND", status });
  if (status >= 400 && status < 500) return new ApiError("请求不合法", { code: "BAD_REQUEST", status });
  if (status >= 500) return new ApiError("服务端错误", { code: "SERVER", status });
  return new ApiError("请求失败", { code: "UNKNOWN", status });
}

function redactMaybeToken(raw: string): string {
  // 兜底：避免把任何疑似 bearer/token 片段直接展示到 UI。
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/sk-[A-Za-z0-9]{16,}/g, "sk-***");
}

function safeExtractDetail(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const detail = (parsed as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) {
        const oneLine = detail.replace(/\s+/g, " ").trim();
        return redactMaybeToken(oneLine).slice(0, 200);
      }
    }
  } catch {
  }
  return null;
}

function mapHttpErrorWithDetail(status: number, detail: string | null): ApiError {
  if (status === 403 && detail) {
    return new ApiError(`权限不足（${detail}）`, { code: "FORBIDDEN", status });
  }
  if ((status === 400 || status === 422) && detail) {
    return new ApiError(`请求不合法：${detail}`, { code: "BAD_REQUEST", status });
  }
  if (status === 409 && detail) {
    return new ApiError(`请求冲突：${detail}`, { code: "BAD_REQUEST", status });
  }
  return mapHttpError(status);
}

export type ApiRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  auth?: "admin" | "none";
};

export async function apiRequestJson<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  const baseUrl = baseUrlFromEnv();
  const url = joinUrl(baseUrl, path);

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };

  const useAuth = (opts.auth ?? "admin") === "admin";
  if (useAuth) {
    const token = getAdminAccessToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body,
    });
  } catch {
    throw new ApiError("网络异常，请检查后端服务地址", { code: "NETWORK" });
  }

  if (!res.ok) {
    const detail = safeExtractDetail(await res.text());
    throw mapHttpErrorWithDetail(res.status, detail);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("响应解析失败", { code: "PARSE" });
  }
}

export type AdminLoginPayload = {
  email: string;
  password: string;
};

export type AdminLoginResult = {
  access_token: string;
  token_type: string;
  admin_user_id: string;
  role: string;
};

export async function adminLogin(payload: AdminLoginPayload): Promise<AdminLoginResult> {
  return apiRequestJson<AdminLoginResult>("/api/v1/admin/auth/login", {
    method: "POST",
    auth: "none",
    body: payload,
  });
}

export type AdminFeatureFlags = {
  plugins_enabled?: boolean;
  invite_registration_enabled?: boolean;
  [k: string]: unknown;
};

export type AdminFeatureFlagsUpdate = Partial<
  Pick<AdminFeatureFlags, "plugins_enabled" | "invite_registration_enabled">
>;

export async function adminConfigGetFeatureFlags(): Promise<AdminFeatureFlags> {
  return apiRequestJson<AdminFeatureFlags>("/api/v1/admin/config/feature_flags", { method: "GET" });
}

export async function adminConfigPutFeatureFlags(payload: AdminFeatureFlagsUpdate): Promise<AdminFeatureFlags> {
  return apiRequestJson<AdminFeatureFlags>("/api/v1/admin/config/feature_flags", {
    method: "PUT",
    body: payload,
  });
}

export type AdminInviteCodeCreateRequest = {
  max_uses: number;
  expires_at?: string | null;
};

export type AdminInviteCodeListItem = {
  id: string;
  code_prefix: string;
  max_uses: number;
  uses_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type AdminInviteCodeCreateResponse = AdminInviteCodeListItem & {
  code: string;
};

export type AdminInviteCodeListResponse = {
  items: AdminInviteCodeListItem[];
  next_offset: number | null;
};

export type AdminInviteCodesListParams = {
  limit?: number;
  offset?: number;
};

export async function adminInvitesList(
  params: AdminInviteCodesListParams = {},
): Promise<AdminInviteCodeListResponse> {
  const q = new URLSearchParams();
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));

  const qs = q.toString();
  const path = qs ? `/api/v1/admin/invites?${qs}` : "/api/v1/admin/invites";
  const res = await apiRequestJson<Partial<AdminInviteCodeListResponse>>(path, { method: "GET" });
  return {
    items: Array.isArray(res.items) ? res.items : [],
    next_offset: typeof res.next_offset === "number" ? res.next_offset : null,
  };
}

export async function adminInvitesCreate(
  payload: AdminInviteCodeCreateRequest,
): Promise<AdminInviteCodeCreateResponse> {
  return apiRequestJson<AdminInviteCodeCreateResponse>("/api/v1/admin/invites", {
    method: "POST",
    body: payload,
  });
}

export async function adminInvitesRevoke(invite_id: string): Promise<AdminInviteCodeListItem> {
  const id = requireNonEmpty(invite_id, "invite_id");
  return apiRequestJson<AdminInviteCodeListItem>(`/api/v1/admin/invites/${encodeURIComponent(id)}:revoke`, {
    method: "POST",
  });
}

export type AdminInviteRedemptionListItem = {
  id: string;
  invite_id: string;
  user_id: string;
  user_email: string;
  used_at: string;
};

export type AdminInviteRedemptionListResponse = {
  items: AdminInviteRedemptionListItem[];
  next_offset: number | null;
};

export type AdminInviteRedemptionsListParams = {
  limit?: number;
  offset?: number;
};

export async function adminInvitesRedemptionsList(
  invite_id: string,
  params: AdminInviteRedemptionsListParams = {},
): Promise<AdminInviteRedemptionListResponse> {
  const id = requireNonEmpty(invite_id, "invite_id");
  const q = new URLSearchParams();
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));
  const qs = q.toString();
  const path = qs
    ? `/api/v1/admin/invites/${encodeURIComponent(id)}/redemptions?${qs}`
    : `/api/v1/admin/invites/${encodeURIComponent(id)}/redemptions`;
  const res = await apiRequestJson<Partial<AdminInviteRedemptionListResponse>>(path, { method: "GET" });
  return {
    items: Array.isArray(res.items) ? res.items : [],
    next_offset: typeof res.next_offset === "number" ? res.next_offset : null,
  };
}

export type AdminConfigJsonObject = Record<string, unknown>;

export async function adminConfigGetModels(): Promise<AdminConfigJsonObject> {
  return apiRequestJson<AdminConfigJsonObject>("/api/v1/admin/config/models", { method: "GET" });
}

export async function adminConfigPutModels(payloadObj: AdminConfigJsonObject): Promise<AdminConfigJsonObject> {
  return apiRequestJson<AdminConfigJsonObject>("/api/v1/admin/config/models", {
    method: "PUT",
    body: payloadObj,
  });
}

export async function adminConfigGetPrompts(): Promise<AdminConfigJsonObject> {
  return apiRequestJson<AdminConfigJsonObject>("/api/v1/admin/config/prompts", { method: "GET" });
}

export async function adminConfigPutPrompts(payloadObj: AdminConfigJsonObject): Promise<AdminConfigJsonObject> {
  return apiRequestJson<AdminConfigJsonObject>("/api/v1/admin/config/prompts", {
    method: "PUT",
    body: payloadObj,
  });
}

export type AdminAuditLogListItem = {
  id: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata: unknown | string;
  created_at: string;
};

export type AdminAuditLogListResponse = {
  items: AdminAuditLogListItem[];
  next_offset: number | null;
};

export type AdminAuditLogsListParams = {
  actor?: string;
  action?: string;
  target_type?: string;
  target_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
};

export async function adminAuditLogsList(
  params: AdminAuditLogsListParams = {},
): Promise<AdminAuditLogListResponse> {
  const q = new URLSearchParams();
  const actor = params.actor?.trim();
  const action = params.action?.trim();
  const targetType = params.target_type?.trim();
  const targetId = params.target_id?.trim();
  const since = params.since?.trim();
  const until = params.until?.trim();
  if (actor) q.set("actor", actor);
  if (action) q.set("action", action);
  if (targetType) q.set("target_type", targetType);
  if (targetId) q.set("target_id", targetId);
  if (since) q.set("since", since);
  if (until) q.set("until", until);

  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));

  const qs = q.toString();
  const path = qs
    ? `/api/v1/admin/config/audit_logs?${qs}`
    : "/api/v1/admin/config/audit_logs";

  const res = await apiRequestJson<Partial<AdminAuditLogListResponse>>(path, { method: "GET" });
  return {
    items: Array.isArray(res.items) ? res.items : [],
    next_offset: typeof res.next_offset === "number" ? res.next_offset : null,
  };
}

export type AdminMetricsSummary = {
  generated_at: string;
  audit_log_count_24h: number;
  admin_user_count: number;
  llm_chat_count_24h?: number;
  llm_chat_error_count_24h?: number;
  llm_chat_interrupted_count_24h?: number;
  [k: string]: unknown;
};

export async function adminMetricsGetSummary(): Promise<AdminMetricsSummary> {
  return apiRequestJson<AdminMetricsSummary>("/api/v1/admin/metrics/summary", { method: "GET" });
}

export type AdminReviewUgcResponse = {
  asset_id: string;
  status: string;
};

export type AdminReviewUgcQueueItem = {
  asset_id: string;
  asset_type: string;
  uploaded_by_user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
};

export type AdminReviewUgcQueueResponse = {
  items: AdminReviewUgcQueueItem[];
  next_offset: number | null;
};

export type AdminReviewUgcDetail = {
  asset_id: string;
  asset_type: string;
  uploaded_by_user_id: string;
  status: string;
  manifest_json: string;
  manifest: unknown | null;
  storage_path: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
};

export type AdminReviewPluginResponse = {
  id: string;
  version: string;
  status: string;
};

export type AdminReviewPluginQueueItem = {
  id: string;
  version: string;
  name: string;
  status: string;
  sha256: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
};

export type AdminReviewPluginQueueResponse = {
  items: AdminReviewPluginQueueItem[];
  next_offset: number | null;
};

export type AdminReviewPluginDetail = {
  id: string;
  version: string;
  name: string;
  entry: string;
  status: string;
  sha256: string;
  permissions: unknown | null;
  manifest_json: string;
  manifest: unknown | null;
  code: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
};

function requireNonEmpty(raw: string, fieldName: string): string {
  const v = raw.trim();
  if (!v) {
    throw new ApiError(`${fieldName} 不能为空`, { code: "BAD_REQUEST" });
  }
  return v;
}

export async function adminReviewUgcApprove(asset_id: string): Promise<AdminReviewUgcResponse> {
  const id = requireNonEmpty(asset_id, "asset_id");
  return apiRequestJson<AdminReviewUgcResponse>(`/api/v1/admin/review/ugc/${encodeURIComponent(id)}:approve`, {
    method: "POST",
  });
}

export async function adminReviewUgcReject(asset_id: string): Promise<AdminReviewUgcResponse> {
  const id = requireNonEmpty(asset_id, "asset_id");
  return apiRequestJson<AdminReviewUgcResponse>(`/api/v1/admin/review/ugc/${encodeURIComponent(id)}:reject`, {
    method: "POST",
  });
}

export type AdminReviewQueueListParams = {
  status?: string;
  limit?: number;
  offset?: number;
};

export async function adminReviewUgcQueueList(
  params: AdminReviewQueueListParams = {},
): Promise<AdminReviewUgcQueueResponse> {
  const q = new URLSearchParams();
  const status = params.status?.trim();
  if (status) q.set("status", status);
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));

  const qs = q.toString();
  const path = qs ? `/api/v1/admin/review/ugc?${qs}` : "/api/v1/admin/review/ugc";
  const res = await apiRequestJson<Partial<AdminReviewUgcQueueResponse>>(path, { method: "GET" });
  return {
    items: Array.isArray(res.items) ? res.items : [],
    next_offset: typeof res.next_offset === "number" ? res.next_offset : null,
  };
}

export async function adminReviewUgcDetail(asset_id: string): Promise<AdminReviewUgcDetail> {
  const id = requireNonEmpty(asset_id, "asset_id");
  return apiRequestJson<AdminReviewUgcDetail>(`/api/v1/admin/review/ugc/${encodeURIComponent(id)}`, { method: "GET" });
}

export async function adminReviewUgcSetNote(asset_id: string, note: string | null): Promise<AdminReviewUgcDetail> {
  const id = requireNonEmpty(asset_id, "asset_id");
  const body = { note };
  return apiRequestJson<AdminReviewUgcDetail>(`/api/v1/admin/review/ugc/${encodeURIComponent(id)}:note`, {
    method: "POST",
    body,
  });
}

export async function adminReviewPluginApprove(plugin_id: string, version: string): Promise<AdminReviewPluginResponse> {
  const id = requireNonEmpty(plugin_id, "plugin_id");
  const ver = requireNonEmpty(version, "version");
  return apiRequestJson<AdminReviewPluginResponse>(
    `/api/v1/admin/review/plugins/${encodeURIComponent(id)}/${encodeURIComponent(ver)}:approve`,
    {
      method: "POST",
    },
  );
}

export async function adminReviewPluginReject(plugin_id: string, version: string): Promise<AdminReviewPluginResponse> {
  const id = requireNonEmpty(plugin_id, "plugin_id");
  const ver = requireNonEmpty(version, "version");
  return apiRequestJson<AdminReviewPluginResponse>(
    `/api/v1/admin/review/plugins/${encodeURIComponent(id)}/${encodeURIComponent(ver)}:reject`,
    {
      method: "POST",
    },
  );
}

export async function adminReviewPluginsQueueList(
  params: AdminReviewQueueListParams = {},
): Promise<AdminReviewPluginQueueResponse> {
  const q = new URLSearchParams();
  const status = params.status?.trim();
  if (status) q.set("status", status);
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.offset !== undefined) q.set("offset", String(params.offset));

  const qs = q.toString();
  const path = qs ? `/api/v1/admin/review/plugins?${qs}` : "/api/v1/admin/review/plugins";
  const res = await apiRequestJson<Partial<AdminReviewPluginQueueResponse>>(path, { method: "GET" });
  return {
    items: Array.isArray(res.items) ? res.items : [],
    next_offset: typeof res.next_offset === "number" ? res.next_offset : null,
  };
}

export async function adminReviewPluginDetail(plugin_id: string, version: string): Promise<AdminReviewPluginDetail> {
  const id = requireNonEmpty(plugin_id, "plugin_id");
  const ver = requireNonEmpty(version, "version");
  return apiRequestJson<AdminReviewPluginDetail>(
    `/api/v1/admin/review/plugins/${encodeURIComponent(id)}/${encodeURIComponent(ver)}`,
    { method: "GET" },
  );
}

export async function adminReviewPluginSetNote(
  plugin_id: string,
  version: string,
  note: string | null,
): Promise<AdminReviewPluginDetail> {
  const id = requireNonEmpty(plugin_id, "plugin_id");
  const ver = requireNonEmpty(version, "version");
  const body = { note };
  return apiRequestJson<AdminReviewPluginDetail>(
    `/api/v1/admin/review/plugins/${encodeURIComponent(id)}/${encodeURIComponent(ver)}:note`,
    {
      method: "POST",
      body,
    },
  );
}

export type AdminLLMChannelPurpose = "chat" | "embedding";

export type AdminLLMChannel = {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  purpose: AdminLLMChannelPurpose;
  default_model: string;
  timeout_ms: number;
  weight: number;

  api_key_present: boolean;
  api_key_masked: string | null;

  created_at: string;
  updated_at: string;
};

export type AdminLLMChannelListResponse = {
  items: AdminLLMChannel[];
};

export type AdminLLMChannelCreatePayload = {
  name: string;
  base_url: string;
  enabled: boolean;
  purpose: AdminLLMChannelPurpose;
  default_model: string;
  timeout_ms: number;
  weight: number;
  api_key: string;
};

export type AdminLLMChannelUpdatePayload = Partial<Omit<AdminLLMChannelCreatePayload, "api_key">> & {
  api_key?: string;
};

export type AdminLLMConnectivityTestResponse = {
  ok: boolean;
  latency_ms: number | null;
  detail: string | null;
};

export async function adminLlmChannelsList(params: {
  purpose?: AdminLLMChannelPurpose;
  enabled?: boolean;
} = {}): Promise<AdminLLMChannelListResponse> {
  const q = new URLSearchParams();
  if (params.purpose) q.set("purpose", params.purpose);
  if (params.enabled !== undefined) q.set("enabled", String(params.enabled));
  const qs = q.toString();
  const path = qs ? `/api/v1/admin/llm/channels?${qs}` : "/api/v1/admin/llm/channels";
  const res = await apiRequestJson<Partial<AdminLLMChannelListResponse>>(path, { method: "GET" });
  return {
    items: Array.isArray(res.items) ? res.items : [],
  };
}

export async function adminLlmChannelsCreate(payload: AdminLLMChannelCreatePayload): Promise<AdminLLMChannel> {
  return apiRequestJson<AdminLLMChannel>("/api/v1/admin/llm/channels", { method: "POST", body: payload });
}

export async function adminLlmChannelsUpdate(
  channel_id: string,
  payload: AdminLLMChannelUpdatePayload,
): Promise<AdminLLMChannel> {
  const id = requireNonEmpty(channel_id, "channel_id");
  return apiRequestJson<AdminLLMChannel>(`/api/v1/admin/llm/channels/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: payload,
  });
}

export async function adminLlmChannelsDelete(channel_id: string): Promise<{ ok: boolean }> {
  const id = requireNonEmpty(channel_id, "channel_id");
  return apiRequestJson<{ ok: boolean }>(`/api/v1/admin/llm/channels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function adminLlmChannelsTest(channel_id: string): Promise<AdminLLMConnectivityTestResponse> {
  const id = requireNonEmpty(channel_id, "channel_id");
  const res = await apiRequestJson<Partial<AdminLLMConnectivityTestResponse>>(
    `/api/v1/admin/llm/channels/${encodeURIComponent(id)}:test`,
    { method: "POST" },
  );
  return {
    ok: Boolean(res.ok),
    latency_ms: typeof res.latency_ms === "number" ? res.latency_ms : null,
    detail: typeof res.detail === "string" ? res.detail : null,
  };
}

export type AdminLLMRoutingGlobal = {
  default_chat_channel_id: string | null;
  default_embedding_channel_id: string | null;
};

export async function adminLlmRoutingGet(): Promise<AdminLLMRoutingGlobal> {
  const res = await apiRequestJson<Partial<AdminLLMRoutingGlobal>>("/api/v1/admin/llm/routing", { method: "GET" });
  return {
    default_chat_channel_id: typeof res.default_chat_channel_id === "string" ? res.default_chat_channel_id : null,
    default_embedding_channel_id:
      typeof res.default_embedding_channel_id === "string" ? res.default_embedding_channel_id : null,
  };
}

export async function adminLlmRoutingPut(payload: AdminLLMRoutingGlobal): Promise<AdminLLMRoutingGlobal> {
  return apiRequestJson<AdminLLMRoutingGlobal>("/api/v1/admin/llm/routing", { method: "PUT", body: payload });
}
