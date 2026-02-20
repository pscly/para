import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';
import type { ElectronApplication, Page } from 'playwright';

type StubServer = {
  baseUrl: string;
  getScreenshotHits: () => number;
  close: () => Promise<void>;
};

async function startVisionStubServer(): Promise<StubServer> {
  let screenshotHits = 0;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/sensors/screenshot') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => {
        if (Buffer.isBuffer(c)) chunks.push(c);
        else chunks.push(Buffer.from(c));
      });
      await new Promise<void>((resolve) => req.on('end', () => resolve()));

      screenshotHits += 1;

      let payload: unknown = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        payload = null;
      }

      const rec = (payload && typeof payload === 'object') ? (payload as Record<string, unknown>) : null;
      const hasSaveId = typeof rec?.save_id === 'string' && rec.save_id.trim() !== '';
      const hasImage = typeof rec?.image_base64 === 'string' && rec.image_base64.trim() !== '';
      const hasPrivacy = typeof rec?.privacy_mode === 'string' && rec.privacy_mode.trim() !== '';

      if (!hasSaveId || !hasImage || !hasPrivacy) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suggestion: 'stub: 试着把窗口放大一点，然后再发一次截图。' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('STUB_SERVER_NO_ADDRESS');
  }

  const port = (addr as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    getScreenshotHits: () => screenshotHits,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
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

async function navigateToSettingsPage(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
  } catch {
  }

  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });

  await expect(page.getByTestId(TEST_IDS.toggleVision)).toBeVisible({ timeout: 15_000 });
}

function getEvidencePath(filename: string): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', filename);
}

async function withTempUserDataDir<T>(fn: (userDataDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-userdata-'));
  try {
    return await fn(dir);
  } finally {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
    }
  }
}

async function writeStubAuthTokens(userDataDir: string): Promise<void> {
  const filePath = path.join(userDataDir, 'auth.tokens.json');
  const stored = {
    secure: false,
    accessToken: 'stub-access-token',
    refreshToken: 'stub-refresh-token'
  };
  await fs.promises.mkdir(userDataDir, { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(stored), { encoding: 'utf8' });
}

test('Electron vision screenshot: gated by consent + shows suggestion', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startVisionStubServer();

  await withTempUserDataDir(async (userDataDir) => {
    await writeStubAuthTokens(userDataDir);

    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PARA_SERVER_BASE_URL: stub.baseUrl,
        PARA_USER_DATA_DIR: userDataDir
      }
    });

    try {
      const page = await getDebugPanelPage(app);

      await navigateToSettingsPage(page);

      const toggle = page.getByTestId(TEST_IDS.toggleVision);
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');

      await page.getByTestId(TEST_IDS.visionSendTestScreenshot).click();
      await page.waitForTimeout(300);
      expect(stub.getScreenshotHits()).toBe(0);

      await toggle.click();
      await expect(page.getByTestId(TEST_IDS.visionConsentPanel)).toBeVisible();
      await page.getByTestId(TEST_IDS.visionConsentAccept).click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');

      await page.getByTestId(TEST_IDS.visionSendTestScreenshot).click();

      await expect.poll(() => stub.getScreenshotHits()).toBe(1);
      await expect(page.getByTestId(TEST_IDS.visionSuggestion)).toContainText('stub:');

      const evidencePath = getEvidencePath('task-15-vision-suggestion.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await stub.close();
});
