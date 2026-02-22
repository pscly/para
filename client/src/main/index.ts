import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, session, shell, Tray } from 'electron';
import type { Event as ElectronEvent } from 'electron';
import { createUpdateManager, type UpdateManager, type UpdateState } from './updateManager';
import { getParaInstallerConfigPath, tryReadParaInstallerConfigSync, writeParaInstallerConfigAtomic } from './installerConfig';

const AUTH_TOKENS_FILENAME = 'auth.tokens.json';

const BYOK_CONFIG_FILENAME = 'byok.config.json';

const IPC_AUTH_SET_TOKENS = 'auth:setTokens';
const IPC_AUTH_GET_TOKENS = 'auth:getTokens';
const IPC_AUTH_CLEAR_TOKENS = 'auth:clearTokens';

const IPC_AUTH_LOGIN = 'auth:login';
const IPC_AUTH_REGISTER = 'auth:register';
const IPC_AUTH_ME = 'auth:me';
const IPC_AUTH_LOGOUT = 'auth:logout';

const IPC_BYOK_GET_CONFIG = 'byok:getConfig';
const IPC_BYOK_SET_CONFIG = 'byok:setConfig';
const IPC_BYOK_UPDATE_API_KEY = 'byok:updateApiKey';
const IPC_BYOK_CLEAR_API_KEY = 'byok:clearApiKey';
const IPC_BYOK_CHAT_SEND = 'byok:chatSend';
const IPC_BYOK_CHAT_ABORT = 'byok:chatAbort';

const IPC_WS_CONNECT = 'ws:connect';
const IPC_WS_DISCONNECT = 'ws:disconnect';
const IPC_WS_CHAT_SEND = 'ws:chatSend';
const IPC_WS_INTERRUPT = 'ws:interrupt';

const IPC_SAVES_LIST = 'saves:list';
const IPC_SAVES_CREATE = 'saves:create';
const IPC_SAVES_BIND_PERSONA = 'saves:bindPersona';

const IPC_PERSONAS_LIST = 'personas:list';

const IPC_KNOWLEDGE_UPLOAD_MATERIAL = 'knowledge:uploadMaterial';
const IPC_KNOWLEDGE_MATERIAL_STATUS = 'knowledge:materialStatus';

const IPC_VISION_UPLOAD_SCREENSHOT = 'vision:uploadScreenshot';

const IPC_GALLERY_GENERATE = 'gallery:generate';
const IPC_GALLERY_LIST = 'gallery:list';
const IPC_GALLERY_DOWNLOAD = 'gallery:download';

const IPC_TIMELINE_SIMULATE = 'timeline:simulate';
const IPC_TIMELINE_LIST = 'timeline:list';

const IPC_SOCIAL_CREATE_ROOM = 'social:createRoom';
const IPC_SOCIAL_INVITE = 'social:invite';
const IPC_SOCIAL_JOIN = 'social:join';

const IPC_UGC_LIST_APPROVED = 'ugc:listApproved';

const IPC_PLUGINS_GET_STATUS = 'plugins:getStatus';
const IPC_PLUGINS_SET_ENABLED = 'plugins:setEnabled';
const IPC_PLUGINS_LIST_APPROVED = 'plugins:listApproved';
const IPC_PLUGINS_INSTALL = 'plugins:install';
const IPC_PLUGINS_GET_MENU_ITEMS = 'plugins:getMenuItems';
const IPC_PLUGINS_MENU_CLICK = 'plugins:menuClick';
const IPC_PLUGINS_OUTPUT = 'plugins:output';

const IPC_ASSISTANT_SET_ENABLED = 'assistant:setEnabled';
const IPC_ASSISTANT_SET_IDLE_ENABLED = 'assistant:setIdleEnabled';
const IPC_ASSISTANT_WRITE_CLIPBOARD_TEXT = 'assistant:writeClipboardText';
const IPC_ASSISTANT_SUGGESTION = 'assistant:suggestion';

const IPC_UPDATE_GET_STATE = 'update:getState';
const IPC_UPDATE_CHECK = 'update:check';
const IPC_UPDATE_DOWNLOAD = 'update:download';
const IPC_UPDATE_INSTALL = 'update:install';
const IPC_UPDATE_STATE = 'update:state';

const IPC_WS_EVENT = 'ws:event';
const IPC_WS_STATUS = 'ws:status';

const IPC_USERDATA_GET_INFO = 'userdata:getInfo';
const IPC_USERDATA_PICK_DIR = 'userdata:pickDir';
const IPC_USERDATA_MIGRATE = 'userdata:migrate';
const IPC_APP_RELAUNCH = 'app:relaunch';

const IPC_SECURITY_APPENC_GET_STATUS = 'security:appEnc:getStatus';
const IPC_SECURITY_APPENC_SET_ENABLED = 'security:appEnc:setEnabled';

const IPC_SECURITY_DEVOPTIONS_GET_STATUS = 'security:devOptions:getStatus';
const IPC_SECURITY_DEVOPTIONS_SET_ENABLED = 'security:devOptions:setEnabled';

const DEFAULT_SERVER_BASE_URL = 'http://localhost:8000';

const PARA_EXTERNAL_OPEN_ORIGINS_ENV = 'PARA_EXTERNAL_OPEN_ORIGINS';
const PARA_EXTERNAL_OPEN_HOSTS_ENV = 'PARA_EXTERNAL_OPEN_HOSTS';

type UserDataDirSource = 'env' | 'config' | 'default';

let USERDATA_DIR_SOURCE: UserDataDirSource = 'default';

const paraUserDataDirOverride = process.env.PARA_USER_DATA_DIR;
const paraUserDataDirOverrideTrimmed = typeof paraUserDataDirOverride === 'string' ? paraUserDataDirOverride.trim() : '';
if (paraUserDataDirOverrideTrimmed !== '') {
  USERDATA_DIR_SOURCE = 'env';
  app.setPath('userData', paraUserDataDirOverrideTrimmed);
} else {
  const installerConfig = tryReadParaInstallerConfigSync(app.getPath('appData'));
  const configured = installerConfig?.userDataDir;
  if (typeof configured === 'string' && configured.trim() !== '' && path.isAbsolute(configured)) {
    USERDATA_DIR_SOURCE = 'config';
    app.setPath('userData', path.normalize(configured));
  }
}

function envFlagTruthy(name: string): boolean {
  const v = process.env[name];
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  if (s === '') return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function getUidOrNull(): number | null {
  try {
    const uid = (process as unknown as { getuid?: () => number }).getuid?.();
    return typeof uid === 'number' ? uid : null;
  } catch {
    return null;
  }
}

function shouldEnableSandbox(): boolean {
  if (envFlagTruthy('PARA_DISABLE_SANDBOX')) return false;
  if (envFlagTruthy('PARA_FORCE_SANDBOX')) return true;

  if (process.platform === 'linux') {
    const uid = getUidOrNull();
    if (uid === 0) return false;
  }

  return true;
}

const SANDBOX_ENABLED = shouldEnableSandbox();

if (process.env.NODE_ENV === 'test') {
  const uid = getUidOrNull();
  console.error(`[e2e][main] platform=${process.platform} uid=${uid ?? 'n/a'} sandbox=${SANDBOX_ENABLED}`);
}

if (!SANDBOX_ENABLED && process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');

  if (process.env.NODE_ENV === 'test') {
    console.error('[e2e][main] chromium switches: --no-sandbox --disable-setuid-sandbox');
  }
}

if (SANDBOX_ENABLED) {
  app.enableSandbox();
}

function parseCommaSeparatedEnv(name: string): string[] {
  const raw = process.env[name];
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function buildExternalOpenAllowlist(): { origins: Set<string>; hosts: Set<string> } {
  const origins = new Set<string>();
  const hosts = new Set<string>();

  for (const item of parseCommaSeparatedEnv(PARA_EXTERNAL_OPEN_ORIGINS_ENV)) {
    const u = tryParseUrl(item);
    if (!u) continue;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    origins.add(u.origin);
  }

  for (const item of parseCommaSeparatedEnv(PARA_EXTERNAL_OPEN_HOSTS_ENV)) {
    if (item.includes('://') || item.includes('/') || item.includes('?') || item.includes('#')) continue;
    const u = tryParseUrl(`https://${item}`);
    if (!u) continue;
    if (!u.hostname) continue;
    hosts.add(u.host);
  }

  return { origins, hosts };
}

const EXTERNAL_OPEN_ALLOWLIST = buildExternalOpenAllowlist();

function isSafeForExternalOpen(rawUrl: string): boolean {
  const u = tryParseUrl(rawUrl);
  if (!u) return false;

  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (EXTERNAL_OPEN_ALLOWLIST.origins.has(u.origin)) return true;
  if (EXTERNAL_OPEN_ALLOWLIST.hosts.has(u.host)) return true;
  return false;
}

function isFileUrlInsideRendererDist(rawUrl: string, rendererDir: string): boolean {
  const u = tryParseUrl(rawUrl);
  if (!u) return false;
  if (u.protocol !== 'file:') return false;

  const urlForPath = new URL(u.href);
  urlForPath.search = '';
  urlForPath.hash = '';

  let filePath: string;
  try {
    filePath = fileURLToPath(urlForPath);
  } catch {
    return false;
  }

  const rendererRoot = path.resolve(rendererDir);
  const target = path.resolve(filePath);
  const rel = path.relative(rendererRoot, target);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function isSafeForAppNavigation(rawUrl: string, devServerOrigin: string | null, rendererDir: string): boolean {
  const u = tryParseUrl(rawUrl);
  if (!u) return false;
  if (u.protocol === 'file:') return isFileUrlInsideRendererDist(rawUrl, rendererDir);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!devServerOrigin) return false;
  return u.origin === devServerOrigin;
}

type IpcEventLike = {
  senderFrame?: { url?: string | undefined } | null;
  sender: { getURL: () => string };
};

function getIpcAllowlistContext(): { devOrigin: string | null; rendererDir: string } {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const devOrigin = typeof devUrl === 'string' && devUrl.trim() !== '' ? tryParseUrl(devUrl)?.origin ?? null : null;
  const rendererDir = path.join(__dirname, '..', 'renderer');
  return { devOrigin, rendererDir };
}

function isTrustedIpcSenderUrl(rawUrl: string): boolean {
  const { devOrigin, rendererDir } = getIpcAllowlistContext();
  return isSafeForAppNavigation(rawUrl, devOrigin, rendererDir);
}

function assertTrustedIpcSender(event: IpcEventLike): void {
  const rawUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!isTrustedIpcSenderUrl(rawUrl)) {
    throw new Error('UNTRUSTED_IPC_SENDER');
  }
}

function handleTrustedIpc(channel: string, handler: (event: any, ...args: any[]) => any): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event as IpcEventLike);
    return handler(event, ...args);
  });
}

function setupDefaultDenyPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function applyNavigationAndExternalGuards(win: BrowserWindow): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const devOrigin = typeof devUrl === 'string' && devUrl.trim() !== '' ? tryParseUrl(devUrl)?.origin ?? null : null;
  const rendererDir = path.join(__dirname, '..', 'renderer');

  win.webContents.on('will-navigate', (event, url) => {
    if (!isSafeForAppNavigation(url, devOrigin, rendererDir)) {
      event.preventDefault();
    }
  });

  win.webContents.on('will-frame-navigate' as any, (event: ElectronEvent, url: string) => {
    if (!isSafeForAppNavigation(url, devOrigin, rendererDir)) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeForExternalOpen(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function attachWebContentsDiagnosticsForTest(win: BrowserWindow): void {
  if (process.env.NODE_ENV !== 'test') return;

  const prefix = `[e2e][webContents:${win.id}]`;

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const lvl = typeof level === 'number' ? level : -1;
    console.error(`${prefix}[console:${lvl}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`${prefix}[render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`);
  });

  win.webContents.on('preload-error' as any, (_event: unknown, preloadPath: string, error: Error) => {
    console.error(`${prefix}[preload-error] ${preloadPath}: ${error?.message || String(error)}`);
  });
}

type AuthTokensPayload = {
  accessToken: string;
  refreshToken: string;
};

type AuthLoginPayload = {
  email: string;
  password: string;
};

type AuthRegisterPayload = {
  email: string;
  password: string;
  inviteCode?: string;
};

type LoginResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
};

type AuthMeResponse = {
  user_id: string | number;
  email: string;
  debug_allowed: boolean;
};

type StoredAuthTokensFile = {
  secure: boolean;
  accessToken: string;
  refreshToken: string;
};

type KnowledgeUploadPayload = {
  // renderer 侧通过 File.arrayBuffer() 得到 bytes，避免依赖 Electron 的 file.path
  bytes: ArrayBuffer | Uint8Array;
  filename: string;
  mimeType?: string;
  saveId: string;
};

type KnowledgeMaterialStatus = 'pending' | 'indexed' | 'failed';

type KnowledgeMaterial = {
  id: string;
  status: KnowledgeMaterialStatus;
  error?: string;
};

type VisionPrivacyMode = 'strict' | 'standard';

type VisionUploadScreenshotPayload = {
  saveId: string;
  imageBase64: string;
  privacyMode: VisionPrivacyMode;
};

type VisionSuggestionResponse = {
  suggestion: string;
};

type AssistantSuggestionPayload = {
  suggestion: string;
  category: string;
};

type GalleryGeneratePayload = {
  saveId: string;
  prompt: string;
};

type GalleryGenerateResult = {
  id: string;
  status: string;
};

type GalleryListPayload = {
  saveId: string;
};

type GalleryDownloadKind = 'thumb' | 'image';

type GalleryDownloadPayload = {
  galleryId: string;
  kind: GalleryDownloadKind;
};

type GalleryItem = Record<string, unknown>;

type TimelineSimulatePayload = {
  saveId: string;
  eventType?: string;
  content?: string;
};

type TimelineSimulateResult = {
  taskId: string;
  timelineEventId?: string;
};

type TimelineEventItem = {
  id: string;
  saveId: string;
  eventType: string;
  content: string;
  createdAt: string;
};

type TimelineListPayload = {
  saveId: string;
  cursor?: string;
  limit?: number;
};

type TimelineListResult = {
  items: TimelineEventItem[];
  nextCursor: string;
};

type SocialCreateRoomPayload = {
  roomType?: string;
};

type SocialRoomCreateResult = {
  id: string;
  roomType: string;
  createdByUserId: string;
  createdAt: string;
};

type SocialInvitePayload = {
  roomId: string;
  targetUserId: string;
};

type SocialRoomInviteResult = {
  roomId: string;
  actorUserId: string;
  targetUserId: string;
  status: string;
};

type SocialJoinPayload = {
  roomId: string;
};

type SocialRoomJoinResult = {
  roomId: string;
  actorUserId: string;
  targetUserId: string;
  status: string;
};

type UgcApprovedAssetListItem = {
  id: string;
  asset_type: string;
};

type ApprovedPluginListItem = {
  id: string;
  version: string;
  name: string;
  sha256: string;
  permissions: unknown;
};

type PluginInstalledRef = {
  id: string;
  version: string;
  name?: string;
  sha256?: string;
  permissions?: unknown;
};

type PluginStateFile = {
  enabled: boolean;
  installed: PluginInstalledRef | null;
};

type PluginMenuItem = {
  pluginId: string;
  id: string;
  label: string;
};

type PluginStatus = {
  enabled: boolean;
  installed: PluginInstalledRef | null;
  running: boolean;
  menuItems: PluginMenuItem[];
  lastError: string | null;
};

type PluginDownloadBundle = {
  manifestJson: string;
  code: string;
  sha256: string;
};

type FeatureFlagsResponse = {
  generated_at?: string;
  feature_flags?: {
    plugins_enabled?: boolean;
    pluginsEnabled?: boolean;
  };
};

type PluginHostCmd =
  | {
      type: 'load';
      pluginId: string;
      version: string;
      entryPath: string;
      permissions: unknown;
    }
  | {
      type: 'menu:click';
      pluginId: string;
      id: string;
      requestId: string;
    }
  | { type: 'shutdown' };

const PLUGINS_DIRNAME = 'plugins';
const PLUGINS_STATE_FILENAME = 'state.json';
const PLUGINS_BUNDLES_DIRNAME = 'bundles';

const PLUGIN_SAY_MAX_CHARS = 200;
const PLUGIN_SUGGESTION_MAX_CHARS = 200;
const PLUGIN_MENU_ITEMS_MAX = 10;
const PLUGIN_MENU_LABEL_MAX_CHARS = 80;
const PLUGIN_MENU_ID_MAX_CHARS = 80;
const PLUGIN_MENU_CLICK_TIMEOUT_MS = 1200;
const PLUGIN_PENDING_MENU_CLICKS_MAX = 20;

function getAuthTokensFilePath(): string {
  return path.join(app.getPath('userData'), AUTH_TOKENS_FILENAME);
}

function getByokConfigFilePath(): string {
  return path.join(app.getPath('userData'), BYOK_CONFIG_FILENAME);
}

function getPluginsRootDir(): string {
  return path.join(app.getPath('userData'), PLUGINS_DIRNAME);
}

function getPluginsStateFilePath(): string {
  return path.join(getPluginsRootDir(), PLUGINS_STATE_FILENAME);
}

function normalizeAbsPathForCompare(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function isPathInside(childAbs: string, parentAbs: string): boolean {
  const rel = path.relative(parentAbs, childAbs);
  if (rel === '') return false;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

async function migrateUserDataDirTo(targetDirRaw: string): Promise<{ targetDir: string }> {
  try {
    const sourceDir = app.getPath('userData');
    const sourceAbs = path.resolve(sourceDir);
    const targetTrimmed = targetDirRaw.trim();
    if (!targetTrimmed) throw new Error('USERDATA_TARGET_EMPTY');
    if (!path.isAbsolute(targetTrimmed)) throw new Error('USERDATA_TARGET_NOT_ABSOLUTE');

    const targetAbs = path.resolve(targetTrimmed);

    const srcCmp = normalizeAbsPathForCompare(sourceAbs);
    const dstCmp = normalizeAbsPathForCompare(targetAbs);
    if (srcCmp === dstCmp) throw new Error('USERDATA_TARGET_SAME_AS_CURRENT');
    if (isPathInside(targetAbs, sourceAbs)) throw new Error('USERDATA_TARGET_INSIDE_CURRENT');

    const srcStat = await fs.stat(sourceAbs).catch(() => null);
    if (!srcStat || !srcStat.isDirectory()) throw new Error('USERDATA_SOURCE_NOT_DIR');

    const dstStat = await fs.stat(targetAbs).catch(() => null);
    if (dstStat && !dstStat.isDirectory()) throw new Error('USERDATA_TARGET_NOT_DIR');
    if (dstStat) {
      const items = await fs.readdir(targetAbs).catch(() => [] as string[]);
      if (items.length > 0) throw new Error('USERDATA_TARGET_NOT_EMPTY');
    }

    await fs.mkdir(path.dirname(targetAbs), { recursive: true });

    const tmpDir = path.join(
      path.dirname(targetAbs),
      `.para-userdata-migrate.${path.basename(targetAbs) || 'target'}.${process.pid}.${Date.now()}.tmp`
    );

    await fs.mkdir(tmpDir, { recursive: false });

    let renamed = false;
    try {
      const entries = await fs.readdir(sourceAbs, { withFileTypes: true });
      for (const ent of entries) {
        const name = ent.name;
        if (!name) continue;
        const srcPath = path.join(sourceAbs, name);
        const dstPath = path.join(tmpDir, name);
        await fs.cp(srcPath, dstPath, { recursive: true, errorOnExist: true, force: false });
      }

      const probe = path.join(tmpDir, `.para-write-probe.${process.pid}.${Date.now()}`);
      await fs.writeFile(probe, 'ok', { encoding: 'utf8' });
      await fs.unlink(probe);

      if (dstStat) {
        const items = await fs.readdir(targetAbs).catch(() => [] as string[]);
        if (items.length > 0) throw new Error('USERDATA_TARGET_NOT_EMPTY');
        await fs.rmdir(targetAbs);
      }

      await fs.rename(tmpDir, targetAbs);
      renamed = true;
    } finally {
      if (!renamed) {
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {
        }
      }
    }

    try {
      await writeParaInstallerConfigAtomic(app.getPath('appData'), {
        userDataDir: targetAbs,
        version: 1,
        source: 'in-app'
      });
    } catch {
      throw new Error('USERDATA_CONFIG_WRITE_FAILED');
    }

    return { targetDir: targetAbs };
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('USERDATA_')) throw err;
    const code = isObjectRecord(err) ? (err as { code?: unknown }).code : undefined;
    if (code === 'EACCES' || code === 'EPERM') throw new Error('USERDATA_TARGET_NOT_WRITABLE');
    throw new Error('USERDATA_MIGRATE_FAILED');
  }
}

function safePathSegment(raw: string): string {
  const s = raw.trim();
  if (s === '') return 'empty';
  // 只允许有限字符，避免路径穿越/奇怪字符导致的兼容性问题
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

function isPermissionsValue(value: unknown): boolean {
  // alpha：只要求 permissions 字段显式存在；空 {} / [] 代表 deny-all。
  if (Array.isArray(value)) return true;
  if (isObjectRecord(value)) return true;
  return false;
}

function parsePluginDownloadBundle(json: unknown): PluginDownloadBundle {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const rec = json as Record<string, unknown>;
  const manifestJson = typeof rec.manifest_json === 'string' ? rec.manifest_json : '';
  const code = typeof rec.code === 'string' ? rec.code : '';
  const sha256 = typeof rec.sha256 === 'string' ? rec.sha256 : '';
  if (!manifestJson || !code || !sha256) throw new Error('API_FAILED');
  return { manifestJson, code, sha256 };
}

function sha256HexUtf8(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function newPluginRequestId(): string {
  return `plg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAuthTokensPayload(value: unknown): value is AuthTokensPayload {
  if (!isObjectRecord(value)) return false;
  return typeof value.accessToken === 'string' && typeof value.refreshToken === 'string';
}

function isAuthLoginPayload(value: unknown): value is AuthLoginPayload {
  if (!isObjectRecord(value)) return false;
  return typeof value.email === 'string' && typeof value.password === 'string';
}

function isAuthRegisterPayload(value: unknown): value is AuthRegisterPayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.email !== 'string' || typeof rec.password !== 'string') return false;
  if (rec.inviteCode != null && typeof rec.inviteCode !== 'string') return false;
  return true;
}

function bytesToBuffer(bytes: unknown): Buffer | null {
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) {
    const view = bytes as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function isKnowledgeUploadPayload(value: unknown): value is KnowledgeUploadPayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  const buf = bytesToBuffer(rec.bytes);
  if (!buf) return false;
  return (
    typeof rec.filename === 'string' &&
    rec.filename.trim() !== '' &&
    (rec.mimeType == null || typeof rec.mimeType === 'string') &&
    typeof rec.saveId === 'string' &&
    rec.saveId.trim() !== ''
  );
}

function toKnowledgeStatus(raw: unknown): KnowledgeMaterialStatus {
  if (raw === 'pending' || raw === 'indexed' || raw === 'failed') return raw;
  return 'pending';
}

function parseKnowledgeMaterial(json: unknown): KnowledgeMaterial {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');

  const maybeWrapped = json as Record<string, unknown>;
  const material = isObjectRecord(maybeWrapped.material) ? (maybeWrapped.material as Record<string, unknown>) : maybeWrapped;

  const id = String(material.id ?? '').trim();
  if (!id) throw new Error('API_FAILED');

  const status = toKnowledgeStatus(material.status);
  const errorRaw = material.error;
  const error = typeof errorRaw === 'string' && errorRaw.trim() !== '' ? errorRaw : undefined;
  return { id, status, error };
}

function isVisionPrivacyMode(value: unknown): value is VisionPrivacyMode {
  return value === 'strict' || value === 'standard';
}

function isVisionUploadScreenshotPayload(value: unknown): value is VisionUploadScreenshotPayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.saveId === 'string' &&
    rec.saveId.trim() !== '' &&
    typeof rec.imageBase64 === 'string' &&
    rec.imageBase64.trim() !== '' &&
    isVisionPrivacyMode(rec.privacyMode)
  );
}

function parseVisionSuggestionResponse(json: unknown): VisionSuggestionResponse {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const suggestionRaw = (json as Record<string, unknown>).suggestion;
  if (typeof suggestionRaw !== 'string') throw new Error('API_FAILED');
  return { suggestion: suggestionRaw };
}

function isGalleryGeneratePayload(value: unknown): value is GalleryGeneratePayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.saveId === 'string' &&
    rec.saveId.trim() !== '' &&
    typeof rec.prompt === 'string' &&
    rec.prompt.trim() !== ''
  );
}

function isGalleryListPayload(value: unknown): value is GalleryListPayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.saveId === 'string' && rec.saveId.trim() !== '';
}

function isGalleryDownloadPayload(value: unknown): value is GalleryDownloadPayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  const kind = rec.kind;
  return (
    typeof rec.galleryId === 'string' &&
    rec.galleryId.trim() !== '' &&
    (kind === 'thumb' || kind === 'image')
  );
}

function isTimelineSimulatePayload(value: unknown): value is TimelineSimulatePayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.saveId !== 'string' || rec.saveId.trim() === '') return false;
  if (rec.eventType != null && typeof rec.eventType !== 'string') return false;
  if (rec.content != null && typeof rec.content !== 'string') return false;
  return true;
}

function isTimelineListPayload(value: unknown): value is TimelineListPayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.saveId !== 'string' || rec.saveId.trim() === '') return false;
  if (rec.cursor != null && typeof rec.cursor !== 'string') return false;
  if (rec.limit != null && typeof rec.limit !== 'number') return false;
  return true;
}

function parseTimelineListResult(json: unknown): TimelineListResult {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const rec = json as Record<string, unknown>;

  const rawItems = rec.items;
  if (!Array.isArray(rawItems)) throw new Error('API_FAILED');

  const nextCursorRaw =
    typeof rec.next_cursor === 'string'
      ? rec.next_cursor
      : typeof rec.nextCursor === 'string'
        ? rec.nextCursor
        : '';
  const nextCursorStr = String(nextCursorRaw || '0');

  const items: TimelineEventItem[] = rawItems
    .filter((it) => isObjectRecord(it))
    .map((it) => {
      const r = it as Record<string, unknown>;
      return {
        id: String(r.id ?? '').trim(),
        saveId: String(r.save_id ?? r.saveId ?? '').trim(),
        eventType: String(r.event_type ?? r.eventType ?? '').trim(),
        content: String(r.content ?? '').trim(),
        createdAt: String(r.created_at ?? r.createdAt ?? '').trim(),
      };
    })
    .filter((it) => it.id !== '' && it.saveId !== '' && it.eventType !== '' && it.content !== '' && it.createdAt !== '');

  return { items, nextCursor: nextCursorStr };
}

function parseTimelineSimulateResult(json: unknown): TimelineSimulateResult {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const rec = json as Record<string, unknown>;

  const taskIdRaw = rec.task_id ?? rec.taskId;
  const taskId = typeof taskIdRaw === 'string' ? taskIdRaw.trim() : '';
  if (!taskId) throw new Error('API_FAILED');

  const idRaw = rec.timeline_event_id ?? rec.timelineEventId;
  const timelineEventId = typeof idRaw === 'string' && idRaw.trim() !== '' ? idRaw.trim() : undefined;

  return { taskId, timelineEventId };
}

function isSocialCreateRoomPayload(value: unknown): value is SocialCreateRoomPayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  if (rec.roomType != null && typeof rec.roomType !== 'string') return false;
  return true;
}

function isSocialInvitePayload(value: unknown): value is SocialInvitePayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.roomId === 'string' &&
    rec.roomId.trim() !== '' &&
    typeof rec.targetUserId === 'string' &&
    rec.targetUserId.trim() !== ''
  );
}

function isSocialJoinPayload(value: unknown): value is SocialJoinPayload {
  if (!isObjectRecord(value)) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.roomId === 'string' && rec.roomId.trim() !== '';
}

function parseSocialRoomCreateResult(json: unknown): SocialRoomCreateResult {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const rec = json as Record<string, unknown>;

  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  const roomType = typeof rec.room_type === 'string' ? rec.room_type.trim() : '';
  const createdByUserId = typeof rec.created_by_user_id === 'string' ? rec.created_by_user_id.trim() : '';
  const createdAt = typeof rec.created_at === 'string' ? rec.created_at.trim() : '';

  if (!id || !roomType || !createdByUserId || !createdAt) throw new Error('API_FAILED');
  return { id, roomType, createdByUserId, createdAt };
}

function parseSocialRoomInviteResult(json: unknown): SocialRoomInviteResult {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const rec = json as Record<string, unknown>;

  const roomId = typeof rec.room_id === 'string' ? rec.room_id.trim() : '';
  const actorUserId = typeof rec.actor_user_id === 'string' ? rec.actor_user_id.trim() : '';
  const targetUserId = typeof rec.target_user_id === 'string' ? rec.target_user_id.trim() : '';
  const status = typeof rec.status === 'string' ? rec.status.trim() : '';

  if (!roomId || !actorUserId || !targetUserId || !status) throw new Error('API_FAILED');
  return { roomId, actorUserId, targetUserId, status };
}

function parseSocialRoomJoinResult(json: unknown): SocialRoomJoinResult {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const rec = json as Record<string, unknown>;

  const roomId = typeof rec.room_id === 'string' ? rec.room_id.trim() : '';
  const actorUserId = typeof rec.actor_user_id === 'string' ? rec.actor_user_id.trim() : '';
  const targetUserId = typeof rec.target_user_id === 'string' ? rec.target_user_id.trim() : '';
  const status = typeof rec.status === 'string' ? rec.status.trim() : '';

  if (!roomId || !actorUserId || !targetUserId || !status) throw new Error('API_FAILED');
  return { roomId, actorUserId, targetUserId, status };
}

function parseGalleryGenerateResponse(json: unknown): GalleryGenerateResult {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const rec = json as Record<string, unknown>;

  const galleryId = String(rec.gallery_id ?? '').trim();
  const statusRaw = rec.status;

  if (!galleryId) throw new Error('API_FAILED');
  if (typeof statusRaw !== 'string' || statusRaw.trim() === '') throw new Error('API_FAILED');

  return { id: galleryId, status: statusRaw };
}

function isSavesCreatePayload(value: unknown): value is SavesCreatePayload {
  if (!isObjectRecord(value)) return false;
  return typeof value.name === 'string';
}

function isSavesBindPersonaPayload(value: unknown): value is SavesBindPersonaPayload {
  if (!isObjectRecord(value)) return false;
  return typeof value.saveId === 'string' && typeof value.personaId === 'string';
}

function isLoginResponse(value: unknown): value is LoginResponse {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.access_token === 'string' &&
    typeof value.refresh_token === 'string' &&
    typeof value.token_type === 'string'
  );
}

function isAuthMeResponse(value: unknown): value is AuthMeResponse {
  if (!isObjectRecord(value)) return false;
  const userId = value.user_id;
  const debugAllowed = (value as { debug_allowed?: unknown }).debug_allowed;
  return (
    (typeof userId === 'string' || typeof userId === 'number') &&
    typeof value.email === 'string' &&
    typeof debugAllowed === 'boolean'
  );
}

