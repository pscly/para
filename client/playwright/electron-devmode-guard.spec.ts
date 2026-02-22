import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

async function getDebugPanelPage(app: ElectronApplication): Promise<Page> {
  // Electron 启动时窗口数量可能抖动；用轮询等待“至少 1 个窗口”，再尽量等到第 2 个窗口出现。
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => app.windows().length, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2)
    .catch(() => {
      // 某些环境可能只创建 1 个窗口；允许降级。
    });

  const pages: Page[] = app.windows();
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

function parseEffectiveEnabled(text: string): boolean | null {
  const m = text.match(/effectiveEnabled[：:=]\s*(true|false)/i);
  if (!m) return null;
  return m[1]!.toLowerCase() === 'true';
}

function getEvidencePath(filename: string): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', filename);
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

async function withTempProfile<T>(
  fn: (args: { userDataDir: string; xdgConfigHome: string }) => Promise<T>
): Promise<T> {
  return withTempDir('para-e2e-userdata-', async (userDataDir) => {
    return withTempDir('para-e2e-xdg-config-', async (xdgConfigHome) => {
      return fn({ userDataDir, xdgConfigHome });
    });
  });
}

async function navigateHash(page: Page, hash: string): Promise<void> {
  await page.evaluate(
    (h) => {
      window.location.hash = h;
    },
    hash
  );
}

async function navigateHashAndWait(page: Page, hash: string): Promise<void> {
  await navigateHash(page, hash);
  await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe(hash);
}

async function setDevOptionsEnabledFromSettings(page: Page, enabled: boolean): Promise<void> {
  await navigateHashAndWait(page, '#/settings');

  const toggle = page.getByTestId(TEST_IDS.devOptionsToggle);
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(TEST_IDS.devOptionsReason)).toBeVisible({ timeout: 15_000 });

  const pressed = await toggle.getAttribute('aria-pressed');
  const alreadyEnabled = pressed === 'true';
  if (enabled !== alreadyEnabled) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', enabled ? 'true' : 'false', { timeout: 15_000 });
  }

  const effective = page.getByTestId(TEST_IDS.devOptionsEffective);
  await expect
    .poll(async () => parseEffectiveEnabled((await effective.textContent()) ?? ''), { timeout: 15_000 })
    .toBe(enabled);
}

async function enableDevOptionsFromSettings(page: Page): Promise<void> {
  await setDevOptionsEnabledFromSettings(page, true);
}

async function disableDevOptionsFromSettings(page: Page): Promise<void> {
  await setDevOptionsEnabledFromSettings(page, false);
}

test('Electron dev options guard: deny redirects to settings', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  await withTempProfile(async ({ userDataDir, xdgConfigHome }) => {
    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PARA_USER_DATA_DIR: userDataDir,
        XDG_CONFIG_HOME: xdgConfigHome
      }
    });

    try {
      const page = await getDebugPanelPage(app);
      // 明确确保开关处于关闭态，再验证 /dev fail-closed。
      await disableDevOptionsFromSettings(page);
      await navigateHash(page, '#/dev/diagnostics');

      await expect
        .poll(async () => page.evaluate(() => window.location.hash), { timeout: 5_000 })
        .toBe('#/settings');

      await expect(page.getByTestId(TEST_IDS.devOptionsToggle)).toBeVisible({ timeout: 15_000 });

      const evidencePath = getEvidencePath('task-12-electron-devoptions-guard-deny.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

test('Electron dev options guard: allow after enabling in Settings', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  await withTempProfile(async ({ userDataDir, xdgConfigHome }) => {
    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PARA_USER_DATA_DIR: userDataDir,
        XDG_CONFIG_HOME: xdgConfigHome
      }
    });

    try {
      const page = await getDebugPanelPage(app);
      await enableDevOptionsFromSettings(page);

      await navigateHash(page, '#/dev/diagnostics');
      await expect(page.getByTestId('devDiagnostics')).toBeVisible({ timeout: 15_000 });

      const evidencePath = getEvidencePath('task-12-electron-devoptions-guard-allow.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
