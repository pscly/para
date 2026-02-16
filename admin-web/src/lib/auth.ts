export type AdminRole = "super_admin" | "operator" | (string & {});

export type AdminLoginResponse = {
  access_token: string;
  token_type: string;
  admin_user_id: string;
  role: AdminRole;
};

export type AdminSession = {
  accessToken: string;
  tokenType: string;
  adminUserId: string;
  role: AdminRole;
  issuedAtMs: number;
};

const STORAGE_KEY = "para_admin_session_v1";

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadAdminSession(): AdminSession | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = safeJsonParse<AdminSession>(raw);
  if (!parsed) {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
  if (!parsed.accessToken || !parsed.adminUserId || !parsed.role) {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return parsed;
}

export function saveAdminSessionFromLogin(resp: AdminLoginResponse): AdminSession {
  const session: AdminSession = {
    accessToken: resp.access_token,
    tokenType: resp.token_type ?? "bearer",
    adminUserId: resp.admin_user_id,
    role: resp.role,
    issuedAtMs: Date.now(),
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function clearAdminSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function getAdminAccessToken(): string | null {
  return loadAdminSession()?.accessToken ?? null;
}

export function isAdminAuthed(): boolean {
  return Boolean(getAdminAccessToken());
}
