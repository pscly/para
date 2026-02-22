import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

type StubServer = {
  baseUrl: string;
  getLoginCounts: () => {
    plainLoginCount: number;
    encLoginCount: number;
    sawEncHeader: boolean;
  };
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

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(raw: string): Buffer {
  const s = raw.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s + pad, 'base64');
}

function buildReqAad(args: {
  kid: string;
  ts: number;
  rid: string;
  method: string;
  path: string;
  query: string;
}): string {
  return (
    'para-appenc-v1\n' +
    `typ=req\n` +
    `kid=${args.kid}\n` +
    `ts=${args.ts}\n` +
    `rid=${args.rid}\n` +
    `method=${args.method}\n` +
    `path=${args.path}\n` +
    `query=${args.query}`
  );
}

function buildRespAad(args: { kid: string; ts: number; rid: string; status: number }): string {
  return (
    'para-appenc-v1\n' +
    `typ=resp\n` +
    `kid=${args.kid}\n` +
    `ts=${args.ts}\n` +
    `rid=${args.rid}\n` +
    `status=${args.status}`
  );
}

async function readRequestBodyUtf8(req: http.IncomingMessage): Promise<string> {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) req.destroy();
  });
  await new Promise<void>((resolve) => req.on('end', () => resolve()));
  return body;
}

function decryptAppEncRequest(args: {
  envelope: any;
  key: Buffer;
  method: string;
  path: string;
  query: string;
}): { rid: string; plainText: string } {
  const env = args.envelope;

  if (!env || typeof env !== 'object') throw new Error('BAD_ENVELOPE');
  if (env.v !== 1 || env.typ !== 'req' || env.alg !== 'A256GCM') throw new Error('BAD_ENVELOPE');

  const kid = env.kid;
  const ts = env.ts;
  const rid = env.rid;
  const nonceB64 = env.nonce;
  const ctB64 = env.ct;

  if (typeof kid !== 'string' || typeof ts !== 'number' || typeof rid !== 'string') throw new Error('BAD_ENVELOPE');
  if (typeof nonceB64 !== 'string' || typeof ctB64 !== 'string') throw new Error('BAD_ENVELOPE');

  const nonce = base64UrlDecode(nonceB64);
  const ctAll = base64UrlDecode(ctB64);
  if (nonce.length !== 12 || ctAll.length < 17) throw new Error('BAD_ENVELOPE');

  const ciphertext = ctAll.subarray(0, ctAll.length - 16);
  const tag = ctAll.subarray(ctAll.length - 16);

  const aad = buildReqAad({
    kid,
    ts,
    rid,
    method: args.method,
    path: args.path,
    query: args.query
  });

  const decipher = crypto.createDecipheriv('aes-256-gcm', args.key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag));
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { rid, plainText: plain.toString('utf8') };
}

function encryptAppEncResponse(args: { kid: string; key: Buffer; rid: string; status: number; plainJsonText: string }) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12);
  const aad = buildRespAad({ kid: args.kid, ts, rid: args.rid, status: args.status });

  const cipher = crypto.createCipheriv('aes-256-gcm', args.key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(args.plainJsonText, 'utf8')),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    typ: 'resp',
    alg: 'A256GCM',
    kid: args.kid,
    ts,
    rid: args.rid,
    nonce: base64UrlEncode(nonce),
    ct: base64UrlEncode(Buffer.concat([ciphertext, tag]))
  };
}

