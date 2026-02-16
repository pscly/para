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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
};

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ekv7bYAAAAASUVORK5CYII=';
const ONE_BY_ONE_PNG_BYTES = Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64');

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
        found.status = 'running';
      }, 250);

      setTimeout(() => {
        const found = items.find((x) => x.id === id);
        if (!found) return;
        if (found.status !== 'running') return;
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

    if (req.method === 'GET' && url.startsWith('/api/v1/gallery/items/') && url.includes('/download')) {
      const u = new URL(`http://stub${url}`);
      const parts = u.pathname.split('/').filter(Boolean);

      const itemsIdx = parts.indexOf('items');
      const galleryId = itemsIdx >= 0 && parts.length > itemsIdx + 2 && parts[itemsIdx + 2] === 'download'
        ? parts[itemsIdx + 1] ?? ''
        : '';
      const kind = (u.searchParams.get('kind') ?? '').toLowerCase();
      if (!galleryId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'not found' }));
        return;
      }
      if (kind !== 'thumb' && kind !== 'image') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Invalid kind' }));
        return;
      }

      const item = items.find((x) => x.id === galleryId);
      if (!item || item.status !== 'completed') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'not found' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Disposition': `inline; filename="gallery-${galleryId}-${kind}.png"`
      });
      res.end(ONE_BY_ONE_PNG_BYTES);
      return;
    }

    if (req.method === 'GET' && url.startsWith('/api/v1/gallery/items')) {
      const u = new URL(`http://stub${url}`);
      if (u.pathname !== '/api/v1/gallery/items') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'not found' }));
        return;
      }

      const saveId = u.searchParams.get('save_id') ?? '';
      const filtered = items.filter((it) => it.saveId === saveId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          filtered.map((it) => ({
            id: it.id,
            status: it.status,
            created_at: new Date(it.createdAt).toISOString(),
            prompt: it.prompt
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

      await expect(masonry.getByTestId(TEST_IDS.galleryItem)).toHaveCount(1, { timeout: 15_000 });

      const firstItem = masonry.getByTestId(TEST_IDS.galleryItem).first();
      const pill = firstItem.locator('.pill').first();
      await expect(pill).toBeVisible({ timeout: 15_000 });

      await expect
        .poll(
          async () => {
            const t = await pill.textContent();
            return String(t ?? '').trim();
          },
          { timeout: 15_000 },
        )
        .not.toBe('生成中');

      await expect(pill).toHaveText('已完成', { timeout: 15_000 });

      const downloadDiag = await page.evaluate(async () => {
        const api = (window as unknown as { desktopApi?: any }).desktopApi;
        if (!api || !api.gallery) {
          return {
            id: '',
            ctorName: 'desktopApi_missing',
            isArrayBuffer: false,
            isUint8Array: false,
            canUint8Array: false,
            byteLength: 0
          };
        }

        const list = await api.gallery.list('default');
        const first = Array.isArray(list) ? list[0] : null;
        const id = first && typeof first.id === 'string' ? first.id : '';
        if (!id) {
          return {
            id: '',
            ctorName: 'id_missing',
            isArrayBuffer: false,
            isUint8Array: false,
            canUint8Array: false,
            byteLength: 0
          };
        }

        const bytes = await api.gallery.download({ galleryId: id, kind: 'thumb' });
        const ctorName = bytes && (bytes as any).constructor ? String((bytes as any).constructor.name ?? 'unknown') : 'unknown';

        const isArrayBuffer = bytes instanceof ArrayBuffer;
        const isUint8Array = bytes instanceof Uint8Array;

        let byteLength = 0;
        if (isArrayBuffer) {
          byteLength = bytes.byteLength;
        } else if (bytes && typeof (bytes as any).byteLength === 'number') {
          byteLength = (bytes as any).byteLength as number;
        } else if (bytes && typeof (bytes as any).length === 'number') {
          byteLength = (bytes as any).length as number;
        }

        let canUint8Array = false;
        try {
          const u8 = new Uint8Array(bytes);
          canUint8Array = u8.byteLength > 0;
        } catch {
          canUint8Array = false;
        }

        return { id, ctorName, isArrayBuffer, isUint8Array, canUint8Array, byteLength };
      });

      const diag = `ctorName=${downloadDiag.ctorName} isArrayBuffer=${downloadDiag.isArrayBuffer} isUint8Array=${downloadDiag.isUint8Array} canUint8Array=${downloadDiag.canUint8Array} byteLength=${downloadDiag.byteLength}`;
      expect(
        downloadDiag.id,
        `gallery.list() returned empty id (${diag})`,
      ).not.toBe('');

      expect(
        downloadDiag.isArrayBuffer || downloadDiag.isUint8Array || downloadDiag.canUint8Array,
        `gallery.download() returned non-binary-like value (id=${downloadDiag.id || '(empty)'} ${diag})`,
      ).toBeTruthy();

      expect(
        downloadDiag.byteLength,
        `gallery.download() returned empty bytes (id=${downloadDiag.id || '(empty)'} ${diag})`,
      ).toBeGreaterThan(0);

      const img = firstItem.locator('img.gallery-img');
      await expect(img).toHaveCount(1, { timeout: 15_000 });
      await expect(img.first()).toBeVisible({ timeout: 15_000 });

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
