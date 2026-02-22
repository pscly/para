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

function readClientPackageVersion(): string {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const obj = JSON.parse(raw) as { version?: unknown };
  if (typeof obj.version !== 'string' || obj.version.trim() === '') {
    throw new Error('E2E_CLIENT_PKG_VERSION_MISSING');
  }
  return obj.version.trim();
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

async function navigateHashAndWait(page: Page, hash: string): Promise<void> {
  await page.evaluate(
    (h) => {
      window.location.hash = h;
    },
    hash
  );
  await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 5_000 }).toBe(hash);
}

async function enableDevOptionsFromSettings(page: Page): Promise<void> {
  await navigateHashAndWait(page, '#/settings');
  const toggle = page.getByTestId(TEST_IDS.devOptionsToggle);
  await expect(toggle).toBeVisible({ timeout: 15_000 });

  const pressed = await toggle.getAttribute('aria-pressed');
  const alreadyEnabled = pressed === 'true';
  if (!alreadyEnabled) {
    await toggle.click();
  }

  const effective = page.getByTestId(TEST_IDS.devOptionsEffective);
  await expect
    .poll(async () => (await effective.textContent()) ?? '', { timeout: 15_000 })
    .toContain('effectiveEnabled：true');
}

test('Electron Task4: About/meta shows app version', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const expectedVersion = readClientPackageVersion();

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
      await navigateHashAndWait(page, '#/dev/debug');

      const meta = page.getByTestId(TEST_IDS.appMetaVersions);
      await expect(meta).toBeVisible({ timeout: 15_000 });
      await expect(meta).toContainText(`App: ${expectedVersion}`);
    } finally {
      await app.close();
    }
  });
});
