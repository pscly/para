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

type UserRecord = {
  user_id: number;
  email: string;
  username: string | null;
  password: string;
};

async function getDebugPanelPage(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect
    .poll(() => app.windows().length, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2)
    .catch(() => {
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

function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  return v;
}

async function startAuthStubServer({ openRegistrationEnabled }: { openRegistrationEnabled: boolean }): Promise<StubServer> {
  const accessTokenToEmail = new Map<string, string>();
  const usersByEmail = new Map<string, UserRecord>();
  const usernameToEmail = new Map<string, string>();
  const usedInvites = new Set<string>();

  function issueTokensForEmail(email: string): { access_token: string; refresh_token: string } {
    const access_token = randomBytes(16).toString('hex');
    const refresh_token = randomBytes(16).toString('hex');
    accessTokenToEmail.set(access_token, email);
    return { access_token, refresh_token };
  }

  function resolveEmailFromIdentifier(identifier: string): string | null {
    const id = identifier.trim();
    if (id === '') return null;
    if (id.includes('@')) return id;
    const mapped = usernameToEmail.get(id.toLowerCase());
    return mapped ?? null;
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
      const usernameRaw = 'username' in parsed ? (parsed as { username?: unknown }).username : undefined;
      const inviteCode =
        'invite_code' in parsed ? (parsed as { invite_code?: unknown }).invite_code : undefined;

      if (typeof email !== 'string' || typeof password !== 'string') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invalid payload' }));
        return;
      }

      const trimmedInvite = typeof inviteCode === 'string' ? inviteCode.trim() : '';
      if (!trimmedInvite) {
        if (!openRegistrationEnabled) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'invite_code_required' }));
          return;
        }
      } else {
        if (usedInvites.has(trimmedInvite)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'invite_code_exhausted' }));
          return;
        }
        usedInvites.add(trimmedInvite);
      }

      const username = normalizeUsername(usernameRaw);
      const user_id = usersByEmail.size + 1;
      const record: UserRecord = { user_id, email, username, password };
      usersByEmail.set(email, record);
      if (username) usernameToEmail.set(username, email);

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

      const identifierOrEmail =
        'identifier' in parsed
          ? (parsed as { identifier?: unknown }).identifier
          : 'email' in parsed
            ? (parsed as { email?: unknown }).email
            : undefined;
      const password = 'password' in parsed ? (parsed as { password?: unknown }).password : undefined;
      if (typeof identifierOrEmail !== 'string' || typeof password !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      const email = resolveEmailFromIdentifier(identifierOrEmail);
      const u = email ? usersByEmail.get(email) : null;
      if (!u || u.password !== password) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invalid credentials' }));
        return;
      }

      const { access_token, refresh_token } = issueTokensForEmail(u.email);
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
  if (!addr || typeof addr === 'string') throw new Error('STUB_SERVER_NO_ADDRESS');

  const port = (addr as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function withTempProfile<T>(fn: (args: { userDataDir: string; xdgConfigHome: string }) => Promise<T>): Promise<T> {
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-userdata-'));
  const xdgConfigHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-xdgcfg-'));
  try {
    return await fn({ userDataDir, xdgConfigHome });
  } finally {
    try {
      await fs.promises.rm(userDataDir, { recursive: true, force: true });
    } catch {
    }
    try {
      await fs.promises.rm(xdgConfigHome, { recursive: true, force: true });
    } catch {
    }
  }
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

function getEvidencePath(filename: string): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', filename);
}

test('F1: register -> logout -> login (username) -> enter chat', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startAuthStubServer({ openRegistrationEnabled: true });

  await withTempProfile(async ({ userDataDir, xdgConfigHome }) => {
    const launchArgs = [mainEntry];
    if (process.env.CI) {
      launchArgs.push('--no-sandbox', '--disable-gpu');
    }

    const app = await electron.launch({
      executablePath: electronPath as unknown as string,
      args: launchArgs,
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

      const username = 'alice';
      const email = 'alice@example.com';
      const password = 'correct-password';

      await navigateHashAndWait(page, '#/register');
      await expect(page.getByTestId(TEST_IDS.registerEmail)).toBeVisible({ timeout: 15_000 });
      await page.getByTestId(TEST_IDS.registerUsername).fill(username);
      await page.getByTestId(TEST_IDS.registerEmail).fill(email);
      await page.getByTestId(TEST_IDS.registerPassword).fill(password);
      await page.getByTestId(TEST_IDS.registerSubmit).click();

      const primarySidebar = page.getByRole('navigation', { name: 'Primary' });
      await expect(primarySidebar.getByText(`已登录：${email}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId(TEST_IDS.registerError)).toHaveCount(0);

      await primarySidebar.getByRole('button', { name: '退出登录' }).click();
      await expect(page.getByTestId(TEST_IDS.loginSubmit)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 }).toBe('#/login');

      await page.getByTestId(TEST_IDS.loginEmail).fill(username);
      await page.getByTestId(TEST_IDS.loginPassword).fill(password);
      await page.getByTestId(TEST_IDS.loginSubmit).click();

      await expect(primarySidebar.getByText(`已登录：${email}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId(TEST_IDS.loginError)).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '聊天' })).toBeVisible({ timeout: 15_000 });

      await page.screenshot({ path: getEvidencePath('final-f1-auth-happy.png'), fullPage: true });
    } finally {
      await app.close();
    }
  });

  await stub.close();
});
