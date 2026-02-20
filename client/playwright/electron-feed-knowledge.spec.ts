import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';
import type { ElectronApplication, Page } from 'playwright';

type StubServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startKnowledgeStubServer(): Promise<StubServer> {
  const materialCreatedAt = new Map<string, number>();

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/knowledge/materials') {
      req.on('data', () => {
      });
      await new Promise<void>((resolve) => req.on('end', () => resolve()));

      const id = `mat_${randomBytes(8).toString('hex')}`;
      materialCreatedAt.set(id, Date.now());

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          material: {
            id,
            status: 'pending'
          }
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.startsWith('/api/v1/knowledge/materials/')) {
      const id = decodeURIComponent(url.slice('/api/v1/knowledge/materials/'.length));
      const createdAt = materialCreatedAt.get(id);
      if (!createdAt) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'not found' }));
        return;
      }

      const ageMs = Date.now() - createdAt;
      const status = ageMs < 1200 ? 'pending' : 'indexed';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, status }));
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

async function navigateToKnowledgePage(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
  } catch {
  }

  await page.evaluate(() => {
    window.location.hash = '#/knowledge';
  });

  await expect(page.getByTestId(TEST_IDS.feedDropzone)).toBeVisible({ timeout: 15_000 });
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

test('Electron knowledge feed: drag .md, progress -> done', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startKnowledgeStubServer();

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
      await navigateToKnowledgePage(page);

      const dropzone = page.getByTestId(TEST_IDS.feedDropzone);
      await expect(dropzone).toBeVisible();

      const dataTransfer = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        const file = new File(['# Feed test\n\nHello.\n'], 'feed-test.md', { type: 'text/markdown' });
        dt.items.add(file);
        return dt;
      });

      await dropzone.dispatchEvent('dragenter', { dataTransfer });
      await dropzone.dispatchEvent('dragover', { dataTransfer });
      await dropzone.dispatchEvent('drop', { dataTransfer });

      await expect(page.getByTestId(TEST_IDS.feedProgress)).toBeVisible();
      await expect(page.getByTestId(TEST_IDS.feedDone)).toBeVisible();

      const evidencePath = getEvidencePath('task-12-knowledge.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await stub.close();
});
