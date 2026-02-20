import React from 'react';

import { getDesktopApi } from '../../services/desktopApi';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { AppShell } from '../shell/AppShell';
import { TEST_IDS } from '../testIds';

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

function getErrorCode(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return 'UNKNOWN';
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
  if (code.includes('DESKTOP_API_UNAVAILABLE')) return 'Plugins 接口不可用';
  return '插件操作失败';
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
  disabled?: boolean;
};

function ConsentPanel(props: ConsentPanelProps) {
  return (
    <div
      data-testid={props.testIdPanel}
      style={{
        marginTop: 10,
        borderRadius: 14,
        border: '1px solid var(--border)',
        padding: 12,
        background: 'var(--panel)'
      }}
    >
      <div style={{ fontWeight: 650, marginBottom: 6 }}>{props.title}</div>
      <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>{props.description}</div>
      <div style={{ height: 10 }} />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Button
          data-testid={props.testIdAccept}
          variant="primary"
          onClick={props.onAccept}
          disabled={props.disabled}
        >
          {props.acceptLabel}
        </Button>
        <Button
          data-testid={props.testIdDecline}
          variant="secondary"
          onClick={props.onDecline}
          disabled={props.disabled}
        >
          {props.declineLabel}
        </Button>
      </div>
    </div>
  );
}

