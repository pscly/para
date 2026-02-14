import path from 'node:path';
import fs from 'node:fs/promises';
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

function getAuthTokensFilePath(): string {
  return path.join(app.getPath('userData'), AUTH_TOKENS_FILENAME);
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
    .filter(
      (it) =>
        it.id !== '' &&
        it.saveId !== '' &&
        it.eventType !== '' &&
        it.content !== '' &&
        it.createdAt !== ''
    );

  return { items, nextCursor: nextCursorStr };
}

function parseTimelineSimulateResult(json: unknown): TimelineSimulateResult {
  if (!isObjectRecord(json)) throw new Error('API_FAILED');
  const rec = json as Record<string, unknown>;

  const taskIdRaw = rec.task_id ?? rec.taskId;
  const taskId = typeof taskIdRaw === 'string' ? taskIdRaw.trim() : '';
  if (!taskId) throw new Error('API_FAILED');

  const idRaw = rec.timeline_event_id ?? rec.timelineEventId;
  const timelineEventId =
    typeof idRaw === 'string' && idRaw.trim() !== '' ? idRaw.trim() : undefined;

  return { taskId, timelineEventId };
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
      { method: 'GET' }
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
        ...(typeof payload.eventType === 'string' && payload.eventType.trim() !== ''
          ? { event_type: payload.eventType }
          : {}),
        ...(typeof payload.content === 'string' && payload.content.trim() !== ''
          ? { content: payload.content }
          : {})
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
    const limit =
      typeof payload.limit === 'number' && Number.isFinite(payload.limit) ? payload.limit : 20;
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

app.whenReady().then(() => {
  registerAuthIpcHandlers();
  registerWsIpcHandlers();
  registerSavesAndPersonasIpcHandlers();
  registerKnowledgeIpcHandlers();
  registerVisionIpcHandlers();
  registerGalleryIpcHandlers();
  registerTimelineIpcHandlers();
  registerAssistantIpcHandlers();

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
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
