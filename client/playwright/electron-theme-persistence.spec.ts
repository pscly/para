import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

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

test('Task 10e: Settings theme persists across relaunch (PARA_USER_DATA_DIR)', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  await withTempDir('para-e2e-theme-persist-', async (userDataDir) => {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PARA_USER_DATA_DIR: userDataDir
    };
    delete (env as any).PARA_LABS;

    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env
    });

    try {
      const page = await getDebugPanelPage(app);
      await page.evaluate(() => {
        window.location.hash = '#/settings';
      });

      await expect(page.getByTestId(TEST_IDS.updateCard)).toBeVisible();

      await page.getByRole('button', { name: 'dark' }).click();

      await expect
        .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('dark');
    } finally {
      await app.close();
    }

    const app2 = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env
    });

    try {
      const page2 = await getDebugPanelPage(app2);
      await page2.evaluate(() => {
        window.location.hash = '#/settings';
      });

      await expect(page2.getByTestId(TEST_IDS.updateCard)).toBeVisible();

      await expect
        .poll(() => page2.evaluate(() => document.documentElement.getAttribute('data-theme')))
        .toBe('dark');
    } finally {
      await app2.close();
    }
  });
});
