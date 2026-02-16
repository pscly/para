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

async function startAuthStubServer({ correctPassword }: { correctPassword: string }): Promise<StubServer> {
  const accessTokenToEmail = new Map<string, string>();

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/auth/login') {
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

      const email =
        typeof parsed === 'object' && parsed !== null && 'email' in parsed
          ? (parsed as { email?: unknown }).email
          : undefined;
      const password =
        typeof parsed === 'object' && parsed !== null && 'password' in parsed
          ? (parsed as { password?: unknown }).password
          : undefined;

      if (typeof email !== 'string' || typeof password !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      if (password !== correctPassword) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invalid credentials' }));
        return;
      }

      const access_token = randomBytes(16).toString('hex');
      const refresh_token = randomBytes(16).toString('hex');

      accessTokenToEmail.set(access_token, email);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token,
          refresh_token,
          token_type: 'bearer'
        })
      );
      return;
    }

    if (req.method === 'GET' && url === '/api/v1/auth/me') {
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      const email = accessTokenToEmail.get(token);

      if (!email) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'unauthorized' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          user_id: 1,
          email
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

test('Electron login: success', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startAuthStubServer({ correctPassword: 'correct-password' });

  await withTempUserDataDir(async (userDataDir) => {
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

      const email = 'user@example.com';
      await page.getByTestId(TEST_IDS.loginEmail).fill(email);
      await page.getByTestId(TEST_IDS.loginPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.loginSubmit).click();

      await expect(page.getByText(`已登录：${email}`)).toBeVisible();
      await expect(page.locator(`[data-testid="${TEST_IDS.loginError}"]`)).toHaveCount(0);

      const evidencePath = getEvidencePath('task-6-login-success.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await stub.close();
});

test('Electron login: fail', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startAuthStubServer({ correctPassword: 'correct-password' });

  await withTempUserDataDir(async (userDataDir) => {
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

      const email = 'user@example.com';
      await page.getByTestId(TEST_IDS.loginEmail).fill(email);
      await page.getByTestId(TEST_IDS.loginPassword).fill('wrong-password');
      await page.getByTestId(TEST_IDS.loginSubmit).click();

      const err = page.getByTestId(TEST_IDS.loginError);
      await expect(err).toBeVisible();
      await expect(err).toContainText('邮箱或密码错误');
      await expect(page.getByText(`已登录：${email}`)).toHaveCount(0);

      const evidencePath = getEvidencePath('task-6-login-fail.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await stub.close();
});

test('Electron login: enforce secure token storage (fails + no plaintext file)', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startAuthStubServer({ correctPassword: 'correct-password' });

  await withTempUserDataDir(async (userDataDir) => {
    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PARA_SERVER_BASE_URL: stub.baseUrl,
        PARA_USER_DATA_DIR: userDataDir,
        PARA_ENFORCE_SECURE_TOKEN_STORAGE: '1',
        PARA_TEST_DISABLE_SAFE_STORAGE: '1'
      }
    });

    try {
      const page = await getDebugPanelPage(app);

      const email = 'user@example.com';
      await page.getByTestId(TEST_IDS.loginEmail).fill(email);
      await page.getByTestId(TEST_IDS.loginPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.loginSubmit).click();

      const err = page.getByTestId(TEST_IDS.loginError);
      await expect(err).toBeVisible();
      await expect(err).toContainText('本机安全存储不可用');
      await expect(page.getByText(`已登录：${email}`)).toHaveCount(0);

      const userDataPathFromMain = await app.evaluate(({ app: electronApp }) => {
        return electronApp.getPath('userData');
      });
      const tokensFileExists = fs.existsSync(path.join(userDataPathFromMain, 'auth.tokens.json'));
      expect(tokensFileExists).toBeFalsy();

      const evidencePath = getEvidencePath('task-6-4-token-storage.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await stub.close();
});