function getServerBaseUrl(): string {
  const base = process.env.PARA_SERVER_BASE_URL;
  if (typeof base === 'string' && base.trim() !== '') return base;
  return DEFAULT_SERVER_BASE_URL;
}

type WsStatus = {
  status: 'connected' | 'reconnecting' | 'disconnected';
  saveId: string | null;
  lastSeq: number;
};

type WsConnectPayload = {
  saveId: string;
};

type WsChatSendPayload = {
  text: string;
  clientRequestId?: string;
};

type SavesCreatePayload = {
  name: string;
};

type SavesBindPersonaPayload = {
  saveId: string;
  personaId: string;
};

type WsFrameLike = {
  seq?: unknown;
  cursor?: unknown;
  server_event_id?: unknown;
  ack_required?: unknown;
  type?: unknown;
  payload?: unknown;
};

type WsLike = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
};

type WsConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WsLike;

type WsEventListener = (event: unknown) => void;

function isWsLike(maybe: unknown): maybe is WsLike {
  if (!maybe || typeof maybe !== 'object') return false;
  const obj = maybe as Record<string, unknown>;
  return (
    typeof obj.readyState === 'number' &&
    typeof obj.send === 'function' &&
    typeof obj.close === 'function' &&
    typeof obj.addEventListener === 'function' &&
    typeof obj.removeEventListener === 'function'
  );
}

function wrapEventEmitterWs(maybe: unknown): WsLike | null {
  if (!maybe || typeof maybe !== 'object') return null;
  const ws = maybe as {
    readyState?: unknown;
    send?: unknown;
    close?: unknown;
    on?: unknown;
    off?: unknown;
    removeListener?: unknown;
  };
  if (typeof ws.send !== 'function' || typeof ws.close !== 'function') return null;
  if (typeof ws.on !== 'function') return null;

  const listenerMap = new Map<string, Map<WsEventListener, (...args: unknown[]) => void>>();

  const getWrapped = (type: string, listener: WsEventListener): ((...args: unknown[]) => void) => {
    let typeMap = listenerMap.get(type);
    if (!typeMap) {
      typeMap = new Map();
      listenerMap.set(type, typeMap);
    }
    const existing = typeMap.get(listener);
    if (existing) return existing;

    const wrapped = (...args: unknown[]) => {
      if (type === 'message') {
        listener({ data: args[0] });
        return;
      }
      listener({});
    };

    typeMap.set(listener, wrapped);
    return wrapped;
  };

  const addEventListener = (type: string, listener: WsEventListener) => {
    const wrapped = getWrapped(type, listener);
    (ws.on as (...args: unknown[]) => unknown)(type, wrapped);
  };

  const removeEventListener = (type: string, listener: WsEventListener) => {
    const typeMap = listenerMap.get(type);
    const wrapped = typeMap?.get(listener);
    if (!wrapped) return;

    if (typeof ws.off === 'function') {
      (ws.off as (...args: unknown[]) => unknown)(type, wrapped);
    } else if (typeof ws.removeListener === 'function') {
      (ws.removeListener as (...args: unknown[]) => unknown)(type, wrapped);
    }
    typeMap?.delete(listener);
  };

  return {
    get readyState() {
      return typeof ws.readyState === 'number' ? ws.readyState : 0;
    },
    send: (data: string) => (ws.send as (data: string) => void)(data),
    close: (code?: number, reason?: string) => (ws.close as (code?: number, reason?: string) => void)(code, reason),
    addEventListener,
    removeEventListener
  };
}

function installWebSocketGlobalIfNeeded(): void {
  const g = globalThis as unknown as { WebSocket?: unknown };
  if (typeof g.WebSocket === 'function') return;

  try {
    const wsPkg: unknown = require('ws');
    const WsImpl = (wsPkg as { WebSocket?: unknown; default?: unknown }).WebSocket ?? (wsPkg as { default?: unknown }).default ?? wsPkg;
    if (typeof WsImpl !== 'function') return;

    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = function WebSocket(
      url: string,
      options?: { headers?: Record<string, string> }
    ) {
      const raw = new (WsImpl as new (url: string, options?: unknown) => unknown)(url, options);
      const like = isWsLike(raw) ? raw : wrapEventEmitterWs(raw);
      if (!like) throw new Error('WEBSOCKET_INCOMPATIBLE');
      return like;
    } as unknown;
  } catch {
  }
}

installWebSocketGlobalIfNeeded();

function toWsBaseUrl(httpBaseUrl: string): string {
  const trimmed = httpBaseUrl.trim();
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
  throw new Error('INVALID_SERVER_BASE_URL');
}

function wsMessageDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return '';
}

function getLastSeqFromFrame(frame: unknown): number | null {
  if (!isObjectRecord(frame)) return null;
  const f = frame as WsFrameLike;
  if (f.server_event_id == null) return null;
  if (typeof f.seq !== 'number') return null;
  return f.seq;
}

function shouldAckFrame(frame: unknown): boolean {
  if (!isObjectRecord(frame)) return false;
  const f = frame as WsFrameLike;
  return f.server_event_id != null && typeof f.seq === 'number' && f.seq >= 1 && f.ack_required === true;
}

let mainWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let petInteractive = false;
let updateManager: UpdateManager | null = null;

function safeSendToRenderer(channel: string, payload: unknown): void {
  const preferred = mainWindow;
  const win =
    preferred && !preferred.isDestroyed()
      ? preferred
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return;
  if (win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
  }
}

function safeSendToAllRenderers(channel: string, payload: unknown): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed());
  for (const win of wins) {
    try {
      win.webContents.send(channel, payload);
    } catch {
    }
  }
}

class WsV1Client {
  private ws: WsLike | null = null;
  private shouldReconnect = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private saveId: string | null = null;
  private lastReceivedSeq = 0;
  private connecting = false;
  private pendingConnect = false;
  private statusDebounceTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  private emitStatus(status: WsStatus['status']): void {
    safeSendToRenderer(IPC_WS_STATUS, {
      status,
      saveId: this.saveId,
      lastSeq: this.lastReceivedSeq
    } satisfies WsStatus);
  }

  private emitStatusDebounced(): void {
    if (this.statusDebounceTimer) return;
    this.statusDebounceTimer = setTimeout(() => {
      this.statusDebounceTimer = null;
      this.emitStatus(this.getStatus().status);
    }, 200);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startPingTimer(): void {
    if (this.pingTimer) return;
    const intervalMs = 25_000;
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ type: 'PING', payload: { ts: Date.now() } }));
      } catch {
      }
    }, intervalMs);
  }

  private clearStatusDebounceTimer(): void {
    if (this.statusDebounceTimer) {
      clearTimeout(this.statusDebounceTimer);
      this.statusDebounceTimer = null;
    }
  }

  private cleanupSocket(): void {
    this.clearPingTimer();
    if (!this.ws) return;
    try {
      this.ws.close(1000, 'client_cleanup');
    } catch {
    }
    this.ws = null;
  }

  getStatus(): WsStatus {
    const readyState = this.ws?.readyState;
    const status: WsStatus['status'] = readyState === 1 ? 'connected' : this.shouldReconnect ? 'reconnecting' : 'disconnected';
    return { status, saveId: this.saveId, lastSeq: this.lastReceivedSeq };
  }

  async connect(payload: WsConnectPayload): Promise<WsStatus> {
    if (!isObjectRecord(payload) || typeof payload.saveId !== 'string' || payload.saveId.trim() === '') {
      throw new Error('INVALID_PAYLOAD');
    }

    const nextSaveId = payload.saveId.trim();

    if (this.saveId !== nextSaveId) {
      this.lastReceivedSeq = 0;
    }

    this.saveId = nextSaveId;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;
    this.pendingConnect = true;

    this.emitStatus('reconnecting');
    await this.connectOnce();
    return this.getStatus();
  }

  disconnect(): WsStatus {
    this.shouldReconnect = false;
    this.connecting = false;
    this.pendingConnect = false;
    this.clearReconnectTimer();
    this.clearStatusDebounceTimer();
    this.cleanupSocket();
    this.emitStatus('disconnected');
    return this.getStatus();
  }

  chatSend(payload: WsChatSendPayload): void {
    if (!isObjectRecord(payload) || typeof payload.text !== 'string') {
      throw new Error('INVALID_PAYLOAD');
    }
    const text = payload.text;
    if (text.trim() === '') return;
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('WS_NOT_CONNECTED');
    }

    const frame = {
      type: 'CHAT_SEND',
      payload: {
        text
      },
      ...(typeof payload.clientRequestId === 'string' && payload.clientRequestId.trim() !== ''
        ? { client_request_id: payload.clientRequestId }
        : {})
    };

    // 注意：不要在日志中输出 text
    this.ws.send(JSON.stringify(frame));
  }

  interrupt(): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('WS_NOT_CONNECTED');
    }
    this.ws.send(JSON.stringify({ type: 'INTERRUPT' }));
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempt += 1;
    const baseDelayMs = 250;
    const maxDelayMs = 5000;
    const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(this.reconnectAttempt, 8));

    this.pendingConnect = true;
    this.emitStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectOnce();
    }, delayMs);
  }

  private async connectOnce(): Promise<void> {
    if (!this.shouldReconnect) return;
    if (this.connecting) {
      this.pendingConnect = true;
      return;
    }
    if (!this.saveId) throw new Error('MISSING_SAVE_ID');
    if (!this.pendingConnect) return;

    if (this.ws && this.ws.readyState === 1) {
      this.pendingConnect = false;
      this.emitStatus('connected');
      return;
    }

    this.connecting = true;
    this.pendingConnect = false;
    this.clearReconnectTimer();
    this.cleanupSocket();

    const tokens = await readAuthTokensFromDisk();
    if (!this.shouldReconnect) {
      this.connecting = false;
      return;
    }
    if (!tokens) {
      this.connecting = false;
      this.shouldReconnect = false;
      this.emitStatus('disconnected');
      throw new Error('NOT_LOGGED_IN');
    }

    const wsBaseUrl = toWsBaseUrl(getServerBaseUrl());
    const url = new URL('/ws/v1', wsBaseUrl);
    url.searchParams.set('save_id', this.saveId);
    url.searchParams.set('resume_from', String(this.lastReceivedSeq));

    const globalWSImpl: WsConstructor | undefined = (() => {
      const maybe = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
      if (typeof maybe !== 'function') return undefined;
      return maybe as unknown as WsConstructor;
    })();

    const wsUrl = url.toString();
    const wsOptions = {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`
      }
    };

    let ws: WsLike | null = null;
    let connectErr: unknown = null;
    let hasAnyImpl = Boolean(globalWSImpl);

    const tryConstruct = (Ctor: WsConstructor): WsLike => {
      return new Ctor(wsUrl, wsOptions);
    };

    if (globalWSImpl) {
      try {
        ws = tryConstruct(globalWSImpl);
      } catch (err) {
        connectErr = err;
      }
    }

    if (!ws) {
      let undiciWSImpl: WsConstructor | undefined;
      try {
        const undici: unknown = await import('undici' as string);
        const maybe = (undici as { WebSocket?: unknown }).WebSocket;
        if (typeof maybe === 'function') {
          undiciWSImpl = maybe as unknown as WsConstructor;
        }
      } catch (err) {
        if (connectErr == null) connectErr = err;
      }

      if (undiciWSImpl) {
        hasAnyImpl = true;
        try {
          ws = tryConstruct(undiciWSImpl);
        } catch (err) {
          if (connectErr == null) connectErr = err;
        }
      }
    }

    if (!ws) {
      let wsPkgImpl: unknown;
      try {
        const wsPkg: unknown = await import('ws' as string);
        wsPkgImpl = (wsPkg as { WebSocket?: unknown; default?: unknown }).WebSocket ?? (wsPkg as { default?: unknown }).default ?? wsPkg;
      } catch (err) {
        if (connectErr == null) connectErr = err;
      }

      if (typeof wsPkgImpl === 'function') {
        hasAnyImpl = true;
        try {
          const raw = new (wsPkgImpl as new (url: string, options?: unknown) => unknown)(wsUrl, wsOptions);
          ws = isWsLike(raw) ? raw : wrapEventEmitterWs(raw);
          if (!ws) throw new Error('WEBSOCKET_INCOMPATIBLE');
        } catch (err) {
          if (connectErr == null) connectErr = err;
        }
      }
    }

    if (!ws) {
      this.connecting = false;
      this.ws = null;

      if (!hasAnyImpl) {
        this.shouldReconnect = false;
        this.emitStatus('disconnected');
        throw new Error('WEBSOCKET_UNAVAILABLE');
      }

      this.emitStatus('disconnected');

      // 风险说明：query token 会出现在 URL（可能进入日志/代理/崩溃上报），且当前服务端不支持 query token。
      // 如果未来确实需要兼容旧 Node/WebSocket 实现，请在服务端明确支持后再启用该 fallback。
      // const fallbackUrl = new URL(url.toString());
      // fallbackUrl.searchParams.set('access_token', tokens.accessToken);
      // ws = new WSImpl(fallbackUrl.toString());

      throw connectErr instanceof Error ? connectErr : new Error('WS_CONNECT_FAILED');
    }

    this.ws = ws;

    const onOpen = () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.emitStatus('connected');
      this.startPingTimer();

      if (this.pendingConnect && this.shouldReconnect) {
        void this.connectOnce();
      }
    };

    const onMessage = (event: unknown) => {
      const data = isObjectRecord(event) ? (event as { data?: unknown }).data : undefined;
      const text = wsMessageDataToString(data);
      if (!text) return;

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return;
      }

      const maybeLastSeq = getLastSeqFromFrame(parsed);
      if (typeof maybeLastSeq === 'number' && maybeLastSeq > this.lastReceivedSeq) {
        this.lastReceivedSeq = maybeLastSeq;
        this.emitStatusDebounced();
      }

      safeSendToRenderer(IPC_WS_EVENT, parsed);

      if (shouldAckFrame(parsed) && this.ws && this.ws.readyState === 1) {
        try {
          this.ws.send(JSON.stringify({ type: 'ACK', cursor: this.lastReceivedSeq }));
        } catch {
        }
      }
    };

    const onError = () => {};

    const onClose = () => {
      this.connecting = false;
      this.ws = null;
      this.clearPingTimer();
      if (!this.shouldReconnect) {
        this.emitStatus('disconnected');
        return;
      }
      this.scheduleReconnect();

      if (this.pendingConnect && this.shouldReconnect) {
        void this.connectOnce();
      }
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  }
}

const wsClient = new WsV1Client();

function buildApiUrl(baseUrl: string, apiPath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const pathname = apiPath.startsWith('/') ? apiPath.slice(1) : apiPath;
  return new URL(pathname, base).toString();
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parsePluginsEnabledFromFeatureFlagsResponse(json: unknown): boolean | null {
  if (!isObjectRecord(json)) return null;
  const rec = json as FeatureFlagsResponse;
  const flags = rec.feature_flags;
  if (!isObjectRecord(flags)) return null;
  const enabled = (flags as Record<string, unknown>).plugins_enabled ?? (flags as Record<string, unknown>).pluginsEnabled;
  if (typeof enabled !== 'boolean') return null;
  return enabled;
}

async function fetchPluginsEnabledFeatureFlag(): Promise<boolean | null> {
  if (typeof (globalThis as unknown as { fetch?: unknown }).fetch !== 'function') {
    return null;
  }

  const baseUrl = getServerBaseUrl();

  let resp: Response;
  try {
    resp = await fetch(buildApiUrl(baseUrl, '/api/v1/feature_flags'), { method: 'GET' });
  } catch {
    return null;
  }

  if (!resp.ok) return null;
  const json = await readJsonResponse(resp);
  return parsePluginsEnabledFromFeatureFlagsResponse(json);
}

async function loginAndGetMe(email: string, password: string): Promise<AuthMeResponse> {
  if (typeof (globalThis as unknown as { fetch?: unknown }).fetch !== 'function') {
    throw new Error('FETCH_UNAVAILABLE');
  }

  const baseUrl = getServerBaseUrl();

  const { response: loginResp, json: loginJson } = await fetchJson('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  if (loginResp.status === 401) {
    throw new Error('BAD_CREDENTIALS');
  }
  if (!loginResp.ok) {
    throw new Error('AUTH_LOGIN_FAILED');
  }

  if (!isLoginResponse(loginJson)) {
    throw new Error('AUTH_LOGIN_FAILED');
  }

  await writeAuthTokensToDisk({
    accessToken: loginJson.access_token,
    refreshToken: loginJson.refresh_token
  });

  let meResp: Response;
  try {
    meResp = await fetch(buildApiUrl(baseUrl, '/api/v1/auth/me'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${loginJson.access_token}`
      }
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (meResp.status === 401) {
    await clearAuthTokensOnDisk();
    throw new Error('UNAUTHORIZED');
  }
  if (!meResp.ok) {
    await clearAuthTokensOnDisk();
    throw new Error('AUTH_ME_FAILED');
  }

  const meJson = await readJsonResponse(meResp);
  if (!isAuthMeResponse(meJson)) {
    await clearAuthTokensOnDisk();
    throw new Error('AUTH_ME_FAILED');
  }

  return meJson;
}

