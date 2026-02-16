import React from 'react';
import { TEST_IDS } from './testIds';

type SaveListItem = {
  id: string;
  name: string;
  persona_id?: string | null;
};

type PersonaListItem = {
  id: string;
  name: string;
  version: number;
};

type KnowledgeMaterialStatus = 'pending' | 'indexed' | 'failed';

type KnowledgeMaterial = {
  id: string;
  status: KnowledgeMaterialStatus;
  error?: string;
};

type VisionPrivacyMode = 'strict' | 'standard';

type GalleryItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'canceled';

type GalleryItem = {
  id: string;
  status: GalleryItemStatus | string;
  created_at: string;
  prompt: string;
};

type TimelineEventItem = {
  id: string;
  saveId: string;
  eventType: string;
  content: string;
  createdAt: string;
};

type SocialRoomEventItem = {
  key: string;
  text: string;
};

type UgcApprovedAssetListItem = {
  id: string;
  asset_type: string;
  status?: string;
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

type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'error';

type UpdateState = {
  enabled: boolean;
  phase: UpdatePhase | string;
  currentVersion: string;
  availableVersion: string | null;
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null;
  error: string | null;
  lastCheckedAt: string | null;
  allowDowngrade: boolean;
  source: 'real' | 'fake' | 'none' | string;
};

type DesktopApiExt = NonNullable<Window['desktopApi']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBlobUrl(url: string): boolean {
  return url.startsWith('blob:');
}

function bytesToPngDataUrl(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let part = '';
    for (let j = 0; j < chunk.length; j += 1) {
      part += String.fromCharCode(chunk[j] ?? 0);
    }
    binary += part;
  }
  const b64 = window.btoa(binary);
  return `data:image/png;base64,${b64}`;
}

function bytesToImageUrl(bytes: Uint8Array): string {
  try {
    let ab: ArrayBuffer;
    if (bytes.buffer instanceof ArrayBuffer) {
      ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      ab = copy.buffer;
    }

    const blobUrl = URL.createObjectURL(new Blob([ab as any], { type: 'image/png' }));
    if (typeof blobUrl === 'string' && blobUrl.trim() !== '') return blobUrl;
  } catch {
  }
  return bytesToPngDataUrl(bytes);
}

function getUnsubscribe(ret: unknown): (() => void) | null {
  if (typeof ret === 'function') return ret as () => void;
  if (isRecord(ret) && typeof ret.unsubscribe === 'function') return ret.unsubscribe as () => void;
  return null;
}

