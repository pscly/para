import path from 'node:path';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';

export type ParaInstallerConfig = {
  userDataDir: string;
  version?: number;
  source?: string;
};

export function getParaInstallerConfigPath(appDataDir: string): string {
  return path.join(appDataDir, 'Para Desktop', 'para.config.json');
}

export function tryReadParaInstallerConfigSync(appDataDir: string): ParaInstallerConfig | null {
  const configPath = getParaInstallerConfigPath(appDataDir);
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;

    const userDataDir = (parsed as { userDataDir?: unknown }).userDataDir;
    if (typeof userDataDir !== 'string') return null;
    const trimmed = userDataDir.trim();
    if (trimmed === '') return null;

    const version = (parsed as { version?: unknown }).version;
    const source = (parsed as { source?: unknown }).source;

    return {
      userDataDir: trimmed,
      version: typeof version === 'number' ? version : undefined,
      source: typeof source === 'string' ? source : undefined
    };
  } catch {
    return null;
  }
}

function toConfigUserDataDirString(absPath: string): string {
  return process.platform === 'win32' ? absPath.replace(/\\/g, '/') : absPath;
}

export async function writeParaInstallerConfigAtomic(appDataDir: string, cfg: ParaInstallerConfig): Promise<void> {
  const configPath = getParaInstallerConfigPath(appDataDir);
  const dir = path.dirname(configPath);
  await fsp.mkdir(dir, { recursive: true });

  const userDataDir = cfg.userDataDir.trim();
  if (userDataDir === '') {
    throw new Error('PARA_CONFIG_INVALID_USER_DATA_DIR');
  }

  const payload: ParaInstallerConfig = {
    ...cfg,
    userDataDir: toConfigUserDataDirString(userDataDir)
  };

  const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  await fsp.rename(tmp, configPath);
}
