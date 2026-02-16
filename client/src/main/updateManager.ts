import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

export type UpdatePhase =
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

export type UpdateProgress = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type UpdateState = {
  enabled: boolean;
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progress: UpdateProgress | null;
  error: string | null;
  lastCheckedAt: string | null;
  allowDowngrade: boolean;
  source: 'real' | 'fake' | 'none';
};

type UpdateManagerOptions = {
  onState: (state: UpdateState) => void;
};

function envFlagTruthy(name: string): boolean {
  const v = process.env[name];
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  if (s === '') return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseSemverLike(raw: string): { major: number; minor: number; patch: number } | null {
  const s = raw.trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch };
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemverLike(a);
  const pb = parseSemverLike(b);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function shouldEnableUpdatesByDefault(): boolean {
  if (!app.isPackaged) return false;
  return process.platform === 'win32' || process.platform === 'darwin';
}

function shouldEnableUpdates(): boolean {
  if (envFlagTruthy('PARA_UPDATES_ENABLE')) return true;
  return shouldEnableUpdatesByDefault();
}

function shouldAutoCheckOnStartup(): boolean {
  if (envFlagTruthy('PARA_UPDATES_AUTO_CHECK')) return true;
  if (envFlagTruthy('PARA_UPDATES_DISABLE_AUTO_CHECK')) return false;
  return shouldEnableUpdatesByDefault();
}

function shouldUseFakeUpdater(): boolean {
  if (envFlagTruthy('PARA_UPDATES_FAKE')) return true;
  if (process.env.NODE_ENV === 'test') return true;
  return false;
}

function getFakeRemoteVersion(): string {
  const v = process.env.PARA_UPDATES_FAKE_REMOTE_VERSION;
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return '0.0.1';
}

function getAllowDowngrade(): boolean {
  return envFlagTruthy('PARA_UPDATES_ALLOW_DOWNGRADE');
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

type FakePersistedState = { installedVersion: string };

async function getBaseAppVersion(): Promise<string> {
  const envV = process.env.PARA_APP_VERSION;
  if (typeof envV === 'string' && envV.trim() !== '') return envV.trim();

  const v = app.getVersion();
  if (app.isPackaged) return v;

  try {
    const herePkg = await readJsonFile(path.resolve(__dirname, '..', '..', '..', 'package.json'));
    if (herePkg && typeof herePkg === 'object') {
      const rec = herePkg as Record<string, unknown>;
      const pv = rec.version;
      if (typeof pv === 'string' && pv.trim() !== '') return pv.trim();
    }
  } catch {
  }

  try {
    const cwdPkg = await readJsonFile(path.join(process.cwd(), 'package.json'));
    if (cwdPkg && typeof cwdPkg === 'object') {
      const rec = cwdPkg as Record<string, unknown>;
      const pv = rec.version;
      if (typeof pv === 'string' && pv.trim() !== '') return pv.trim();
    }
  } catch {
  }

  if (typeof v === 'string' && typeof process.versions?.electron === 'string' && v === process.versions.electron) {
    const mainEntry = process.argv[1];
    if (typeof mainEntry === 'string' && mainEntry.trim() !== '') {
      const guessedClientRoot = path.resolve(path.dirname(mainEntry), '..', '..', '..');
      const pkgPath = path.join(guessedClientRoot, 'package.json');
      const pkg = await readJsonFile(pkgPath);
      if (pkg && typeof pkg === 'object') {
        const rec = pkg as Record<string, unknown>;
        const pv = rec.version;
        if (typeof pv === 'string' && pv.trim() !== '') return pv.trim();
      }
    }
  }

  return v;
}

function getFakeStateFilePath(): string {
  return path.join(app.getPath('userData'), 'updates.fake.state.json');
}

async function loadFakeInstalledVersion(fallback: string): Promise<string> {
  const data = await readJsonFile(getFakeStateFilePath());
  if (!data || typeof data !== 'object') return fallback;
  const obj = data as Record<string, unknown>;
  const v = obj.installedVersion;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

async function saveFakeInstalledVersion(installedVersion: string): Promise<void> {
  const v = installedVersion.trim();
  if (!v) return;
  const payload: FakePersistedState = { installedVersion: v };
  await writeJsonFileAtomic(getFakeStateFilePath(), payload);
}

export class UpdateManager {
  private state: UpdateState;
  private readonly onState: (s: UpdateState) => void;
  private fakeInstalledVersion: string;
  private fakeDownloadTimer: NodeJS.Timeout | null = null;
  private fakeRemoteVersion: string;

  constructor(opts: UpdateManagerOptions) {
    this.onState = opts.onState;
    this.fakeInstalledVersion = app.getVersion();
    this.fakeRemoteVersion = getFakeRemoteVersion();

    const enabled = shouldEnableUpdates();
    const allowDowngrade = getAllowDowngrade();
    const source: UpdateState['source'] = enabled ? (shouldUseFakeUpdater() ? 'fake' : 'real') : 'none';
    this.state = {
      enabled,
      phase: enabled ? 'idle' : 'disabled',
      currentVersion: app.getVersion(),
      availableVersion: null,
      progress: null,
      error: null,
      lastCheckedAt: null,
      allowDowngrade,
      source
    };
  }

  async init(): Promise<void> {
    if (!this.state.enabled) {
      this.emit();
      return;
    }

    if (this.state.source === 'fake') {
      const base = await getBaseAppVersion();
      this.fakeInstalledVersion = await loadFakeInstalledVersion(base);
      this.state.currentVersion = this.fakeInstalledVersion;
      this.emit();
      return;
    }

    const { autoUpdater } = await import('electron-updater');

    autoUpdater.autoDownload = false;
    autoUpdater.allowDowngrade = this.state.allowDowngrade;

    const feedUrl = process.env.PARA_UPDATES_URL;
    if (typeof feedUrl === 'string' && feedUrl.trim() !== '') {
      try {
        autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl.trim() } as any);
      } catch (err: unknown) {
        this.setError(`UPDATE_FEED_URL_INVALID:${String((err as any)?.message ?? err)}`);
      }
    }

    autoUpdater.on('checking-for-update', () => {
      this.setPhase('checking');
    });

    autoUpdater.on('update-available', (info: any) => {
      const v = typeof info?.version === 'string' ? info.version : null;
      this.setAvailable(v);
    });

    autoUpdater.on('update-not-available', () => {
      this.setNotAvailable();
    });

    autoUpdater.on('download-progress', (p: any) => {
      const percent = typeof p?.percent === 'number' ? p.percent : 0;
      const transferred = typeof p?.transferred === 'number' ? p.transferred : 0;
      const total = typeof p?.total === 'number' ? p.total : 0;
      const bytesPerSecond = typeof p?.bytesPerSecond === 'number' ? p.bytesPerSecond : 0;
      this.setDownloading({ percent, transferred, total, bytesPerSecond });
    });

    autoUpdater.on('update-downloaded', (info: any) => {
      const v = typeof info?.version === 'string' ? info.version : this.state.availableVersion;
      this.setDownloaded(v);
    });

    autoUpdater.on('error', (err: unknown) => {
      this.setError(`UPDATE_ERROR:${String((err as any)?.message ?? err)}`);
    });

    this.emit();
  }

  startAutoCheckIfNeeded(): void {
    if (!this.state.enabled) return;
    if (!shouldAutoCheckOnStartup()) return;
    setTimeout(() => {
      void this.checkForUpdates();
    }, 3_000);
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async checkForUpdates(): Promise<UpdateState> {
    if (!this.state.enabled) return this.getState();

    this.state.lastCheckedAt = nowIso();
    this.state.error = null;

    if (this.state.source === 'fake') {
      this.setPhase('checking');
      await new Promise((r) => setTimeout(r, 80));

      this.fakeRemoteVersion = getFakeRemoteVersion();

      const installed = this.fakeInstalledVersion;
      const remote = this.fakeRemoteVersion;
      const cmp = compareSemver(remote, installed);
      const isDowngrade = cmp < 0;
      const hasUpdate = cmp > 0 || (isDowngrade && this.state.allowDowngrade);

      if (hasUpdate) {
        this.setAvailable(remote);
      } else {
        this.setNotAvailable();
      }
      return this.getState();
    }

    try {
      const { autoUpdater } = await import('electron-updater');
      this.setPhase('checking');
      await autoUpdater.checkForUpdates();
      return this.getState();
    } catch (err: unknown) {
      this.setError(`UPDATE_CHECK_FAILED:${String((err as any)?.message ?? err)}`);
      return this.getState();
    }
  }

  async downloadUpdate(): Promise<UpdateState> {
    if (!this.state.enabled) return this.getState();

    if (this.state.source === 'fake') {
      if (this.state.phase !== 'available') {
        this.setError('UPDATE_DOWNLOAD_INVALID_STATE');
        return this.getState();
      }

      if (this.fakeDownloadTimer) {
        return this.getState();
      }

      this.setDownloading({ percent: 0, transferred: 0, total: 100, bytesPerSecond: 0 });
      let step = 0;
      this.fakeDownloadTimer = setInterval(() => {
        step += 1;
        const percent = Math.min(100, step * 10);
        const transferred = percent;
        const total = 100;
        const bytesPerSecond = 200_000;
        this.setDownloading({ percent, transferred, total, bytesPerSecond });
        if (percent >= 100) {
          if (this.fakeDownloadTimer) clearInterval(this.fakeDownloadTimer);
          this.fakeDownloadTimer = null;
          this.setDownloaded(this.state.availableVersion);
        }
      }, 60);

      return this.getState();
    }

    try {
      const { autoUpdater } = await import('electron-updater');
      await autoUpdater.downloadUpdate();
      return this.getState();
    } catch (err: unknown) {
      this.setError(`UPDATE_DOWNLOAD_FAILED:${String((err as any)?.message ?? err)}`);
      return this.getState();
    }
  }

  async installUpdate(): Promise<UpdateState> {
    if (!this.state.enabled) return this.getState();

    if (this.state.source === 'fake') {
      if (this.state.phase !== 'downloaded') {
        this.setError('UPDATE_INSTALL_INVALID_STATE');
        return this.getState();
      }

      this.setPhase('installing');
      await new Promise((r) => setTimeout(r, 120));
      const v = this.state.availableVersion;
      if (typeof v === 'string' && v.trim() !== '') {
        this.fakeInstalledVersion = v;
        this.state.currentVersion = v;
        await saveFakeInstalledVersion(v);
      }
      this.state.availableVersion = null;
      this.state.progress = null;
      this.setPhase('installed');
      setTimeout(() => {
        this.setPhase('idle');
      }, 200);
      return this.getState();
    }

    try {
      const { autoUpdater } = await import('electron-updater');
      this.setPhase('installing');
      autoUpdater.quitAndInstall();
      return this.getState();
    } catch (err: unknown) {
      this.setError(`UPDATE_INSTALL_FAILED:${String((err as any)?.message ?? err)}`);
      return this.getState();
    }
  }

  private emit(): void {
    this.onState({ ...this.state });
  }

  private setPhase(phase: UpdatePhase): void {
    this.state.phase = phase;
    if (phase !== 'error') {
      if (phase === 'checking' || phase === 'available' || phase === 'not-available' || phase === 'downloading' || phase === 'downloaded') {
        this.state.error = null;
      }
    }
    this.emit();
  }

  private setAvailable(version: string | null): void {
    this.state.availableVersion = version && version.trim() !== '' ? version.trim() : null;
    this.state.progress = null;
    this.state.phase = 'available';
    this.emit();
  }

  private setNotAvailable(): void {
    this.state.availableVersion = null;
    this.state.progress = null;
    this.state.phase = 'not-available';
    this.emit();
  }

  private setDownloading(progress: UpdateProgress): void {
    this.state.progress = progress;
    this.state.phase = 'downloading';
    this.emit();
  }

  private setDownloaded(version: string | null): void {
    if (version && version.trim() !== '') this.state.availableVersion = version.trim();
    this.state.progress = { percent: 100, transferred: 1, total: 1, bytesPerSecond: 0 };
    this.state.phase = 'downloaded';
    this.emit();
  }

  private setError(message: string): void {
    this.state.error = message;
    this.state.phase = 'error';
    this.emit();
  }
}

export async function createUpdateManager(opts: UpdateManagerOptions): Promise<UpdateManager> {
  const mgr = new UpdateManager(opts);
  await mgr.init();
  mgr.startAutoCheckIfNeeded();
  return mgr;
}
