import React from 'react';
import { useNavigate } from 'react-router-dom';

import { getDesktopApi, getUnsubscribe } from '../../services/desktopApi';
import { getThemePreference, initTheme, setThemePreference, type ThemePreference } from '../../services/theme';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { TextInput } from '../../ui/TextInput';
import { AppShell } from '../shell/AppShell';
import { TEST_IDS } from '../testIds';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type DesktopApiExt = NonNullable<Window['desktopApi']>;
type UpdateState = Awaited<ReturnType<DesktopApiExt['update']['getState']>>;
type UserDataInfo = Awaited<ReturnType<DesktopApiExt['userData']['getInfo']>>;
type DevOptionsStatus = Awaited<ReturnType<DesktopApiExt['security']['getDevOptionsStatus']>>;

type VisionPrivacyMode = 'strict' | 'standard';

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

function getErrorCode(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return 'UNKNOWN';
}

function toReadableUserDataError(err: unknown): string {
  const code = getErrorCode(err);
  if (code.includes('USERDATA_TARGET_EMPTY')) return '请输入新目录';
  if (code.includes('USERDATA_TARGET_NOT_ABSOLUTE')) return '请输入绝对路径';
  if (code.includes('USERDATA_TARGET_SAME_AS_CURRENT')) return '目标目录与当前目录相同';
  if (code.includes('USERDATA_TARGET_INSIDE_CURRENT')) return '目标目录在当前目录内部，已禁止（避免递归复制）';
  if (code.includes('USERDATA_TARGET_NOT_DIR')) return '目标路径存在但不是目录';
  if (code.includes('USERDATA_TARGET_NOT_EMPTY')) return '目标目录非空，请选择一个空目录';
  if (code.includes('USERDATA_TARGET_NOT_WRITABLE')) return '目标目录不可写';
  if (code.includes('USERDATA_CONFIG_WRITE_FAILED')) return '迁移已完成，但写入配置失败（未切换）。请检查权限后重试。';
  if (code.includes('USERDATA_MIGRATE_FAILED')) return '迁移失败';
  return '迁移失败';
}

function toReadableRelaunchError(err: unknown): string {
  const code = getErrorCode(err);
  if (code.includes('DESKTOP_API_UNAVAILABLE')) return '重启接口不可用';
  return '重启失败';
}