async function registerAndGetMe(email: string, password: string, inviteCode?: string): Promise<AuthMeResponse> {
  if (typeof (globalThis as unknown as { fetch?: unknown }).fetch !== 'function') {
    throw new Error('FETCH_UNAVAILABLE');
  }

  const baseUrl = getServerBaseUrl();

  const body: Record<string, unknown> = { email, password };
  const trimmedInvite = typeof inviteCode === 'string' ? inviteCode.trim() : '';
  if (trimmedInvite !== '') {
    body.invite_code = trimmedInvite;
  }

  const { response: registerResp, json: registerJson } = await fetchJson('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!registerResp.ok) {
    const detail = isObjectRecord(registerJson)
      ? (registerJson as Record<string, unknown>).detail
      : null;
    if (typeof detail === 'string' && detail.trim() !== '') {
      throw new Error(detail);
    }
    throw new Error('AUTH_REGISTER_FAILED');
  }

  if (!isLoginResponse(registerJson)) {
    throw new Error('AUTH_REGISTER_FAILED');
  }

  await writeAuthTokensToDisk({
    accessToken: registerJson.access_token,
    refreshToken: registerJson.refresh_token
  });

  let meResp: Response;
  try {
    meResp = await fetch(buildApiUrl(baseUrl, '/api/v1/auth/me'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${registerJson.access_token}`
      }
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (meResp.status === 401) {
    await clearAuthTokensOnDisk();
    throw new Error('UNAUTHORIZED');
  }
  if (!meResp.ok) {
    await clearAuthTokensOnDisk();
    throw new Error('AUTH_ME_FAILED');
  }

  const meJson = await readJsonResponse(meResp);
  if (!isAuthMeResponse(meJson)) {
    await clearAuthTokensOnDisk();
    throw new Error('AUTH_ME_FAILED');
  }

  return meJson;
}

async function readMeFromDiskToken(): Promise<AuthMeResponse> {
  if (typeof (globalThis as unknown as { fetch?: unknown }).fetch !== 'function') {
    throw new Error('FETCH_UNAVAILABLE');
  }

  const tokens = await readAuthTokensFromDisk();
  if (!tokens) {
    throw new Error('NOT_LOGGED_IN');
  }

  const baseUrl = getServerBaseUrl();

  let meResp: Response;
  try {
    meResp = await fetch(buildApiUrl(baseUrl, '/api/v1/auth/me'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`
      }
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (meResp.status === 401) {
    await clearAuthTokensOnDisk();
    throw new Error('NOT_LOGGED_IN');
  }
  if (!meResp.ok) {
    throw new Error('AUTH_ME_FAILED');
  }

  const meJson = await readJsonResponse(meResp);
  if (!isAuthMeResponse(meJson)) {
    throw new Error('AUTH_ME_FAILED');
  }

  return meJson;
}

async function requireAccessTokenFromDisk(): Promise<string> {
  const tokens = await readAuthTokensFromDisk();
  if (!tokens || tokens.accessToken.trim() === '') {
    throw new Error('NOT_LOGGED_IN');
  }
  return tokens.accessToken;
}

type AppEncConfig = {
  enabled: boolean;
  primaryKid: string;
  keys: Map<string, Buffer>;
};

type AppEncStatus = {
  desiredEnabled: boolean;
  effectiveEnabled: boolean;
  error: string | null;
};

type DevOptionsStatus = {
  desiredEnabled: boolean;
  effectiveEnabled: boolean;
  error: string | null;
};

type ParaSecurityConfigFile = {
  version: 1;
  appEncEnabled?: boolean;
  developerOptionsEnabled?: boolean;
};

function getParaSecurityConfigPath(appDataDir: string): string {
  return path.join(appDataDir, 'Para Desktop', 'para.security.json');
}

async function tryReadParaSecurityConfig(appDataDir: string): Promise<ParaSecurityConfigFile | null> {
  const p = getParaSecurityConfigPath(appDataDir);
  try {
    const raw = await fs.readFile(p, { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as { version?: unknown; appEncEnabled?: unknown; developerOptionsEnabled?: unknown };
    const version = rec.version;
    if (version !== 1) return null;
    return {
      version: 1,
      appEncEnabled: typeof rec.appEncEnabled === 'boolean' ? rec.appEncEnabled : undefined,
      developerOptionsEnabled:
        typeof rec.developerOptionsEnabled === 'boolean' ? rec.developerOptionsEnabled : undefined
    };
  } catch {
    return null;
  }
}

async function writeParaSecurityConfigAtomic(appDataDir: string, cfg: ParaSecurityConfigFile): Promise<void> {
  const configPath = getParaSecurityConfigPath(appDataDir);
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });

  // 注意：同一个配置文件承载多个开关，写入时需要 merge，避免某个开关持久化时把其它开关覆盖为 false。
  let existing: ParaSecurityConfigFile | null = null;
  try {
    existing = await tryReadParaSecurityConfig(appDataDir);
  } catch {
    existing = null;
  }

  const merged: ParaSecurityConfigFile = {
    version: 1,
    appEncEnabled: typeof cfg.appEncEnabled === 'boolean' ? cfg.appEncEnabled : existing?.appEncEnabled,
    developerOptionsEnabled:
      typeof cfg.developerOptionsEnabled === 'boolean'
        ? cfg.developerOptionsEnabled
        : existing?.developerOptionsEnabled
  };

  const payload: ParaSecurityConfigFile = {
    version: 1,
    appEncEnabled: Boolean(merged.appEncEnabled),
    developerOptionsEnabled: Boolean(merged.developerOptionsEnabled)
  };

  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  await fs.rename(tmp, configPath);
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(raw: string): Buffer {
  const s = raw.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s + pad, 'base64');
}

function parseAppEncKeys(raw: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const item of parts) {
    const idx = item.indexOf(':');
    if (idx <= 0) throw new Error('APPENC_MISCONFIG');
    const kid = item.slice(0, idx).trim();
    const keyRaw = item.slice(idx + 1).trim();
    if (!kid || !keyRaw) throw new Error('APPENC_MISCONFIG');
    const key = base64UrlDecode(keyRaw);
    if (key.length !== 32) throw new Error('APPENC_MISCONFIG');
    out.set(kid, key);
  }
  return out;
}

let APP_ENC_DESIRED_ENABLED = false;

let APP_ENC_CONFIG: AppEncConfig = { enabled: false, primaryKid: '', keys: new Map() };
let APP_ENC_STATUS: AppEncStatus = { desiredEnabled: false, effectiveEnabled: false, error: null };

let DEV_OPTIONS_DESIRED_ENABLED = false;
let DEV_OPTIONS_STATUS: DevOptionsStatus = { desiredEnabled: false, effectiveEnabled: false, error: null };

function setAppEncDisabledWithError(error: string | null): void {
  APP_ENC_CONFIG = { enabled: false, primaryKid: '', keys: new Map() };
  APP_ENC_STATUS = { desiredEnabled: false, effectiveEnabled: false, error };
}

async function initAppEncToggleFromDisk(): Promise<void> {
  const appDataDir = app.getPath('appData');
  let cfg: ParaSecurityConfigFile | null = null;
  try {
    cfg = await tryReadParaSecurityConfig(appDataDir);
  } catch {
    cfg = null;
  }
  APP_ENC_DESIRED_ENABLED = Boolean(cfg?.appEncEnabled);
  recomputeAppEncFromEnvAndToggle();

  if (APP_ENC_STATUS.desiredEnabled && !APP_ENC_STATUS.effectiveEnabled && APP_ENC_STATUS.error) {
    const misconfig = APP_ENC_STATUS.error;
    APP_ENC_DESIRED_ENABLED = false;
    setAppEncDisabledWithError(misconfig);
    try {
      await writeParaSecurityConfigAtomic(appDataDir, { version: 1, appEncEnabled: false });
    } catch {
    }
  }
}

async function initDevOptionsToggleFromDisk(): Promise<void> {
  const appDataDir = app.getPath('appData');
  let cfg: ParaSecurityConfigFile | null = null;
  try {
    cfg = await tryReadParaSecurityConfig(appDataDir);
  } catch {
    cfg = null;
  }
  DEV_OPTIONS_DESIRED_ENABLED = Boolean(cfg?.developerOptionsEnabled);
  // effective 依赖登录态 + 服务器返回 debug_allowed；这里不做网络请求，首次查询 status 时再计算。
  DEV_OPTIONS_STATUS = {
    desiredEnabled: DEV_OPTIONS_DESIRED_ENABLED,
    effectiveEnabled: !app.isPackaged ? DEV_OPTIONS_DESIRED_ENABLED : false,
    error: null
  };
}

function getAppEncStatusForRenderer(): AppEncStatus & { configPath: string } {
  const appDataDir = app.getPath('appData');
  return {
    ...APP_ENC_STATUS,
    configPath: getParaSecurityConfigPath(appDataDir)
  };
}

async function computeDevOptionsStatus(): Promise<DevOptionsStatus> {
  const desiredEnabled = Boolean(DEV_OPTIONS_DESIRED_ENABLED);
  if (!desiredEnabled) {
    return { desiredEnabled: false, effectiveEnabled: false, error: null };
  }

  // dev/test：不做任何网络校验，直接按用户期望生效。
  if (!app.isPackaged) {
    return { desiredEnabled: true, effectiveEnabled: true, error: null };
  }

  // production：fail-closed，必须 logged_in 且 debug_allowed。
  let me: AuthMeResponse;
  try {
    me = await readMeFromDiskToken();
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : 'AUTH_ME_FAILED';
    if (
      code === 'NOT_LOGGED_IN' ||
      code === 'UNAUTHORIZED' ||
      code === 'NETWORK_ERROR' ||
      code === 'AUTH_ME_FAILED'
    ) {
      return { desiredEnabled: true, effectiveEnabled: false, error: code };
    }
    return { desiredEnabled: true, effectiveEnabled: false, error: 'AUTH_ME_FAILED' };
  }

  const debugAllowed = me.debug_allowed;
  if (!debugAllowed) {
    return { desiredEnabled: true, effectiveEnabled: false, error: 'DEBUG_NOT_ALLOWED' };
  }

  return { desiredEnabled: true, effectiveEnabled: true, error: null };
}

async function getDevOptionsStatusForRenderer(): Promise<DevOptionsStatus & { configPath: string }> {
  const appDataDir = app.getPath('appData');
  DEV_OPTIONS_STATUS = await computeDevOptionsStatus();
  return {
    ...DEV_OPTIONS_STATUS,
    configPath: getParaSecurityConfigPath(appDataDir)
  };
}

async function setDevOptionsDesiredEnabledAndPersist(
  enabled: boolean
): Promise<DevOptionsStatus & { configPath: string }> {
  const prev = Boolean(DEV_OPTIONS_DESIRED_ENABLED);
  DEV_OPTIONS_DESIRED_ENABLED = Boolean(enabled);

  const appDataDir = app.getPath('appData');
  try {
    await writeParaSecurityConfigAtomic(appDataDir, { version: 1, developerOptionsEnabled: DEV_OPTIONS_DESIRED_ENABLED });
  } catch {
    DEV_OPTIONS_DESIRED_ENABLED = prev;
    DEV_OPTIONS_STATUS = {
      desiredEnabled: DEV_OPTIONS_DESIRED_ENABLED,
      effectiveEnabled: !app.isPackaged ? DEV_OPTIONS_DESIRED_ENABLED : false,
      error: 'DEVOPTIONS_TOGGLE_PERSIST_FAILED'
    };
    return {
      ...DEV_OPTIONS_STATUS,
      configPath: getParaSecurityConfigPath(appDataDir)
    };
  }

  return getDevOptionsStatusForRenderer();
}

async function setAppEncDesiredEnabledAndPersist(
  enabled: boolean
): Promise<AppEncStatus & { configPath: string }> {
  const prev = Boolean(APP_ENC_DESIRED_ENABLED);
  APP_ENC_DESIRED_ENABLED = Boolean(enabled);

  const appDataDir = app.getPath('appData');
  try {
    await writeParaSecurityConfigAtomic(appDataDir, { version: 1, appEncEnabled: APP_ENC_DESIRED_ENABLED });
  } catch {
    APP_ENC_DESIRED_ENABLED = prev;
    recomputeAppEncFromEnvAndToggle();
    return {
      ...getAppEncStatusForRenderer(),
      error: 'APPENC_TOGGLE_PERSIST_FAILED'
    };
  }

  recomputeAppEncFromEnvAndToggle();

  if (enabled && !APP_ENC_STATUS.effectiveEnabled && APP_ENC_STATUS.error) {
    const misconfig = APP_ENC_STATUS.error;
    APP_ENC_DESIRED_ENABLED = false;
    setAppEncDisabledWithError(misconfig);
    try {
      await writeParaSecurityConfigAtomic(appDataDir, { version: 1, appEncEnabled: false });
    } catch {
    }
  }

  return getAppEncStatusForRenderer();
}

function recomputeAppEncFromEnvAndToggle(): void {
  const desiredEnabled = Boolean(APP_ENC_DESIRED_ENABLED);

  if (!desiredEnabled) {
    setAppEncDisabledWithError(null);
    return;
  }

  const keysRaw = process.env.PARA_APPENC_KEYS;
  const primaryKid = typeof process.env.PARA_APPENC_PRIMARY_KID === 'string' ? process.env.PARA_APPENC_PRIMARY_KID.trim() : '';

  if (typeof keysRaw !== 'string' || keysRaw.trim() === '') {
    APP_ENC_CONFIG = { enabled: false, primaryKid: '', keys: new Map() };
    APP_ENC_STATUS = { desiredEnabled: true, effectiveEnabled: false, error: 'APPENC_KEYS_MISSING' };
    return;
  }
  if (primaryKid === '') {
    APP_ENC_CONFIG = { enabled: false, primaryKid: '', keys: new Map() };
    APP_ENC_STATUS = { desiredEnabled: true, effectiveEnabled: false, error: 'APPENC_PRIMARY_KID_MISSING' };
    return;
  }

  let keys: Map<string, Buffer>;
  try {
    keys = parseAppEncKeys(keysRaw);
  } catch {
    APP_ENC_CONFIG = { enabled: false, primaryKid: '', keys: new Map() };
    APP_ENC_STATUS = { desiredEnabled: true, effectiveEnabled: false, error: 'APPENC_KEYS_INVALID' };
    return;
  }

  if (!keys.has(primaryKid)) {
    APP_ENC_CONFIG = { enabled: false, primaryKid: '', keys: new Map() };
    APP_ENC_STATUS = { desiredEnabled: true, effectiveEnabled: false, error: 'APPENC_PRIMARY_KID_UNKNOWN' };
    return;
  }

  APP_ENC_CONFIG = { enabled: true, primaryKid, keys };
  APP_ENC_STATUS = { desiredEnabled: true, effectiveEnabled: true, error: null };
}

function getHeaderValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return '';
  for (const [k, v] of Object.entries(headers)) {
    if (k.trim().toLowerCase() === name.trim().toLowerCase()) return v;
  }
  return '';
}

