import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

async function navigateHash(page: Page, hash: string, testIdToWaitFor: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await expect(page.getByTestId(testIdToWaitFor)).toBeVisible({ timeout: 15_000 });
}

async function getBodyText(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body.innerText);
  return typeof text === 'string' ? text : '';
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

test('Electron smoke: core routes render and stable testids exist', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  delete env.PARA_LABS;

  const launchArgs = [mainEntry];
  if (env.CI) {
    launchArgs.push('--no-sandbox', '--disable-gpu');
  }

  let app: ElectronApplication;
  try {
    app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: launchArgs,
      env,
    });
  } catch (err) {
    const evidencePath = path.resolve(
      process.cwd(),
      '..',
      '.sisyphus',
      'evidence',
      'ci-electron-launch-failure.txt',
    );
    await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    await fs.promises.writeFile(
      evidencePath,
      [
        'Electron launch failed',
        `mainEntry=${mainEntry}`,
        `mainEntryExists=${fs.existsSync(mainEntry)}`,
        `electronPath=${String(electronPath)}`,
        `platform=${process.platform}`,
        `arch=${process.arch}`,
        `versions=${JSON.stringify(process.versions)}`,
        `DISPLAY=${env.DISPLAY ?? ''}`,
        `XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR ?? ''}`,
        `launchArgs=${JSON.stringify(launchArgs)}`,
        '',
        msg,
        '',
      ].join('\n'),
      { encoding: 'utf8' },
    );
    throw err;
  }

  try {
    const page = await getDebugPanelPage(app);

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
    } catch {
    }

    await navigateHash(page, '#/login', TEST_IDS.loginSubmit);
    await navigateHash(page, '#/chat', TEST_IDS.chatInput);

    // Forbidden copy smoke guard: scan all user-visible core routes.
    const forbidden = ['调试', 'Task', '最小 UI', '离线模拟'];
    const scannedRoutes = [
      { hash: '#/chat', anchor: TEST_IDS.chatInput },
      { hash: '#/updates', anchor: TEST_IDS.updateCard },
    ] as const;

    const hitsByRoute: Record<string, string[]> = {};
    for (const r of scannedRoutes) {
      await navigateHash(page, r.hash, r.anchor);
      const bodyText = await getBodyText(page);
      hitsByRoute[r.hash] = forbidden.filter((k) => bodyText.includes(k));
    }

    const hits = Array.from(new Set(Object.values(hitsByRoute).flat())).sort();

    const copyEvidencePath = path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'task-15-smoke-and-copy.txt');
    await fs.promises.mkdir(path.dirname(copyEvidencePath), { recursive: true });
    await fs.promises.writeFile(
      copyEvidencePath,
      [
        'Electron smoke copy scan',
        `routes=${JSON.stringify(scannedRoutes.map((r) => r.hash))}`,
        `forbidden=${JSON.stringify(forbidden)}`,
        `hits=${JSON.stringify(hits)}`,
        `hitsByRoute=${JSON.stringify(hitsByRoute)}`,
      ].join('\n') + '\n',
      { encoding: 'utf8' },
    );
    expect(fs.existsSync(copyEvidencePath)).toBeTruthy();

    expect(hits).toEqual([]);

    await expect(page.getByTestId(TEST_IDS.galleryGenerate)).toHaveCount(0);
    await expect(page.getByTestId(TEST_IDS.timelineCard)).toHaveCount(0);
    await expect(page.getByTestId(TEST_IDS.socialRoomCard)).toHaveCount(0);

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
  } finally {
    await app.close();
  }
});
