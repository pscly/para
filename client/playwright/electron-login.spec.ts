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
  getIssuedTokensForEmail: (email: string) => { access_token: string; refresh_token: string } | null;
  close: () => Promise<void>;
};

type SecretNeedle =
  | { name: string; kind: 'literal'; value: string }
  | { name: string; kind: 'regex'; value: RegExp };

type SecretHit = {
  filePath: string;
  needleName: string;
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
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
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
  const issuedTokensByEmail = new Map<string, { access_token: string; refresh_token: string }>();

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
       issuedTokensByEmail.set(email, { access_token, refresh_token });

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
          email,
          debug_allowed: false
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
    getIssuedTokensForEmail: (email: string) => {
      const v = issuedTokensByEmail.get(email);
      return v ? { access_token: v.access_token, refresh_token: v.refresh_token } : null;
    },
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

function getDefaultSecretNeedles(): SecretNeedle[] {
  const needles: SecretNeedle[] = [
    { name: 'bearer_header', kind: 'regex', value: /\bbearer\s+[a-z0-9._~\-]{8,}/i },

    { name: 'openai_sk_like', kind: 'regex', value: /\bsk-[A-Za-z0-9]{20,}\b/ },
    { name: 'openai_api_key_env', kind: 'regex', value: /\bOPENAI_API_KEY\s*=/ },

    {
      name: 'access_token_kv',
      kind: 'regex',
      value: /\baccess_token\b\s*[:=]\s*["'][^"']{4,}["']/i
    },
    {
      name: 'refresh_token_kv',
      kind: 'regex',
      value: /\brefresh_token\b\s*[:=]\s*["'][^"']{4,}["']/i
    },
    {
      name: 'api_key_kv',
      kind: 'regex',
      value: /\bapi[_-]?key\b\s*[:=]\s*["'][^"']{4,}["']/i
    }
  ];

  const extra = process.env.PARA_E2E_SECRET_SCAN_EXTRA_NEEDLES;
  if (typeof extra === 'string' && extra.trim() !== '') {
    const parts = extra
      .split(/\r?\n|,/g)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    for (let i = 0; i < parts.length; i += 1) {
      needles.push({ name: `extra_literal_${i}`, kind: 'literal', value: parts[i]! });
    }
  }

  return needles;
}

async function readFileUpTo(filePath: string, maxBytes: number): Promise<Buffer | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size <= 0) return Buffer.alloc(0);
  if (st.size > maxBytes) return null;

  try {
    return await fs.promises.readFile(filePath);
  } catch {
    return null;
  }
}

function isProbablyText(buf: Buffer): boolean {
  return !buf.includes(0);
}

function bufferMatchesNeedle(buf: Buffer, needle: SecretNeedle): boolean {
  if (needle.kind === 'literal') {
    if (!needle.value) return false;
    return buf.includes(Buffer.from(needle.value, 'utf8'));
  }

  if (!isProbablyText(buf)) return false;
  const text = buf.toString('utf8');
  try {
    return needle.value.test(text);
  } catch {
    return false;
  }
}

async function scanDirsForPlaintextSecrets(opts: {
  dirs: string[];
  needles: SecretNeedle[];
  maxFileBytes?: number;
}): Promise<SecretHit[]> {
  const maxFileBytes = typeof opts.maxFileBytes === 'number' ? opts.maxFileBytes : 1024 * 1024;
  const hits: SecretHit[] = [];

  for (const dir of opts.dirs) {
    const root = typeof dir === 'string' && dir.trim() !== '' ? dir : '';
    if (!root) continue;

    let st: fs.Stats;
    try {
      st = await fs.promises.stat(root);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const files = await listFilesRecursively(root);
    for (const filePath of files) {
      const buf = await readFileUpTo(filePath, maxFileBytes);
      if (!buf) continue;
      for (const needle of opts.needles) {
        if (bufferMatchesNeedle(buf, needle)) {
          hits.push({ filePath, needleName: needle.name });
        }
      }
    }
  }

  return hits;
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

      await page.evaluate(() => {
        window.location.hash = '#/login';
      });
      await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible();

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

      const evidencePathTask7 = getEvidencePath('task-7-login-e2e.png');
      await fs.promises.mkdir(path.dirname(evidencePathTask7), { recursive: true });
      await page.screenshot({ path: evidencePathTask7, fullPage: true });
      expect(fs.existsSync(evidencePathTask7)).toBeTruthy();
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

      await page.evaluate(() => {
        window.location.hash = '#/login';
      });
      await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible();

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
    const xdgConfigHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-xdg-config-'));
    let app: ElectronApplication | null = null;

    try {
      app = await electron.launch({
        executablePath: electronPath as unknown as string,
        args: [mainEntry],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PARA_SERVER_BASE_URL: stub.baseUrl,
          PARA_USER_DATA_DIR: userDataDir,
          PARA_ENFORCE_SECURE_TOKEN_STORAGE: '1',
          PARA_TEST_DISABLE_SAFE_STORAGE: '1',
          XDG_CONFIG_HOME: xdgConfigHome
        }
      });

      const page = await getDebugPanelPage(app);

      await page.evaluate(() => {
        window.location.hash = '#/login';
      });
      await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible();

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

      const appDataPathFromMain = await app.evaluate(({ app: electronApp }) => {
        return electronApp.getPath('appData');
      });

      const issued = stub.getIssuedTokensForEmail(email);
      const issuedNeedles: SecretNeedle[] = issued
        ? [
            { name: 'issued_access_token', kind: 'literal', value: issued.access_token },
            { name: 'issued_refresh_token', kind: 'literal', value: issued.refresh_token }
          ]
        : [];

      const dirsToScan: string[] = [userDataPathFromMain];
      if (typeof appDataPathFromMain === 'string') {
        const resolvedAppData = path.resolve(appDataPathFromMain);
        const resolvedXdg = path.resolve(xdgConfigHome);
        if (resolvedAppData.startsWith(resolvedXdg)) {
          dirsToScan.push(appDataPathFromMain);
        }
      }

      const hits = await scanDirsForPlaintextSecrets({
        dirs: dirsToScan,
        needles: [...getDefaultSecretNeedles(), ...issuedNeedles]
      });
      expect(hits).toEqual([]);

      const evidencePath = getEvidencePath('task-6-4-token-storage.png');
      await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
      await page.screenshot({ path: evidencePath, fullPage: true });
      expect(fs.existsSync(evidencePath)).toBeTruthy();
    } finally {
      if (app) {
        try {
          await app.close();
        } catch {
        }
      }

      try {
        await fs.promises.rm(xdgConfigHome, { recursive: true, force: true });
      } catch {
      }
    }
  });

  await stub.close();
});

