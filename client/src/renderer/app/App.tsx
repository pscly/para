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

type VisionSuggestionResponse = {
  suggestion: string;
};

type DesktopApiExt = {
  saves?: {
    list: () => Promise<SaveListItem[]>;
    create: (name: string) => Promise<{ id: string; name: string }>;
    bindPersona: (saveId: string, personaId: string) => Promise<unknown>;
  };
  personas?: {
    list: () => Promise<PersonaListItem[]>;
  };
  knowledge?: {
    uploadMaterial: (payload: {
      bytes: ArrayBuffer;
      filename: string;
      mimeType?: string;
      saveId: string;
    }) => Promise<KnowledgeMaterial>;
    materialStatus: (id: string) => Promise<KnowledgeMaterial>;
  };
  vision?: {
    uploadScreenshot: (payload: {
      saveId: string;
      imageBase64: string;
      privacyMode: VisionPrivacyMode;
    }) => Promise<VisionSuggestionResponse>;
  };
  assistant?: {
    setEnabled: (enabled: boolean, saveId: string) => Promise<void>;
    setIdleEnabled: (enabled: boolean) => Promise<void>;
    onSuggestion: (handler: (payload: unknown) => void) => () => void;
    writeClipboardText?: (text: string) => Promise<void>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getUnsubscribe(ret: unknown): (() => void) | null {
  if (typeof ret === 'function') return ret as () => void;
  if (isRecord(ret) && typeof ret.unsubscribe === 'function') return ret.unsubscribe as () => void;
  return null;
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

  const feedAbortRef = React.useRef<AbortController | null>(null);

  const activeClientRequestIdRef = React.useRef<string | null>(null);
  const activeRequestDoneRef = React.useRef<boolean>(false);

  const versions = window.desktopApi?.versions;

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
    const api = window.desktopApi as unknown as DesktopApiExt | undefined;
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

  function getDesktopApiExt(): DesktopApiExt | null {
    const api = window.desktopApi as unknown;
    if (!api) return null;
    return api as DesktopApiExt;
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
            <div
              data-testid={TEST_IDS.visionConsentPanel}
              style={{
                marginTop: 10,
                borderRadius: 14,
                border: '1px solid rgba(255,255,255,0.18)',
                padding: 12,
                background: 'rgba(0,0,0,0.18)'
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6 }}>需要你的明确同意</div>
              <div className="meta">
                开启后，“发送测试截图”会通过主进程向服务端请求 `POST /api/v1/sensors/screenshot`。
                默认隐私模式为 strict：不写入 WS、不落盘、不记录截图内容。
              </div>
              <div style={{ height: 10 }} />
              <div className="row">
                <button
                  type="button"
                  data-testid={TEST_IDS.visionConsentAccept}
                  onClick={onVisionConsentAccept}
                  className="btn-ok"
                >
                  同意并开启
                </button>
                <button
                  type="button"
                  data-testid={TEST_IDS.visionConsentDecline}
                  onClick={onVisionConsentDecline}
                  className="btn-warn"
                >
                  暂不开启
                </button>
              </div>
            </div>
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