function formatRoomEventText(frame: Record<string, unknown>): SocialRoomEventItem | null {
  const payload = frame.payload;
  const serverEventId = typeof frame.server_event_id === 'string' ? frame.server_event_id : '';

  let text = '';
  if (isRecord(payload)) {
    const eventName = typeof payload.event === 'string' ? payload.event : 'ROOM_EVENT';
    const roomId = typeof payload.room_id === 'string' ? payload.room_id : '';
    const actor = typeof payload.actor_user_id === 'string' ? payload.actor_user_id : '';
    const target = typeof payload.target_user_id === 'string' ? payload.target_user_id : '';
    const at = typeof payload.created_at === 'string' ? payload.created_at : '';

    const parts = [eventName];
    if (roomId) parts.push(`room=${roomId}`);
    if (actor) parts.push(`actor=${actor}`);
    if (target) parts.push(`target=${target}`);
    if (at) parts.push(`at=${at}`);
    text = parts.join(' ');
  } else {
    try {
      text = `ROOM_EVENT ${JSON.stringify(payload)}`;
    } catch {
      text = 'ROOM_EVENT (unparseable payload)';
    }
  }

  if (text.trim() === '') return null;
  const key = serverEventId || `room_evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return { key, text };
}

function toStatusLabel(status: unknown): string {
  if (typeof status === 'string') {
    if (status === 'connected') return '已连接';
    if (status === 'reconnecting') return '重连中';
    if (status === 'disconnected') return '未连接';
    if (status === 'CONNECTED') return '已连接';
    if (status === 'CONNECTING') return '连接中';
    if (status === 'RECONNECTING') return '重连中';
    if (status === 'DISCONNECTED') return '未连接';
    return status;
  }
  if (isRecord(status)) {
    const s = status.status;
    if (typeof s === 'string') return toStatusLabel(s);
  }
  return '未连接';
}

function toUpdatePhaseLabel(phase: unknown): string {
  if (typeof phase !== 'string') return '未知';
  if (phase === 'disabled') return '未启用';
  if (phase === 'idle') return '空闲';
  if (phase === 'checking') return '检查中…';
  if (phase === 'available') return '发现更新';
  if (phase === 'not-available') return '已是最新';
  if (phase === 'downloading') return '下载中…';
  if (phase === 'downloaded') return '已下载';
  if (phase === 'installing') return '安装中…';
  if (phase === 'installed') return '已安装';
  if (phase === 'error') return '错误';
  return phase;
}

function clampPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : 0;
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function newClientRequestId(): string {
  const uuid = window.crypto?.randomUUID?.();
  if (typeof uuid === 'string' && uuid) return uuid;
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function App() {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [loginError, setLoginError] = React.useState('');
  const [loggedInEmail, setLoggedInEmail] = React.useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = React.useState(false);

  const [chatInput, setChatInput] = React.useState('');
  const [lastAiMessage, setLastAiMessage] = React.useState('还没有 AI 回复');
  const [wsStatusLabel, setWsStatusLabel] = React.useState('未连接');
  const [chatMeta, setChatMeta] = React.useState('');

  const [activeSaveId, setActiveSaveId] = React.useState<string>('default');
  const [saveCreateName, setSaveCreateName] = React.useState('');
  const [saves, setSaves] = React.useState<SaveListItem[]>([]);
  const [personas, setPersonas] = React.useState<PersonaListItem[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = React.useState('');
  const [saveUiError, setSaveUiError] = React.useState('');
  const [saveUiInfo, setSaveUiInfo] = React.useState('');

  const [feedPhase, setFeedPhase] = React.useState<'idle' | 'uploading' | 'indexing' | 'done' | 'error'>(
    'idle',
  );
  const [feedFilename, setFeedFilename] = React.useState('');
  const [feedError, setFeedError] = React.useState('');

  const [visionEnabled, setVisionEnabled] = React.useState(false);
  const [visionConsentOpen, setVisionConsentOpen] = React.useState(false);
  const [visionSuggestion, setVisionSuggestion] = React.useState('还没有建议');
  const [visionError, setVisionError] = React.useState('');
  const [visionSending, setVisionSending] = React.useState(false);

  const [assistantEnabled, setAssistantEnabled] = React.useState(false);
  const [assistantIdleEnabled, setAssistantIdleEnabled] = React.useState(false);
  const [assistantSuggestion, setAssistantSuggestion] = React.useState('还没有建议');
  const [assistantCategory, setAssistantCategory] = React.useState('');
  const [assistantUiError, setAssistantUiError] = React.useState('');

  const [galleryPrompt, setGalleryPrompt] = React.useState('一段记忆胶囊');
  const [galleryItems, setGalleryItems] = React.useState<GalleryItem[]>([]);
  const [galleryBusy, setGalleryBusy] = React.useState(false);
  const [galleryUiError, setGalleryUiError] = React.useState('');
  const [galleryImageUrls, setGalleryImageUrls] = React.useState<Record<string, string>>({});
  const galleryImageUrlsRef = React.useRef<Record<string, string>>({});
  const galleryImageLoadingRef = React.useRef<Set<string>>(new Set());

  const [timelineItems, setTimelineItems] = React.useState<TimelineEventItem[]>([]);
  const [timelineBusy, setTimelineBusy] = React.useState(false);
  const [timelineUiError, setTimelineUiError] = React.useState('');

  const [socialRoomId, setSocialRoomId] = React.useState('');
  const [socialTargetUserId, setSocialTargetUserId] = React.useState('');
  const [socialUiError, setSocialUiError] = React.useState('');
  const [socialUiInfo, setSocialUiInfo] = React.useState('');
  const [socialBusy, setSocialBusy] = React.useState(false);
  const [socialRoomEvents, setSocialRoomEvents] = React.useState<SocialRoomEventItem[]>([]);

  const [ugcAssets, setUgcAssets] = React.useState<UgcApprovedAssetListItem[]>([]);
  const [ugcBusy, setUgcBusy] = React.useState(false);
  const [ugcUiError, setUgcUiError] = React.useState('');

  const [pluginsStatus, setPluginsStatus] = React.useState<PluginStatus | null>(null);
  const [pluginsApproved, setPluginsApproved] = React.useState<ApprovedPluginListItem[]>([]);
  const [pluginsSelectedKey, setPluginsSelectedKey] = React.useState<string>('');
  const [pluginsBusy, setPluginsBusy] = React.useState(false);
  const [pluginsUiError, setPluginsUiError] = React.useState('');
  const [pluginsConsentOpen, setPluginsConsentOpen] = React.useState(false);

  const [updateState, setUpdateState] = React.useState<UpdateState | null>(null);
  const [updateUiError, setUpdateUiError] = React.useState('');
  const [updateBusy, setUpdateBusy] = React.useState(false);

  const socialSeenEventIdsRef = React.useRef<Set<string>>(new Set());

  const galleryPollTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const feedAbortRef = React.useRef<AbortController | null>(null);

  const activeClientRequestIdRef = React.useRef<string | null>(null);
  const activeRequestDoneRef = React.useRef<boolean>(false);

  const versions = window.desktopApi?.versions;

  React.useEffect(() => {
    const api = window.desktopApi;
    const plugins = api?.plugins;
    if (!plugins) return;
    void plugins
      .getStatus()
      .then((status) => setPluginsStatus(status ?? null))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    const update = window.desktopApi?.update;
    if (!update) return;

    void update
      .getState()
      .then((s) => setUpdateState(s as any))
      .catch(() => {});

    let unsub: (() => void) | null = null;
    try {
      unsub = getUnsubscribe(update.onState((s) => setUpdateState(s as any)));
    } catch {
      unsub = null;
    }

    return () => {
      try {
        unsub?.();
      } catch {
      }
    };
  }, []);

  React.useEffect(() => {
    galleryImageUrlsRef.current = galleryImageUrls;
  }, [galleryImageUrls]);

  React.useEffect(() => {
    return () => {
      for (const url of Object.values(galleryImageUrlsRef.current)) {
        try {
          if (isBlobUrl(url)) URL.revokeObjectURL(url);
        } catch {
        }
      }
    };
  }, []);

  React.useEffect(() => {
    const keep = new Set(
      galleryItems
        .filter((it) => String(it.status) === 'completed')
        .map((it) => it.id),
    );

    setGalleryImageUrls((prev) => {
      const next: Record<string, string> = {};
      for (const [id, url] of Object.entries(prev)) {
        if (keep.has(id)) next[id] = url;
        else {
          try {
            if (isBlobUrl(url)) URL.revokeObjectURL(url);
          } catch {
          }
        }
      }
      return next;
    });
  }, [galleryItems]);

  React.useEffect(() => {
    const gallery = window.desktopApi?.gallery;
    if (!gallery) return;

    const completed = galleryItems.filter((it) => String(it.status) === 'completed');
    const toFetch = completed
      .map((it) => it.id)
      .filter((id) => !(id in galleryImageUrlsRef.current) && !galleryImageLoadingRef.current.has(id));

    if (toFetch.length === 0) return;

    for (const id of toFetch) galleryImageLoadingRef.current.add(id);

    void (async () => {
      const fresh: Record<string, string> = {};

      for (const id of toFetch) {
        try {
          let buf: ArrayBuffer;
          try {
            buf = await gallery.download({ galleryId: id, kind: 'thumb' });
          } catch {
            buf = await gallery.download({ galleryId: id, kind: 'image' });
          }

          let u8: Uint8Array;
          try {
            u8 = new Uint8Array(buf);
          } catch {
            u8 = new Uint8Array(0);
          }
          if (u8.byteLength === 0) continue;
          fresh[id] = bytesToImageUrl(u8);
        } catch {
        } finally {
          galleryImageLoadingRef.current.delete(id);
        }
      }

      if (Object.keys(fresh).length > 0) {
        setGalleryImageUrls((prev) => ({ ...prev, ...fresh }));
      }
    })();
  }, [galleryItems]);

  React.useEffect(() => {
    const ws = window.desktopApi?.ws;
    if (!ws) return;

    const unsubscribes: Array<() => void> = [];

    const unsubStatus = getUnsubscribe(
      ws.onStatus((status: unknown) => {
        setWsStatusLabel(toStatusLabel(status));
      }),
    );
    if (unsubStatus) unsubscribes.push(unsubStatus);

    const unsubEvent = getUnsubscribe(
      ws.onEvent((frame: unknown) => {
        if (!isRecord(frame)) return;
        const type = frame.type;
        if (typeof type !== 'string') return;

        if (type === 'ROOM_EVENT') {
          const serverEventId = typeof frame.server_event_id === 'string' ? frame.server_event_id : '';
          if (serverEventId && socialSeenEventIdsRef.current.has(serverEventId)) return;
          if (serverEventId) socialSeenEventIdsRef.current.add(serverEventId);

          const item = formatRoomEventText(frame);
          if (!item) return;
          setSocialRoomEvents((prev) => {
            const next = [...prev, item];
            return next.length > 80 ? next.slice(next.length - 80) : next;
          });
          return;
        }

        if (type === 'CHAT_TOKEN') {
          const payload = frame.payload;
          const token = isRecord(payload) ? payload.token : undefined;
          if (typeof token !== 'string' || token.length === 0) return;

          const frameClientRequestId =
            typeof frame.clientRequestId === 'string' ? (frame.clientRequestId as string) : null;

          if (activeRequestDoneRef.current) return;
          if (
            activeClientRequestIdRef.current &&
            frameClientRequestId &&
            frameClientRequestId !== activeClientRequestIdRef.current
          ) {
            return;
          }

          setLastAiMessage((prev) => prev + token);
          return;
        }

        if (type === 'CHAT_DONE') {
          activeRequestDoneRef.current = true;

          const payload = frame.payload;
          const reason = isRecord(payload) ? payload.reason : undefined;
          if (typeof reason === 'string' && reason) setChatMeta(`完成：${reason}`);
          else setChatMeta('完成');
        }
      }),
    );
    if (unsubEvent) unsubscribes.push(unsubEvent);

    return () => {
      for (const unsub of unsubscribes) {
        try {
          unsub();
        } catch {
        }
      }
    };
  }, []);

  React.useEffect(() => {
    return () => {
      if (galleryPollTimerRef.current) {
        clearInterval(galleryPollTimerRef.current);
        galleryPollTimerRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    const api = window.desktopApi;
    const assistant = api?.assistant;
    if (!assistant?.onSuggestion) return;

    const unsub = getUnsubscribe(
      assistant.onSuggestion((payload: unknown) => {
        if (!isRecord(payload)) return;
        const suggestion = payload.suggestion;
        const category = payload.category;

        if (typeof suggestion === 'string' && suggestion.trim() !== '') setAssistantSuggestion(suggestion);
        else setAssistantSuggestion('（空建议）');

        if (typeof category === 'string') setAssistantCategory(category);
        else setAssistantCategory('');
      }),
    );

    return () => {
      try {
        unsub?.();
      } catch {
      }
    };
  }, []);

  React.useEffect(() => {
    return () => {
      try {
        feedAbortRef.current?.abort();
      } catch {
      }
    };
  }, []);

  function getErrorCode(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (typeof err === 'object' && err !== null && 'message' in err) {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string') return msg;
    }
    return 'UNKNOWN';
  }

  function toReadableLoginError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('BAD_CREDENTIALS')) return '邮箱或密码错误';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('SAFE_STORAGE_UNAVAILABLE')) {
      return '本机安全存储不可用，无法安全保存登录态（已禁止明文保存 token）。请先修复系统密钥环/凭据服务或更换到受支持的桌面环境后重试。';
    }
    return '登录失败';
  }

  function toReadableSaveUiError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('NOT_LOGGED_IN')) return '请先登录';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('API_FAILED')) return '请求失败';
    if (code.includes('INVALID_PAYLOAD')) return '参数不正确';
    return '操作失败';
  }

  function toReadableKnowledgeError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('INVALID_PAYLOAD')) return '文件不正确';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('API_FAILED')) return '请求失败';
    if (code.includes('TIMEOUT')) return '索引超时';
    return '投喂失败';
  }

  function toReadableVisionError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('NOT_LOGGED_IN')) return '请先登录';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('API_FAILED')) return '请求失败';
    if (code.includes('INVALID_PAYLOAD')) return '参数不正确';
    return '发送失败';
  }

  function toReadableAssistantError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('NOT_LOGGED_IN')) return '请先登录';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('API_FAILED')) return '请求失败';
    if (code.includes('INVALID_PAYLOAD')) return '参数不正确';
    return '助手操作失败';
  }

  function toReadableGalleryError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('NOT_LOGGED_IN')) return '请先登录';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('API_FAILED')) return '请求失败';
    if (code.includes('INVALID_PAYLOAD')) return '参数不正确';
    return '相册操作失败';
  }

  function toReadableTimelineError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('NOT_LOGGED_IN')) return '请先登录';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('API_FAILED')) return '请求失败';
    if (code.includes('INVALID_PAYLOAD')) return '参数不正确';
    return '时间轴操作失败';
  }

  function toReadableSocialError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('NOT_LOGGED_IN')) return '请先登录';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('FORBIDDEN')) return '没有权限（可能未被邀请/无管理权限）';
    if (code.includes('NOT_FOUND')) return '房间不存在';
    if (code.includes('INVALID_PAYLOAD')) return '参数不正确';
    if (code.includes('API_FAILED')) return '请求失败';
    return '社交房间操作失败';
  }

  function toReadableUgcError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('NOT_LOGGED_IN')) return '请先登录';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('FORBIDDEN')) return '没有权限';
    if (code.includes('NOT_FOUND')) return '接口不存在';
    if (code.includes('INVALID_PAYLOAD')) return '参数不正确';
    if (code.includes('API_FAILED')) return '请求失败';
    return 'UGC 拉取失败';
  }

  function toReadablePluginsError(err: unknown): string {
    const code = getErrorCode(err);
    if (code.includes('NOT_LOGGED_IN')) return '请先登录';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('NO_APPROVED_PLUGINS')) return '暂无已审核插件（approved 列表为空）';
    if (code.includes('SHA256_MISMATCH')) return '插件校验失败（sha256 不匹配）';
    if (code.includes('PERMISSIONS_REQUIRED')) return '插件 manifest.permissions 缺失（必须显式声明）';
    if (code.includes('PLUGIN_NOT_INSTALLED_ON_DISK')) return '插件未安装到本地（请先安装）';
    if (code.includes('API_FAILED')) return '请求失败';
    if (code.includes('INVALID_PAYLOAD')) return '参数不正确';
    return '插件操作失败';
  }

  function toGalleryStatusLabel(status: unknown): string {
    if (status === 'pending') return '生成中';
    if (status === 'running') return '生成中';
    if (status === 'completed') return '已完成';
    if (status === 'failed') return '失败';
    if (status === 'canceled') return '已取消';
    if (typeof status === 'string' && status.trim() !== '') return status;
    return 'unknown';
  }

  function formatGalleryTime(raw: string | undefined): string {
    if (!raw) return '';
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return raw;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function getDesktopApiExt(): DesktopApiExt | null {
    const api = window.desktopApi;
    if (!api) return null;
    return api;
  }

  function isMdFile(file: File): boolean {
    const name = file.name.toLowerCase();
    if (name.endsWith('.md')) return true;
    if (file.type === 'text/markdown') return true;
    return false;
  }

  async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function pollMaterialUntilDone(
    knowledge: NonNullable<DesktopApiExt['knowledge']>,
    id: string,
    signal: AbortSignal,
  ): Promise<KnowledgeMaterial> {
    const started = Date.now();
    while (!signal.aborted) {
      const m = await knowledge.materialStatus(id);
      if (m.status === 'indexed' || m.status === 'failed') return m;
      if (Date.now() - started > 30_000) {
        throw new Error('TIMEOUT');
      }
      await sleep(400, signal);
    }
    throw new Error('ABORTED');
  }

  async function refreshGalleryList(opts?: { silent?: boolean }) {
    const api = getDesktopApiExt();
    const gallery = api?.gallery;
    if (!gallery) {
      if (!opts?.silent) setGalleryUiError('相册接口不可用');
      return;
    }

    try {
      const list = await gallery.list(activeSaveId);
      setGalleryItems(Array.isArray(list) ? list : []);
      if (!opts?.silent) setGalleryUiError('');
    } catch (err: unknown) {
      if (!opts?.silent) setGalleryUiError(toReadableGalleryError(err));
    }
  }

  async function onGalleryRefresh() {
    if (galleryBusy) return;
    setGalleryUiError('');
    setGalleryBusy(true);
    try {
      await refreshGalleryList();
    } finally {
      setGalleryBusy(false);
    }
  }

  async function onGalleryGenerate() {
    if (galleryBusy) return;
    setGalleryUiError('');

    const prompt = galleryPrompt.trim();
    if (!prompt) {
      setGalleryUiError('请输入 prompt');
      return;
    }

    const api = getDesktopApiExt();
    const gallery = api?.gallery;
    if (!gallery) {
      setGalleryUiError('相册接口不可用');
      return;
    }

    setGalleryBusy(true);
    try {
      const created = await gallery.generate({ saveId: activeSaveId, prompt });
      setGalleryItems((prev) => {
        const exists = prev.some((it) => it.id === created.id);
        if (exists) return prev;
        const optimistic: GalleryItem = {
          id: created.id,
          status: created.status || 'pending',
          created_at: new Date().toISOString(),
          prompt
        };
        return [optimistic, ...prev];
      });
      await refreshGalleryList({ silent: true });
    } catch (err: unknown) {
      setGalleryUiError(toReadableGalleryError(err));
    } finally {
      setGalleryBusy(false);
    }
  }

  async function refreshTimelineList(opts?: { silent?: boolean }) {
    const api = getDesktopApiExt();
    const timeline = api?.timeline;
    if (!timeline) {
      if (!opts?.silent) setTimelineUiError('时间轴接口不可用');
      return;
    }

    try {
      const res = await timeline.list({ saveId: activeSaveId, cursor: '0', limit: 20 });
      setTimelineItems(Array.isArray(res?.items) ? res.items : []);
      if (!opts?.silent) setTimelineUiError('');
    } catch (err: unknown) {
      if (!opts?.silent) setTimelineUiError(toReadableTimelineError(err));
    }
  }

  async function onTimelineRefresh() {
    if (timelineBusy) return;
    setTimelineUiError('');
    setTimelineBusy(true);
    try {
      await refreshTimelineList();
    } finally {
      setTimelineBusy(false);
    }
  }

  async function onTimelineSimulate() {
    if (timelineBusy) return;
    setTimelineUiError('');

    const api = getDesktopApiExt();
    const timeline = api?.timeline;
    if (!timeline) {
      setTimelineUiError('时间轴接口不可用');
      return;
    }

    setTimelineBusy(true);
    try {
      await timeline.simulate({ saveId: activeSaveId });
      await refreshTimelineList({ silent: true });
    } catch (err: unknown) {
      setTimelineUiError(toReadableTimelineError(err));
    } finally {
      setTimelineBusy(false);
    }
  }

  async function onSocialCreateRoom() {
    if (socialBusy) return;
    setSocialUiError('');
    setSocialUiInfo('');

    const api = getDesktopApiExt();
    const social = api?.social;
    if (!social) {
      setSocialUiError('社交接口不可用');
      return;
    }

    setSocialBusy(true);
    try {
      const created = await social.createRoom({ roomType: 'social' });
      setSocialRoomId(created.id);
      setSocialUiInfo(`已创建房间：${created.id}`);
    } catch (err: unknown) {
      setSocialUiError(toReadableSocialError(err));
    } finally {
      setSocialBusy(false);
    }
  }

  async function onSocialInvite() {
    if (socialBusy) return;
    setSocialUiError('');
    setSocialUiInfo('');

    const roomId = socialRoomId.trim();
    if (!roomId) {
      setSocialUiError('请先创建房间');
      return;
    }
    const targetUserId = socialTargetUserId.trim();
    if (!targetUserId) {
      setSocialUiError('请输入 target user_id');
      return;
    }

    const api = getDesktopApiExt();
    const social = api?.social;
    if (!social) {
      setSocialUiError('社交接口不可用');
      return;
    }

    setSocialBusy(true);
    try {
      const res = await social.invite({ roomId, targetUserId });
      setSocialUiInfo(`已邀请：${res.targetUserId}（status=${res.status}）`);
    } catch (err: unknown) {
      setSocialUiError(toReadableSocialError(err));
    } finally {
      setSocialBusy(false);
    }
  }

  async function refreshUgcApprovedAssets(opts?: { silent?: boolean }) {
    const api = getDesktopApiExt();
    const ugc = api?.ugc;
    if (!ugc) {
      if (!opts?.silent) setUgcUiError('UGC 接口不可用');
      return;
    }

    try {
      const list = await ugc.listApproved();
      setUgcAssets(Array.isArray(list) ? list : []);
      if (!opts?.silent) setUgcUiError('');
    } catch (err: unknown) {
      if (!opts?.silent) setUgcUiError(toReadableUgcError(err));
    }
  }

  async function onUgcRefresh() {
    if (ugcBusy) return;
    setUgcUiError('');
    setUgcBusy(true);
    try {
      await refreshUgcApprovedAssets();
    } finally {
      setUgcBusy(false);
    }
  }

  function makePluginKey(it: { id: string; version: string }): string {
    return `${it.id}@@${it.version}`;
  }

  function parsePluginKey(key: string): { pluginId: string; version: string } | null {
    const idx = key.indexOf('@@');
    if (idx <= 0) return null;
    const pluginId = key.slice(0, idx).trim();
    const version = key.slice(idx + 2).trim();
    if (!pluginId || !version) return null;
    return { pluginId, version };
  }

  async function refreshPluginsStatus(opts?: { silent?: boolean }) {
    const api = getDesktopApiExt();
    const plugins = api?.plugins;
    if (!plugins) {
      if (!opts?.silent) setPluginsUiError('Plugins 接口不可用');
      return;
    }

    try {
      const status = await plugins.getStatus();
      setPluginsStatus(status ?? null);
      if (!opts?.silent) setPluginsUiError('');
    } catch (err: unknown) {
      if (!opts?.silent) setPluginsUiError(toReadablePluginsError(err));
    }
  }

  async function refreshPluginsApproved(opts?: { silent?: boolean }) {
    const api = getDesktopApiExt();
    const plugins = api?.plugins;
    if (!plugins) {
      if (!opts?.silent) setPluginsUiError('Plugins 接口不可用');
      return;
    }

    try {
      const list = await plugins.listApproved();
      const safe = Array.isArray(list) ? list : [];
      setPluginsApproved(safe);

      if (safe.length > 0 && !pluginsSelectedKey) {
        setPluginsSelectedKey(makePluginKey(safe[0]));
      }

      if (!opts?.silent) setPluginsUiError('');
    } catch (err: unknown) {
      if (!opts?.silent) setPluginsUiError(toReadablePluginsError(err));
    }
  }

  async function onPluginsRefresh() {
    if (pluginsBusy) return;
    setPluginsUiError('');
    setPluginsBusy(true);
    try {
      await refreshPluginsApproved();
      await refreshPluginsStatus({ silent: true });
    } finally {
      setPluginsBusy(false);
    }
  }

  async function onPluginsToggle() {
    if (pluginsBusy) return;
    setPluginsUiError('');

    const api = getDesktopApiExt();
    const plugins = api?.plugins;
    if (!plugins) {
      setPluginsUiError('Plugins 接口不可用');
      return;
    }

    if (!(pluginsStatus?.enabled ?? false)) {
      setPluginsConsentOpen(true);
      return;
    }

    setPluginsBusy(true);
    try {
      const status = await plugins.setEnabled(false);
      setPluginsStatus(status ?? null);
    } catch (err: unknown) {
      setPluginsUiError(toReadablePluginsError(err));
    } finally {
      setPluginsBusy(false);
      setPluginsConsentOpen(false);
    }
  }

  async function onPluginsConsentAccept() {
    if (pluginsBusy) return;
    setPluginsUiError('');

    const api = getDesktopApiExt();
    const plugins = api?.plugins;
    if (!plugins) {
      setPluginsUiError('Plugins 接口不可用');
      return;
    }

    setPluginsBusy(true);
    try {
      const status = await plugins.setEnabled(true);
      setPluginsStatus(status ?? null);
      setPluginsConsentOpen(false);
    } catch (err: unknown) {
      setPluginsUiError(toReadablePluginsError(err));
    } finally {
      setPluginsBusy(false);
    }
  }

  function onPluginsConsentDecline() {
    setPluginsConsentOpen(false);
  }

  async function onPluginsInstall() {
    if (pluginsBusy) return;
    setPluginsUiError('');

    const api = getDesktopApiExt();
    const plugins = api?.plugins;
    if (!plugins) {
      setPluginsUiError('Plugins 接口不可用');
      return;
    }

    setPluginsBusy(true);
    try {
      const parsed = parsePluginKey(pluginsSelectedKey);
      const status = parsed ? await plugins.install(parsed) : await plugins.install();
      setPluginsStatus(status ?? null);

      window.setTimeout(() => {
        void refreshPluginsStatus({ silent: true });
      }, 200);
    } catch (err: unknown) {
      setPluginsUiError(toReadablePluginsError(err));
    } finally {
      setPluginsBusy(false);
    }
  }

  async function onSocialJoin() {
    if (socialBusy) return;
    setSocialUiError('');
    setSocialUiInfo('');

    const roomId = socialRoomId.trim();
    if (!roomId) {
      setSocialUiError('请先创建房间');
      return;
    }

    const api = getDesktopApiExt();
    const social = api?.social;
    if (!social) {
      setSocialUiError('社交接口不可用');
      return;
    }

    setSocialBusy(true);
    try {
      const res = await social.join({ roomId });
      setSocialUiInfo(`已加入（status=${res.status}）`);
    } catch (err: unknown) {
      setSocialUiError(toReadableSocialError(err));
    } finally {
      setSocialBusy(false);
    }
  }

  React.useEffect(() => {
    setGalleryItems([]);
    setGalleryUiError('');

    setTimelineItems([]);
    setTimelineUiError('');

    if (galleryPollTimerRef.current) {
      clearInterval(galleryPollTimerRef.current);
      galleryPollTimerRef.current = null;
    }

    const api = window.desktopApi;
    const gallery = api?.gallery;
    if (!gallery) return;
    void gallery
      .list(activeSaveId)
      .then((list) => setGalleryItems(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [activeSaveId]);

  React.useEffect(() => {
    const hasInFlight = galleryItems.some((it) => {
      const s = String(it.status);
      return s === 'pending' || s === 'running';
    });
    if (!hasInFlight) {
      if (galleryPollTimerRef.current) {
        clearInterval(galleryPollTimerRef.current);
        galleryPollTimerRef.current = null;
      }
      return;
    }

    if (galleryPollTimerRef.current) return;
    galleryPollTimerRef.current = setInterval(() => {
      const api = window.desktopApi;
      const gallery = api?.gallery;
      if (!gallery) return;

      void gallery
        .list(activeSaveId)
        .then((list) => setGalleryItems(Array.isArray(list) ? list : []))
        .catch(() => {});
    }, 900);
  }, [galleryItems, activeSaveId]);

  async function onFeedDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();

    setFeedError('');

    const file = e.dataTransfer.files?.item(0);
    if (!file) {
      setFeedPhase('error');
      setFeedError('未检测到文件');
      return;
    }

    if (!isMdFile(file)) {
      setFeedPhase('error');
      setFeedError('仅支持 .md 文件');
      return;
    }

    const api = getDesktopApiExt();
    const knowledge = api?.knowledge;
    if (!knowledge) {
      setFeedPhase('error');
      setFeedError('投喂接口不可用');
      return;
    }

    try {
      feedAbortRef.current?.abort();
    } catch {
    }
    const controller = new AbortController();
    feedAbortRef.current = controller;

    const filename = file.name;
    setFeedFilename(filename);
    setFeedPhase('uploading');

    try {
      const bytes = await file.arrayBuffer();

      const uploaded = await knowledge.uploadMaterial({
        bytes,
        filename,
        mimeType: file.type || 'text/markdown',
        saveId: activeSaveId
      });

      if (uploaded.status === 'indexed') {
        setFeedPhase('done');
        return;
      }
      if (uploaded.status === 'failed') {
        setFeedPhase('error');
        setFeedError(uploaded.error || '索引失败');
        return;
      }

      setFeedPhase('indexing');
      const finalM = await pollMaterialUntilDone(knowledge, uploaded.id, controller.signal);
      if (finalM.status === 'indexed') {
        setFeedPhase('done');
        return;
      }

      setFeedPhase('error');
      setFeedError(finalM.error || '索引失败');
    } catch (err: unknown) {
      if (getErrorCode(err).includes('ABORTED')) return;
      setFeedPhase('error');
      setFeedError(toReadableKnowledgeError(err));
    }
  }

  function onFeedDragOver(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
  }

  type ConsentPanelProps = {
    testIdPanel: string;
    testIdAccept: string;
    testIdDecline: string;
    title: string;
    description: React.ReactNode;
    acceptLabel: string;
    declineLabel: string;
    onAccept: () => void;
    onDecline: () => void;
  };

  function ConsentPanel(props: ConsentPanelProps) {
    return (
      <div
        data-testid={props.testIdPanel}
        style={{
          marginTop: 10,
          borderRadius: 14,
          border: '1px solid rgba(255,255,255,0.18)',
          padding: 12,
          background: 'rgba(0,0,0,0.18)'
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{props.title}</div>
        <div className="meta">{props.description}</div>
        <div style={{ height: 10 }} />
        <div className="row">
          <button
            type="button"
            data-testid={props.testIdAccept}
            onClick={props.onAccept}
            className="btn-ok"
          >
            {props.acceptLabel}
          </button>
          <button
            type="button"
            data-testid={props.testIdDecline}
            onClick={props.onDecline}
            className="btn-warn"
          >
            {props.declineLabel}
          </button>
        </div>
      </div>
    );
  }

  function onToggleVision() {
    setVisionError('');
    if (visionEnabled) {
      setVisionEnabled(false);
      setVisionConsentOpen(false);
      setVisionSuggestion('还没有建议');
      return;
    }
    setVisionConsentOpen(true);
  }

  function onVisionConsentAccept() {
    setVisionEnabled(true);
    setVisionConsentOpen(false);
    setVisionError('');
  }

  function onVisionConsentDecline() {
    setVisionConsentOpen(false);
    setVisionEnabled(false);
    setVisionError('');
  }

  async function onSendTestScreenshot() {
    setVisionError('');

    if (!visionEnabled) {
      setVisionError('请先开启并授权');
      return;
    }
    if (visionSending) return;

    const api = getDesktopApiExt();
    const vision = api?.vision;
    if (!vision) {
      setVisionError('截图理解接口不可用');
      return;
    }

    const TEST_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZ+XioAAAAASUVORK5CYII=';
    const privacyMode: VisionPrivacyMode = 'strict';

    setVisionSending(true);
    setVisionSuggestion('发送中…');
    try {
      const resp = await vision.uploadScreenshot({
        saveId: activeSaveId,
        imageBase64: TEST_PNG_BASE64,
        privacyMode
      });
      const suggestion = typeof resp?.suggestion === 'string' && resp.suggestion.trim() !== '' ? resp.suggestion : '（空建议）';
      setVisionSuggestion(suggestion);
    } catch (err: unknown) {
      setVisionSuggestion('还没有建议');
      setVisionError(toReadableVisionError(err));
    } finally {
      setVisionSending(false);
    }
  }

  async function onToggleAssistant() {
    setAssistantUiError('');

    const api = getDesktopApiExt();
    const assistant = api?.assistant;
    if (!assistant) {
      setAssistantUiError('系统助手接口不可用');
      return;
    }

    const nextEnabled = !assistantEnabled;
    try {
      await assistant.setEnabled(nextEnabled, activeSaveId);
      setAssistantEnabled(nextEnabled);

      if (!nextEnabled) {
        setAssistantSuggestion('还没有建议');
        setAssistantCategory('');
      }
    } catch (err: unknown) {
      setAssistantUiError(toReadableAssistantError(err));
    }
  }

  async function onToggleAssistantIdle() {
    setAssistantUiError('');

    const api = getDesktopApiExt();
    const assistant = api?.assistant;
    if (!assistant) {
      setAssistantUiError('系统助手接口不可用');
      return;
    }

    const nextEnabled = !assistantIdleEnabled;
    try {
      await assistant.setIdleEnabled(nextEnabled);
      setAssistantIdleEnabled(nextEnabled);
    } catch (err: unknown) {
      setAssistantUiError(toReadableAssistantError(err));
    }
  }

  async function onAssistantCopyEnglish() {
    setAssistantUiError('');

    const api = getDesktopApiExt();
    const assistant = api?.assistant;
    const writeClipboardText = assistant?.writeClipboardText;
    if (!assistant || typeof writeClipboardText !== 'function') {
      setAssistantUiError('复制接口不可用');
      return;
    }

    const sample = 'This is a debug clipboard sample. Please translate it into Chinese.';
    try {
      await writeClipboardText(sample);
      setAssistantSuggestion('已写入剪贴板，等待建议…');
      setAssistantCategory('');
    } catch (err: unknown) {
      setAssistantUiError(toReadableAssistantError(err));
    }
  }

  async function onLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isLoggingIn) return;
    if (!email || !password) {
      setLoginError('请输入邮箱与密码');
      setLoggedInEmail(null);
      return;
    }

    const auth = window.desktopApi?.auth;
    if (!auth) {
      setLoginError('登录失败');
      setLoggedInEmail(null);
      return;
    }

    setIsLoggingIn(true);
    setLoginError('');
    try {
      const me = await auth.login(email, password);
      setLoggedInEmail(me.email);
      setLoginError('');
    } catch (err: unknown) {
      setLoggedInEmail(null);
      setLoginError(toReadableLoginError(err));
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function onConnect() {
    const ws = window.desktopApi?.ws;
    if (!ws) {
      setWsStatusLabel('未连接');
      setChatMeta('连接不可用');
      return;
    }
    try {
      await ws.connect(activeSaveId);
      setChatMeta('正在连接…');
    } catch {
      setChatMeta('连接失败');
    }
  }

  async function onLoadSaves() {
    setSaveUiError('');
    setSaveUiInfo('');

    const api = getDesktopApiExt();
    const savesApi = api?.saves;
    if (!savesApi) {
      setSaveUiError('存档接口不可用');
      return;
    }

    try {
      const list = await savesApi.list();
      setSaves(Array.isArray(list) ? list : []);
      setSaveUiInfo('已加载存档');
    } catch (err: unknown) {
      setSaveUiError(toReadableSaveUiError(err));
    }
  }

  async function onCreateSave() {
    setSaveUiError('');
    setSaveUiInfo('');

    const name = saveCreateName.trim();
    if (!name) {
      setSaveUiError('请输入存档名称');
      return;
    }

    const api = getDesktopApiExt();
    const savesApi = api?.saves;
    if (!savesApi) {
      setSaveUiError('存档接口不可用');
      return;
    }

    try {
      const created = await savesApi.create(name);
      setSaveCreateName('');
      setActiveSaveId(created.id);
      setSaves((prev) => {
        const next = prev.filter((s) => s.id !== created.id);
        return [{ id: created.id, name: created.name, persona_id: null }, ...next];
      });
      setSaveUiInfo('已创建存档');
    } catch (err: unknown) {
      setSaveUiError(toReadableSaveUiError(err));
    }
  }

  async function onLoadPersonas() {
    setSaveUiError('');
    setSaveUiInfo('');

    const api = getDesktopApiExt();
    const personasApi = api?.personas;
    if (!personasApi) {
      setSaveUiError('Persona 接口不可用');
      return;
    }

    try {
      const list = await personasApi.list();
      setPersonas(Array.isArray(list) ? list : []);
      setSaveUiInfo('已加载 Persona');
    } catch (err: unknown) {
      setSaveUiError(toReadableSaveUiError(err));
    }
  }

  async function onBindPersona() {
    setSaveUiError('');
    setSaveUiInfo('');

    const personaId = selectedPersonaId.trim();
    if (!personaId) {
      setSaveUiError('请选择 Persona');
      return;
    }

    const api = getDesktopApiExt();
    const savesApi = api?.saves;
    if (!savesApi) {
      setSaveUiError('存档接口不可用');
      return;
    }

    try {
      await savesApi.bindPersona(activeSaveId, personaId);
      setSaves((prev) =>
        prev.map((s) => (s.id === activeSaveId ? { ...s, persona_id: personaId } : s)),
      );
      setSaveUiInfo('已绑定 Persona');
    } catch (err: unknown) {
      setSaveUiError(toReadableSaveUiError(err));
    }
  }

  async function onChatSend() {
    const text = chatInput.trim();
    if (!text) return;

    const ws = window.desktopApi?.ws;
    if (!ws) {
      setLastAiMessage('聊天不可用');
      return;
    }

    const clientRequestId = newClientRequestId();
    activeClientRequestIdRef.current = clientRequestId;
    activeRequestDoneRef.current = false;

    setChatMeta('生成中…');
    setLastAiMessage('');
    setChatInput('');

    try {
      await ws.chatSend(text, clientRequestId);
    } catch {
      activeRequestDoneRef.current = true;
      setChatMeta('发送失败');
    }
  }

  async function onChatStop() {
    const ws = window.desktopApi?.ws;
    if (!ws) return;
    try {
      await ws.interrupt();
      activeRequestDoneRef.current = true;
      setChatMeta('已停止');
    } catch {
    }
  }

  async function onUpdateCheck() {
    const update = window.desktopApi?.update;
    if (!update) {
      setUpdateUiError('更新接口不可用');
      return;
    }

    setUpdateBusy(true);
    setUpdateUiError('');
    try {
      const s = (await update.check()) as any;
      setUpdateState(s as UpdateState);
    } catch {
      setUpdateUiError('检查更新失败');
    } finally {
      setUpdateBusy(false);
    }
  }

  async function onUpdateDownload() {
    const update = window.desktopApi?.update;
    if (!update) {
      setUpdateUiError('更新接口不可用');
      return;
    }

    setUpdateBusy(true);
    setUpdateUiError('');
    try {
      const s = (await update.download()) as any;
      setUpdateState(s as UpdateState);
    } catch {
      setUpdateUiError('下载更新失败');
    } finally {
      setUpdateBusy(false);
    }
  }

  async function onUpdateInstall() {
    const update = window.desktopApi?.update;
    if (!update) {
      setUpdateUiError('更新接口不可用');
      return;
    }

    setUpdateBusy(true);
    setUpdateUiError('');
    try {
      const s = (await update.install()) as any;
      setUpdateState(s as UpdateState);
    } catch {
      setUpdateUiError('安装更新失败');
    } finally {
      setUpdateBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="title">桌宠调试面板</h1>
        <div className="meta">
          Electron: {versions?.electron ?? 'unknown'} | Node: {versions?.node ?? 'unknown'}
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2>连接 / 运行状态</h2>
          <div className="row">
            <span className="pill">状态：{wsStatusLabel}</span>
            <button type="button" onClick={onConnect}>
              连接
            </button>
            <button type="button" className="btn-warn" onClick={onChatStop}>
              停止
            </button>
          </div>

          <div style={{ height: 10 }} />
          <div className="meta">存档 / Persona</div>
          <div className="split">
            <select value={activeSaveId} onChange={(e) => setActiveSaveId(e.target.value)}>
              <option value="default">default</option>
              {saves
                .filter((s) => s.id !== 'default')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <button type="button" onClick={onLoadSaves}>
              加载存档
            </button>
          </div>
          <div className="split">
            <input
              value={saveCreateName}
              onChange={(e) => setSaveCreateName(e.target.value)}
              placeholder="新存档名称"
            />
            <button type="button" onClick={onCreateSave}>
              创建存档
            </button>
          </div>
          <div className="split">
            <select
              value={selectedPersonaId}
              onChange={(e) => setSelectedPersonaId(e.target.value)}
            >
              <option value="">选择 Persona</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} v{p.version}
                </option>
              ))}
            </select>
            <button type="button" onClick={onLoadPersonas}>
              加载 Persona
            </button>
          </div>
          <div className="row">
            <span className="pill">当前：{activeSaveId}</span>
            <button type="button" onClick={onBindPersona}>
              绑定到当前存档
            </button>
          </div>
          {saveUiError ? <div className="danger">{saveUiError}</div> : null}
          {saveUiInfo ? <div className="meta">{saveUiInfo}</div> : null}

          <div style={{ height: 10 }} />
          <div className="last" data-testid={TEST_IDS.chatLastAiMessage}>
            {lastAiMessage}
          </div>
          {chatMeta ? <div className="meta">{chatMeta}</div> : null}
        </section>

        <section className="card" data-testid={TEST_IDS.updateCard}>
          <h2>自动更新（Windows / macOS）</h2>
          <div className="meta">
            生产环境默认开启（Windows + macOS）；开发环境默认关闭，可通过环境变量显式开启。建议通过“发布更高 patch 但回退代码”的方式回滚。
          </div>
          <div style={{ height: 10 }} />

          <div className="row" data-testid={TEST_IDS.updateStatus}>
            <span className="pill">状态：{toUpdatePhaseLabel(updateState?.phase ?? 'disabled')}</span>
            <span className="pill">当前：{updateState?.currentVersion ?? 'unknown'}</span>
            <span className="pill">可用：{updateState?.availableVersion ?? '-'}</span>
          </div>

          {updateState?.progress ? (
            <div className="row">
              <span className="pill">进度：{clampPercent(updateState.progress.percent).toFixed(0)}%</span>
            </div>
          ) : null}

          <div style={{ height: 10 }} />
          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.updateCheck}
              onClick={onUpdateCheck}
              disabled={updateBusy || !updateState?.enabled || updateState.phase === 'checking' || updateState.phase === 'downloading' || updateState.phase === 'installing'}
            >
              检查更新
            </button>
            <button
              type="button"
              data-testid={TEST_IDS.updateDownload}
              onClick={onUpdateDownload}
              disabled={
                updateBusy ||
                !updateState?.enabled ||
                updateState.phase !== 'available'
              }
            >
              下载
            </button>
            <button
              type="button"
              data-testid={TEST_IDS.updateInstall}
              className="btn-warn"
              onClick={onUpdateInstall}
              disabled={updateBusy || !updateState?.enabled || updateState.phase !== 'downloaded'}
            >
              安装并重启
            </button>
          </div>

          {updateState?.lastCheckedAt ? <div className="meta">上次检查：{updateState.lastCheckedAt}</div> : null}
          {typeof updateState?.source === 'string' ? <div className="meta">更新源：{updateState.source}</div> : null}
          {updateState?.allowDowngrade ? <div className="meta">允许降级：已开启（仅测试/紧急）</div> : null}

          {updateUiError ? <div className="danger">{updateUiError}</div> : null}
          {updateState?.error ? <div className="danger">{updateState.error}</div> : null}
        </section>

        <section className="card">
          <h2>知识投喂</h2>
          <button
            type="button"
            data-testid={TEST_IDS.feedDropzone}
            onDragOver={onFeedDragOver}
            onDrop={onFeedDrop}
            aria-label="知识投喂拖拽区"
            onKeyDown={() => {}}
            style={{
              border: '1px dashed rgba(255,255,255,0.35)',
              borderRadius: 14,
              padding: 14,
              minHeight: 88,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              justifyContent: 'center'
            }}
          >
            <div className="meta">拖拽 .md 文件到此处，自动上传并等待索引完成</div>

            {feedPhase === 'uploading' || feedPhase === 'indexing' ? (
              <div className="row" data-testid={TEST_IDS.feedProgress}>
                <span className="pill">
                  {feedPhase === 'uploading' ? '上传中…' : '索引中…'} {feedFilename ? `(${feedFilename})` : ''}
                </span>
              </div>
            ) : null}

            {feedPhase === 'done' ? (
              <div className="row" data-testid={TEST_IDS.feedDone}>
                <span className="pill">已完成 {feedFilename ? `(${feedFilename})` : ''}</span>
              </div>
            ) : null}

            {feedPhase === 'error' && feedError ? <div className="danger">{feedError}</div> : null}
          </button>
        </section>

        <section className="card">
          <h2>多模态截图理解（强隐私开关）</h2>
          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.toggleVision}
              aria-pressed={visionEnabled}
              onClick={onToggleVision}
              className={visionEnabled ? 'btn-ok' : ''}
            >
              {visionEnabled ? '已开启（点击撤回）' : '默认关闭（点击申请开启）'}
            </button>
            <button
              type="button"
              data-testid={TEST_IDS.visionSendTestScreenshot}
              onClick={onSendTestScreenshot}
              disabled={visionSending}
            >
              {visionSending ? '发送中…' : '发送测试截图'}
            </button>
          </div>

          {visionConsentOpen ? (
            <ConsentPanel
              testIdPanel={TEST_IDS.visionConsentPanel}
              testIdAccept={TEST_IDS.visionConsentAccept}
              testIdDecline={TEST_IDS.visionConsentDecline}
              title="需要你的明确同意"
              description={
                <>
                  开启后，“发送测试截图”会通过主进程向服务端请求 `POST /api/v1/sensors/screenshot`。默认隐私模式为 strict：不写入
                  WS、不落盘、不记录截图内容。
                </>
              }
              acceptLabel="同意并开启"
              declineLabel="暂不开启"
              onAccept={onVisionConsentAccept}
              onDecline={onVisionConsentDecline}
            />
          ) : null}

          {visionError ? <div className="danger">{visionError}</div> : null}
          <div style={{ height: 10 }} />
          <div className="meta">建议（服务端返回）：</div>
          <div className="last" data-testid={TEST_IDS.visionSuggestion}>
            {visionSuggestion}
          </div>
        </section>

        <section className="card">
          <h2>系统助手（默认关闭）</h2>
          <div className="meta">
            开启后主进程会周期读取剪贴板文本；检测到变化且“看起来像英文”时，调用服务端 `POST /api/v1/sensors/event` 获取建议并推送到此处。
          </div>
          <div style={{ height: 10 }} />

          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.toggleAssistant}
              aria-pressed={assistantEnabled}
              onClick={onToggleAssistant}
              className={assistantEnabled ? 'btn-ok' : ''}
            >
              {assistantEnabled ? '已开启（点击关闭）' : '默认关闭（点击开启）'}
            </button>
            <button
              type="button"
              data-testid={TEST_IDS.toggleAssistantIdle}
              aria-pressed={assistantIdleEnabled}
              onClick={onToggleAssistantIdle}
              className={assistantIdleEnabled ? 'btn-ok' : ''}
            >
              {assistantIdleEnabled ? '闲置关怀：已开启' : '闲置关怀：默认关闭'}
            </button>
            <button type="button" data-testid={TEST_IDS.assistantCopyEnglish} onClick={onAssistantCopyEnglish}>
              复制一段英文
            </button>
          </div>

          {assistantUiError ? <div className="danger">{assistantUiError}</div> : null}
          <div style={{ height: 10 }} />
          <div className="meta">最后一次建议{assistantCategory ? `（${assistantCategory}）` : ''}：</div>
          <div className="last" data-testid={TEST_IDS.assistantSuggestion}>
            {assistantSuggestion}
          </div>
        </section>

        <section className="card">
          <h2>生成式相册</h2>
          <div className="meta">输入 prompt 点击生成；存在 pending 条目时会自动刷新列表。</div>
          <div style={{ height: 10 }} />
          <div className="row" data-testid={TEST_IDS.galleryGenerate}>
            <input
              value={galleryPrompt}
              onChange={(e) => setGalleryPrompt(e.target.value)}
              placeholder="生成提示词（prompt）"
            />
            <button type="button" onClick={onGalleryGenerate} disabled={galleryBusy}>
              {galleryBusy ? '生成中…' : '生成'}
            </button>
            <button
              type="button"
              data-testid={TEST_IDS.galleryRefresh}
              onClick={onGalleryRefresh}
              className="btn-warn"
              disabled={galleryBusy}
            >
              刷新
            </button>
          </div>

          {galleryUiError ? <div className="danger">{galleryUiError}</div> : null}

          <div style={{ height: 10 }} />
          <div className="gallery-masonry" data-testid={TEST_IDS.galleryMasonry}>
            {galleryItems.length === 0 ? (
              <div className="meta">暂无图片（先生成或点击刷新）</div>
            ) : (
              galleryItems.map((it) => {
                const statusLabel = toGalleryStatusLabel(it.status);
                const timeLabel = formatGalleryTime(it.created_at);
                const imgSrc = galleryImageUrls[it.id] ?? '';

                return (
                  <div key={it.id} className="gallery-item" data-testid={TEST_IDS.galleryItem}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="pill">{statusLabel}</span>
                      {timeLabel ? <span className="meta">{timeLabel}</span> : null}
                    </div>
                    <div className="meta" style={{ marginTop: 6 }}>
                      {it.prompt}
                    </div>

                    <div style={{ height: 8 }} />
                    {String(it.status) === 'completed' && imgSrc ? (
                      <img className="gallery-img" src={imgSrc} alt={it.prompt || it.id} loading="lazy" />
                    ) : (
                      <div className="gallery-placeholder">
                        {String(it.status) === 'failed'
                          ? '生成失败'
                          : String(it.status) === 'canceled'
                            ? '已取消'
                            : '等待生成…'}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="card" data-testid={TEST_IDS.timelineCard}>
          <h2>时间轴（离线模拟）</h2>
          <div className="meta">手动触发服务端生成离线事件；刷新可拉取时间轴列表。</div>
          <div style={{ height: 10 }} />

          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.timelineSimulate}
              onClick={onTimelineSimulate}
              disabled={timelineBusy}
              className={timelineBusy ? '' : 'btn-ok'}
            >
              {timelineBusy ? '处理中…' : '模拟一次'}
            </button>
            <button
              type="button"
              data-testid={TEST_IDS.timelineRefresh}
              onClick={onTimelineRefresh}
              disabled={timelineBusy}
              className="btn-warn"
            >
              刷新
            </button>
            <span className="pill">当前：{activeSaveId}</span>
          </div>

          {timelineUiError ? <div className="danger">{timelineUiError}</div> : null}

          <div style={{ height: 10 }} />
          <div
            data-testid={TEST_IDS.timelineList}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10
            }}
          >
            {timelineItems.length === 0 ? (
              <div className="meta">暂无事件（点击“模拟一次”或“刷新”）</div>
            ) : (
              timelineItems.map((it) => {
                const timeLabel = formatGalleryTime(it.createdAt);
                return (
                  <div
                    key={it.id}
                    data-testid={TEST_IDS.timelineItem}
                    style={{
                      border: '1px solid rgba(255,255,255,0.14)',
                      borderRadius: 12,
                      padding: 10,
                      background: 'rgba(0,0,0,0.12)'
                    }}
                  >
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="pill">{it.eventType}</span>
                      {timeLabel ? <span className="meta">{timeLabel}</span> : null}
                    </div>
                    <div style={{ height: 6 }} />
                    <div>{it.content}</div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="card" data-testid={TEST_IDS.socialRoomCard}>
          <h2>社交房间（最小 UI）</h2>
          <div className="meta">
            renderer 仅发起 IPC；主进程携带 token 调用 `/api/v1/social/*`；WS 收到 `ROOM_EVENT` 会追加到列表。
          </div>
          <div style={{ height: 10 }} />

          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.socialCreateRoom}
              onClick={onSocialCreateRoom}
              disabled={socialBusy}
              className={socialBusy ? '' : 'btn-ok'}
            >
              {socialBusy ? '处理中…' : '创建房间'}
            </button>
            <span className="pill" data-testid={TEST_IDS.socialRoomId}>
              room_id：{socialRoomId || '（未创建）'}
            </span>
          </div>

          <div style={{ height: 10 }} />
          <div className="split">
            <input
              data-testid={TEST_IDS.socialTargetUserId}
              value={socialTargetUserId}
              onChange={(e) => setSocialTargetUserId(e.target.value)}
              placeholder="好友 user_id（target_user_id）"
              inputMode="text"
            />
            <button
              type="button"
              data-testid={TEST_IDS.socialInvite}
              onClick={onSocialInvite}
              disabled={socialBusy}
            >
              邀请
            </button>
          </div>

          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.socialJoin}
              onClick={onSocialJoin}
              disabled={socialBusy}
              className="btn-warn"
            >
              加入
            </button>
            <span className="pill">当前：{activeSaveId}</span>
          </div>

          {socialUiError ? <div className="danger">{socialUiError}</div> : null}
          {socialUiInfo ? <div className="meta">{socialUiInfo}</div> : null}

          <div style={{ height: 10 }} />
          <div className="meta">房间事件（ROOM_EVENT）：</div>
          <div
            data-testid={TEST_IDS.socialEventList}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              maxHeight: 200,
              overflow: 'auto'
            }}
          >
            {socialRoomEvents.length === 0 ? (
              <div className="meta">暂无事件（提示：先点击“连接”，再触发创建/邀请/加入）</div>
            ) : (
              socialRoomEvents.map((it) => (
                <div
                  key={it.key}
                  data-testid={TEST_IDS.socialEventItem}
                  style={{
                    border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: 12,
                    padding: 10,
                    background: 'rgba(0,0,0,0.12)'
                  }}
                >
                  {it.text}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="card" data-testid={TEST_IDS.pluginsCard}>
          <h2>Plugins（alpha / Task 21）</h2>
          <div className="meta">
            默认关闭；renderer 不直接 fetch，所有网络请求在主进程完成。开启后主进程会 fork 独立子进程，并在 vm context
            执行插件代码（注意：vm 不是安全边界）。
          </div>
          <div style={{ height: 10 }} />

          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.pluginsToggle}
              aria-pressed={pluginsStatus?.enabled ?? false}
              onClick={onPluginsToggle}
              disabled={pluginsBusy}
              className={pluginsStatus?.enabled ? 'btn-ok' : 'btn-warn'}
            >
              {pluginsStatus?.enabled ? '已开启执行（点击撤回）' : '默认关闭（点击申请开启）'}
            </button>
            <span className="pill" data-testid={TEST_IDS.pluginsStatus}>
              host：{pluginsStatus?.running ? '运行中' : '未运行'}
            </span>
            <span className="pill">菜单项：{pluginsStatus?.menuItems?.length ?? 0}</span>
          </div>

          {pluginsConsentOpen ? (
            <ConsentPanel
              testIdPanel={TEST_IDS.pluginsConsentPanel}
              testIdAccept={TEST_IDS.pluginsConsentAccept}
              testIdDecline={TEST_IDS.pluginsConsentDecline}
              title="需要你的明确同意"
              description={
                <>
                  开启后，主进程可能会下载并执行“已审核（approved）插件”的代码（独立子进程 + vm context；注意：vm 不是安全边界）。
                  你可以随时点击“撤回”关闭执行。
                  另外，远端 kill-switch（`feature_flags.plugins_enabled`）仍可能阻止实际运行。
                </>
              }
              acceptLabel="同意并开启执行"
              declineLabel="暂不开启"
              onAccept={onPluginsConsentAccept}
              onDecline={onPluginsConsentDecline}
            />
          ) : null}

          <div style={{ height: 10 }} />
          <div className="split">
            <button
              type="button"
              data-testid={TEST_IDS.pluginsRefresh}
              onClick={onPluginsRefresh}
              disabled={pluginsBusy}
              className="btn-warn"
            >
              {pluginsBusy ? '拉取中…' : '拉取 approved 列表'}
            </button>
            <select
              data-testid={TEST_IDS.pluginsSelect}
              value={pluginsSelectedKey}
              onChange={(e) => setPluginsSelectedKey(e.target.value)}
              disabled={pluginsBusy || pluginsApproved.length === 0}
            >
              {pluginsApproved.length === 0 ? (
                <option value="">（未拉取列表）</option>
              ) : (
                pluginsApproved.map((it) => (
                  <option key={makePluginKey(it)} value={makePluginKey(it)}>
                    {it.name} ({it.id}@{it.version})
                  </option>
                ))
              )}
            </select>
          </div>

          <div style={{ height: 10 }} />
          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.pluginsInstall}
              onClick={onPluginsInstall}
              disabled={pluginsBusy}
              className="btn-ok"
            >
              {pluginsBusy ? '处理中…' : '安装'}
            </button>
            <span className="pill">
              已安装：
              {pluginsStatus?.installed
                ? `${pluginsStatus.installed.name || pluginsStatus.installed.id}@${pluginsStatus.installed.version}`
                : '（无）'}
            </span>
          </div>

          {pluginsUiError ? (
            <div className="danger" data-testid={TEST_IDS.pluginsError}>
              {pluginsUiError}
            </div>
          ) : null}
          {!pluginsUiError && pluginsStatus?.lastError ? <div className="danger">{pluginsStatus.lastError}</div> : null}

          <div style={{ height: 10 }} />
          <div className="meta">插件菜单项（addMenuItem）：</div>
          <div
            data-testid={TEST_IDS.pluginsMenuList}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              maxHeight: 200,
              overflow: 'auto'
            }}
          >
            {!pluginsStatus?.enabled ? (
              <div className="meta">执行已关闭：菜单项为空（符合 alpha 安全默认）</div>
            ) : (pluginsStatus?.menuItems?.length ?? 0) === 0 ? (
              <div className="meta">暂无菜单项（提示：需要插件在启动时调用 addMenuItem）</div>
            ) : (
              (pluginsStatus?.menuItems ?? []).map((it) => (
                <div
                  key={`${it.pluginId}:${it.id}`}
                  data-testid={TEST_IDS.pluginsMenuItem}
                  style={{
                    border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: 12,
                    padding: 10,
                    background: 'rgba(0,0,0,0.12)'
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="pill">{it.label}</span>
                    <span className="meta">{it.id}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="card" data-testid={TEST_IDS.ugcCard}>
          <h2>UGC 工坊（只拉取 approved）</h2>
          <div className="meta">
            renderer 仅发起 IPC；主进程携带 token 调用 `GET /api/v1/ugc/assets?status=approved`。
          </div>
          <div style={{ height: 10 }} />

          <div className="row">
            <button
              type="button"
              data-testid={TEST_IDS.ugcRefresh}
              onClick={onUgcRefresh}
              disabled={ugcBusy}
              className="btn-warn"
            >
              {ugcBusy ? '刷新中…' : '刷新'}
            </button>
            <span className="pill">只看：approved</span>
          </div>

          {ugcUiError ? <div className="danger">{ugcUiError}</div> : null}

          <div style={{ height: 10 }} />
          <div
            data-testid={TEST_IDS.ugcList}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              maxHeight: 200,
              overflow: 'auto'
            }}
          >
            {ugcAssets.length === 0 ? (
              <div className="meta">暂无 approved 资源（点击“刷新”）</div>
            ) : (
              ugcAssets.map((it) => (
                <div
                  key={it.id}
                  data-testid={TEST_IDS.ugcItem}
                  style={{
                    border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: 12,
                    padding: 10,
                    background: 'rgba(0,0,0,0.12)'
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="pill">{it.asset_type || 'unknown'}</span>
                    <span className="meta">{it.id}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="card">
          <h2>登录</h2>
          <form onSubmit={onLoginSubmit} className="chat">
            <div className="split">
              <input
                data-testid={TEST_IDS.loginEmail}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="邮箱"
                inputMode="email"
              />
              <input
                data-testid={TEST_IDS.loginPassword}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="密码"
                type="password"
              />
            </div>
            <div className="row">
              <button data-testid={TEST_IDS.loginSubmit} type="submit" disabled={isLoggingIn}>
                {isLoggingIn ? '登录中…' : '登录'}
              </button>
              {loggedInEmail ? (
                <span className="pill">已登录：{loggedInEmail}</span>
              ) : (
                <span className="pill">未登录</span>
              )}
            </div>
            {loginError ? (
              <div className="danger" data-testid={TEST_IDS.loginError}>
                {loginError}
              </div>
            ) : null}
          </form>
        </section>

        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2>Chat</h2>
          <div className="chat">
            <div className="chatbar">
              <input
                data-testid={TEST_IDS.chatInput}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="对 TA 说点什么"
              />
              <button data-testid={TEST_IDS.chatSend} type="button" onClick={onChatSend}>
                发送
              </button>
                <button
                  data-testid={TEST_IDS.chatStop}
                  className="btn-warn"
                  type="button"
                  onClick={onChatStop}
                >
                  停止
                </button>
              </div>
            <div className="meta">
              提示：这些 data-testid 从 Day 1 固化，后续 UI/路由变化也不影响自动化。
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
