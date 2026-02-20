import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

type StubServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startFeatureFlagsStubServer(): Promise<StubServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url === '/api/v1/feature_flags' || url.startsWith('/api/v1/feature_flags?'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ feature_flags: { plugins_enabled: true } }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('STUB_SERVER_NO_ADDRESS');
  const port = (addr as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
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

function getEvidencePath(filename: string): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'final-ui', filename);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function hardenForStableScreenshots(page: Page): Promise<void> {
  await page.addStyleTag({
    content: [
      '*{',
      '  animation: none !important;',
      '  transition: none !important;',
      '  caret-color: transparent !important;',
      '}',
      ':focus{ outline: none !important; }'
    ].join('\n')
  });
  await page.evaluate(() => {
    try {
      (document.activeElement as HTMLElement | null)?.blur?.();
    } catch {
    }
    window.scrollTo(0, 0);
  });
}

async function navigateHashAndWait(page: Page, hash: string, anchorTestId: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await expect(page.getByTestId(anchorTestId)).toBeVisible({ timeout: 15_000 });
}

async function waitForAnyAnchor(page: Page, testIds: string[]): Promise<void> {
  const errors: unknown[] = [];
  for (const id of testIds) {
    try {
      await expect(page.getByTestId(id)).toBeVisible({ timeout: 10_000 });
      return;
    } catch (e) {
      errors.push(e);
    }
  }
  throw new Error(`E2E_NO_ANCHOR_VISIBLE: ${testIds.join(',')} | errors=${errors.length}`);
}

async function screenshotToEvidence(page: Page, filename: string): Promise<void> {
  const screenshotPath = getEvidencePath(filename);
  await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  expect(fs.existsSync(screenshotPath)).toBeTruthy();
}

test('UI snapshots: Login/Chat/Settings/Plugins to final-ui evidence', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startFeatureFlagsStubServer();

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PARA_SERVER_BASE_URL: stub.baseUrl
  };
  delete (env as any).PARA_LABS;

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    env
  });

  try {
    const page = await getDebugPanelPage(app);
    await page.setViewportSize({ width: 1280, height: 800 });
    await hardenForStableScreenshots(page);

    const themes: Array<'light' | 'dark'> = ['light', 'dark'];
    for (const theme of themes) {
      await setTheme(page, theme);

      await navigateHashAndWait(page, '#/login', TEST_IDS.loginSubmit);
      await screenshotToEvidence(page, `login-${theme}.png`);

      await setTheme(page, theme);
      await navigateHashAndWait(page, '#/chat', TEST_IDS.chatInput);
      await screenshotToEvidence(page, `chat-${theme}.png`);

      await setTheme(page, theme);
      await page.evaluate(() => {
        window.location.hash = '#/settings';
      });
      await waitForAnyAnchor(page, [TEST_IDS.userDataCard, TEST_IDS.updateCard]);
      await screenshotToEvidence(page, `settings-${theme}.png`);

      await setTheme(page, theme);
      await navigateHashAndWait(page, '#/plugins', TEST_IDS.pluginsCard);
      await screenshotToEvidence(page, `plugins-${theme}.png`);
    }
  } finally {
    await app.close();
    await stub.close();
  }
});
