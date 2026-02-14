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
  getClipboardHits: () => number;
  getIdleHits: () => number;
  close: () => Promise<void>;
};

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  req.on('data', (c) => {
    if (Buffer.isBuffer(c)) chunks.push(c);
    else chunks.push(Buffer.from(c));
  });
  await new Promise<void>((resolve) => req.on('end', () => resolve()));

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function startAssistantStubServer(): Promise<StubServer> {
  let clipboardHits = 0;
  let idleHits = 0;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/sensors/event') {
      const payload = await readJsonBody(req);
      const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
      const eventType = typeof rec?.event_type === 'string' ? rec.event_type : '';

      if (eventType === 'clipboard') {
        clipboardHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ suggestion: 'stub: translate?', category: 'translation' }));
        return;
      }

      if (eventType === 'idle') {
        idleHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ suggestion: 'stub: care', category: 'care' }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'bad payload' }));
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
    getClipboardHits: () => clipboardHits,
    getIdleHits: () => idleHits,
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

function getEvidencePath(): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'task-16-assistant-suggest.png');
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

test('Electron assistant suggest: clipboard + idle', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startAssistantStubServer();

  try {
    await withTempUserDataDir(async (userDataDir) => {
      await writeStubAuthTokens(userDataDir);

      const app = await electron.launch({
        executablePath: electronPath as unknown as string,
        args: [mainEntry],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PARA_SERVER_BASE_URL: stub.baseUrl,
          PARA_USER_DATA_DIR: userDataDir,
          PARA_ASSISTANT_IDLE_MS: '600'
        }
      });

      try {
        const page = await getDebugPanelPage(app);

        const toggleAssistant = page.getByTestId(TEST_IDS.toggleAssistant);
        await expect(toggleAssistant).toBeVisible();
        await expect(toggleAssistant).toHaveAttribute('aria-pressed', 'false');
        await toggleAssistant.click();
        await expect(toggleAssistant).toHaveAttribute('aria-pressed', 'true');

        await page.waitForTimeout(800);
        expect(stub.getIdleHits()).toBe(0);
        expect(stub.getClipboardHits()).toBe(0);

        const uniqueText = `This is an E2E unique clipboard text ${Date.now()}. Please translate it into Chinese.`;
        await page.evaluate(async (text) => {
          const api = (window as any).desktopApi;
          const fn = api?.assistant?.writeClipboardText;
          if (typeof fn !== 'function') throw new Error('E2E_NO_WRITE_CLIPBOARD');
          await fn(text);
        }, uniqueText);

        await expect.poll(() => stub.getClipboardHits(), { timeout: 15_000 }).toBe(1);
        await expect(page.getByTestId(TEST_IDS.assistantSuggestion)).toContainText('stub:');

        const assistantCard = page.locator('section.card').filter({ hasText: '系统助手' });
        await expect(assistantCard.getByText('（translation）')).toBeVisible();

        const toggleIdle = page.getByTestId(TEST_IDS.toggleAssistantIdle);
        await expect(toggleIdle).toBeVisible();
        await expect(toggleIdle).toHaveAttribute('aria-pressed', 'false');
        await toggleIdle.click();
        await expect(toggleIdle).toHaveAttribute('aria-pressed', 'true');

        await expect.poll(() => stub.getIdleHits(), { timeout: 10_000 }).toBe(1);
        await expect(page.getByTestId(TEST_IDS.assistantSuggestion)).toContainText('stub: care');
        await expect(assistantCard.getByText('（care）')).toBeVisible();

        const evidencePath = getEvidencePath();
        await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
        await page.screenshot({ path: evidencePath, fullPage: true });
        expect(fs.existsSync(evidencePath)).toBeTruthy();
      } finally {
        await app.close();
      }
    });
  } finally {
    await stub.close();
  }
});