function toReadableByokError(err: unknown): string {
  const code = getErrorCode(err);
  if (code.includes('BYOK_BASE_URL_INVALID')) return 'base_url 不合法（需要 http/https 绝对 URL）';
  if (code.includes('BYOK_CONFIG_INCOMPLETE')) return 'BYOK 配置不完整（需要 base_url / model / api_key）';
  if (code.includes('BYOK_DISABLED')) return 'BYOK 未启用';
  if (code.includes('BYOK_BUSY')) return 'BYOK 正在生成中…';
  if (code.includes('SAFE_STORAGE_UNAVAILABLE')) return '本机安全存储不可用，无法安全保存/使用 BYOK Key。';
  if (code.includes('BYOK_KEY_DECRYPT_FAILED')) return 'BYOK Key 解密失败（可能系统密钥环变更），请重新更新 Key。';
  if (code.includes('ABORTED')) return '已停止';
  if (code.includes('NETWORK_ERROR')) return '网络错误';
  if (code.includes('API_FAILED')) return '请求失败';
  return 'BYOK 失败';
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

type DevOptionsReasonCode = 'NOT_LOGGED_IN' | 'DEBUG_NOT_ALLOWED' | 'NETWORK_ERROR' | 'AUTH_ME_FAILED' | 'OK' | 'DISABLED';

function toDevOptionsReasonCodeFromStatus(s: Pick<DevOptionsStatus, 'desiredEnabled' | 'effectiveEnabled' | 'error'>): DevOptionsReasonCode {
  const desired = Boolean(s.desiredEnabled);
  const effective = Boolean(s.effectiveEnabled);
  const code = typeof s.error === 'string' ? s.error : '';

  if (!desired) return 'DISABLED';
  if (effective && !code) return 'OK';
  if (code.includes('NOT_LOGGED_IN')) return 'NOT_LOGGED_IN';
  if (code.includes('DEBUG_NOT_ALLOWED')) return 'DEBUG_NOT_ALLOWED';
  if (code.includes('NETWORK_ERROR')) return 'NETWORK_ERROR';
  if (code.includes('AUTH_ME_FAILED')) return 'AUTH_ME_FAILED';
  return 'AUTH_ME_FAILED';
}

function toDevOptionsReasonCodeFromError(err: unknown): DevOptionsReasonCode {
  const code = getErrorCode(err);
  if (code.includes('NOT_LOGGED_IN')) return 'NOT_LOGGED_IN';
  if (code.includes('DEBUG_NOT_ALLOWED')) return 'DEBUG_NOT_ALLOWED';
  if (code.includes('NETWORK_ERROR')) return 'NETWORK_ERROR';
  if (code.includes('AUTH_ME_FAILED')) return 'AUTH_ME_FAILED';
  return 'NETWORK_ERROR';
}

function toReadableDevOptionsReasonHint(code: DevOptionsReasonCode): string {
  if (code === 'OK') return '已生效。';
  if (code === 'DISABLED') return '已关闭（desiredEnabled=false）。';
  if (code === 'NOT_LOGGED_IN') return '未登录：正式包需要登录后才可能生效。';
  if (code === 'DEBUG_NOT_ALLOWED') return '未授权：需要后端为当前用户启用 debug_allowed。';
  if (code === 'NETWORK_ERROR') return '网络错误：无法校验/更新授权状态（fail-closed）。';
  return '授权校验失败：/auth/me 响应不符合预期（fail-closed）。';
}

function toReadableDevOptionsUiError(err: unknown): string {
  const code = getErrorCode(err);
  if (code.includes('DESKTOP_API_UNAVAILABLE')) return '开发者选项接口不可用（可能不是 Electron 环境或版本过旧）';
  if (code.includes('NETWORK_ERROR')) return '网络错误';
  if (code.includes('NOT_LOGGED_IN')) return '请先登录';
  if (code.includes('DEBUG_NOT_ALLOWED')) return '后端未授权 debug_allowed';
  if (code.includes('AUTH_ME_FAILED')) return '授权校验失败';
  return '操作失败';
}

export function SettingsPage() {
  const navigate = useNavigate();

  const activeSaveId = 'default';

  const [themePref, setThemePref] = React.useState<ThemePreference>(() => getThemePreference());

  const [appVersion, setAppVersion] = React.useState<string | null>(null);
  const [updateState, setUpdateState] = React.useState<UpdateState | null>(null);
  const [updateBusy, setUpdateBusy] = React.useState(false);
  const [updateUiError, setUpdateUiError] = React.useState('');

  const [userDataInfo, setUserDataInfo] = React.useState<UserDataInfo | null>(null);
  const [userDataTargetDir, setUserDataTargetDir] = React.useState('');
  const [userDataBusy, setUserDataBusy] = React.useState(false);
  const [userDataUiError, setUserDataUiError] = React.useState('');
  const [userDataUiInfo, setUserDataUiInfo] = React.useState('');
  const [userDataNeedsRestart, setUserDataNeedsRestart] = React.useState(false);

  const [byokEnabled, setByokEnabled] = React.useState(false);
  const [byokBaseUrl, setByokBaseUrl] = React.useState('');
  const [byokModel, setByokModel] = React.useState('');
  const [byokApiKeyPresent, setByokApiKeyPresent] = React.useState(false);
  const [byokSecureStorageAvailable, setByokSecureStorageAvailable] = React.useState(false);
  const [byokApiKeyInput, setByokApiKeyInput] = React.useState('');
  const [byokBusy, setByokBusy] = React.useState(false);
  const [byokUiError, setByokUiError] = React.useState('');

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

  const [devOptionsDesiredEnabled, setDevOptionsDesiredEnabled] = React.useState(false);
  const [devOptionsEffectiveEnabled, setDevOptionsEffectiveEnabled] = React.useState(false);
  const [devOptionsReason, setDevOptionsReason] = React.useState<DevOptionsReasonCode>('DISABLED');
  const [devOptionsBusy, setDevOptionsBusy] = React.useState(false);
  const [devOptionsUiError, setDevOptionsUiError] = React.useState('');

  React.useEffect(() => {
    const api = getDesktopApi();
    if (!api?.getAppVersion) return;
    void api
      .getAppVersion()
      .then((v) => {
        if (typeof v === 'string' && v.trim() !== '') setAppVersion(v.trim());
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    const api = getDesktopApi();
    const byok = api?.byok;
    if (!byok?.getConfig) return;
    void byok
      .getConfig()
      .then((cfg) => {
        setByokEnabled(Boolean(cfg.enabled));
        setByokBaseUrl(typeof cfg.base_url === 'string' ? cfg.base_url : '');
        setByokModel(typeof cfg.model === 'string' ? cfg.model : '');
        setByokApiKeyPresent(Boolean(cfg.api_key_present));
        setByokSecureStorageAvailable(Boolean(cfg.secure_storage_available));
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    const api = getDesktopApi();
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
    const update = getDesktopApi()?.update;
    if (!update) return;

    void update
      .getState()
      .then((s) => setUpdateState(s))
      .catch(() => {});

    let unsub: (() => void) | null = null;
    try {
      unsub = getUnsubscribe(update.onState((s) => setUpdateState(s)));
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
    const userData = getDesktopApi()?.userData;
    if (!userData?.getInfo) return;
    void userData
      .getInfo()
      .then((info) => {
        if (info && typeof info.userDataDir === 'string') setUserDataInfo(info);
      })
      .catch(() => {});
  }, []);

  const refreshDevOptionsStatus = React.useCallback(async (opts?: { silent?: boolean }) => {
    const security = getDesktopApi()?.security;
    if (!security?.getDevOptionsStatus) {
      if (!opts?.silent) setDevOptionsUiError('开发者选项接口不可用');
      setDevOptionsDesiredEnabled(false);
      setDevOptionsEffectiveEnabled(false);
      setDevOptionsReason('NETWORK_ERROR');
      return;
    }

    try {
      const s = await security.getDevOptionsStatus();
      const desiredEnabled = Boolean(s?.desiredEnabled);
      const effectiveEnabled = Boolean(s?.effectiveEnabled);
      const reason = toDevOptionsReasonCodeFromStatus({
        desiredEnabled,
        effectiveEnabled,
        error: typeof s?.error === 'string' ? s.error : null
      });
      setDevOptionsDesiredEnabled(desiredEnabled);
      setDevOptionsEffectiveEnabled(effectiveEnabled);
      setDevOptionsReason(reason);
      if (!opts?.silent) setDevOptionsUiError('');
    } catch (err: unknown) {
      if (!opts?.silent) setDevOptionsUiError(toReadableDevOptionsUiError(err));
      setDevOptionsEffectiveEnabled(false);
      setDevOptionsReason(toDevOptionsReasonCodeFromError(err));
    }
  }, []);

  React.useEffect(() => {
    void refreshDevOptionsStatus({ silent: true });
  }, [refreshDevOptionsStatus]);

  function onThemePick(pref: ThemePreference) {
    setThemePreference(pref);
    initTheme();
    setThemePref(pref);
  }

  async function onUpdateCheck() {
    const update = getDesktopApi()?.update;
    if (!update) {
      setUpdateUiError('更新接口不可用');
      return;
    }

    setUpdateBusy(true);
    setUpdateUiError('');
    try {
      const s = await update.check();
      setUpdateState(s);
    } catch {
      setUpdateUiError('检查更新失败');
    } finally {
      setUpdateBusy(false);
    }
  }

  async function onByokSaveConfig() {
    if (byokBusy) return;
    setByokUiError('');

    const byok = getDesktopApi()?.byok;
    if (!byok?.setConfig) {
      setByokUiError('BYOK 保存接口不可用');
      return;
    }

    setByokBusy(true);
    try {
      const cfg = await byok.setConfig({ enabled: byokEnabled, base_url: byokBaseUrl, model: byokModel });
      setByokEnabled(Boolean(cfg.enabled));
      setByokBaseUrl(typeof cfg.base_url === 'string' ? cfg.base_url : '');
      setByokModel(typeof cfg.model === 'string' ? cfg.model : '');
      setByokApiKeyPresent(Boolean(cfg.api_key_present));
      setByokSecureStorageAvailable(Boolean(cfg.secure_storage_available));
      setByokUiError('');
    } catch (err: unknown) {
      setByokUiError(toReadableByokError(err));
    } finally {
      setByokBusy(false);
    }
  }

  async function onByokToggle() {
    if (byokBusy) return;
    setByokUiError('');

    const byok = getDesktopApi()?.byok;
    if (!byok?.setConfig) {
      setByokUiError('BYOK 开关接口不可用');
      return;
    }

    const nextEnabled = !byokEnabled;
    setByokBusy(true);
    try {
      const cfg = await byok.setConfig({ enabled: nextEnabled, base_url: byokBaseUrl, model: byokModel });
      setByokEnabled(Boolean(cfg.enabled));
      setByokBaseUrl(typeof cfg.base_url === 'string' ? cfg.base_url : '');
      setByokModel(typeof cfg.model === 'string' ? cfg.model : '');
      setByokApiKeyPresent(Boolean(cfg.api_key_present));
      setByokSecureStorageAvailable(Boolean(cfg.secure_storage_available));
      setByokUiError('');
    } catch (err: unknown) {
      setByokUiError(toReadableByokError(err));
    } finally {
      setByokBusy(false);
    }
  }

  async function onByokUpdateApiKey() {
    if (byokBusy) return;
    setByokUiError('');

    const apiKey = byokApiKeyInput.trim();
    if (!apiKey) {
      setByokUiError('请输入 API Key');
      return;
    }

    const byok = getDesktopApi()?.byok;
    if (!byok?.updateApiKey) {
      setByokUiError('BYOK 更新 Key 接口不可用');
      return;
    }

    setByokBusy(true);
    try {
      const cfg = await byok.updateApiKey(apiKey);
      setByokApiKeyInput('');
      setByokApiKeyPresent(Boolean(cfg.api_key_present));
      setByokSecureStorageAvailable(Boolean(cfg.secure_storage_available));
      setByokUiError('');
    } catch (err: unknown) {
      setByokUiError(toReadableByokError(err));
    } finally {
      setByokBusy(false);
    }
  }

  async function onByokClearApiKey() {
    if (byokBusy) return;
    setByokUiError('');

    const byok = getDesktopApi()?.byok;
    if (!byok?.clearApiKey) {
      setByokUiError('BYOK 清除 Key 接口不可用');
      return;
    }

    setByokBusy(true);
    try {
      const cfg = await byok.clearApiKey();
      setByokApiKeyPresent(Boolean(cfg.api_key_present));
      setByokSecureStorageAvailable(Boolean(cfg.secure_storage_available));
      setByokUiError('');
    } catch (err: unknown) {
      setByokUiError(toReadableByokError(err));
    } finally {
      setByokBusy(false);
    }
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

    const vision = getDesktopApi()?.vision;
    if (!vision?.uploadScreenshot) {
      setVisionError('截图理解接口不可用');
      return;
    }

    const TEST_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZ+XioAAAAASUVORK5CYII=';
    const privacyMode: VisionPrivacyMode = 'strict';

    setVisionSending(true);
    setVisionSuggestion('发送中…');
    try {
      const resp = await vision.uploadScreenshot({ saveId: activeSaveId, imageBase64: TEST_PNG_BASE64, privacyMode });
      setVisionSuggestion(typeof resp.suggestion === 'string' && resp.suggestion.trim() !== '' ? resp.suggestion : '（空建议）');
    } catch (err: unknown) {
      setVisionSuggestion('还没有建议');
      setVisionError(toReadableVisionError(err));
    } finally {
      setVisionSending(false);
    }
  }

  async function onToggleAssistant() {
    setAssistantUiError('');

    const assistant = getDesktopApi()?.assistant;
    if (!assistant?.setEnabled) {
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

    const assistant = getDesktopApi()?.assistant;
    if (!assistant?.setIdleEnabled) {
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

  async function onDevOptionsToggle() {
    if (devOptionsBusy) return;
    setDevOptionsUiError('');

    const security = getDesktopApi()?.security;
    if (!security?.setDevOptionsEnabled) {
      setDevOptionsUiError('开发者选项开关接口不可用');
      setDevOptionsDesiredEnabled(false);
      setDevOptionsEffectiveEnabled(false);
      setDevOptionsReason('NETWORK_ERROR');
      return;
    }

    const nextEnabled = !devOptionsDesiredEnabled;
    setDevOptionsBusy(true);
    try {
      const s = await security.setDevOptionsEnabled(nextEnabled);
      const desiredEnabled = Boolean(s?.desiredEnabled);
      const effectiveEnabled = Boolean(s?.effectiveEnabled);
      const reason = toDevOptionsReasonCodeFromStatus({
        desiredEnabled,
        effectiveEnabled,
        error: typeof s?.error === 'string' ? s.error : null
      });
      setDevOptionsDesiredEnabled(desiredEnabled);
      setDevOptionsEffectiveEnabled(effectiveEnabled);
      setDevOptionsReason(reason);
      await refreshDevOptionsStatus({ silent: true });
    } catch (err: unknown) {
      setDevOptionsUiError(toReadableDevOptionsUiError(err));
      setDevOptionsEffectiveEnabled(false);
      setDevOptionsReason(toDevOptionsReasonCodeFromError(err));
      await refreshDevOptionsStatus({ silent: true });
    } finally {
      setDevOptionsBusy(false);
    }
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
          border: '1px solid var(--line)',
          padding: 12,
          background: 'var(--panel)'
        }}
      >
        <div style={{ fontWeight: 650, marginBottom: 6 }}>{props.title}</div>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>{props.description}</div>
        <div style={{ height: 10 }} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button data-testid={props.testIdAccept} variant="primary" onClick={props.onAccept}>
            {props.acceptLabel}
          </Button>
          <Button data-testid={props.testIdDecline} variant="secondary" onClick={props.onDecline}>
            {props.declineLabel}
          </Button>
        </div>
      </div>
    );
  }

  async function onAppRelaunch(opts?: { setError?: (msg: string) => void; mapper?: (err: unknown) => string }) {
    const appApi = getDesktopApi()?.app;
    if (!appApi?.relaunch) {
      opts?.setError?.('重启接口不可用');
      return;
    }

    try {
      await appApi.relaunch();
    } catch (err: unknown) {
      const mapper = opts?.mapper ?? toReadableRelaunchError;
      opts?.setError?.(mapper(err));
    }
  }

  async function refreshUserDataInfo(opts?: { silent?: boolean }) {
    const userData = getDesktopApi()?.userData;
    if (!userData?.getInfo) {
      if (!opts?.silent) setUserDataUiError('数据目录接口不可用');
      return;
    }

    try {
      const info = await userData.getInfo();
      setUserDataInfo(info);
      if (!opts?.silent) setUserDataUiError('');
    } catch (err: unknown) {
      if (!opts?.silent) setUserDataUiError(toReadableUserDataError(err));
    }
  }

  async function onUserDataPickDir() {
    if (userDataBusy) return;
    setUserDataUiError('');
    setUserDataUiInfo('');

    const userData = getDesktopApi()?.userData;
    if (!userData?.pickDir) {
      setUserDataUiError('选择目录不可用');
      return;
    }

    try {
      const res = await userData.pickDir();
      if (res?.canceled) return;
      const path = typeof res?.path === 'string' ? res.path : '';
      if (path.trim() !== '') setUserDataTargetDir(path);
    } catch (err: unknown) {
      setUserDataUiError(toReadableUserDataError(err));
    }
  }

  async function onUserDataMigrate() {
    if (userDataBusy) return;
    setUserDataUiError('');
    setUserDataUiInfo('');
    setUserDataNeedsRestart(false);

    const targetDir = userDataTargetDir.trim();
    if (!targetDir) {
      setUserDataUiError('请输入新目录');
      return;
    }

    const userData = getDesktopApi()?.userData;
    if (!userData?.migrate) {
      setUserDataUiError('迁移接口不可用');
      return;
    }

    setUserDataBusy(true);
    try {
      const res = await userData.migrate(targetDir);
      const finalTarget =
        typeof res?.targetDir === 'string' && res.targetDir.trim() !== ''
          ? res.targetDir.trim()
          : targetDir;
      setUserDataUiInfo(`迁移完成：${finalTarget}`);
      setUserDataNeedsRestart(true);
      await refreshUserDataInfo({ silent: true });
    } catch (err: unknown) {
      setUserDataUiError(toReadableUserDataError(err));
    } finally {
      setUserDataBusy(false);
    }
  }

  const effectiveVersion = appVersion ?? updateState?.currentVersion ?? 'unknown';
  const updatePhaseLabel = toUpdatePhaseLabel(updateState?.phase);
  const updatePercent = clampPercent(updateState?.progress?.percent);
  const updateProgressLabel = updateState?.progress
    ? `${Math.round(updatePercent)}% (${updateState.progress.transferred}/${updateState.progress.total})`
    : '-';

  return (
    <AppShell>
      <div className="ui-shell__content">
        <div style={{ width: 'min(980px, 100%)', margin: '0 auto', paddingTop: 24, display: 'grid', gap: 12 }}>
          <Card as="main">
            <h2>Settings</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>应用设置与诊断信息</div>
          </Card>

          <Card>
            <h2>外观</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>主题偏好：system / light / dark（立即生效）</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant={themePref === 'system' ? 'primary' : 'secondary'} onClick={() => onThemePick('system')}>
                system
              </Button>
              <Button variant={themePref === 'light' ? 'primary' : 'secondary'} onClick={() => onThemePick('light')}>
                light
              </Button>
              <Button variant={themePref === 'dark' ? 'primary' : 'secondary'} onClick={() => onThemePick('dark')}>
                dark
              </Button>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>当前：{themePref}</div>
            </div>
          </Card>

          <Card data-testid={TEST_IDS.updateCard}>
            <h2>更新</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>当前版本：{effectiveVersion}</div>

            <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>状态：{updatePhaseLabel}</div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>可用版本：{updateState?.availableVersion ?? '-'}</div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>进度：{updateProgressLabel}</div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>错误：{updateUiError || updateState?.error || '-'}</div>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button data-testid={TEST_IDS.updateCheck} onClick={() => void onUpdateCheck()} loading={updateBusy}>
                检查更新
              </Button>
              <Button
                variant="secondary"
                onClick={() => void onAppRelaunch({ setError: setUpdateUiError, mapper: toReadableRelaunchError })}
              >
                重启应用
              </Button>
            </div>
          </Card>

          <Card data-testid={TEST_IDS.userDataCard}>
            <h2>数据目录（userData）</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              当前生效的数据目录为 Electron 的 userData 根路径。迁移会把旧目录内容复制到新目录，并写入稳定配置（appData/Para Desktop/para.config.json）。
            </div>
            <div style={{ height: 10 }} />

            <div
              style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}
              data-testid={TEST_IDS.userDataCurrentDir}
            >
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>当前：{userDataInfo?.userDataDir ?? 'unknown'}</span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>来源：{userDataInfo?.source ?? 'unknown'}</span>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }} data-testid={TEST_IDS.userDataConfigPath}>
              配置文件：{userDataInfo?.configPath ?? '-'}
            </div>

            {userDataInfo?.envOverrideActive ? (
              <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
                提示：检测到环境变量 PARA_USER_DATA_DIR（优先级最高）。迁移写入的配置需要在移除该变量后才会生效。
              </div>
            ) : null}

            <div style={{ height: 10 }} />

            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <TextInput
                  label="新数据目录"
                  placeholder="新数据目录（绝对路径）"
                  value={userDataTargetDir}
                  onChange={(e) => setUserDataTargetDir(e.target.value)}
                  data-testid={TEST_IDS.userDataTargetInput}
                  disabled={userDataBusy}
                />
              </div>
              <Button
                variant="secondary"
                data-testid={TEST_IDS.userDataPickDir}
                onClick={() => void onUserDataPickDir()}
                disabled={userDataBusy}
              >
                选择…
              </Button>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
              <Button
                variant="danger"
                data-testid={TEST_IDS.userDataMigrate}
                onClick={() => void onUserDataMigrate()}
                loading={userDataBusy}
              >
                {userDataBusy ? '迁移中…' : '迁移并写入配置'}
              </Button>
              <Button variant="secondary" onClick={() => void refreshUserDataInfo()} disabled={userDataBusy}>
                刷新
              </Button>
            </div>

            <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 10 }} data-testid={TEST_IDS.userDataStatus}>
              {userDataNeedsRestart
                ? '迁移完成：需要重启才能完全切换到新目录。'
                : userDataUiInfo
                  ? userDataUiInfo
                  : '未执行迁移'}
            </div>

            {userDataNeedsRestart ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                <Button
                  data-testid={TEST_IDS.userDataRestart}
                  variant="primary"
                  onClick={() => void onAppRelaunch({ setError: setUserDataUiError, mapper: toReadableRelaunchError })}
                >
                  一键重启
                </Button>
              </div>
            ) : null}

            {userDataUiError ? (
              <div className="ui-field__error" role="alert" style={{ marginTop: 10 }}>
                {userDataUiError}
              </div>
            ) : null}
          </Card>

          <Card>
            <h2>入口</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>快速跳转到常用页面</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={() => navigate('/plugins')}>
                打开 /plugins
              </Button>
              <Button variant="secondary" onClick={() => navigate('/knowledge')}>
                打开 /knowledge
              </Button>
            </div>
          </Card>

          <Card>
            <h2>开发者选项（/dev）</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              提示：正式包需要登录且后端授权 <code>debug_allowed</code> 才会生效（默认 fail-closed）。
            </div>

            <div style={{ height: 12 }} />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                type="button"
                data-testid={TEST_IDS.devOptionsToggle}
                aria-pressed={devOptionsDesiredEnabled}
                onClick={() => void onDevOptionsToggle()}
                variant={devOptionsDesiredEnabled ? 'primary' : 'secondary'}
                loading={devOptionsBusy}
              >
                {devOptionsDesiredEnabled ? 'desired：已开启（点击关闭）' : 'desired：默认关闭（点击开启）'}
              </Button>
              <Button variant="secondary" onClick={() => void refreshDevOptionsStatus()} disabled={devOptionsBusy}>
                刷新
              </Button>
            </div>

            <div style={{ height: 10 }} />
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>desiredEnabled：{String(devOptionsDesiredEnabled)}</div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }} data-testid={TEST_IDS.devOptionsEffective}>
                effectiveEnabled：{String(devOptionsEffectiveEnabled)}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }} data-testid={TEST_IDS.devOptionsReason}>
                reason：{devOptionsReason}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>说明：{toReadableDevOptionsReasonHint(devOptionsReason)}</div>
            </div>

            {devOptionsUiError ? (
              <div className="ui-field__error" role="alert" style={{ marginTop: 10 }}>
                {devOptionsUiError}
              </div>
            ) : null}
          </Card>

          <Card data-testid={TEST_IDS.byokCard}>
            <h2>高级能力：BYOK（自带 Key）</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              配置后 Chat 会优先走 BYOK 直连（不会回显旧 key；更新后会安全保存）。
            </div>

            <div style={{ height: 12 }} />
            <div style={{ display: 'grid', gap: 10 }}>
              <TextInput
                data-testid={TEST_IDS.byokBaseUrl}
                value={byokBaseUrl}
                onChange={(e) => setByokBaseUrl(e.target.value)}
                placeholder="base_url（例如 https://api.openai.com）"
                disabled={byokBusy}
              />
              <TextInput
                data-testid={TEST_IDS.byokModel}
                value={byokModel}
                onChange={(e) => setByokModel(e.target.value)}
                placeholder="model（例如 gpt-4o-mini）"
                disabled={byokBusy}
              />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button data-testid={TEST_IDS.byokSave} variant="secondary" onClick={() => void onByokSaveConfig()} loading={byokBusy}>
                  保存配置
                </Button>
                <Button
                  data-testid={TEST_IDS.byokToggle}
                  variant={byokEnabled ? 'primary' : 'danger'}
                  aria-pressed={byokEnabled}
                  onClick={() => void onByokToggle()}
                  loading={byokBusy}
                >
                  {byokEnabled ? '已启用（点击关闭）' : '默认关闭（点击启用）'}
                </Button>
                <span style={{ color: 'var(--muted)', fontSize: 13 }} data-testid={TEST_IDS.byokStatus}>
                  {byokEnabled && byokBaseUrl.trim() && byokModel.trim() && byokApiKeyPresent
                    ? '状态：已启用（Chat 将走 BYOK 直连）'
                    : byokEnabled
                      ? '状态：已启用（配置未完整时 Chat 仍走 WS）'
                      : '状态：未启用'}
                </span>
              </div>

              <TextInput
                data-testid={TEST_IDS.byokApiKeyInput}
                value={byokApiKeyInput}
                onChange={(e) => setByokApiKeyInput(e.target.value)}
                placeholder="API Key（不会回显旧值；输入新 key 后点击更新）"
                type="password"
                autoComplete="off"
                disabled={byokBusy}
              />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button data-testid={TEST_IDS.byokApiKeyUpdate} variant="secondary" onClick={() => void onByokUpdateApiKey()} loading={byokBusy}>
                  更新 Key
                </Button>
                <Button data-testid={TEST_IDS.byokApiKeyClear} variant="secondary" onClick={() => void onByokClearApiKey()} disabled={byokBusy}>
                  清除 Key
                </Button>
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                  key：{byokApiKeyPresent ? '已设置' : '未设置'} · 安全存储：{byokSecureStorageAvailable ? '可用' : '不可用'}
                </span>
              </div>
            </div>

            {byokUiError ? (
              <div className="ui-field__error" role="alert" style={{ marginTop: 10 }}>
                {byokUiError}
              </div>
            ) : null}
          </Card>

          <Card>
            <h2>高级能力：多模态截图理解（强隐私开关）</h2>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                type="button"
                data-testid={TEST_IDS.toggleVision}
                aria-pressed={visionEnabled}
                onClick={onToggleVision}
                variant={visionEnabled ? 'primary' : 'secondary'}
              >
                {visionEnabled ? '已开启（点击撤回）' : '默认关闭（点击申请开启）'}
              </Button>
              <Button
                type="button"
                data-testid={TEST_IDS.visionSendTestScreenshot}
                onClick={() => void onSendTestScreenshot()}
                disabled={visionSending}
              >
                {visionSending ? '发送中…' : '发送测试截图'}
              </Button>
            </div>

            {visionConsentOpen ? (
              <ConsentPanel
                testIdPanel={TEST_IDS.visionConsentPanel}
                testIdAccept={TEST_IDS.visionConsentAccept}
                testIdDecline={TEST_IDS.visionConsentDecline}
                title="需要你的明确同意"
                description={
                  <>
                    开启后，“发送测试截图”会通过主进程向服务端请求 `POST /api/v1/sensors/screenshot`。默认隐私模式为 strict：不写入 WS、
                    不落盘、不记录截图内容。
                  </>
                }
                acceptLabel="同意并开启"
                declineLabel="暂不开启"
                onAccept={onVisionConsentAccept}
                onDecline={onVisionConsentDecline}
              />
            ) : null}

            {visionError ? (
              <div className="ui-field__error" role="alert" style={{ marginTop: 10 }}>
                {visionError}
              </div>
            ) : null}

            <div style={{ height: 10 }} />
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>建议（服务端返回）：</div>
            <div data-testid={TEST_IDS.visionSuggestion} style={{ marginTop: 6 }}>
              {visionSuggestion}
            </div>
          </Card>

          <Card>
            <h2>
              系统助手（默认关闭）{assistantCategory ? <span style={{ color: 'var(--muted)' }}>（{assistantCategory}）</span> : null}
            </h2>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              开启后主进程会周期读取剪贴板文本；检测到变化且“看起来像英文”时，调用服务端 `POST /api/v1/sensors/event` 获取建议并推送到此处。
            </div>
            <div style={{ height: 12 }} />

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                type="button"
                data-testid={TEST_IDS.toggleAssistant}
                aria-pressed={assistantEnabled}
                onClick={() => void onToggleAssistant()}
                variant={assistantEnabled ? 'primary' : 'secondary'}
              >
                {assistantEnabled ? '已开启（点击关闭）' : '默认关闭（点击开启）'}
              </Button>
              <Button
                type="button"
                data-testid={TEST_IDS.toggleAssistantIdle}
                aria-pressed={assistantIdleEnabled}
                onClick={() => void onToggleAssistantIdle()}
                variant={assistantIdleEnabled ? 'primary' : 'secondary'}
              >
                {assistantIdleEnabled ? '闲置关怀：已开启' : '闲置关怀：默认关闭'}
              </Button>
            </div>

            {assistantUiError ? (
              <div className="ui-field__error" role="alert" style={{ marginTop: 10 }}>
                {assistantUiError}
              </div>
            ) : null}

            <div style={{ height: 10 }} />
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>建议（服务端返回）：</div>
            <div data-testid={TEST_IDS.assistantSuggestion} style={{ marginTop: 6 }}>
              {assistantSuggestion}
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