async function startAuthStubServer(args: {
  correctPassword: string;
  appEncKid: string;
  appEncKey: Buffer;
}): Promise<StubServer> {
  const accessTokenToEmail = new Map<string, string>();

  let plainLoginCount = 0;
  let encLoginCount = 0;
  let sawEncHeader = false;

  const server = http.createServer(async (req, res) => {
    const method = String(req.method ?? '').toUpperCase();
    const rawUrl = req.url ?? '';

    const fullUrl = new URL(rawUrl, 'http://127.0.0.1');
    const pathname = fullUrl.pathname;
    const query = fullUrl.search.startsWith('?') ? fullUrl.search.slice(1) : '';

    if (method === 'POST' && pathname === '/api/v1/auth/login') {
      const enc = req.headers['x-para-enc'];
      const wantRespEnc = req.headers['x-para-enc-resp'] === 'v1';

      const rawBody = await readRequestBodyUtf8(req);

      let payload: any;
      let requestRid: string | null = null;

      if (enc === 'v1') {
        sawEncHeader = true;
        encLoginCount += 1;

        let env: any;
        try {
          env = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'bad envelope' }));
          return;
        }

        if (typeof env?.kid !== 'string' || env.kid !== args.appEncKid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'unknown kid' }));
          return;
        }

        try {
          const decrypted = decryptAppEncRequest({
            envelope: env,
            key: args.appEncKey,
            method,
            path: pathname,
            query
          });
          requestRid = decrypted.rid;
          payload = JSON.parse(decrypted.plainText);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'decrypt failed' }));
          return;
        }
      } else {
        plainLoginCount += 1;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'bad json' }));
          return;
        }
      }

      const email = payload?.email;
      const password = payload?.password;
      if (typeof email !== 'string' || typeof password !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'bad payload' }));
        return;
      }

      if (password !== args.correctPassword) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'invalid credentials' }));
        return;
      }

      const access_token = crypto.randomBytes(16).toString('hex');
      const refresh_token = crypto.randomBytes(16).toString('hex');
      accessTokenToEmail.set(access_token, email);

      const plainResp = JSON.stringify({ access_token, refresh_token, token_type: 'bearer' });

      if (enc === 'v1' && wantRespEnc && requestRid) {
        const env = encryptAppEncResponse({
          kid: args.appEncKid,
          key: args.appEncKey,
          rid: requestRid,
          status: 200,
          plainJsonText: plainResp
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Para-Enc': 'v1' });
        res.end(JSON.stringify(env));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(plainResp);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/auth/me') {
      const auth = req.headers.authorization;
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      const email = accessTokenToEmail.get(token);
      if (!email) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'unauthorized' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user_id: 1, email, debug_allowed: false }));
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
    getLoginCounts: () => ({
      plainLoginCount,
      encLoginCount,
      sawEncHeader
    }),
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

test('Electron appenc: toggle + encrypted req/resp', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const kid = 'e2e-kid';
  const key = crypto.createHash('sha256').update('para-e2e-appenc-key-v1').digest();

  const stub = await startAuthStubServer({
    correctPassword: 'correct-password',
    appEncKid: kid,
    appEncKey: key
  });

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
          XDG_CONFIG_HOME: xdgConfigHome,
          PARA_APPENC_KEYS: `${kid}:${base64UrlEncode(key)}`,
          PARA_APPENC_PRIMARY_KID: kid
        }
      });

      const page = await getDebugPanelPage(app);

      await page.evaluate(() => {
        window.location.hash = '#/login';
      });
      await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible({ timeout: 15_000 });

      const email = 'user@example.com';

      await page.getByTestId(TEST_IDS.loginEmail).fill(email);
      await page.getByTestId(TEST_IDS.loginPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.loginSubmit).click();
      await expect(page.getByText(`已登录：${email}`)).toBeVisible();

      const c1 = stub.getLoginCounts();
      expect(c1.plainLoginCount).toBe(1);
      expect(c1.encLoginCount).toBe(0);

      await page.evaluate(() => {
        window.location.hash = '#/settings';
      });
      const devToggle = page.getByTestId(TEST_IDS.devOptionsToggle);
      await expect(devToggle).toBeVisible({ timeout: 15_000 });

      const devPressed = await devToggle.getAttribute('aria-pressed');
      const devAlreadyEnabled = devPressed === 'true';
      if (!devAlreadyEnabled) {
        await devToggle.click();
      }

      const devEffective = page.getByTestId(TEST_IDS.devOptionsEffective);
      await expect
        .poll(async () => (await devEffective.textContent()) ?? '', { timeout: 15_000 })
        .toContain('effectiveEnabled：true');

      await page.evaluate(() => {
        window.location.hash = '#/dev/debug';
      });

      const toggle = page.getByTestId(TEST_IDS.securityAppEncToggle);
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');

      await page.evaluate(() => {
        window.location.hash = '#/login';
      });
      await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible({ timeout: 15_000 });
      await page.getByTestId(TEST_IDS.loginEmail).fill(email);
      await page.getByTestId(TEST_IDS.loginPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.loginSubmit).click();
      await expect(page.getByText(`已登录：${email}`)).toBeVisible();

      const c2 = stub.getLoginCounts();
      expect(c2.encLoginCount).toBe(1);
      expect(c2.sawEncHeader).toBe(true);

      await page.evaluate(() => {
        window.location.hash = '#/dev/debug';
      });
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');

      await page.evaluate(() => {
        window.location.hash = '#/login';
      });
      await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible({ timeout: 15_000 });
      await page.getByTestId(TEST_IDS.loginEmail).fill(email);
      await page.getByTestId(TEST_IDS.loginPassword).fill('correct-password');
      await page.getByTestId(TEST_IDS.loginSubmit).click();
      await expect(page.getByText(`已登录：${email}`)).toBeVisible();

      const c3 = stub.getLoginCounts();
      expect(c3.plainLoginCount).toBe(2);
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
