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

function getEvidencePath(): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'task-7-2-update-rollback.txt');
}

async function mkTempUserDataDir(): Promise<string> {
  const base = path.resolve(process.cwd(), 'playwright-results');
  await fs.promises.mkdir(base, { recursive: true });
  return fs.promises.mkdtemp(path.join(base, 'userData-updates-'));
}

async function launchApp(mainEntry: string, env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    env: {
      ...process.env,
      ...env,
      NODE_ENV: 'test'
    }
  });
}

test('Electron updates (fake): publish -> update -> rollback (controlled)', async () => {
  test.setTimeout(90_000);

  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const userDataDir = await mkTempUserDataDir();
  const evidenceFile = getEvidencePath();
  await fs.promises.mkdir(path.dirname(evidenceFile), { recursive: true });

  const lines: string[] = [];
  lines.push(`[task-7-2] updates rollback e2e (fake updater)`);
  lines.push(`platform=${process.platform}`);
  lines.push(`userDataDir=${userDataDir}`);
  lines.push(`note=fake updater only; production uses electron-updater`);

  lines.push('---');
  lines.push('step=publish: remote=0.0.2');

  const app1 = await launchApp(mainEntry, {
    PARA_USER_DATA_DIR: userDataDir,
    PARA_UPDATES_ENABLE: '1',
    PARA_UPDATES_FAKE: '1',
    PARA_UPDATES_DISABLE_AUTO_CHECK: '1',
    PARA_UPDATES_FAKE_REMOTE_VERSION: '0.0.2'
  });

  try {
    const page = await getDebugPanelPage(app1);

    await expect(page.getByTestId(TEST_IDS.updateCard)).toBeVisible();
    await page.getByTestId(TEST_IDS.updateCheck).click();

    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('发现更新');
    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('可用：0.0.2');

    await page.getByTestId(TEST_IDS.updateDownload).click();
    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('已下载');

    await page.getByTestId(TEST_IDS.updateInstall).click();
    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('当前：0.0.2');

    lines.push('result=updated current=0.0.2');
  } finally {
    await app1.close();
  }

  lines.push('---');
  lines.push('step=rollback candidate (downgrade blocked by default): remote=0.0.1 allowDowngrade=0');

  const app2 = await launchApp(mainEntry, {
    PARA_USER_DATA_DIR: userDataDir,
    PARA_UPDATES_ENABLE: '1',
    PARA_UPDATES_FAKE: '1',
    PARA_UPDATES_DISABLE_AUTO_CHECK: '1',
    PARA_UPDATES_FAKE_REMOTE_VERSION: '0.0.1'
  });

  try {
    const page = await getDebugPanelPage(app2);

    await page.getByTestId(TEST_IDS.updateCheck).click();
    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('已是最新');

    lines.push('result=blocked (no allowDowngrade)');
  } finally {
    await app2.close();
  }

  lines.push('---');
  lines.push('step=rollback (controlled): remote=0.0.1 allowDowngrade=1');

  const app3 = await launchApp(mainEntry, {
    PARA_USER_DATA_DIR: userDataDir,
    PARA_UPDATES_ENABLE: '1',
    PARA_UPDATES_FAKE: '1',
    PARA_UPDATES_DISABLE_AUTO_CHECK: '1',
    PARA_UPDATES_ALLOW_DOWNGRADE: '1',
    PARA_UPDATES_FAKE_REMOTE_VERSION: '0.0.1'
  });

  try {
    const page = await getDebugPanelPage(app3);

    await page.getByTestId(TEST_IDS.updateCheck).click();
    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('发现更新');
    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('可用：0.0.1');

    await page.getByTestId(TEST_IDS.updateDownload).click();
    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('已下载');

    await page.getByTestId(TEST_IDS.updateInstall).click();
    await expect(page.getByTestId(TEST_IDS.updateStatus)).toContainText('当前：0.0.1');

    lines.push('result=rolled_back current=0.0.1');
  } finally {
    await app3.close();
  }

  lines.push('---');
  lines.push(`osTmpDir=${os.tmpdir()}`);

  await fs.promises.writeFile(evidenceFile, `${lines.join('\n')}\n`, 'utf-8');
  expect(fs.existsSync(evidenceFile)).toBeTruthy();
});
