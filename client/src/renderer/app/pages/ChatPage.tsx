import React from 'react';

import { getDesktopApi, getUnsubscribe } from '../../services/desktopApi';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { TextInput } from '../../ui/TextInput';
import { TEST_IDS } from '../testIds';
import { AppShell } from '../shell/AppShell';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function toReadableWsUiError(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim() !== '') return err.message;
  if (typeof err === 'string' && err.trim() !== '') return err;
  return '操作失败';
}

function toReadableByokError(err: unknown): string {
  if (err instanceof Error && typeof err.message === 'string' && err.message.trim() !== '') {
    const code = err.message;
    if (code.includes('BYOK_BASE_URL_INVALID')) return 'base_url 不合法';
    if (code.includes('BYOK_CONFIG_INCOMPLETE')) return 'BYOK 配置不完整（需要 base_url / model / api_key）';
    if (code.includes('BYOK_DISABLED')) return 'BYOK 未启用';
    if (code.includes('BYOK_BUSY')) return 'BYOK 正在生成中…';
    if (code.includes('SAFE_STORAGE_UNAVAILABLE')) return '本机安全存储不可用，无法安全保存/使用 BYOK Key。';
    if (code.includes('BYOK_KEY_DECRYPT_FAILED')) return 'BYOK Key 解密失败，请重新更新 Key。';
    if (code.includes('ABORTED')) return '已停止';
    if (code.includes('NETWORK_ERROR')) return '网络错误';
    if (code.includes('API_FAILED')) return '请求失败';
    return code;
  }
  if (typeof err === 'string' && err.trim() !== '') return err;
  return 'BYOK 失败';
}