export function PluginsPage() {
  const [pluginsStatus, setPluginsStatus] = React.useState<PluginStatus | null>(null);
  const [pluginsApproved, setPluginsApproved] = React.useState<ApprovedPluginListItem[]>([]);
  const [pluginsSelectedKey, setPluginsSelectedKey] = React.useState<string>('');
  const [pluginsBusy, setPluginsBusy] = React.useState(false);
  const [pluginsUiError, setPluginsUiError] = React.useState('');
  const [pluginsConsentOpen, setPluginsConsentOpen] = React.useState(false);

  React.useEffect(() => {
    const plugins = getDesktopApi()?.plugins;
    if (!plugins?.getStatus) return;
    void plugins
      .getStatus()
      .then((status) => setPluginsStatus((status as PluginStatus) ?? null))
      .catch(() => {});
  }, []);

  async function refreshPluginsStatus(opts?: { silent?: boolean }) {
    const plugins = getDesktopApi()?.plugins;
    if (!plugins?.getStatus) {
      if (!opts?.silent) setPluginsUiError('Plugins 接口不可用');
      return;
    }

    try {
      const status = await plugins.getStatus();
      setPluginsStatus((status as PluginStatus) ?? null);
      if (!opts?.silent) setPluginsUiError('');
    } catch (err: unknown) {
      if (!opts?.silent) setPluginsUiError(toReadablePluginsError(err));
    }
  }

  async function refreshPluginsApproved(opts?: { silent?: boolean }) {
    const plugins = getDesktopApi()?.plugins;
    if (!plugins?.listApproved) {
      if (!opts?.silent) setPluginsUiError('Plugins 接口不可用');
      return;
    }

    try {
      const list = await plugins.listApproved();
      const safe = Array.isArray(list) ? (list as ApprovedPluginListItem[]) : [];
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

    const plugins = getDesktopApi()?.plugins;
    if (!plugins?.setEnabled) {
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
      setPluginsStatus((status as PluginStatus) ?? null);
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

    const plugins = getDesktopApi()?.plugins;
    if (!plugins?.setEnabled) {
      setPluginsUiError('Plugins 接口不可用');
      return;
    }

    setPluginsBusy(true);
    try {
      const status = await plugins.setEnabled(true);
      setPluginsStatus((status as PluginStatus) ?? null);
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

    const plugins = getDesktopApi()?.plugins;
    if (!plugins?.install) {
      setPluginsUiError('Plugins 接口不可用');
      return;
    }

    setPluginsBusy(true);
    try {
      const parsed = parsePluginKey(pluginsSelectedKey);
      const status = parsed ? await plugins.install(parsed) : await plugins.install();
      setPluginsStatus((status as PluginStatus) ?? null);

      window.setTimeout(() => {
        void refreshPluginsStatus({ silent: true });
      }, 200);
    } catch (err: unknown) {
      setPluginsUiError(toReadablePluginsError(err));
    } finally {
      setPluginsBusy(false);
    }
  }

  const enabled = pluginsStatus?.enabled ?? false;
  const runningLabel = pluginsStatus?.running ? '运行中' : '未运行';
  const installedLabel = pluginsStatus?.installed
    ? `${pluginsStatus.installed.name || pluginsStatus.installed.id}@${pluginsStatus.installed.version}`
    : '（无）';
  const menuItems: PluginMenuItem[] = Array.isArray((pluginsStatus as any)?.menuItems)
    ? (((pluginsStatus as any)?.menuItems ?? []) as PluginMenuItem[])
    : [];
  const lastError = typeof (pluginsStatus as any)?.lastError === 'string' ? (((pluginsStatus as any).lastError ?? '') as string) : '';

  return (
    <AppShell>
      <div className="ui-shell__content">
        <div style={{ width: 'min(980px, 100%)', margin: '0 auto', paddingTop: 24, display: 'grid', gap: 12 }}>
          <Card as="main" data-testid={TEST_IDS.pluginsCard}>
            <h2>Plugins</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              默认关闭。开启后主进程可能会下载并执行“已审核（approved）插件”的代码；你可以随时撤回关闭执行。
            </div>

            <div style={{ height: 12 }} />

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                data-testid={TEST_IDS.pluginsToggle}
                aria-pressed={enabled}
                onClick={() => void onPluginsToggle()}
                loading={pluginsBusy}
                variant={enabled ? 'primary' : 'danger'}
              >
                {enabled ? '已开启执行（点击撤回）' : '默认关闭（点击申请开启）'}
              </Button>
              <span style={{ color: 'var(--muted)', fontSize: 13 }} data-testid={TEST_IDS.pluginsStatus}>
                host：{runningLabel}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>菜单项：{menuItems.length}</span>
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
                    你可以随时点击“撤回”关闭执行。远端开关（feature flags）也可能阻止实际运行。
                  </>
                }
                acceptLabel="同意并开启执行"
                declineLabel="暂不开启"
                onAccept={() => void onPluginsConsentAccept()}
                onDecline={onPluginsConsentDecline}
                disabled={pluginsBusy}
              />
            ) : null}

            <div style={{ height: 12 }} />

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                data-testid={TEST_IDS.pluginsRefresh}
                variant="secondary"
                onClick={() => void onPluginsRefresh()}
                loading={pluginsBusy}
              >
                {pluginsBusy ? '拉取中…' : '拉取 approved 列表'}
              </Button>

              <select
                data-testid={TEST_IDS.pluginsSelect}
                value={pluginsSelectedKey}
                onChange={(e) => setPluginsSelectedKey(e.target.value)}
                disabled={pluginsBusy || pluginsApproved.length === 0}
                style={{
                  flex: 1,
                  minWidth: 280,
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--panel)',
                  color: 'var(--text)'
                }}
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

            <div style={{ height: 12 }} />

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button data-testid={TEST_IDS.pluginsInstall} onClick={() => void onPluginsInstall()} loading={pluginsBusy}>
                {pluginsBusy ? '处理中…' : '安装'}
              </Button>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>已安装：{installedLabel}</span>
            </div>

            {pluginsUiError ? (
              <div className="ui-field__error" role="alert" data-testid={TEST_IDS.pluginsError} style={{ marginTop: 10 }}>
                {pluginsUiError}
              </div>
            ) : null}

            {!pluginsUiError && lastError ? (
              <div className="ui-field__error" role="alert" style={{ marginTop: 10 }}>
                {lastError}
              </div>
            ) : null}

            <div style={{ height: 12 }} />
            <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>插件菜单项：</div>
            <div
              data-testid={TEST_IDS.pluginsMenuList}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                maxHeight: 240,
                overflow: 'auto'
              }}
            >
              {!enabled ? (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>执行已关闭：菜单项为空（安全默认）</div>
              ) : menuItems.length === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 13 }}>暂无菜单项（提示：插件需要在启动时添加菜单项）</div>
              ) : (
                menuItems.map((it) => (
                  <Card
                    key={`${it.pluginId}:${it.id}`}
                    data-testid={TEST_IDS.pluginsMenuItem}
                    style={{ padding: 10, borderRadius: 12, background: 'var(--panel)' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                      <span style={{ fontSize: 13 }}>{it.label}</span>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{it.id}</span>
                    </div>
                  </Card>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