function isJsonContentType(contentType: string): boolean {
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json';
}

function buildReqAad(args: {
  kid: string;
  ts: number;
  rid: string;
  method: string;
  path: string;
  query: string;
}): string {
  return (
    'para-appenc-v1\n' +
    `typ=req\n` +
    `kid=${args.kid}\n` +
    `ts=${args.ts}\n` +
    `rid=${args.rid}\n` +
    `method=${args.method}\n` +
    `path=${args.path}\n` +
    `query=${args.query}`
  );
}

function buildRespAad(args: { kid: string; ts: number; rid: string; status: number }): string {
  return (
    'para-appenc-v1\n' +
    `typ=resp\n` +
    `kid=${args.kid}\n` +
    `ts=${args.ts}\n` +
    `rid=${args.rid}\n` +
    `status=${args.status}`
  );
}

function maybeEncryptJsonRequestWithAppEnc(args: {
  urlObj: URL;
  method: string;
  contentType: string;
  initForFetch: RequestInit;
}): { initForFetch: RequestInit; requestRid: string | null } {
  const canEncryptJsonBody =
    APP_ENC_CONFIG.enabled &&
    typeof args.initForFetch.body === 'string' &&
    args.method !== 'GET' &&
    args.method !== 'HEAD' &&
    (args.initForFetch.body as string).trim() !== '' &&
    isJsonContentType(args.contentType);

  if (!canEncryptJsonBody) {
    return { initForFetch: args.initForFetch, requestRid: null };
  }

  const rid = base64UrlEncode(crypto.randomBytes(16));
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12);
  const key = APP_ENC_CONFIG.keys.get(APP_ENC_CONFIG.primaryKid);
  if (!key) {
    return { initForFetch: args.initForFetch, requestRid: null };
  }

  const query = args.urlObj.search.startsWith('?') ? args.urlObj.search.slice(1) : '';
  const aad = buildReqAad({
    kid: APP_ENC_CONFIG.primaryKid,
    ts,
    rid,
    method: args.method,
    path: args.urlObj.pathname,
    query
  });

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(args.initForFetch.body as string, 'utf8')),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  const ct = base64UrlEncode(Buffer.concat([ciphertext, tag]));

  const env = {
    v: 1,
    typ: 'req',
    alg: 'A256GCM',
    kid: APP_ENC_CONFIG.primaryKid,
    ts,
    rid,
    nonce: base64UrlEncode(nonce),
    ct
  };

  const headersOut = {
    ...((args.initForFetch.headers ?? {}) as Record<string, string>),
    'Content-Type': 'application/json',
    'X-Para-Enc': 'v1',
    'X-Para-Enc-Resp': 'v1'
  };

  return {
    requestRid: rid,
    initForFetch: {
      ...args.initForFetch,
      body: JSON.stringify(env),
      headers: headersOut
    }
  };
}

function maybeDecryptJsonResponseWithAppEnc(args: {
  response: Response;
  json: unknown;
  requestRid: string | null;
}): unknown {
  if (args.response.headers.get('X-Para-Enc') !== 'v1') {
    return args.json;
  }

  if (!APP_ENC_CONFIG.enabled) throw new Error('APPENC_DISABLED');

  if (!isObjectRecord(args.json)) throw new Error('API_FAILED');
  const env = args.json as Record<string, unknown>;
  if (env.v !== 1 || env.typ !== 'resp' || env.alg !== 'A256GCM') throw new Error('API_FAILED');
  if (typeof env.kid !== 'string' || typeof env.ts !== 'number' || typeof env.rid !== 'string') throw new Error('API_FAILED');
  if (typeof env.nonce !== 'string' || typeof env.ct !== 'string') throw new Error('API_FAILED');
  if (args.requestRid && env.rid !== args.requestRid) throw new Error('API_FAILED');

  const key = APP_ENC_CONFIG.keys.get(env.kid);
  if (!key) throw new Error('API_FAILED');

  const nonce = base64UrlDecode(env.nonce);
  const ctAllBuf = base64UrlDecode(env.ct);
  if (nonce.length !== 12 || ctAllBuf.length < 17) throw new Error('API_FAILED');

  const ctAll = new Uint8Array(ctAllBuf.buffer, ctAllBuf.byteOffset, ctAllBuf.byteLength);
  const ciphertext = ctAll.subarray(0, ctAll.length - 16);
  const tag = ctAll.subarray(ctAll.length - 16);

  const aad = buildRespAad({ kid: env.kid, ts: env.ts, rid: env.rid, status: args.response.status });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag));
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const text = plain.toString('utf8');
  return text.trim() === '' ? null : (JSON.parse(text) as unknown);
}

