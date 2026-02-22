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
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => app.windows().length, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2)
    .catch(() => {
      // 某些环境可能只创建 1 个窗口；允许降级。
    });

  const pages: Page[] = app.windows();
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

function parseEffectiveEnabled(text: string): boolean | null {
  const m = text.match(/effectiveEnabled[：:=]\s*(true|false)/i);
  if (!m) return null;
  return m[1]!.toLowerCase() === 'true';
}

async function startAuthStubServer(): Promise<StubServer> {
  const accessTokenToEmail = new Map<string, string>();
  const usersByEmail = new Map<string, { password: string; user_id: number }>();
  const usedInvites = new Set<string>();

  function issueTokensForEmail(email: string): { access_token: string; refresh_token: string } {
    const access_token = randomBytes(16).toString('hex');
    const refresh_token = randomBytes(16).toString('hex');
    accessTokenToEmail.set(access_token, email);
    return { access_token, refresh_token };
  }

  async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    await new Promise<void>((resolve) => req.on('end', () => resolve()));
    if (body.trim() === '') return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';

    if (req.method === 'POST' && url === '/api/v1/auth/register') {
      const parsed = await readJsonBody(req);
      if (typeof parsed !== 'object' || parsed === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      const email = 'email' in parsed ? (parsed as { email?: unknown }).email : undefined;
      const password = 'password' in parsed ? (parsed as { password?: unknown }).password : undefined;
      const inviteCode =
        'invite_code' in parsed ? (parsed as { invite_code?: unknown }).invite_code : undefined;

      if (typeof email !== 'string' || typeof password !== 'string') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invalid payload' }));
        return;
      }

      const trimmedInvite = typeof inviteCode === 'string' ? inviteCode.trim() : '';
      if (!trimmedInvite) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invite_code_required' }));
        return;
      }
      if (usedInvites.has(trimmedInvite)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invite_code_exhausted' }));
        return;
      }

      usedInvites.add(trimmedInvite);
      usersByEmail.set(email, { password, user_id: usersByEmail.size + 1 });
      const { access_token, refresh_token } = issueTokensForEmail(email);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token, refresh_token, token_type: 'bearer' }));
      return;
    }

    if (req.method === 'POST' && url === '/api/v1/auth/login') {
      const parsed = await readJsonBody(req);
      if (typeof parsed !== 'object' || parsed === null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      const email = 'email' in parsed ? (parsed as { email?: unknown }).email : undefined;
      const password = 'password' in parsed ? (parsed as { password?: unknown }).password : undefined;
      if (typeof email !== 'string' || typeof password !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      const u = usersByEmail.get(email);
      if (!u || u.password !== password) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invalid credentials' }));
        return;
      }

      const { access_token, refresh_token } = issueTokensForEmail(email);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token, refresh_token, token_type: 'bearer' }));
      return;
    }

    if (req.method === 'GET' && url === '/api/v1/auth/me') {
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      const email = accessTokenToEmail.get(token);
      const u = email ? usersByEmail.get(email) : null;

      if (!email || !u) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'unauthorized' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user_id: u.user_id, email, debug_allowed: false }));
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
  await expect(page.getByTestId(TEST_IDS.devOptionsReason)).toBeVisible({ timeout: 15_000 });

  const pressed = await toggle.getAttribute('aria-pressed');
  const alreadyEnabled = pressed === 'true';
  if (!alreadyEnabled) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  }

  const effective = page.getByTestId(TEST_IDS.devOptionsEffective);
  await expect
    .poll(async () => parseEffectiveEnabled((await effective.textContent()) ?? ''), { timeout: 15_000 })
    .toBe(true);
}

test('Electron register: invite required', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startAuthStubServer();

  await withTempProfile(async ({ userDataDir, xdgConfigHome }) => {
    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PARA_SERVER_BASE_URL: stub.baseUrl,
        PARA_USER_DATA_DIR: userDataDir,
        XDG_CONFIG_HOME: xdgConfigHome
      }
    });

    try {
      const page = await getDebugPanelPage(app);

      await enableDevOptionsFromSettings(page);
      await navigateHashAndWait(page, '#/dev/register');
      await expect(page.getByTestId(TEST_IDS.registerEmail)).toBeVisible();

      const email = 'register-required@example.com';

      await page.getByTestId(TEST_IDS.registerEmail).fill(email);
      await page.getByTestId(TEST_IDS.registerPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.registerSubmit).click();

      const err = page.getByTestId(TEST_IDS.registerError);
      await expect(err).toBeVisible();
      await expect(err).toContainText('需要邀请码');
      await expect(page.getByText(`已登录：${email}`)).toHaveCount(0);

      const evidencePath = getEvidencePath('task-20-register-invite-required.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await stub.close();
});

test('Electron register: success + invite exhausted', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startAuthStubServer();
  const inviteOnce = 'INVITE-ONCE';

  await withTempProfile(async ({ userDataDir, xdgConfigHome }) => {
    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PARA_SERVER_BASE_URL: stub.baseUrl,
        PARA_USER_DATA_DIR: userDataDir,
        XDG_CONFIG_HOME: xdgConfigHome
      }
    });

    try {
      const page = await getDebugPanelPage(app);

      await enableDevOptionsFromSettings(page);
      await navigateHashAndWait(page, '#/dev/register');
      await expect(page.getByTestId(TEST_IDS.registerEmail)).toBeVisible();

      const email = 'register-success@example.com';

      await page.getByTestId(TEST_IDS.registerEmail).fill(email);
      await page.getByTestId(TEST_IDS.registerPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.registerInviteCode).fill(inviteOnce);
      await page.getByTestId(TEST_IDS.registerSubmit).click();

      await expect(page.getByText(`已登录：${email}`)).toBeVisible();
      await expect(page.locator(`[data-testid="${TEST_IDS.registerError}"]`)).toHaveCount(0);

      try {
        await page.getByTestId(TEST_IDS.registerInviteCode).fill('');
      } catch {
      }

      const evidencePath = getEvidencePath('task-20-register-success.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await withTempProfile(async ({ userDataDir, xdgConfigHome }) => {
    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: [mainEntry],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PARA_SERVER_BASE_URL: stub.baseUrl,
        PARA_USER_DATA_DIR: userDataDir,
        XDG_CONFIG_HOME: xdgConfigHome
      }
    });

    try {
      const page = await getDebugPanelPage(app);

      await enableDevOptionsFromSettings(page);
      await navigateHashAndWait(page, '#/dev/register');
      await expect(page.getByTestId(TEST_IDS.registerEmail)).toBeVisible();

      const email = 'register-exhausted@example.com';

      await page.getByTestId(TEST_IDS.registerEmail).fill(email);
      await page.getByTestId(TEST_IDS.registerPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.registerInviteCode).fill(inviteOnce);
      await page.getByTestId(TEST_IDS.registerSubmit).click();

      const err = page.getByTestId(TEST_IDS.registerError);
      await expect(err).toBeVisible();
      await expect(err).toContainText('邀请码已用尽');
      await expect(page.getByText(`已登录：${email}`)).toHaveCount(0);

      try {
        await page.getByTestId(TEST_IDS.registerInviteCode).fill('');
      } catch {
      }

      const evidencePath = getEvidencePath('task-20-register-invite-exhausted.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  await stub.close();
});
