import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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

type StubGalleryItem = {
  id: string;
  saveId: string;
  prompt: string;
  createdAt: number;
  status: 'pending' | 'completed' | 'failed';
};

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ekv7bYAAAAASUVORK5CYII=';
const ONE_BY_ONE_PNG_DATA_URL = `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`;

async function startGalleryStubServer(): Promise<StubServer> {
  const items: StubGalleryItem[] = [];

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/gallery/generate') {
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
        res.end(JSON.stringify({ detail: 'bad json' }));
        return;
      }

      const saveId =
        typeof parsed === 'object' && parsed !== null && 'save_id' in parsed
          ? (parsed as { save_id?: unknown }).save_id
          : undefined;
      const prompt =
        typeof parsed === 'object' && parsed !== null && 'prompt' in parsed
          ? (parsed as { prompt?: unknown }).prompt
          : undefined;

      if (typeof saveId !== 'string' || typeof prompt !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      const id = `gal_${randomBytes(8).toString('hex')}`;
      const createdAt = Date.now();
      const item: StubGalleryItem = { id, saveId, prompt, createdAt, status: 'pending' };
      items.unshift(item);

      setTimeout(() => {
        const found = items.find((x) => x.id === id);
        if (!found) return;
        if (found.status !== 'pending') return;
        found.status = 'completed';
      }, 650);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          task_id: `task_${randomBytes(6).toString('hex')}`,
          gallery_id: id,
          status: 'pending'
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.startsWith('/api/v1/gallery/items')) {
      const u = new URL(`http://stub${url}`);
      const saveId = u.searchParams.get('save_id') ?? '';
      const filtered = items.filter((it) => it.saveId === saveId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          filtered.map((it) => ({
            id: it.id,
            status: it.status,
            created_at: new Date(it.createdAt).toISOString(),
            prompt: it.prompt,
            thumb_data_url: it.status === 'completed' ? ONE_BY_ONE_PNG_DATA_URL : null,
            image_data_url: it.status === 'completed' ? ONE_BY_ONE_PNG_DATA_URL : null
          })),
        ),
      );
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

test('Task 17: generative gallery -> pending -> completed (with evidence screenshot)', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startGalleryStubServer();

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

      const gen = page.getByTestId(TEST_IDS.galleryGenerate);
      await expect(gen).toBeVisible();

      await gen.locator('input').fill('e2e: a tiny memory capsule');
      await gen.getByRole('button', { name: '生成' }).click();

      const masonry = page.getByTestId(TEST_IDS.galleryMasonry);
      await expect(masonry).toBeVisible();

      await expect(masonry.getByTestId(TEST_IDS.galleryItem)).toHaveCount(1);

      const img = masonry.locator('img.gallery-img');
      await expect(img).toHaveCount(1);
      await expect(img.first()).toBeVisible();

      const evidencePath = getEvidencePath('task-17-gallery.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await masonry.screenshot({ path: evidencePath });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await stub.close();
});
