import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

function getEvidencePath(filename: string): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', filename);
}

async function getDebugPanelPage(app: ElectronApplication): Promise<Page> {
  const timeoutMs = 5_000;
  const pollIntervalMs = 100;
  const deadline = Date.now() + timeoutMs;

  let pages: Page[] = app.windows();
  while (pages.length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pages = app.windows();
  }

  if (pages.length === 0) throw new Error('E2E_NO_ELECTRON_WINDOWS');

  let bestPage: Page = pages[0]!;
  let bestWidth = -1;

  for (const page of pages) {
    if (page.isClosed()) continue;

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 1_000 });
    } catch {
    }

    let width = 0;
    try {
      const w = await page.evaluate(() => window.innerWidth);
      width = typeof w === 'number' ? w : 0;
    } catch {
      width = 0;
    }

    if (width > bestWidth) {
      bestWidth = width;
      bestPage = page;
    }
  }

  return bestPage;
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
    }
  }
}

async function writeStubUserDataFiles(userDataDir: string): Promise<void> {
  await fs.promises.mkdir(userDataDir, { recursive: true });

  const authTokensPath = path.join(userDataDir, 'auth.tokens.json');
  await fs.promises.writeFile(
    authTokensPath,
    JSON.stringify({ secure: false, accessToken: 'stub-access-token', refreshToken: 'stub-refresh-token' }),
    { encoding: 'utf8' },
  );

  const pluginsDir = path.join(userDataDir, 'plugins');
  await fs.promises.mkdir(pluginsDir, { recursive: true });
  await fs.promises.writeFile(path.join(pluginsDir, 'stub.txt'), 'ok', { encoding: 'utf8' });

  const updatesFakeStatePath = path.join(userDataDir, 'updates.fake.state.json');
  await fs.promises.writeFile(updatesFakeStatePath, JSON.stringify({ installedVersion: '0.0.1' }), { encoding: 'utf8' });
}

function getConfigPathFromXdgConfigHome(xdgConfigHome: string): string {
  return path.join(xdgConfigHome, 'Para Desktop', 'para.config.json');
}

test('Task 14: migrate userData dir -> write config -> relaunch uses new userDataDir', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  await withTempDir('para-e2e-userdata-src-', async (sourceUserDataDir) => {
    await withTempDir('para-e2e-xdg-config-', async (xdgConfigHome) => {
      await writeStubUserDataFiles(sourceUserDataDir);

      const targetUserDataDir = path.join(os.tmpdir(), `para-e2e-userdata-dst-${Date.now()}-${Math.random().toString(16).slice(2)}`);

      const app = await electron.launch({
        executablePath: electronPath as unknown as string,
        args: [mainEntry],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PARA_USER_DATA_DIR: sourceUserDataDir,
          XDG_CONFIG_HOME: xdgConfigHome
        }
      });

      try {
        const page = await getDebugPanelPage(app);
        await page.evaluate(() => { window.location.hash = '#/settings'; });
        await expect(page.getByTestId(TEST_IDS.userDataCard)).toBeVisible();

        const task10EvidencePath = getEvidencePath('task-10-userdata-migration.png');
        await fs.promises.mkdir(path.dirname(task10EvidencePath), { recursive: true });
        await page.screenshot({ path: task10EvidencePath, fullPage: true });
        expect(fs.existsSync(task10EvidencePath)).toBeTruthy();

        await page.getByTestId(TEST_IDS.userDataTargetInput).fill(targetUserDataDir);
        await page.getByTestId(TEST_IDS.userDataMigrate).click();

        const status = page.getByTestId(TEST_IDS.userDataStatus);
        await expect(status).toContainText('需要重启', { timeout: 30_000 });
        await expect(page.getByTestId(TEST_IDS.userDataRestart)).toBeVisible();

        const evidencePath = getEvidencePath('task-14-userdata-migrate.png');
        await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
        await page.screenshot({ path: evidencePath, fullPage: true });
        expect(fs.existsSync(evidencePath)).toBeTruthy();

        const configPath = getConfigPathFromXdgConfigHome(xdgConfigHome);
        await expect
          .poll(async () => fs.existsSync(configPath), { timeout: 5_000 })
          .toBeTruthy();

        const raw = await fs.promises.readFile(configPath, { encoding: 'utf8' });
        const parsed = JSON.parse(raw) as any;
        expect(typeof parsed?.userDataDir).toBe('string');
        expect(path.resolve(String(parsed.userDataDir))).toBe(path.resolve(targetUserDataDir));
      } finally {
        await app.close();
      }

      const app2 = await electron.launch({
        executablePath: electronPath as unknown as string,
        args: [mainEntry],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          XDG_CONFIG_HOME: xdgConfigHome
        }
      });

      try {
        const page2 = await getDebugPanelPage(app2);
        await expect(page2.getByTestId(TEST_IDS.userDataCard)).toBeVisible();

        const info = await page2.evaluate(async () => {
          const api = (window as any).desktopApi;
          return api?.userData?.getInfo ? await api.userData.getInfo() : null;
        });

        expect(info).toBeTruthy();
        expect(path.resolve(String((info as any).userDataDir))).toBe(path.resolve(targetUserDataDir));

        expect(fs.existsSync(path.join(targetUserDataDir, 'auth.tokens.json'))).toBeTruthy();
        expect(fs.existsSync(path.join(targetUserDataDir, 'plugins', 'stub.txt'))).toBeTruthy();
        expect(fs.existsSync(path.join(targetUserDataDir, 'updates.fake.state.json'))).toBeTruthy();
      } finally {
        await app2.close();
      }

      try {
        await fs.promises.rm(targetUserDataDir, { recursive: true, force: true });
      } catch {
      }
    });
  });
});

test('Task 14: migrate failure -> config not written -> no restart required', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  await withTempDir('para-e2e-userdata-src-', async (sourceUserDataDir) => {
    await withTempDir('para-e2e-xdg-config-', async (xdgConfigHome) => {
      await writeStubUserDataFiles(sourceUserDataDir);

      const targetUserDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-userdata-dst-nonempty-'));
      await fs.promises.writeFile(path.join(targetUserDataDir, 'already.txt'), 'x', { encoding: 'utf8' });

      const app = await electron.launch({
        executablePath: electronPath as unknown as string,
        args: [mainEntry],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PARA_USER_DATA_DIR: sourceUserDataDir,
          XDG_CONFIG_HOME: xdgConfigHome
        }
      });

      try {
        const page = await getDebugPanelPage(app);
        await page.evaluate(() => { window.location.hash = '#/settings'; });
        await expect(page.getByTestId(TEST_IDS.userDataCard)).toBeVisible();

        await page.getByTestId(TEST_IDS.userDataTargetInput).fill(targetUserDataDir);
        await page.getByTestId(TEST_IDS.userDataMigrate).click();

        await expect(page.getByText('目标目录非空')).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId(TEST_IDS.userDataRestart)).toHaveCount(0);

        const evidencePath = getEvidencePath('task-14-userdata-migrate-fail.png');
        await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
        await page.screenshot({ path: evidencePath, fullPage: true });
        expect(fs.existsSync(evidencePath)).toBeTruthy();

        const configPath = getConfigPathFromXdgConfigHome(xdgConfigHome);
        expect(fs.existsSync(configPath)).toBeFalsy();
      } finally {
        await app.close();
      }

      try {
        await fs.promises.rm(targetUserDataDir, { recursive: true, force: true });
      } catch {
      }
    });
  });
});