async function fetchJson(
  apiPath: string,
  init: RequestInit & { headers?: Record<string, string> }
): Promise<{ response: Response; json: unknown }> {
  if (typeof (globalThis as unknown as { fetch?: unknown }).fetch !== 'function') {
    throw new Error('FETCH_UNAVAILABLE');
  }

  const baseUrl = getServerBaseUrl();

  const fullUrl = buildApiUrl(baseUrl, apiPath);
  const urlObj = new URL(fullUrl);
  const method = String(init.method ?? 'GET').toUpperCase();
  const headersIn = init.headers ?? {};
  const contentType = getHeaderValue(headersIn, 'content-type');

  let initForFetch: RequestInit = {
    ...init,
    headers: {
      ...headersIn
    }
  };

  const prepared = maybeEncryptJsonRequestWithAppEnc({
    urlObj,
    method,
    contentType,
    initForFetch
  });
  initForFetch = prepared.initForFetch;

  let resp: Response;
  try {
    resp = await fetch(fullUrl, initForFetch);
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  let json = await readJsonResponse(resp);
  json = maybeDecryptJsonResponseWithAppEnc({ response: resp, json, requestRid: prepared.requestRid });
  return { response: resp, json };
}

async function fetchAuthedJson(
  apiPath: string,
  init: RequestInit & { headers?: Record<string, string> }
): Promise<{ response: Response; json: unknown }> {
  if (typeof (globalThis as unknown as { fetch?: unknown }).fetch !== 'function') {
    throw new Error('FETCH_UNAVAILABLE');
  }

  const accessToken = await requireAccessTokenFromDisk();
  const baseUrl = getServerBaseUrl();

  const fullUrl = buildApiUrl(baseUrl, apiPath);
  const urlObj = new URL(fullUrl);
  const method = String(init.method ?? 'GET').toUpperCase();
  const headersIn = init.headers ?? {};
  const contentType = getHeaderValue(headersIn, 'content-type');

  let initForFetch: RequestInit = {
    ...init,
    headers: {
      ...headersIn,
      Authorization: `Bearer ${accessToken}`
    }
  };

  const prepared = maybeEncryptJsonRequestWithAppEnc({
    urlObj,
    method,
    contentType,
    initForFetch
  });
  initForFetch = prepared.initForFetch;

  let resp: Response;
  try {
    resp = await fetch(fullUrl, initForFetch);
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (resp.status === 401) {
    await clearAuthTokensOnDisk();
    throw new Error('NOT_LOGGED_IN');
  }

  let json = await readJsonResponse(resp);

  json = maybeDecryptJsonResponseWithAppEnc({ response: resp, json, requestRid: prepared.requestRid });

  return { response: resp, json };
}

async function fetchAuthedBytes(
  apiPath: string,
  init: RequestInit & { headers?: Record<string, string> }
): Promise<{ response: Response; bytes: Uint8Array }> {
  if (typeof (globalThis as unknown as { fetch?: unknown }).fetch !== 'function') {
    throw new Error('FETCH_UNAVAILABLE');
  }

  const accessToken = await requireAccessTokenFromDisk();
  const baseUrl = getServerBaseUrl();

  let resp: Response;
  try {
    resp = await fetch(buildApiUrl(baseUrl, apiPath), {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`
      }
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (resp.status === 401) {
    await clearAuthTokensOnDisk();
    throw new Error('NOT_LOGGED_IN');
  }

  let buf: ArrayBuffer;
  try {
    buf = await resp.arrayBuffer();
  } catch {
    buf = new ArrayBuffer(0);
  }
  return { response: resp, bytes: new Uint8Array(buf) };
}

function throwApiErrorForStatus(resp: Response): never {
  if (resp.status === 403) throw new Error('FORBIDDEN');
  if (resp.status === 404) throw new Error('NOT_FOUND');
  if (resp.status === 422) throw new Error('INVALID_PAYLOAD');
  throw new Error('API_FAILED');
}

function looksLikeEnglish(textIn: string): boolean {
  const t = textIn.trim();
  if (t === '') return false;
  if (t.length < 8) return false;

  const total = t.length;
  let letters = 0;
  let spaces = 0;
  for (const ch of t) {
    if (ch.trim() === '') {
      spaces += 1;
      continue;
    }
    if (ch.length === 1 && ch.charCodeAt(0) <= 0x7f) {
      const code = ch.charCodeAt(0);
      const isAlpha =
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122);
      if (isAlpha) letters += 1;
    }
  }

  if (letters < 4) return false;
  if (letters / total < 0.25) return false;

  const spaceRatio = spaces / total;
  if (!(spaceRatio >= 0.05 && spaceRatio <= 0.6)) return false;

  return true;
}

function parseEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

function getAssistantIdleMs(): number {
  const env = parseEnvInt('PARA_ASSISTANT_IDLE_MS');
  if (typeof env === 'number' && env > 0) return env;
  return 5 * 60 * 1000;
}

class AssistantManager {
  private enabled = false;
  private saveId: string | null = null;
  private idleEnabled = false;

  private clipboardTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastClipboardText: string | null = null;
  private inFlight = false;

  setEnabled(enabled: boolean, saveId: string): void {
    if (!enabled) {
      this.enabled = false;
      this.saveId = null;
      this.stopAll();
      return;
    }

    const nextSaveId = saveId.trim();
    if (nextSaveId === '') throw new Error('INVALID_PAYLOAD');

    this.enabled = true;
    this.saveId = nextSaveId;
    this.startClipboardPolling();
    this.refreshIdleTimer();
  }

  setIdleEnabled(enabled: boolean): void {
    this.idleEnabled = Boolean(enabled);
    this.refreshIdleTimer();
  }

  writeClipboardText(text: string): void {
    clipboard.writeText(text);
  }

  private stopAll(): void {
    if (this.clipboardTimer) {
      clearInterval(this.clipboardTimer);
      this.clipboardTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.inFlight = false;
    this.lastClipboardText = null;
  }

  private startClipboardPolling(): void {
    if (this.clipboardTimer) return;
    try {
      this.lastClipboardText = clipboard.readText();
    } catch {
      this.lastClipboardText = null;
    }

    const intervalMs = 1200;
    this.clipboardTimer = setInterval(() => {
      void this.pollClipboardOnce();
    }, intervalMs);
  }

  private refreshIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.enabled) return;
    if (!this.idleEnabled) return;
    const idleMs = getAssistantIdleMs();
    this.idleTimer = setTimeout(() => {
      void this.fireIdleOnce(idleMs);
    }, idleMs);
  }

  private async fireIdleOnce(idleMs: number): Promise<void> {
    if (!this.enabled || !this.idleEnabled) return;
    const saveId = this.saveId;
    if (!saveId) return;

    await this.sendSensorEvent({
      save_id: saveId,
      event_type: 'idle',
      idle_seconds: Math.floor(idleMs / 1000),
      app_name: 'para-desktop'
    });
  }

  private async pollClipboardOnce(): Promise<void> {
    if (!this.enabled) return;
    if (this.inFlight) return;
    const saveId = this.saveId;
    if (!saveId) return;

    let text = '';
    try {
      text = clipboard.readText();
    } catch {
      return;
    }

    if (this.lastClipboardText === text) return;
    this.lastClipboardText = text;

    if (!looksLikeEnglish(text)) return;

    await this.sendSensorEvent({
      save_id: saveId,
      event_type: 'clipboard',
      text,
      app_name: 'para-desktop'
    });
  }

  private async sendSensorEvent(payload: Record<string, unknown>): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const { response, json } = await fetchAuthedJson('/api/v1/sensors/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) return;
      if (!isObjectRecord(json)) return;
      const suggestion = json.suggestion;
      const category = json.category;
      if (typeof suggestion !== 'string' || suggestion.trim() === '') return;
      if (typeof category !== 'string' || category.trim() === '') return;

      safeSendToRenderer(IPC_ASSISTANT_SUGGESTION, {
        suggestion,
        category
      } satisfies AssistantSuggestionPayload);
    } catch {
    } finally {
      this.inFlight = false;
    }
  }
}

const assistantManager = new AssistantManager();

class PluginManager {
  private state: PluginStateFile = { enabled: false, installed: null };
  private host: ChildProcess | null = null;
  private menuItems: PluginMenuItem[] = [];
  private lastError: string | null = null;

  private remotePluginsEnabled = false;

  private pendingMenuClicks = new Map<
    string,
    {
      resolve: (ok: boolean) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  async init(): Promise<void> {
    this.state = await this.readStateFromDisk();
    await this.applyEffectiveRuntimeState();
  }

  async setRemotePluginsEnabled(enabled: boolean): Promise<void> {
    const next = Boolean(enabled);
    if (this.remotePluginsEnabled === next) return;
    this.remotePluginsEnabled = next;
    await this.applyEffectiveRuntimeState();
  }

  private isExecutionAllowed(): boolean {
    return this.state.enabled && this.remotePluginsEnabled;
  }

  private async applyEffectiveRuntimeState(knownEntryPath?: string): Promise<void> {
    if (!this.isExecutionAllowed()) {
      await this.stopHost();
      this.clearRuntimeState();
      return;
    }

    const installed = this.state.installed;
    if (!installed) {
      await this.stopHost();
      this.clearRuntimeState();
      return;
    }

    const running = Boolean(this.host && !this.host.killed);
    if (running) return;

    await this.startHost(installed, knownEntryPath);
  }

  getStatus(): PluginStatus {
    const running = Boolean(this.host && !this.host.killed);
    return {
      enabled: this.state.enabled,
      installed: this.state.installed,
      running: this.isExecutionAllowed() ? running : false,
      menuItems: this.isExecutionAllowed() ? [...this.menuItems] : [],
      lastError: this.lastError
    };
  }

  getMenuItems(): PluginMenuItem[] {
    if (!this.isExecutionAllowed()) return [];
    return [...this.menuItems];
  }

  async clickMenuItem(payload: { pluginId: string; id: string }): Promise<{ ok: boolean }> {
    if (!this.isExecutionAllowed()) throw new Error('PLUGINS_DISABLED');
    const installed = this.state.installed;
    if (!installed) throw new Error('NO_PLUGIN_INSTALLED');
    if (!this.host || this.host.killed) throw new Error('PLUGIN_HOST_NOT_RUNNING');

    const pluginId = String(payload.pluginId ?? '').trim();
    const id = String(payload.id ?? '').trim();
    if (!pluginId || !id) throw new Error('INVALID_PAYLOAD');
    if (pluginId !== installed.id) throw new Error('PLUGIN_MISMATCH');

    if (this.pendingMenuClicks.size >= PLUGIN_PENDING_MENU_CLICKS_MAX) {
      throw new Error('TOO_MANY_PENDING');
    }

    const requestId = newPluginRequestId();

    const ok = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMenuClicks.delete(requestId);
        reject(new Error('TIMEOUT'));
      }, PLUGIN_MENU_CLICK_TIMEOUT_MS);

      this.pendingMenuClicks.set(requestId, { resolve, reject, timer });

      try {
        this.host?.send?.({ type: 'menu:click', pluginId, id, requestId } satisfies PluginHostCmd);
      } catch {
        clearTimeout(timer);
        this.pendingMenuClicks.delete(requestId);
        reject(new Error('PLUGIN_HOST_SEND_FAILED'));
      }
    });

    return { ok };
  }

  async setEnabled(enabled: boolean): Promise<PluginStatus> {
    const nextEnabled = Boolean(enabled);
    if (this.state.enabled === nextEnabled) return this.getStatus();

    this.state.enabled = nextEnabled;
    await this.writeStateToDisk(this.state);

    if (nextEnabled) this.lastError = null;
    await this.applyEffectiveRuntimeState();
    return this.getStatus();
  }

  async listApproved(): Promise<ApprovedPluginListItem[]> {
    const { response, json } = await fetchAuthedJson('/api/v1/plugins', { method: 'GET' });
    if (!response.ok) throwApiErrorForStatus(response);
    if (!Array.isArray(json)) throw new Error('API_FAILED');

    return json
      .filter((it) => isObjectRecord(it))
      .map((it) => {
        const rec = it as Record<string, unknown>;
        const id = String(rec.id ?? '').trim();
        const version = String(rec.version ?? '').trim();
        const name = String(rec.name ?? '').trim();
        const sha256 = String(rec.sha256 ?? '').trim();
        const permissions = rec.permissions;
        return { id, version, name, sha256, permissions } satisfies ApprovedPluginListItem;
      })
      .filter((it) => {
        if (it.id === '' || it.version === '' || it.name === '') return false;
        if (it.sha256 === '' || it.sha256.length < 16) return false;
        if (!isPermissionsValue(it.permissions)) return false;
        return true;
      });
  }

  async install(selection?: Partial<{ pluginId: string; version: string }>): Promise<PluginStatus> {
    const approved = await this.listApproved();
    if (approved.length === 0) throw new Error('NO_APPROVED_PLUGINS');

    const wantId = typeof selection?.pluginId === 'string' ? selection.pluginId.trim() : '';
    const wantVer = typeof selection?.version === 'string' ? selection.version.trim() : '';

    let chosen: ApprovedPluginListItem | null = null;
    if (wantId && wantVer) {
      chosen = approved.find((p) => p.id === wantId && p.version === wantVer) ?? null;
    } else if (wantId) {
      chosen = approved.find((p) => p.id === wantId) ?? null;
    }
    if (!chosen) chosen = approved[0] ?? null;
    if (!chosen) throw new Error('NO_APPROVED_PLUGINS');

    const entryPath = await this.downloadAndStoreBundle(chosen);

    this.state.installed = {
      id: chosen.id,
      version: chosen.version,
      name: chosen.name,
      sha256: chosen.sha256,
      permissions: chosen.permissions
    };
    await this.writeStateToDisk(this.state);

    if (this.isExecutionAllowed()) {
      await this.startHost({ ...this.state.installed, permissions: chosen.permissions }, entryPath);
    } else {
      await this.stopHost();
      this.clearRuntimeState();
    }

    return this.getStatus();
  }

  private clearRuntimeState(): void {
    this.menuItems = [];
  }

  private rejectAllPendingMenuClicks(err: Error): void {
    for (const [requestId, p] of this.pendingMenuClicks.entries()) {
      clearTimeout(p.timer);
      this.pendingMenuClicks.delete(requestId);
      try {
        p.reject(err);
      } catch {
      }
    }
  }

  private async stopHost(): Promise<void> {
    if (!this.host) return;
    const host = this.host;
    this.host = null;

    this.rejectAllPendingMenuClicks(new Error('PLUGIN_HOST_STOPPED'));

    try {
      host.send?.({ type: 'shutdown' } satisfies PluginHostCmd);
    } catch {
    }

    try {
      host.kill();
    } catch {
    }
  }

  private async startHost(installed: PluginInstalledRef, knownEntryPath?: string): Promise<void> {
    if (!this.isExecutionAllowed()) return;
    if (!installed.permissions || !isPermissionsValue(installed.permissions)) {
      this.lastError = 'PERMISSIONS_REQUIRED';
      return;
    }

    await this.stopHost();
    this.clearRuntimeState();
    this.lastError = null;

    const entryPath = knownEntryPath ?? this.getBundleEntryPath(installed.id, installed.version);
    try {
      await fs.access(entryPath);
    } catch {
      this.lastError = 'PLUGIN_NOT_INSTALLED_ON_DISK';
      return;
    }

    const pluginHostEntry = path.join(__dirname, 'plugin_host.js');
    const child = fork(pluginHostEntry, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
      }
    });
    this.host = child;

    child.on('message', (raw: unknown) => {
      this.onHostMessage(raw);
    });
    child.on('exit', () => {
      if (this.host === child) this.host = null;
      this.rejectAllPendingMenuClicks(new Error('PLUGIN_HOST_EXITED'));
    });
    child.on('error', () => {
      if (this.host === child) this.host = null;
      this.rejectAllPendingMenuClicks(new Error('PLUGIN_HOST_ERROR'));
      this.lastError = 'PLUGIN_HOST_ERROR';
    });

    try {
      child.send({
        type: 'load',
        pluginId: installed.id,
        version: installed.version,
        entryPath,
        permissions: installed.permissions
      } satisfies PluginHostCmd);
    } catch {
      this.lastError = 'PLUGIN_HOST_SEND_FAILED';
    }
  }

  private onHostMessage(raw: unknown): void {
    if (!isObjectRecord(raw)) return;
    const msg = raw as Record<string, unknown>;
    const type = msg.type;
    if (typeof type !== 'string') return;

    if (type === 'menu:click:result') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
      const ok = msg.ok === true;
      if (!requestId) return;
      const pending = this.pendingMenuClicks.get(requestId);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pendingMenuClicks.delete(requestId);

      try {
        pending.resolve(ok);
      } catch {
      }
      return;
    }

    if (type === 'error') {
      const message = typeof msg.message === 'string' ? msg.message : 'PLUGIN_RUNTIME_ERROR';
      this.lastError = message;
      return;
    }

    if (type === 'menu:add') {
      const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId : '';
      const item = isObjectRecord(msg.item) ? (msg.item as Record<string, unknown>) : null;
      const id = item && typeof item.id === 'string' ? item.id : '';
      const label = item && typeof item.label === 'string' ? item.label : '';
      if (!pluginId || !id || !label) return;

      if (this.menuItems.length >= PLUGIN_MENU_ITEMS_MAX) return;

      const clippedId = id.trim().slice(0, PLUGIN_MENU_ID_MAX_CHARS);
      const clippedLabel = label.trim().slice(0, PLUGIN_MENU_LABEL_MAX_CHARS);
      if (!clippedId || !clippedLabel) return;

      this.menuItems.push({ pluginId, id: clippedId, label: clippedLabel });
      return;
    }

    if (type === 'say' || type === 'suggestion') {
      const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId : '';
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!pluginId || !text) return;
      const maxChars = type === 'say' ? PLUGIN_SAY_MAX_CHARS : PLUGIN_SUGGESTION_MAX_CHARS;
      const clipped = text.trim().slice(0, maxChars);
      if (!clipped) return;
      safeSendToAllRenderers(IPC_PLUGINS_OUTPUT, { type, pluginId, text: clipped });
      return;
    }
  }

  private getBundleEntryPath(pluginId: string, version: string): string {
    const safeId = safePathSegment(pluginId);
    const safeVer = safePathSegment(version);
    return path.join(getPluginsRootDir(), PLUGINS_BUNDLES_DIRNAME, safeId, safeVer, 'index.js');
  }

  private async downloadAndStoreBundle(item: ApprovedPluginListItem): Promise<string> {
    const { response, json } = await fetchAuthedJson(
      `/api/v1/plugins/${encodeURIComponent(item.id)}/${encodeURIComponent(item.version)}`,
      { method: 'GET' },
    );
    if (!response.ok) throwApiErrorForStatus(response);
    const bundle = parsePluginDownloadBundle(json);
    const codeText = bundle.code;

    const expected = item.sha256.trim().toLowerCase();
    const actual = sha256HexUtf8(codeText).toLowerCase();
    const serverSha = bundle.sha256.trim().toLowerCase();
    if (serverSha && serverSha !== actual) throw new Error('SHA256_MISMATCH');
    if (expected && expected !== actual) throw new Error('SHA256_MISMATCH');

    const entryPath = this.getBundleEntryPath(item.id, item.version);
    const dir = path.dirname(entryPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${entryPath}.tmp`;
    await fs.writeFile(tmpPath, codeText, { encoding: 'utf8' });
    await fs.rename(tmpPath, entryPath);
    return entryPath;
  }

  private async readStateFromDisk(): Promise<PluginStateFile> {
    const filePath = getPluginsStateFilePath();
    let raw: string;
    try {
      raw = await fs.readFile(filePath, { encoding: 'utf8' });
    } catch (err: unknown) {
      const code = isObjectRecord(err) ? err.code : undefined;
      if (code === 'ENOENT') return { enabled: false, installed: null };
      return { enabled: false, installed: null };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { enabled: false, installed: null };
    }

    if (!isObjectRecord(parsed)) return { enabled: false, installed: null };
    const enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : false;
    const installedRaw = parsed.installed;
    if (!isObjectRecord(installedRaw)) {
      return { enabled, installed: null };
    }

    const id = typeof installedRaw.id === 'string' ? installedRaw.id.trim() : '';
    const version = typeof installedRaw.version === 'string' ? installedRaw.version.trim() : '';
    if (!id || !version) return { enabled, installed: null };

    const name = typeof installedRaw.name === 'string' ? installedRaw.name : undefined;
    const sha256 = typeof installedRaw.sha256 === 'string' ? installedRaw.sha256 : undefined;
    const permissions = installedRaw.permissions;

    return {
      enabled,
      installed: {
        id,
        version,
        name,
        sha256,
        permissions
      }
    };
  }

  private async writeStateToDisk(state: PluginStateFile): Promise<void> {
    const root = getPluginsRootDir();
    await fs.mkdir(root, { recursive: true });

    const filePath = getPluginsStateFilePath();
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state), { encoding: 'utf8' });
    await fs.rename(tmpPath, filePath);
  }

}

const pluginManager = new PluginManager();

const FEATURE_FLAGS_POLL_INTERVAL_MS = 1200;

class FeatureFlagsPoller {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private pluginsEnabled: boolean | null = null;

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, FEATURE_FLAGS_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async pollOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const enabled = await fetchPluginsEnabledFeatureFlag();
      if (typeof enabled !== 'boolean') return;
      if (this.pluginsEnabled === enabled) return;
      this.pluginsEnabled = enabled;
      await pluginManager.setRemotePluginsEnabled(enabled);
    } catch {
    } finally {
      this.inFlight = false;
    }
  }
}

const featureFlagsPoller = new FeatureFlagsPoller();

function shouldEnforceSecureTokenStorage(): boolean {
  if (envFlagTruthy('PARA_ENFORCE_SECURE_TOKEN_STORAGE')) return true;
  return app.isPackaged;
}

function isSecureTokenStorageAvailable(): boolean {
  if (process.env.NODE_ENV === 'test' && envFlagTruthy('PARA_TEST_DISABLE_SAFE_STORAGE')) {
    return false;
  }

  if (!safeStorage.isEncryptionAvailable()) return false;

  try {
    const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => unknown }).getSelectedStorageBackend?.();
    if (backend === 'basic_text') return false;
  } catch {
  }

  return true;
}

type ByokConfigFile = {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key_enc: string | null;
};

type ByokConfigPublic = {
  enabled: boolean;
  base_url: string;
  model: string;
  api_key_present: boolean;
  secure_storage_available: boolean;
};

let byokEphemeralApiKey: string | null = null;

function isByokConfigFile(value: unknown): value is ByokConfigFile {
  if (!isObjectRecord(value)) return false;
  const v = value as Record<string, unknown>;
  const enabled = v.enabled;
  const baseUrl = v.base_url;
  const model = v.model;
  const apiKeyEnc = v.api_key_enc;
  if (typeof enabled !== 'boolean') return false;
  if (typeof baseUrl !== 'string') return false;
  if (typeof model !== 'string') return false;
  if (!(apiKeyEnc === null || typeof apiKeyEnc === 'string')) return false;
  return true;
}

function normalizeByokBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error('BYOK_BASE_URL_INVALID');
  }
  if (!(u.protocol === 'http:' || u.protocol === 'https:')) {
    throw new Error('BYOK_BASE_URL_INVALID');
  }
  const s = u.toString();
  return s.endsWith('/') ? s.slice(0, s.length - 1) : s;
}

function normalizeByokModel(raw: string): string {
  return raw.trim();
}

async function readByokConfigFromDisk(): Promise<ByokConfigFile> {
  const filePath = getByokConfigFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, { encoding: 'utf8' });
  } catch (err: unknown) {
    const code = isObjectRecord(err) ? err.code : undefined;
    if (code === 'ENOENT') {
      return { enabled: false, base_url: '', model: '', api_key_enc: null };
    }
    return { enabled: false, base_url: '', model: '', api_key_enc: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { enabled: false, base_url: '', model: '', api_key_enc: null };
  }

  if (!isByokConfigFile(parsed)) {
    return { enabled: false, base_url: '', model: '', api_key_enc: null };
  }

  return {
    enabled: parsed.enabled,
    base_url: typeof parsed.base_url === 'string' ? parsed.base_url : '',
    model: typeof parsed.model === 'string' ? parsed.model : '',
    api_key_enc: parsed.api_key_enc
  };
}

async function writeByokConfigToDisk(next: ByokConfigFile): Promise<void> {
  const userDataDir = app.getPath('userData');
  await fs.mkdir(userDataDir, { recursive: true });

  const filePath = getByokConfigFilePath();
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(next), { encoding: 'utf8' });
  await fs.rename(tmpPath, filePath);
}

function toByokPublic(cfg: ByokConfigFile): ByokConfigPublic {
  const ephemeralPresent = typeof byokEphemeralApiKey === 'string' && byokEphemeralApiKey.trim() !== '';
  return {
    enabled: cfg.enabled,
    base_url: cfg.base_url,
    model: cfg.model,
    api_key_present:
      (typeof cfg.api_key_enc === 'string' && cfg.api_key_enc.trim() !== '') ||
      ephemeralPresent,
    secure_storage_available: isSecureTokenStorageAvailable()
  };
}

let byokInFlight: { controller: AbortController } | null = null;