test('Electron login: secure token storage baseline (CI stable: fail-closed or encrypted at rest + scan userData/appData)', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const stub = await startAuthStubServer({ correctPassword: 'correct-password' });

  await withTempUserDataDir(async (userDataDir) => {
    const xdgConfigHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-xdg-config-'));
    let app: ElectronApplication | null = null;

    try {
      app = await electron.launch({
        executablePath: electronPath as unknown as string,
        args: [mainEntry],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PARA_SERVER_BASE_URL: stub.baseUrl,
          PARA_USER_DATA_DIR: userDataDir,
          PARA_ENFORCE_SECURE_TOKEN_STORAGE: '1',
          XDG_CONFIG_HOME: xdgConfigHome
        }
      });

      const pathsFromMain = await app.evaluate(({ app: electronApp }) => {
        return {
          userData: electronApp.getPath('userData'),
          appData: electronApp.getPath('appData')
        };
      });

      const page = await getDebugPanelPage(app);

      await page.evaluate(() => {
        window.location.hash = '#/login';
      });
      await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible();

      const email = 'user@example.com';
      await page.getByTestId(TEST_IDS.loginEmail).fill(email);
      await page.getByTestId(TEST_IDS.loginPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.loginSubmit).click();

      const loggedInText = page.getByText(`已登录：${email}`);
      const err = page.getByTestId(TEST_IDS.loginError);

      let loginSucceeded = false;
      try {
        await expect(loggedInText).toBeVisible({ timeout: 5_000 });
        loginSucceeded = true;
      } catch {
        loginSucceeded = false;
      }

      const userDataPath = typeof pathsFromMain?.userData === 'string' ? pathsFromMain.userData : userDataDir;
      const tokensFilePath = path.join(userDataPath, 'auth.tokens.json');

      if (loginSucceeded) {
        await expect(err).toHaveCount(0);

        expect(fs.existsSync(tokensFilePath)).toBeTruthy();
        const raw = await fs.promises.readFile(tokensFilePath, { encoding: 'utf8' });
        const parsed = JSON.parse(raw) as any;
        expect(parsed && typeof parsed === 'object').toBeTruthy();
        expect((parsed as any).secure).toBe(true);

        const evidencePath = getEvidencePath('task-26-login-secure-storage-ok.png');
        await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
        await page.screenshot({ path: evidencePath, fullPage: true });
        expect(fs.existsSync(evidencePath)).toBeTruthy();
      } else {
        await expect(err).toBeVisible();
        await expect(err).toContainText('本机安全存储不可用');
        await expect(loggedInText).toHaveCount(0);
        expect(fs.existsSync(tokensFilePath)).toBeFalsy();

        const evidencePath = getEvidencePath('task-26-login-secure-storage-fail-closed.png');
        await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
        await page.screenshot({ path: evidencePath, fullPage: true });
        expect(fs.existsSync(evidencePath)).toBeTruthy();
      }

      const issued = stub.getIssuedTokensForEmail(email);
      const issuedNeedles: SecretNeedle[] = issued
        ? [
            { name: 'issued_access_token', kind: 'literal', value: issued.access_token },
            { name: 'issued_refresh_token', kind: 'literal', value: issued.refresh_token }
          ]
        : [];

      const dirsToScan: string[] = [];
      if (typeof pathsFromMain?.userData === 'string') dirsToScan.push(pathsFromMain.userData);

      if (typeof pathsFromMain?.appData === 'string') {
        const resolvedAppData = path.resolve(pathsFromMain.appData);
        const resolvedXdg = path.resolve(xdgConfigHome);
        if (resolvedAppData.startsWith(resolvedXdg)) {
          dirsToScan.push(pathsFromMain.appData);
        }
      }

      const hits = await scanDirsForPlaintextSecrets({
        dirs: dirsToScan,
        needles: [...getDefaultSecretNeedles(), ...issuedNeedles]
      });
      expect(hits).toEqual([]);
    } finally {
      if (app) {
        try {
          await app.close();
        } catch {
        }
      }

      try {
        await fs.promises.rm(xdgConfigHome, { recursive: true, force: true });
      } catch {
      }
    }
  });

  await stub.close();
});
