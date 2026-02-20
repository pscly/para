import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

type StubServer = {
  baseUrl: string;
  getRequestCount: () => number;
  close: () => Promise<void>;
};

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

async function navigateToSettingsPage(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
  } catch {
  }

  await page.evaluate(() => {
    window.location.hash = '#/settings';
  });

  await expect(page.getByTestId(TEST_IDS.byokBaseUrl)).toBeVisible({ timeout: 15_000 });
}

async function navigateToChatPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/chat';
  });
  await expect(page.getByTestId(TEST_IDS.chatInput)).toBeVisible({ timeout: 15_000 });
}

async function startOpenAiChatStubServer(opts: { expectedApiKey: string; replyText: string }): Promise<StubServer> {
  let requestCount = 0;

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/v1/chat/completions') {
      requestCount += 1;

      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (token !== opts.expectedApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'invalid_request_error' } }));
        return;
      }

      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy();
      });
      await new Promise<void>((resolve) => req.on('end', () => resolve()));

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json', type: 'invalid_request_error' } }));
        return;
      }

      const model =
        typeof parsed === 'object' && parsed !== null && 'model' in parsed
          ? (parsed as { model?: unknown }).model
          : undefined;
      const messages =
        typeof parsed === 'object' && parsed !== null && 'messages' in parsed
          ? (parsed as { messages?: unknown }).messages
          : undefined;
      if (typeof model !== 'string' || !Array.isArray(messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad payload', type: 'invalid_request_error' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_stub',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: opts.replyText },
              finish_reason: 'stop'
            }
          ]
        })
      );
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
    getRequestCount: () => requestCount,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
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

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) out.push(full);
    }
  }
  return out;
}

async function fileContainsNeedle(filePath: string, needle: string): Promise<boolean> {
  if (!needle) return false;
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(filePath);
  } catch {
    return false;
  }
  return buf.includes(Buffer.from(needle, 'utf8'));
}

test('Electron BYOK chat-only: direct completion + no plaintext api_key on disk', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const apiKey = 'test_byok_key_1234567890';
  const stub = await startOpenAiChatStubServer({ expectedApiKey: apiKey, replyText: 'stub-byok-reply' });

  await withTempUserDataDir(async (userDataDir) => {
    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PARA_USER_DATA_DIR: userDataDir
      }
    });

    try {
      const page = await getDebugPanelPage(app);

      await navigateToSettingsPage(page);

      await page.getByTestId(TEST_IDS.byokBaseUrl).fill(stub.baseUrl);
      await page.getByTestId(TEST_IDS.byokModel).fill('gpt-test');
      await page.getByTestId(TEST_IDS.byokSave).click();

      await page.getByTestId(TEST_IDS.byokApiKeyInput).fill(apiKey);
      await page.getByTestId(TEST_IDS.byokApiKeyUpdate).click();

      await page.getByTestId(TEST_IDS.byokToggle).click();

      await navigateToChatPage(page);

      await page.getByTestId(TEST_IDS.chatInput).fill('hello');
      await page.getByTestId(TEST_IDS.chatSend).click();

      await expect(page.getByTestId(TEST_IDS.chatLastAiMessage)).toContainText('stub-byok-reply');
      expect(stub.getRequestCount()).toBeGreaterThan(0);

      const evidencePath = getEvidencePath('task-15-byok.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }

    const files = await listFilesRecursively(userDataDir);
    for (const f of files) {
      const hasPlain = await fileContainsNeedle(f, apiKey);
      expect(hasPlain).toBeFalsy();
    }
  });

  await stub.close();
});
