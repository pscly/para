import fs from 'node:fs';
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

test('Electron smoke: renders debug panel and has stable testids', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  });

  const page = await getDebugPanelPage(app);

  await expect(page.getByTestId(TEST_IDS.chatInput)).toBeVisible();
  await expect(page.getByTestId(TEST_IDS.loginSubmit)).toBeVisible();

  const evidencePath = path.resolve(
    process.cwd(),
    '..',
    '.sisyphus',
    'evidence',
    'task-3-electron-smoke.png'
  );
  await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
  await page.screenshot({ path: evidencePath, fullPage: true });
  expect(fs.existsSync(evidencePath)).toBeTruthy();

  await app.close();
});
