import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';

const AUTH_TOKENS_FILENAME = 'auth.tokens.json';

const IPC_AUTH_SET_TOKENS = 'auth:setTokens';
const IPC_AUTH_GET_TOKENS = 'auth:getTokens';
const IPC_AUTH_CLEAR_TOKENS = 'auth:clearTokens';

const IPC_AUTH_LOGIN = 'auth:login';
const IPC_AUTH_ME = 'auth:me';
const IPC_AUTH_LOGOUT = 'auth:logout';

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

const IPC_WS_EVENT = 'ws:event';
const IPC_WS_STATUS = 'ws:status';

const DEFAULT_SERVER_BASE_URL = 'http://localhost:8000';

const paraUserDataDirOverride = process.env.PARA_USER_DATA_DIR;
if (typeof paraUserDataDirOverride === 'string' && paraUserDataDirOverride.trim() !== '') {
  app.setPath('userData', paraUserDataDirOverride);
}

type AuthTokensPayload = {
  accessToken: string;
  refreshToken: string;
};

type AuthLoginPayload = {
  email: string;
  password: string;
};

type LoginResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
};

type AuthMeResponse = {
  user_id: string | number;
  email: string;
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

function getPluginsRootDir(): string {
  return path.join(app.getPath('userData'), PLUGINS_DIRNAME);
}

function getPluginsStateFilePath(): string {
  return path.join(getPluginsRootDir(), PLUGINS_STATE_FILENAME);
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
  return (
    (typeof userId === 'string' || typeof userId === 'number') &&
    typeof value.email === 'string'
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

  private clearStatusDebounceTimer(): void {
    if (this.statusDebounceTimer) {
      clearTimeout(this.statusDebounceTimer);
      this.statusDebounceTimer = null;
    }
  }

  private cleanupSocket(): void {
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

  let loginResp: Response;
  try {
    loginResp = await fetch(buildApiUrl(baseUrl, '/api/v1/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }

  if (loginResp.status === 401) {
    throw new Error('BAD_CREDENTIALS');
  }
  if (!loginResp.ok) {
    throw new Error('AUTH_LOGIN_FAILED');
  }

  const loginJson = await readJsonResponse(loginResp);
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

async function fetchAuthedJson(
  apiPath: string,
  init: RequestInit & { headers?: Record<string, string> }
): Promise<{ response: Response; json: unknown }> {
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

  const json = await readJsonResponse(resp);
  return { response: resp, json };
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

function isStoredAuthTokensFile(value: unknown): value is StoredAuthTokensFile {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.secure === 'boolean' &&
    typeof value.accessToken === 'string' &&
    typeof value.refreshToken === 'string'
  );
}

async function writeAuthTokensToDisk(payload: AuthTokensPayload): Promise<{ secure: boolean }> {
  const secure = safeStorage.isEncryptionAvailable();

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
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      secure: false
    };
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

function registerAuthIpcHandlers() {
  ipcMain.handle(IPC_AUTH_SET_TOKENS, async (_event, payload: unknown) => {
    if (!isAuthTokensPayload(payload)) {
      throw new Error('Invalid payload for auth:setTokens');
    }
    return writeAuthTokensToDisk(payload);
  });

  ipcMain.handle(IPC_AUTH_GET_TOKENS, async () => {
    return readAuthTokensFromDisk();
  });

  ipcMain.handle(IPC_AUTH_CLEAR_TOKENS, async () => {
    await clearAuthTokensOnDisk();
  });

  ipcMain.handle(IPC_AUTH_LOGIN, async (_event, payload: unknown) => {
    if (!isAuthLoginPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }

    return loginAndGetMe(payload.email, payload.password);
  });

  ipcMain.handle(IPC_AUTH_ME, async () => {
    return readMeFromDiskToken();
  });

  ipcMain.handle(IPC_AUTH_LOGOUT, async () => {
    await clearAuthTokensOnDisk();
  });
}

function registerWsIpcHandlers() {
  ipcMain.handle(IPC_WS_CONNECT, async (_event, payload: unknown) => {
    return wsClient.connect(payload as WsConnectPayload);
  });

  ipcMain.handle(IPC_WS_DISCONNECT, async () => {
    return wsClient.disconnect();
  });

  ipcMain.handle(IPC_WS_CHAT_SEND, async (_event, payload: unknown) => {
    wsClient.chatSend(payload as WsChatSendPayload);
  });

  ipcMain.handle(IPC_WS_INTERRUPT, async () => {
    wsClient.interrupt();
  });
}

function registerSavesAndPersonasIpcHandlers() {
  ipcMain.handle(IPC_SAVES_LIST, async () => {
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

  ipcMain.handle(IPC_SAVES_CREATE, async (_event, payload: unknown) => {
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

  ipcMain.handle(IPC_SAVES_BIND_PERSONA, async (_event, payload: unknown) => {
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

  ipcMain.handle(IPC_PERSONAS_LIST, async () => {
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
  ipcMain.handle(IPC_KNOWLEDGE_UPLOAD_MATERIAL, async (_event, payload: unknown) => {
    if (!isKnowledgeUploadPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }
    return uploadKnowledgeMaterial(payload);
  });

  ipcMain.handle(IPC_KNOWLEDGE_MATERIAL_STATUS, async (_event, payload: unknown) => {
    if (!isKnowledgeMaterialStatusPayload(payload)) {
      throw new Error('INVALID_PAYLOAD');
    }
    return readKnowledgeMaterialStatus(payload.id);
  });
}

function registerVisionIpcHandlers() {
  ipcMain.handle(IPC_VISION_UPLOAD_SCREENSHOT, async (_event, payload: unknown) => {
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
  ipcMain.handle(IPC_GALLERY_GENERATE, async (_event, payload: unknown) => {
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

  ipcMain.handle(IPC_GALLERY_LIST, async (_event, payload: unknown) => {
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
}

function registerTimelineIpcHandlers() {
  ipcMain.handle(IPC_TIMELINE_SIMULATE, async (_event, payload: unknown) => {
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

  ipcMain.handle(IPC_TIMELINE_LIST, async (_event, payload: unknown) => {
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
  ipcMain.handle(IPC_SOCIAL_CREATE_ROOM, async (_event, payload: unknown) => {
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

  ipcMain.handle(IPC_SOCIAL_INVITE, async (_event, payload: unknown) => {
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

  ipcMain.handle(IPC_SOCIAL_JOIN, async (_event, payload: unknown) => {
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
  ipcMain.handle(IPC_UGC_LIST_APPROVED, async (): Promise<UgcApprovedAssetListItem[]> => {
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
  ipcMain.handle(IPC_PLUGINS_GET_STATUS, async (): Promise<PluginStatus> => {
    return pluginManager.getStatus();
  });

  ipcMain.handle(IPC_PLUGINS_GET_MENU_ITEMS, async (): Promise<PluginMenuItem[]> => {
    return pluginManager.getMenuItems();
  });

  ipcMain.handle(IPC_PLUGINS_SET_ENABLED, async (_event, payload: unknown): Promise<PluginStatus> => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    return pluginManager.setEnabled(enabled);
  });

  ipcMain.handle(IPC_PLUGINS_LIST_APPROVED, async (): Promise<ApprovedPluginListItem[]> => {
    return pluginManager.listApproved();
  });

  ipcMain.handle(IPC_PLUGINS_INSTALL, async (_event, payload: unknown): Promise<PluginStatus> => {
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

  ipcMain.handle(IPC_PLUGINS_MENU_CLICK, async (_event, payload: unknown): Promise<{ ok: boolean }> => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const pluginId = payload.pluginId;
    const id = payload.id;
    if (typeof pluginId !== 'string' || typeof id !== 'string') throw new Error('INVALID_PAYLOAD');
    return pluginManager.clickMenuItem({ pluginId, id });
  });
}

function registerAssistantIpcHandlers() {
  ipcMain.handle(IPC_ASSISTANT_SET_ENABLED, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    const saveId = payload.saveId;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    if (typeof saveId !== 'string') throw new Error('INVALID_PAYLOAD');
    assistantManager.setEnabled(enabled, saveId);
  });

  ipcMain.handle(IPC_ASSISTANT_SET_IDLE_ENABLED, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const enabled = payload.enabled;
    if (typeof enabled !== 'boolean') throw new Error('INVALID_PAYLOAD');
    assistantManager.setIdleEnabled(enabled);
  });

  ipcMain.handle(IPC_ASSISTANT_WRITE_CLIPBOARD_TEXT, async (_event, payload: unknown) => {
    if (!isObjectRecord(payload)) throw new Error('INVALID_PAYLOAD');
    const text = payload.text;
    if (typeof text !== 'string') throw new Error('INVALID_PAYLOAD');
    assistantManager.writeClipboardText(text);
  });
}

function createMainWindow() {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.js');

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: '桌宠调试面板',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html');
    win.loadFile(indexHtml);
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    safeSendToRenderer(IPC_WS_STATUS, wsClient.getStatus());
  });

  return win;
}

function createPetWindow() {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.js');

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
      preload: preloadPath
    }
  });

  win.setIgnoreMouseEvents(true, { forward: true });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(`${devUrl}?window=pet`);
  } else {
    const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html');
    win.loadFile(indexHtml, { query: { window: 'pet' } });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

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
  registerAuthIpcHandlers();
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
