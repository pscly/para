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

type StubTimelineItem = {
  id: string;
  saveId: string;
  eventType: string;
  content: string;
  createdAt: string;
};

function randomId(): string {
  return randomBytes(8).toString('hex');
}

async function startTimelineStubServer(): Promise<StubServer> {
  const items: StubTimelineItem[] = [];

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/timeline/simulate') {
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
          : typeof parsed === 'object' && parsed !== null && 'saveId' in parsed
            ? (parsed as { saveId?: unknown }).saveId
            : undefined;

      const eventType =
        typeof parsed === 'object' && parsed !== null && 'event_type' in parsed
          ? (parsed as { event_type?: unknown }).event_type
          : typeof parsed === 'object' && parsed !== null && 'eventType' in parsed
            ? (parsed as { eventType?: unknown }).eventType
            : 'WALKED';

      const content =
        typeof parsed === 'object' && parsed !== null && 'content' in parsed
          ? (parsed as { content?: unknown }).content
          : undefined;

      if (typeof saveId !== 'string' || saveId.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      const id = `tl_${randomId()}`;
      const createdAt = new Date().toISOString();
      items.unshift({
        id,
        saveId,
        eventType: typeof eventType === 'string' && eventType.trim() !== '' ? eventType : 'WALKED',
        content: typeof content === 'string' && content.trim() !== '' ? content : 'e2e: timeline simulated event',
        createdAt
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          task_id: `task_${randomId()}`,
          timeline_event_id: id
        })
      );
      return;
    }

    if (req.method === 'GET' && (url === '/api/v1/timeline' || url.startsWith('/api/v1/timeline?'))) {
      const u = new URL(`http://stub${url}`);
      const saveId = u.searchParams.get('save_id') ?? u.searchParams.get('saveId') ?? '';

      const filtered = items.filter((it) => it.saveId === saveId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          items: filtered.map((it) => ({
            id: it.id,
            save_id: it.saveId,
            event_type: it.eventType,
            content: it.content,
            created_at: it.createdAt
          })),
          next_cursor: 'end'
        })
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
  await fs.promises.mkdir(userDataDir, { recursive: true });
  await fs.promises.writeFile(
    filePath,
    JSON.stringify({
      secure: false,
      accessToken: `e2e-access-${randomId()}`,
      refreshToken: `e2e-refresh-${randomId()}`
    }),
    { encoding: 'utf8' }
  );
}

test('Task 18: timeline simulate + list (with evidence screenshot)', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startTimelineStubServer();

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
          PARA_USER_DATA_DIR: userDataDir
        }
      });

      try {
        const page = await getDebugPanelPage(app);

        const card = page.getByTestId(TEST_IDS.timelineCard);
        await expect(card).toBeVisible();

        const simulate = page.getByTestId(TEST_IDS.timelineSimulate);
        await expect(simulate).toBeVisible();
        await simulate.click();

        const list = page.getByTestId(TEST_IDS.timelineList);
        await expect(list).toBeVisible();

        const firstItem = page.getByTestId(TEST_IDS.timelineItem).first();
        await expect(firstItem).toBeVisible({ timeout: 15_000 });

        const evidencePath = getEvidencePath('task-18-timeline.png');
        await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
        await card.screenshot({ path: evidencePath });
        expect(fs.existsSync(evidencePath)).toBeTruthy();
      } finally {
        await app.close();
      }
    });
  } finally {
    await stub.close();
  }
});