async function byokChatCompletionsOnce(payload: { text: string }): Promise<{ content: string }> {
  const cfg = await readByokConfigFromDisk();
  if (!cfg.enabled) throw new Error('BYOK_DISABLED');

  const baseUrl = normalizeByokBaseUrl(cfg.base_url);
  const model = normalizeByokModel(cfg.model);
  if (!baseUrl || !model) throw new Error('BYOK_CONFIG_INCOMPLETE');

  let apiKey: string | null = null;
  if (typeof cfg.api_key_enc === 'string' && cfg.api_key_enc.trim() !== '') {
    if (!isSecureTokenStorageAvailable()) {
      throw new Error('SAFE_STORAGE_UNAVAILABLE');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('SAFE_STORAGE_UNAVAILABLE');
    }

    try {
      apiKey = safeStorage.decryptString(Buffer.from(cfg.api_key_enc, 'base64'));
    } catch {
      throw new Error('BYOK_KEY_DECRYPT_FAILED');
    }
  } else if (process.env.NODE_ENV === 'test') {
    apiKey = typeof byokEphemeralApiKey === 'string' ? byokEphemeralApiKey : null;
  }

  if (!apiKey || apiKey.trim() === '') throw new Error('BYOK_CONFIG_INCOMPLETE');

  if (byokInFlight) {
    throw new Error('BYOK_BUSY');
  }

  const controller = new AbortController();
  byokInFlight = { controller };

  try {
    const url = new URL('/v1/chat/completions', baseUrl);

    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: payload.text }]
        })
      });
    } catch (err: unknown) {
      const name = isObjectRecord(err) ? err.name : undefined;
      if (name === 'AbortError') throw new Error('ABORTED');
      throw new Error('NETWORK_ERROR');
    }

    if (!resp.ok) {
      throw new Error('API_FAILED');
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      throw new Error('API_FAILED');
    }

    const choices = isObjectRecord(json) ? (json as Record<string, unknown>).choices : undefined;
    if (!Array.isArray(choices) || choices.length === 0) throw new Error('API_FAILED');
    const first = choices[0];
    const msg = isObjectRecord(first) ? (first as Record<string, unknown>).message : undefined;
    const content = isObjectRecord(msg) ? (msg as Record<string, unknown>).content : undefined;
    if (typeof content !== 'string') throw new Error('API_FAILED');

    return { content };
  } finally {
    byokInFlight = null;
  }
}

function isStoredAuthTokensFile(value: unknown): value is StoredAuthTokensFile {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.secure === 'boolean' &&
    typeof value.accessToken === 'string' &&
    typeof value.refreshToken === 'string'
  );
}

async function writeAuthTokensToDisk(payload: AuthTokensPayload): Promise<{ secure: boolean }> {
  const enforce = shouldEnforceSecureTokenStorage();
  const secure = isSecureTokenStorageAvailable();

  if (enforce && !secure) {
    await clearAuthTokensOnDisk();
    throw new Error('SAFE_STORAGE_UNAVAILABLE');
  }

  const stored: StoredAuthTokensFile = {
    secure,
    accessToken: secure
      ? safeStorage.encryptString(payload.accessToken).toString('base64')
      : payload.accessToken,
    refreshToken: secure
      ? safeStorage.encryptString(payload.refreshToken).toString('base64')
      : payload.refreshToken
  };

  const userDataDir = app.getPath('userData');
  await fs.mkdir(userDataDir, { recursive: true });

  const targetPath = getAuthTokensFilePath();
  const tmpPath = `${targetPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(stored), { encoding: 'utf8' });
  await fs.rename(tmpPath, targetPath);

  return { secure };
}

async function readAuthTokensFromDisk(): Promise<
  { accessToken: string; refreshToken: string; secure: boolean } | null
> {
  const enforce = shouldEnforceSecureTokenStorage();
  const filePath = getAuthTokensFilePath();

  let raw: string;
  try {
    raw = await fs.readFile(filePath, { encoding: 'utf8' });
  } catch (err: unknown) {
    const code = isObjectRecord(err) ? err.code : undefined;
    if (code === 'ENOENT') return null;
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isStoredAuthTokensFile(parsed)) return null;

  if (!parsed.secure) {
    if (enforce) {
      await clearAuthTokensOnDisk();
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      secure: false
    };
  }

  if (enforce && !isSecureTokenStorageAvailable()) {
    await clearAuthTokensOnDisk();
    return null;
  }

  if (!safeStorage.isEncryptionAvailable()) return null;

  try {
    return {
      accessToken: safeStorage.decryptString(Buffer.from(parsed.accessToken, 'base64')),
      refreshToken: safeStorage.decryptString(Buffer.from(parsed.refreshToken, 'base64')),
      secure: true
    };
  } catch {
    return null;
  }
}

async function clearAuthTokensOnDisk(): Promise<void> {
  const filePath = getAuthTokensFilePath();
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    const code = isObjectRecord(err) ? err.code : undefined;
    if (code === 'ENOENT') return;
  }
}

function registerByokIpcHandlers() {
  handleTrustedIpc(IPC_BYOK_GET_CONFIG, async (): Promise<ByokConfigPublic> => {
    const cfg = await readByokConfigFromDisk();
    return toByokPublic(cfg);
  });

  handleTrustedIpc(IPC_BYOK_SET_CONFIG, async (_event, payload: unknown): Promise<ByokConfigPublic> => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    const baseUrl = payload.base_url;
    const model = payload.model;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    if (typeof baseUrl !== 'string') throw new Error('INVALID_PAYLOAD');
    if (typeof model !== 'string') throw new Error('INVALID_PAYLOAD');

    const prev = await readByokConfigFromDisk();
    const next: ByokConfigFile = {
      ...prev,
      enabled,
      base_url: normalizeByokBaseUrl(baseUrl),
      model: normalizeByokModel(model)
    };
    await writeByokConfigToDisk(next);
    return toByokPublic(next);
  });

  handleTrustedIpc(IPC_BYOK_UPDATE_API_KEY, async (_event, payload: unknown): Promise<ByokConfigPublic> => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const apiKey = payload.api_key;
    if (typeof apiKey !== 'string') throw new Error('INVALID_PAYLOAD');
    const trimmed = apiKey.trim();
    if (trimmed === '') throw new Error('INVALID_PAYLOAD');

    const prev = await readByokConfigFromDisk();
    if (!isSecureTokenStorageAvailable() || !safeStorage.isEncryptionAvailable()) {
      if (process.env.NODE_ENV === 'test') {
        byokEphemeralApiKey = trimmed;
        const next: ByokConfigFile = { ...prev, api_key_enc: null };
        await writeByokConfigToDisk(next);
        return toByokPublic(next);
      }
      throw new Error('SAFE_STORAGE_UNAVAILABLE');
    }

    byokEphemeralApiKey = null;
    const enc = safeStorage.encryptString(trimmed).toString('base64');
    const next: ByokConfigFile = { ...prev, api_key_enc: enc };
    await writeByokConfigToDisk(next);
    return toByokPublic(next);
  });

  handleTrustedIpc(IPC_BYOK_CLEAR_API_KEY, async (): Promise<ByokConfigPublic> => {
    byokEphemeralApiKey = null;
    const prev = await readByokConfigFromDisk();
    const next: ByokConfigFile = { ...prev, api_key_enc: null };
    await writeByokConfigToDisk(next);
    return toByokPublic(next);
  });

  handleTrustedIpc(IPC_BYOK_CHAT_SEND, async (_event, payload: unknown): Promise<{ content: string }> => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const text = payload.text;
    if (typeof text !== 'string') throw new Error('INVALID_PAYLOAD');
    const trimmed = text.trim();
    if (!trimmed) throw new Error('INVALID_PAYLOAD');
    return byokChatCompletionsOnce({ text: trimmed });
  });

  handleTrustedIpc(IPC_BYOK_CHAT_ABORT, async (): Promise<{ ok: boolean }> => {
    try {
      byokInFlight?.controller.abort();
    } catch {
    }
    return { ok: true };
  });
}

function registerAuthIpcHandlers() {
  handleTrustedIpc(IPC_AUTH_SET_TOKENS, async (_event, payload: unknown) => {
    if (!isAuthTokensPayload(payload)) {
      throw new Error('Invalid payload for auth:setTokens');
    }
    return writeAuthTokensToDisk(payload);
  });

  handleTrustedIpc(IPC_AUTH_GET_TOKENS, async () => {
    return readAuthTokensFromDisk();
  });

  handleTrustedIpc(IPC_AUTH_CLEAR_TOKENS, async () => {
    await clearAuthTokensOnDisk();
  });

  handleTrustedIpc(IPC_AUTH_LOGIN, async (_event, payload: unknown) => {
    if (!isAuthLoginPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    return loginAndGetMe(payload.email, payload.password);
  });

  handleTrustedIpc(IPC_AUTH_REGISTER, async (_event, payload: unknown) => {
    if (!isAuthRegisterPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    return registerAndGetMe(payload.email, payload.password, payload.inviteCode);
  });

  handleTrustedIpc(IPC_AUTH_ME, async () => {
    return readMeFromDiskToken();
  });

  handleTrustedIpc(IPC_AUTH_LOGOUT, async () => {
    await clearAuthTokensOnDisk();
  });
}

function registerWsIpcHandlers() {
  handleTrustedIpc(IPC_WS_CONNECT, async (_event, payload: unknown) => {
    return wsClient.connect(payload as WsConnectPayload);
  });

  handleTrustedIpc(IPC_WS_DISCONNECT, async () => {
    return wsClient.disconnect();
  });

  handleTrustedIpc(IPC_WS_CHAT_SEND, async (_event, payload: unknown) => {
    wsClient.chatSend(payload as WsChatSendPayload);
  });

  handleTrustedIpc(IPC_WS_INTERRUPT, async () => {
    wsClient.interrupt();
  });
}

function registerSavesAndPersonasIpcHandlers() {
  handleTrustedIpc(IPC_SAVES_LIST, async () => {
    const { response, json } = await fetchAuthedJson('/api/v1/saves', { method: 'GET' });
    if (!response.ok) {
      throw new Error('API_FAILED');
    }
    if (!Array.isArray(json)) {
      throw new Error('API_FAILED');
    }
    return json
      .filter((it) => isObjectRecord(it))
      .map((it) => {
        const rec = it as Record<string, unknown>;
        const personaId = rec.persona_id;
        return {
          id: String(rec.id ?? ''),
          name: String(rec.name ?? ''),
          persona_id:
            personaId == null || typeof personaId === 'string' ? (personaId as string | null) : null
        };
      })
      .filter((it) => it.id !== '' && it.name !== '');
  });

  handleTrustedIpc(IPC_SAVES_CREATE, async (_event, payload: unknown) => {
    if (!isSavesCreatePayload(payload) || payload.name.trim() === '') {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, json } = await fetchAuthedJson('/api/v1/saves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: payload.name })
    });

    if (!response.ok) {
      throw new Error('API_FAILED');
    }
    if (!isObjectRecord(json) || typeof json.id !== 'string' || typeof json.name !== 'string') {
      throw new Error('API_FAILED');
    }
    return { id: json.id, name: json.name };
  });

  handleTrustedIpc(IPC_SAVES_BIND_PERSONA, async (_event, payload: unknown) => {
    if (!isSavesBindPersonaPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }
    if (payload.saveId.trim() === '' || payload.personaId.trim() === '') {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, json } = await fetchAuthedJson(`/api/v1/saves/${payload.saveId}/persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona_id: payload.personaId })
    });

    if (!response.ok) {
      throw new Error('API_FAILED');
    }
    if (!isObjectRecord(json) || typeof json.save_id !== 'string' || typeof json.persona_id !== 'string') {
      throw new Error('API_FAILED');
    }
    return { save_id: json.save_id, persona_id: json.persona_id };
  });

  handleTrustedIpc(IPC_PERSONAS_LIST, async () => {
    const { response, json } = await fetchAuthedJson('/api/v1/personas', { method: 'GET' });
    if (!response.ok) {
      throw new Error('API_FAILED');
    }
    if (!Array.isArray(json)) {
      throw new Error('API_FAILED');
    }
    return json
      .filter((it) => isObjectRecord(it))
      .map((it) => {
        const rec = it as Record<string, unknown>;
        return {
          id: String(rec.id ?? ''),
          name: String(rec.name ?? ''),
          version: typeof rec.version === 'number' ? rec.version : 0
        };
      })
      .filter((it) => it.id !== '' && it.name !== '');
  });
}

type KnowledgeMaterialStatusPayload = {
  id: string;
};

function isKnowledgeMaterialStatusPayload(value: unknown): value is KnowledgeMaterialStatusPayload {
  if (!isObjectRecord(value)) return false;
  return typeof (value as Record<string, unknown>).id === 'string';
}

async function uploadKnowledgeMaterial(payload: KnowledgeUploadPayload): Promise<KnowledgeMaterial> {
  if (typeof (globalThis as unknown as { FormData?: unknown }).FormData !== 'function') {
    throw new Error('FETCH_UNAVAILABLE');
  }
  if (typeof (globalThis as unknown as { Blob?: unknown }).Blob !== 'function') {
    throw new Error('FETCH_UNAVAILABLE');
  }

  const bytesBuf = bytesToBuffer(payload.bytes);
  if (!bytesBuf) throw new Error('INVALID_PAYLOAD');

  const form = new FormData();
  const bytesU8 = Uint8Array.from(bytesBuf);
  const blob = new Blob([bytesU8], { type: payload.mimeType || 'application/octet-stream' });
  form.append('file', blob, payload.filename);
  form.append('save_id', payload.saveId);

  const { response, json } = await fetchAuthedJson('/api/v1/knowledge/materials', {
    method: 'POST',
    body: form
  });
  if (!response.ok) throw new Error('API_FAILED');
  return parseKnowledgeMaterial(json);
}

async function readKnowledgeMaterialStatus(id: string): Promise<KnowledgeMaterial> {
  const { response, json } = await fetchAuthedJson(
    `/api/v1/knowledge/materials/${encodeURIComponent(id)}`,
    { method: 'GET' },
  );
  if (!response.ok) throw new Error('API_FAILED');
  return parseKnowledgeMaterial(json);
}

function registerKnowledgeIpcHandlers() {
  handleTrustedIpc(IPC_KNOWLEDGE_UPLOAD_MATERIAL, async (_event, payload: unknown) => {
    if (!isKnowledgeUploadPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }
    return uploadKnowledgeMaterial(payload);
  });

  handleTrustedIpc(IPC_KNOWLEDGE_MATERIAL_STATUS, async (_event, payload: unknown) => {
    if (!isKnowledgeMaterialStatusPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }
    return readKnowledgeMaterialStatus(payload.id);
  });
}

function registerVisionIpcHandlers() {
  handleTrustedIpc(IPC_VISION_UPLOAD_SCREENSHOT, async (_event, payload: unknown) => {
    if (!isVisionUploadScreenshotPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, json } = await fetchAuthedJson('/api/v1/sensors/screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        save_id: payload.saveId,
        image_base64: payload.imageBase64,
        privacy_mode: payload.privacyMode
      })
    });
    if (!response.ok) throw new Error('API_FAILED');
    return parseVisionSuggestionResponse(json);
  });
}