export function ChatPage() {
  const [authStatus, setAuthStatus] = React.useState<'unknown' | 'loggedIn' | 'loggedOut'>('unknown');
  const [loggedInEmail, setLoggedInEmail] = React.useState<string | null>(null);

  const [activeSaveId] = React.useState<string>('default');

  const [input, setInput] = React.useState('');
  const [lastAiMessage, setLastAiMessage] = React.useState('');

  const [wsStatusLabel, setWsStatusLabel] = React.useState<string>('未连接');
  const [chatMeta, setChatMeta] = React.useState<string>('');
  const [chatBusy, setChatBusy] = React.useState<boolean>(false);

  const [byokEnabled, setByokEnabled] = React.useState<boolean>(false);

  const activeClientRequestIdRef = React.useRef<string | null>(null);
  const activeRequestDoneRef = React.useRef<boolean>(false);

  // token buffer + flush：避免每个 token 都 setState(prev + token) 造成 O(n^2) 热点。
  const pendingTokensRef = React.useRef<string[]>([]);
  const flushScheduledRef = React.useRef<boolean>(false);
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | number | null>(null);

  const flushPendingTokens = React.useCallback(() => {
    flushScheduledRef.current = false;
    const pending = pendingTokensRef.current;
    if (pending.length === 0) return;
    pendingTokensRef.current = [];
    const chunk = pending.join('');
    if (chunk.length === 0) return;
    setLastAiMessage((prev) => prev + chunk);
  }, []);

  const scheduleFlush = React.useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushPendingTokens();
    }, 16);
  }, [flushPendingTokens]);

  React.useEffect(() => {
    let cancelled = false;

    async function hydrateAuth() {
      const me = getDesktopApi()?.auth?.me;
      if (typeof me !== 'function') {
        if (!cancelled) {
          setAuthStatus('loggedOut');
          setLoggedInEmail(null);
        }
        return;
      }

      try {
        const ret = await me();
        const email = (ret as { email?: unknown } | null)?.email;
        if (!cancelled && typeof email === 'string' && email.trim()) {
          setAuthStatus('loggedIn');
          setLoggedInEmail(email);
          return;
        }
      } catch {
      }

      if (!cancelled) {
        setAuthStatus('loggedOut');
        setLoggedInEmail(null);
      }
    }

    void hydrateAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function hydrateByok() {
      const byok = getDesktopApi()?.byok;
      if (!byok?.getConfig) return;
      try {
        const cfg = await byok.getConfig();
        if (cancelled) return;
        setByokEnabled(Boolean(cfg.enabled));
      } catch {
      }
    }

    void hydrateByok();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const ws = getDesktopApi()?.ws;
    if (!ws) {
      setWsStatusLabel('未连接');
      return;
    }

    const unsubscribes: Array<() => void> = [];

    let unsubStatus: (() => void) | null = null;
    try {
      unsubStatus = getUnsubscribe(
        ws.onStatus((status: unknown) => {
          setWsStatusLabel(toStatusLabel(status));
        }),
      );
    } catch {
      unsubStatus = null;
    }
    if (unsubStatus) unsubscribes.push(unsubStatus);

    let unsubEvent: (() => void) | null = null;
    try {
      unsubEvent = getUnsubscribe(
        ws.onEvent((frame: unknown) => {
          if (!isRecord(frame)) return;
          const type = frame.type;
          if (typeof type !== 'string') return;

          if (type === 'CHAT_TOKEN') {
            if (activeRequestDoneRef.current) return;
            const payload = frame.payload;
            const token = isRecord(payload) ? payload.token : undefined;
            if (typeof token !== 'string' || token.length === 0) return;

            const frameClientRequestIdRaw = (frame as any).clientRequestId ?? (frame as any).client_request_id;
            const frameClientRequestId = typeof frameClientRequestIdRaw === 'string' ? frameClientRequestIdRaw : null;

            if (
              activeClientRequestIdRef.current &&
              frameClientRequestId &&
              frameClientRequestId !== activeClientRequestIdRef.current
            ) {
              return;
            }

            pendingTokensRef.current.push(token);
            scheduleFlush();
            return;
          }

          if (type === 'CHAT_DONE') {
            activeRequestDoneRef.current = true;
            setChatBusy(false);
            flushPendingTokens();

            const payload = frame.payload;
            const reason = isRecord(payload) ? payload.reason : undefined;
            if (typeof reason === 'string' && reason) setChatMeta(`完成：${reason}`);
            else setChatMeta('完成');
          }
        }),
      );
    } catch {
      unsubEvent = null;
    }
    if (unsubEvent) unsubscribes.push(unsubEvent);

    return () => {
      if (flushTimerRef.current) {
        try {
          clearTimeout(flushTimerRef.current);
        } catch {
        }
        flushTimerRef.current = null;
      }
      flushScheduledRef.current = false;
      pendingTokensRef.current = [];

      for (const unsub of unsubscribes) {
        try {
          unsub();
        } catch {
        }
      }
    };
  }, [flushPendingTokens, scheduleFlush]);

  async function onConnect() {
    const ws = getDesktopApi()?.ws;
    if (!ws?.connect) {
      setChatMeta('连接不可用');
      setWsStatusLabel('未连接');
      return;
    }
    try {
      setChatMeta('正在连接…');
      const res = await ws.connect(activeSaveId);
      setWsStatusLabel(toStatusLabel(res?.status));
    } catch (err: unknown) {
      setChatMeta(`连接失败：${toReadableWsUiError(err)}`);
    }
  }

  async function onChatSend() {
    const text = input.trim();
    if (!text) return;

    const api = getDesktopApi();
    const byok = api?.byok;
    const ws = api?.ws;

    const clientRequestId = newClientRequestId();
    activeClientRequestIdRef.current = clientRequestId;
    activeRequestDoneRef.current = false;

    pendingTokensRef.current = [];
    flushScheduledRef.current = false;
    if (flushTimerRef.current) {
      try {
        clearTimeout(flushTimerRef.current);
      } catch {
      }
      flushTimerRef.current = null;
    }

    setChatBusy(true);
    setChatMeta('生成中…');
    setLastAiMessage('');
    setInput('');

    try {
      if (byok?.getConfig && byok?.chatSend) {
        let enabled = byokEnabled;
        if (!enabled) {
          try {
            const cfg = await byok.getConfig();
            enabled = Boolean(cfg.enabled);
            setByokEnabled(enabled);
          } catch {
            enabled = false;
          }
        }

        if (enabled) {
          const resp = await byok.chatSend(text);
          const content = typeof resp?.content === 'string' ? resp.content : '';
          activeRequestDoneRef.current = true;
          setChatBusy(false);
          setChatMeta('完成');
          setLastAiMessage(content || '（空回复）');
          return;
        }
      }

      if (!ws?.chatSend) {
        activeRequestDoneRef.current = true;
        setChatBusy(false);
        setChatMeta('聊天不可用');
        return;
      }

      await ws.chatSend(text, clientRequestId);
    } catch (err: unknown) {
      activeRequestDoneRef.current = true;
      setChatBusy(false);
      setChatMeta(`发送失败：${byokEnabled ? toReadableByokError(err) : toReadableWsUiError(err)}`);
    }
  }

  async function onChatStop() {
    const api = getDesktopApi();

    const byok = api?.byok;
    if (byokEnabled && byok?.chatAbort) {
      try {
        await byok.chatAbort();
        activeRequestDoneRef.current = true;
        setChatBusy(false);
        setChatMeta('已停止');
        return;
      } catch (err: unknown) {
        setChatMeta(`停止失败：${toReadableByokError(err)}`);
        return;
      }
    }

    const ws = api?.ws;
    if (!ws?.interrupt) {
      setChatMeta('停止不可用');
      return;
    }

    try {
      await ws.interrupt();
      activeRequestDoneRef.current = true;
      setChatBusy(false);
      setChatMeta('已停止');
    } catch (err: unknown) {
      setChatMeta(`停止失败：${toReadableWsUiError(err)}`);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void onChatSend();
  }

  const authLabel = authStatus === 'loggedIn' && loggedInEmail ? `已登录：${loggedInEmail}` : '未登录';

  return (
    <AppShell>
      <div className="ui-shell__content">
        <Card as="main">
          <h2>聊天</h2>

          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
            {authLabel}
            {byokEnabled ? ' · 模式：BYOK' : ''}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            <Button type="button" onClick={onConnect}>
              连接
            </Button>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>状态：{wsStatusLabel}</div>
            {chatMeta ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>· {chatMeta}</div> : null}
          </div>

          <form onSubmit={onSubmit} style={{ display: 'grid', gap: 10 }}>
            <TextInput
              label="消息"
              placeholder="输入消息"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              data-testid={TEST_IDS.chatInput}
            />

            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button
                type="button"
                data-testid={TEST_IDS.chatStop}
                variant="secondary"
                onClick={onChatStop}
                disabled={!chatBusy}
              >
                停止
              </Button>
              <Button data-testid={TEST_IDS.chatSend} type="submit" disabled={chatBusy}>
                发送
              </Button>
            </div>

            <div data-testid={TEST_IDS.chatLastAiMessage}>{lastAiMessage}</div>
          </form>
        </Card>
      </div>
    </AppShell>
  );
}
