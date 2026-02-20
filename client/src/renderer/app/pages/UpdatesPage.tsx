import React from 'react';

import { getDesktopApi, getUnsubscribe } from '../../services/desktopApi';
import { Card } from '../../ui/Card';
import { AppShell } from '../shell/AppShell';
import { TEST_IDS } from '../testIds';

type DesktopApiExt = NonNullable<Window['desktopApi']>;
type UpdateState = Awaited<ReturnType<DesktopApiExt['update']['getState']>>;

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

export function UpdatesPage() {
  const [updateState, setUpdateState] = React.useState<UpdateState | null>(null);
  const [updateUiError, setUpdateUiError] = React.useState('');
  const [updateBusy, setUpdateBusy] = React.useState(false);

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

  async function onUpdateDownload() {
    const update = getDesktopApi()?.update;
    if (!update) {
      setUpdateUiError('更新接口不可用');
      return;
    }

    setUpdateBusy(true);
    setUpdateUiError('');
    try {
      const s = await update.download();
      setUpdateState(s);
    } catch {
      setUpdateUiError('下载更新失败');
    } finally {
      setUpdateBusy(false);
    }
  }

  async function onUpdateInstall() {
    const update = getDesktopApi()?.update;
    if (!update) {
      setUpdateUiError('更新接口不可用');
      return;
    }

    setUpdateBusy(true);
    setUpdateUiError('');
    try {
      const s = await update.install();
      setUpdateState(s);
    } catch {
      setUpdateUiError('安装更新失败');
    } finally {
      setUpdateBusy(false);
    }
  }

  const phase = updateState?.phase;
  const enabled = updateState?.enabled;
  const checkDisabled =
    updateBusy ||
    enabled === false ||
    phase === 'checking' ||
    phase === 'downloading' ||
    phase === 'installing';
  const downloadDisabled = updateBusy || enabled !== true || phase !== 'available';
  const installDisabled = updateBusy || enabled !== true || phase !== 'downloaded';

  return (
    <AppShell>
      <div className="ui-shell__content">
        <div style={{ width: 'min(980px, 100%)', margin: '0 auto', paddingTop: 24, display: 'grid', gap: 12 }}>
          <Card as="main" data-testid={TEST_IDS.updateCard}>
            <h2>更新</h2>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              生产环境默认开启（Windows + macOS）；开发环境默认关闭，可通过环境变量显式开启。
            </div>
            <div style={{ height: 12 }} />

            <div className="row" data-testid={TEST_IDS.updateStatus}>
              <span className="pill">状态：{toUpdatePhaseLabel(phase ?? 'disabled')}</span>
              <span className="pill">当前：{updateState?.currentVersion ?? 'unknown'}</span>
              <span className="pill">可用：{updateState?.availableVersion ?? '-'}</span>
            </div>

            {updateState?.progress ? (
              <div className="row" style={{ marginTop: 6 }}>
                <span className="pill">进度：{clampPercent(updateState.progress.percent).toFixed(0)}%</span>
              </div>
            ) : null}

            <div style={{ height: 12 }} />

            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <button type="button" data-testid={TEST_IDS.updateCheck} onClick={() => void onUpdateCheck()} disabled={checkDisabled}>
                检查更新
              </button>
              <button
                type="button"
                data-testid={TEST_IDS.updateDownload}
                onClick={() => void onUpdateDownload()}
                disabled={downloadDisabled}
              >
                下载
              </button>
              <button
                type="button"
                data-testid={TEST_IDS.updateInstall}
                className="btn-warn"
                onClick={() => void onUpdateInstall()}
                disabled={installDisabled}
              >
                安装并重启
              </button>
            </div>

            {updateState?.lastCheckedAt ? <div className="meta">上次检查：{updateState.lastCheckedAt}</div> : null}
            {typeof updateState?.source === 'string' ? <div className="meta">更新源：{updateState.source}</div> : null}
            {updateState?.allowDowngrade ? <div className="meta">允许降级：已开启（仅测试/紧急）</div> : null}

            {updateUiError ? <div className="danger">{updateUiError}</div> : null}
            {updateState?.error ? <div className="danger">{updateState.error}</div> : null}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