function registerGalleryIpcHandlers() {
  handleTrustedIpc(IPC_GALLERY_GENERATE, async (_event, payload: unknown) => {
    if (!isGalleryGeneratePayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, json } = await fetchAuthedJson('/api/v1/gallery/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        save_id: payload.saveId,
        prompt: payload.prompt
      })
    });
    if (!response.ok) throw new Error('API_FAILED');
    return parseGalleryGenerateResponse(json);
  });

  handleTrustedIpc(IPC_GALLERY_LIST, async (_event, payload: unknown) => {
    if (!isGalleryListPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, json } = await fetchAuthedJson(
      `/api/v1/gallery/items?save_id=${encodeURIComponent(payload.saveId)}`,
      { method: 'GET' },
    );
    if (!response.ok) throw new Error('API_FAILED');
    if (!Array.isArray(json)) throw new Error('API_FAILED');
    return json as GalleryItem[];
  });

  handleTrustedIpc(IPC_GALLERY_DOWNLOAD, async (_event, payload: unknown) => {
    if (!isGalleryDownloadPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, bytes } = await fetchAuthedBytes(
      `/api/v1/gallery/items/${encodeURIComponent(payload.galleryId)}/download?kind=${encodeURIComponent(payload.kind)}`,
      { method: 'GET' },
    );
    if (!response.ok) throw new Error('API_FAILED');
    return bytes.buffer;
  });
}

function registerTimelineIpcHandlers() {
  handleTrustedIpc(IPC_TIMELINE_SIMULATE, async (_event, payload: unknown) => {
    if (!isTimelineSimulatePayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, json } = await fetchAuthedJson('/api/v1/timeline/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        save_id: payload.saveId,
        ...(typeof payload.eventType === 'string' && payload.eventType.trim() !== '' ? { event_type: payload.eventType } : {}),
        ...(typeof payload.content === 'string' && payload.content.trim() !== '' ? { content: payload.content } : {})
      })
    });
    if (!response.ok) throw new Error('API_FAILED');
    return parseTimelineSimulateResult(json);
  });

  handleTrustedIpc(IPC_TIMELINE_LIST, async (_event, payload: unknown) => {
    if (!isTimelineListPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const cursor = typeof payload.cursor === 'string' ? payload.cursor : '0';
    const limit = typeof payload.limit === 'number' && Number.isFinite(payload.limit) ? payload.limit : 20;
    const qs = new URLSearchParams({
      save_id: payload.saveId,
      cursor,
      limit: String(Math.max(1, Math.min(200, Math.floor(limit))))
    });

    const { response, json } = await fetchAuthedJson(`/api/v1/timeline?${qs.toString()}`, {
      method: 'GET'
    });
    if (!response.ok) throw new Error('API_FAILED');
    return parseTimelineListResult(json);
  });
}

function registerSocialIpcHandlers() {
  handleTrustedIpc(IPC_SOCIAL_CREATE_ROOM, async (_event, payload: unknown) => {
    if (!isSocialCreateRoomPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const roomType = typeof payload.roomType === 'string' && payload.roomType.trim() !== '' ? payload.roomType.trim() : 'social';
    const { response, json } = await fetchAuthedJson('/api/v1/social/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_type: roomType })
    });
    if (!response.ok) throwApiErrorForStatus(response);
    return parseSocialRoomCreateResult(json);
  });

  handleTrustedIpc(IPC_SOCIAL_INVITE, async (_event, payload: unknown) => {
    if (!isSocialInvitePayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, json } = await fetchAuthedJson(
      `/api/v1/social/rooms/${encodeURIComponent(payload.roomId)}/invite`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_user_id: payload.targetUserId })
      }
    );
    if (!response.ok) throwApiErrorForStatus(response);
    return parseSocialRoomInviteResult(json);
  });

  handleTrustedIpc(IPC_SOCIAL_JOIN, async (_event, payload: unknown) => {
    if (!isSocialJoinPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    const { response, json } = await fetchAuthedJson(
      `/api/v1/social/rooms/${encodeURIComponent(payload.roomId)}/join`,
      { method: 'POST' },
    );
    if (!response.ok) throwApiErrorForStatus(response);
    return parseSocialRoomJoinResult(json);
  });
}

function registerUgcIpcHandlers() {
  handleTrustedIpc(IPC_UGC_LIST_APPROVED, async (): Promise<UgcApprovedAssetListItem[]> => {
    const { response, json } = await fetchAuthedJson('/api/v1/ugc/assets?status=approved', {
      method: 'GET'
    });
    if (!response.ok) throwApiErrorForStatus(response);
    if (!Array.isArray(json)) throw new Error('API_FAILED');

    return json
      .filter((it) => isObjectRecord(it))
      .map((it) => {
        const rec = it as Record<string, unknown>;
        const rawId = rec.id;
        const rawAssetType = rec.asset_type ?? rec.assetType;
        return {
          id: String(rawId ?? ''),
          asset_type: String(rawAssetType ?? '')
        };
      })
      .filter((it) => it.id.trim() !== '' && it.asset_type.trim() !== '');
  });
}

function registerPluginsIpcHandlers() {
  handleTrustedIpc(IPC_PLUGINS_GET_STATUS, async (): Promise<PluginStatus> => {
    return pluginManager.getStatus();
  });

  handleTrustedIpc(IPC_PLUGINS_GET_MENU_ITEMS, async (): Promise<PluginMenuItem[]> => {
    return pluginManager.getMenuItems();
  });

  handleTrustedIpc(IPC_PLUGINS_SET_ENABLED, async (_event, payload: unknown): Promise<PluginStatus> => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    return pluginManager.setEnabled(enabled);
  });

  handleTrustedIpc(IPC_PLUGINS_LIST_APPROVED, async (): Promise<ApprovedPluginListItem[]> => {
    return pluginManager.listApproved();
  });

  handleTrustedIpc(IPC_PLUGINS_INSTALL, async (_event, payload: unknown): Promise<PluginStatus> => {
    if (payload == null) return pluginManager.install();
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const pluginId = payload.pluginId;
    const version = payload.version;
    if (pluginId != null && typeof pluginId !== 'string') throw new Error('INVALID_PAYLOAD');
    if (version != null && typeof version !== 'string') throw new Error('INVALID_PAYLOAD');
    return pluginManager.install({
      pluginId: typeof pluginId === 'string' ? pluginId : undefined,
      version: typeof version === 'string' ? version : undefined
    });
  });

  handleTrustedIpc(IPC_PLUGINS_MENU_CLICK, async (_event, payload: unknown): Promise<{ ok: boolean }> => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const pluginId = payload.pluginId;
    const id = payload.id;
    if (typeof pluginId !== 'string' || typeof id !== 'string') throw new Error('INVALID_PAYLOAD');
    return pluginManager.clickMenuItem({ pluginId, id });
  });
}

function registerAssistantIpcHandlers() {
  handleTrustedIpc(IPC_ASSISTANT_SET_ENABLED, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    const saveId = payload.saveId;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    if (typeof saveId !== 'string') throw new Error('INVALID_PAYLOAD');
    assistantManager.setEnabled(enabled, saveId);
  });

  handleTrustedIpc(IPC_ASSISTANT_SET_IDLE_ENABLED, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    assistantManager.setIdleEnabled(enabled);
  });

  handleTrustedIpc(IPC_ASSISTANT_WRITE_CLIPBOARD_TEXT, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const text = payload.text;
    if (typeof text !== 'string') throw new Error('INVALID_PAYLOAD');
    assistantManager.writeClipboardText(text);
  });
}

function getDisabledUpdateState(): UpdateState {
  return {
    enabled: false,
    phase: 'disabled',
    currentVersion: app.getVersion(),
    availableVersion: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
    allowDowngrade: false,
    source: 'none'
  };
}

async function getParaAppVersion(): Promise<string> {
  const envV = process.env.PARA_APP_VERSION;
  if (typeof envV === 'string' && envV.trim() !== '') return envV.trim();

  let vFromApp = 'unknown';
  try {
    vFromApp = app.getVersion();
  } catch {
    vFromApp = 'unknown';
  }

  const electronV = process.versions.electron;
  const appVersionLooksLikeElectron = typeof electronV === 'string' && electronV.trim() !== '' && vFromApp === electronV;
  if (app.isPackaged && !appVersionLooksLikeElectron) return vFromApp;

  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf8');
    const obj = JSON.parse(raw) as { version?: unknown };
    if (typeof obj.version === 'string' && obj.version.trim() !== '') return obj.version.trim();
  } catch {
  }

  return vFromApp;
}

function registerAppIpcHandlers() {
  handleTrustedIpc('app:getVersion', async (): Promise<string> => {
    return getParaAppVersion();
  });
}

function registerUpdateIpcHandlers() {
  handleTrustedIpc(IPC_UPDATE_GET_STATE, async (): Promise<UpdateState> => {
    return updateManager ? updateManager.getState() : getDisabledUpdateState();
  });

  handleTrustedIpc(IPC_UPDATE_CHECK, async (): Promise<UpdateState> => {
    return updateManager ? updateManager.checkForUpdates() : getDisabledUpdateState();
  });

  handleTrustedIpc(IPC_UPDATE_DOWNLOAD, async (): Promise<UpdateState> => {
    return updateManager ? updateManager.downloadUpdate() : getDisabledUpdateState();
  });

  handleTrustedIpc(IPC_UPDATE_INSTALL, async (): Promise<UpdateState> => {
    return updateManager ? updateManager.installUpdate() : getDisabledUpdateState();
  });
}

function registerUserDataIpcHandlers() {
  handleTrustedIpc(IPC_USERDATA_GET_INFO, async () => {
    const appDataDir = app.getPath('appData');
    return {
      userDataDir: app.getPath('userData'),
      source: USERDATA_DIR_SOURCE,
      configPath: getParaInstallerConfigPath(appDataDir),
      envOverrideActive: typeof process.env.PARA_USER_DATA_DIR === 'string' && process.env.PARA_USER_DATA_DIR.trim() !== ''
    };
  });

  handleTrustedIpc(IPC_USERDATA_PICK_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const options: Electron.OpenDialogOptions = {
      title: '选择数据目录',
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    };

    let result: Electron.OpenDialogReturnValue;
    if (win) {
      result = await dialog.showOpenDialog(win, options);
    } else {
      result = await dialog.showOpenDialog(options);
    }

    if (result.canceled) return { canceled: true, path: null as string | null };
    const selected = result.filePaths?.[0];
    const p = typeof selected === 'string' && selected.trim() !== '' ? selected : null;
    return { canceled: false, path: p };
  });

  handleTrustedIpc(IPC_USERDATA_MIGRATE, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const targetDir = payload.targetDir;
    if (typeof targetDir !== 'string') throw new Error('INVALID_PAYLOAD');
    return migrateUserDataDirTo(targetDir);
  });

  handleTrustedIpc(IPC_APP_RELAUNCH, async () => {
    app.relaunch();
    app.exit(0);
  });
}

function registerSecurityIpcHandlers() {
  handleTrustedIpc(IPC_SECURITY_APPENC_GET_STATUS, async () => {
    return getAppEncStatusForRenderer();
  });

  handleTrustedIpc(IPC_SECURITY_APPENC_SET_ENABLED, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    return setAppEncDesiredEnabledAndPersist(enabled);
  });

  handleTrustedIpc(IPC_SECURITY_DEVOPTIONS_GET_STATUS, async () => {
    return getDevOptionsStatusForRenderer();
  });

  handleTrustedIpc(IPC_SECURITY_DEVOPTIONS_SET_ENABLED, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    return setDevOptionsDesiredEnabledAndPersist(enabled);
  });
}

function createMainWindow() {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.js');
  const devUrlRaw = process.env.VITE_DEV_SERVER_URL;
  const devUrl = typeof devUrlRaw === 'string' && devUrlRaw.trim() !== '' ? devUrlRaw : null;
  const devToolsEnabled = Boolean(devUrl);

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: '桌宠调试面板',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: SANDBOX_ENABLED,
      devTools: devToolsEnabled,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: preloadPath
    }
  });

  attachWebContentsDiagnosticsForTest(win);

  applyNavigationAndExternalGuards(win);

  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html');
    win.loadFile(indexHtml);
  }

  win.webContents.on('did-finish-load', () => {
    safeSendToRenderer(IPC_WS_STATUS, wsClient.getStatus());
    safeSendToRenderer(IPC_UPDATE_STATE, updateManager ? updateManager.getState() : getDisabledUpdateState());
  });

  return win;
}

function createPetWindow() {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.js');
  const devUrlRaw = process.env.VITE_DEV_SERVER_URL;
  const devUrl = typeof devUrlRaw === 'string' && devUrlRaw.trim() !== '' ? devUrlRaw : null;
  const devToolsEnabled = Boolean(devUrl);

  const win = new BrowserWindow({
    width: 320,
    height: 320,
    title: '桌宠',
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: SANDBOX_ENABLED,
      devTools: devToolsEnabled,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: preloadPath
    }
  });

  attachWebContentsDiagnosticsForTest(win);

  applyNavigationAndExternalGuards(win);

  win.setIgnoreMouseEvents(true, { forward: true });

  if (devUrl) {
    win.loadURL(`${devUrl}?window=pet`);
  } else {
    const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html');
    win.loadFile(indexHtml, { query: { window: 'pet' } });
  }

  return win;
}

function ensureMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }
  return mainWindow;
}

function ensurePetWindow(): BrowserWindow {
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = createPetWindow();
    if (petInteractive) {
      petWindow.setIgnoreMouseEvents(false);
    }
  }
  return petWindow;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示/隐藏桌宠',
      click: () => {
        const win = ensurePetWindow();
        if (win.isVisible()) {
          win.hide();
        } else {
          win.show();
        }
      }
    },
    {
      label: '打开调试面板',
      click: () => {
        const win = ensureMainWindow();
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    },
    {
      label: '切换可交互',
      type: 'checkbox',
      checked: petInteractive,
      click: () => {
        togglePetInteractivity();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      }
    }
  ]);
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function setPetInteractivity(nextInteractive: boolean): void {
  petInteractive = nextInteractive;
  const win = ensurePetWindow();

  if (petInteractive) {
    win.show();
    win.focus();
    win.setIgnoreMouseEvents(false);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  refreshTrayMenu();
}

function togglePetInteractivity(): void {
  setPetInteractivity(!petInteractive);
}

function setupTray(): void {
  if (tray) return;

  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZ+XioAAAAASUVORK5CYII='
  );

  tray = new Tray(icon);
  tray.setToolTip('Para');
  refreshTrayMenu();
}

app.whenReady().then(async () => {
  setupDefaultDenyPermissions();

  const appVersion = await getParaAppVersion();
  console.log(`[main] app_version=${appVersion}`);

  await initAppEncToggleFromDisk();
  await initDevOptionsToggleFromDisk();

  updateManager = await createUpdateManager({
    onState: (state) => {
      safeSendToAllRenderers(IPC_UPDATE_STATE, state);
    }
  });

  registerSecurityIpcHandlers();
  registerAppIpcHandlers();
  registerAuthIpcHandlers();
  registerByokIpcHandlers();
  registerWsIpcHandlers();
  registerSavesAndPersonasIpcHandlers();
  registerKnowledgeIpcHandlers();
  registerVisionIpcHandlers();
  registerGalleryIpcHandlers();
  registerTimelineIpcHandlers();
  registerSocialIpcHandlers();
  registerUgcIpcHandlers();
  registerAssistantIpcHandlers();
  registerPluginsIpcHandlers();
  registerUpdateIpcHandlers();
  registerUserDataIpcHandlers();

  await pluginManager.init();
  featureFlagsPoller.start();

  mainWindow = createMainWindow();
  petWindow = createPetWindow();
  setupTray();

  globalShortcut.register('CommandOrControl+Shift+P', () => {
    togglePetInteractivity();
  });

  app.on('activate', () => {
    const needMain = !mainWindow || mainWindow.isDestroyed();
    const needPet = !petWindow || petWindow.isDestroyed();
    if (!needMain && !needPet) return;

    if (needMain) mainWindow = createMainWindow();
    if (needPet) petWindow = createPetWindow();

    setupTray();
  });
});

app.on('will-quit', () => {
  featureFlagsPoller.stop();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
