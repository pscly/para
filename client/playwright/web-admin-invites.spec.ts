import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo, Socket } from 'node:net';

import { test, expect, chromium } from '@playwright/test';

test.use({
  actionTimeout: 10_000,
  navigationTimeout: 15_000
});

type BackendStub = {
  baseUrl: string;
  adminEmail: string;
  adminPassword: string;
  operatorEmail: string;
  operatorPassword: string;
  close: () => Promise<void>;
};

type AdminWebStaticServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

function randomId(): string {
  return randomBytes(8).toString('hex');
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > maxBytes) req.destroy();
  });
  await new Promise<void>((resolve) => req.on('end', () => resolve()));
  if (body.trim() === '') return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function getBearerToken(req: http.IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return '';
  if (!auth.startsWith('Bearer ')) return '';
  return auth.slice('Bearer '.length);
}

type StubAdmin = {
  token: string;
  admin_user_id: string;
  role: 'super_admin' | 'operator';
};

type InviteListItem = {
  id: string;
  code_prefix: string;
  max_uses: number;
  uses_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type InviteCreateResponse = InviteListItem & { code: string };

type InviteRedemptionListItem = {
  id: string;
  invite_id: string;
  user_id: string;
  user_email: string;
  used_at: string;
};

function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

async function startStubBackend(): Promise<BackendStub> {
  const adminEmail = 'admin@local';
  const adminPassword = 'admin-password';
  const operatorEmail = 'operator@local';
  const operatorPassword = 'operator-password';

  const adminsByToken = new Map<string, StubAdmin>();

  const invites: InviteListItem[] = [];
  const fullCodesByInviteId = new Map<string, string>();
  const redemptionsByInviteId = new Map<string, InviteRedemptionListItem[]>();

  function listInviteItems(): InviteListItem[] {
    return invites.slice();
  }

  function requireAdmin(req: http.IncomingMessage): StubAdmin | null {
    const token = getBearerToken(req);
    if (!token) return null;
    return adminsByToken.get(token) ?? null;
  }

  const sockets = new Set<Socket>();
  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'POST' && rawUrl === '/api/v1/admin/auth/login') {
      const parsed = await readJsonBody(req);
      const email =
        typeof parsed === 'object' && parsed !== null && 'email' in parsed ? (parsed as { email?: unknown }).email : undefined;
      const password =
        typeof parsed === 'object' && parsed !== null && 'password' in parsed
          ? (parsed as { password?: unknown }).password
          : undefined;

      if (typeof email !== 'string' || typeof password !== 'string') {
        writeJson(res, 400, { detail: 'bad payload' });
        return;
      }

      let role: StubAdmin['role'] | null = null;
      let admin_user_id = '';
      if (email === adminEmail && password === adminPassword) {
        role = 'super_admin';
        admin_user_id = 'admin-e2e';
      }
      if (email === operatorEmail && password === operatorPassword) {
        role = 'operator';
        admin_user_id = 'operator-e2e';
      }
      if (!role) {
        writeJson(res, 401, { detail: 'invalid credentials' });
        return;
      }

      const token = `stub-admin-${randomId()}`;
      adminsByToken.set(token, { token, admin_user_id, role });
      writeJson(res, 200, {
        access_token: token,
        token_type: 'bearer',
        admin_user_id,
        role
      });
      return;
    }

    if (method === 'GET' && (rawUrl === '/api/v1/admin/invites' || rawUrl.startsWith('/api/v1/admin/invites?'))) {
      const admin = requireAdmin(req);
      if (!admin) {
        writeJson(res, 401, { detail: 'unauthorized' });
        return;
      }
      const u = new URL(`http://stub${rawUrl}`);
      const limit = Math.max(1, Math.min(200, parseIntParam(u.searchParams.get('limit'), 50)));
      const offset = Math.max(0, parseIntParam(u.searchParams.get('offset'), 0));

      const all = listInviteItems();
      const page = all.slice(offset, offset + limit);
      const more = offset + limit < all.length;
      writeJson(res, 200, {
        items: page,
        next_offset: more ? offset + page.length : null
      });
      return;
    }

    if (method === 'POST' && rawUrl === '/api/v1/admin/invites') {
      const admin = requireAdmin(req);
      if (!admin) {
        writeJson(res, 401, { detail: 'unauthorized' });
        return;
      }
      if (admin.role !== 'super_admin') {
        writeJson(res, 403, { detail: 'require_super_admin' });
        return;
      }

      const parsed = await readJsonBody(req);
      const maxUsesRaw =
        typeof parsed === 'object' && parsed !== null && 'max_uses' in parsed
          ? (parsed as { max_uses?: unknown }).max_uses
          : undefined;
      const max_uses = typeof maxUsesRaw === 'number' ? Math.floor(maxUsesRaw) : Number(maxUsesRaw);
      if (!Number.isFinite(max_uses) || max_uses < 1 || max_uses > 10_000) {
        writeJson(res, 400, { detail: 'max_uses must be within [1, 10000]' });
        return;
      }

      const id = `inv_${randomId()}`;
      const code = randomBytes(20)
        .toString('base64')
        .replace(/[^A-Za-z0-9]/g, '')
        .toUpperCase()
        .slice(0, 26);
      const code_prefix = code.slice(0, 6);
      const created_at = new Date().toISOString();

      const row: InviteListItem = {
        id,
        code_prefix,
        max_uses,
        uses_count: 0,
        expires_at: null,
        revoked_at: null,
        created_at
      };
      invites.unshift(row);
      fullCodesByInviteId.set(id, code);
      const redemption: InviteRedemptionListItem = {
        id: `red_${randomId()}`,
        invite_id: id,
        user_id: 'user-e2e',
        user_email: 'user@local',
        used_at: new Date(Date.now() + 10).toISOString()
      };
      redemptionsByInviteId.set(id, [redemption]);
      row.uses_count = Math.min(row.max_uses, 1);

      const resp: InviteCreateResponse = { ...row, code };
      writeJson(res, 201, resp);
      return;
    }

    if (method === 'POST') {
      const m = rawUrl.match(/^\/api\/v1\/admin\/invites\/([^/]+):revoke$/);
      if (m) {
        const inviteId = decodeURIComponent(m[1] ?? '');
        const admin = requireAdmin(req);
        if (!admin) {
          writeJson(res, 401, { detail: 'unauthorized' });
          return;
        }
        if (admin.role !== 'super_admin') {
          writeJson(res, 403, { detail: 'require_super_admin' });
          return;
        }
        const row = invites.find((it) => it.id === inviteId) ?? null;
        if (!row) {
          writeJson(res, 404, { detail: 'Invite not found' });
          return;
        }
        if (!row.revoked_at) row.revoked_at = new Date().toISOString();
        writeJson(res, 200, row);
        return;
      }
    }

    if (method === 'GET') {
      const m = rawUrl.match(/^\/api\/v1\/admin\/invites\/([^/]+)\/redemptions(\?.*)?$/);
      if (m) {
        const inviteId = decodeURIComponent(m[1] ?? '');
        const admin = requireAdmin(req);
        if (!admin) {
          writeJson(res, 401, { detail: 'unauthorized' });
          return;
        }

        const row = invites.find((it) => it.id === inviteId) ?? null;
        if (!row) {
          writeJson(res, 404, { detail: 'Invite not found' });
          return;
        }

        const u = new URL(`http://stub${rawUrl}`);
        const limit = Math.max(1, Math.min(200, parseIntParam(u.searchParams.get('limit'), 50)));
        const offset = Math.max(0, parseIntParam(u.searchParams.get('offset'), 0));
        const all = redemptionsByInviteId.get(inviteId) ?? [];
        const page = all.slice(offset, offset + limit);
        const more = offset + limit < all.length;
        writeJson(res, 200, {
          items: page,
          next_offset: more ? offset + page.length : null
        });
        return;
      }
    }

    writeJson(res, 404, { detail: 'not found' });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('STUB_SERVER_NO_ADDRESS');
  const port = (addr as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    adminEmail,
    adminPassword,
    operatorEmail,
    operatorPassword,
    close: async () => {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.ico') return 'image/x-icon';
  return 'application/octet-stream';
}

async function startStaticAdminWebServer(distDir: string): Promise<AdminWebStaticServer> {
  if (!fs.existsSync(distDir)) {
    throw new Error(`ADMIN_WEB_DIST_NOT_FOUND: ${distDir}`);
  }

  const sockets = new Set<Socket>();
  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }

    const u = new URL(`http://static${rawUrl}`);
    const pathname = decodeURIComponent(u.pathname);

    const requested = pathname === '/' ? '/index.html' : pathname;
    const absRequested = path.resolve(distDir, `.${requested}`);
    const isWithinDist = absRequested.startsWith(path.resolve(distDir) + path.sep);

    const hasDot = path.basename(requested).includes('.');
    const tryFiles: string[] = [];
    if (isWithinDist) {
      tryFiles.push(absRequested);
    }
    if (!hasDot) {
      tryFiles.push(path.resolve(distDir, 'index.html'));
    }

    let chosen: string | null = null;
    for (const p of tryFiles) {
      try {
        const st = await fs.promises.stat(p);
        if (st.isFile()) {
          chosen = p;
          break;
        }
      } catch {
      }
    }

    if (!chosen) {
      res.writeHead(404);
      res.end();
      return;
    }

    res.setHeader('Content-Type', contentTypeForPath(chosen));
    res.writeHead(200);
    if (method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(chosen).pipe(res);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('STATIC_SERVER_NO_ADDRESS');
  const port = (addr as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function runViteBuildAdminWeb(opts: { serverBaseUrl: string; outDir: string }): Promise<void> {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const adminWebDir = path.resolve(process.cwd(), '..', 'admin-web');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      npmCmd,
      [
        'exec',
        '--',
        'vite',
        'build',
        '--emptyOutDir',
        '--outDir',
        opts.outDir
      ],
      {
        cwd: adminWebDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          VITE_SERVER_BASE_URL: opts.serverBaseUrl
        }
      },
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`admin-web build exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`admin-web build failed: ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

test('Plan 5.2: admin-web manages invites (create/list/revoke/redemptions, RBAC)', async () => {
  test.setTimeout(180_000);

  const stub = await startStubBackend();
  let staticServer: AdminWebStaticServer | null = null;
  let adminWebBuildRoot: string | null = null;

  try {
    await test.step('Build admin-web (VITE_SERVER_BASE_URL -> stub backend)', async () => {
      const buildRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-admin-web-invites-'));
      adminWebBuildRoot = buildRoot;
      await runViteBuildAdminWeb({
        serverBaseUrl: stub.baseUrl,
        outDir: path.join(buildRoot, 'dist')
      });
    });

    staticServer = await test.step('Serve admin-web dist (SPA fallback)', async () => {
      return startStaticAdminWebServer(path.join(adminWebBuildRoot!, 'dist'));
    });

    await test.step('Web: super_admin login -> create -> list(no code) -> revoke -> redemptions', async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      try {
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(15_000);

        await page.goto(`${staticServer!.baseUrl}/config/invites`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Para Admin')).toBeVisible({ timeout: 15_000 });

        await page.getByLabel('Email').fill(stub.adminEmail);
        await page.getByLabel('Password').fill(stub.adminPassword);
        await page.getByRole('button', { name: '登录' }).click();

        await expect(page.getByRole('heading', { name: '邀请码管理' })).toBeVisible({ timeout: 15_000 });

        const createBtn = page.getByTestId('invite-create-btn');
        await expect(createBtn).toBeVisible();
        await expect(createBtn).toBeEnabled();
        await createBtn.click();

        await expect(page.getByText('邀请码只展示一次，请立即保存。', { exact: true })).toBeVisible({ timeout: 15_000 });
        const codePre = page.getByTestId('invite-created-code');
        await expect(codePre).toBeVisible({ timeout: 15_000 });
        const code = (await codePre.textContent()) ?? '';
        expect(code.trim().length).toBeGreaterThan(10);
        const prefix = code.trim().slice(0, 6);

        await page.getByRole('button', { name: '我已保存，关闭' }).click();
        await expect(page.getByTestId('invite-created-code')).toHaveCount(0);
        await expect(page.getByTestId('invites-table')).toContainText(prefix, { timeout: 15_000 });
        await expect(page.getByTestId('invites-table')).not.toContainText(code.trim());

        const row = page.getByTestId('invites-table').locator('tbody tr').filter({ hasText: prefix }).first();
        await expect(row).toBeVisible({ timeout: 15_000 });

        page.once('dialog', (d) => d.accept().catch(() => undefined));
        await row.getByRole('button', { name: '撤销' }).click();
        await expect(row.getByText('REVOKED', { exact: true })).toBeVisible({ timeout: 15_000 });

        await row.getByRole('button', { name: '使用记录' }).click();
        const panel = page.getByTestId('invite-redemptions-panel');
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect(panel.getByText('user@local', { exact: true })).toBeVisible({ timeout: 15_000 });
      } finally {
        await page.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      }
    });

    await test.step('Web: operator login is read-only (no create/revoke)', async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      try {
        await page.goto(`${staticServer!.baseUrl}/config/invites`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByText('Para Admin')).toBeVisible({ timeout: 15_000 });

        await page.getByLabel('Email').fill(stub.operatorEmail);
        await page.getByLabel('Password').fill(stub.operatorPassword);
        await page.getByRole('button', { name: '登录' }).click();

        await expect(page.getByRole('heading', { name: '邀请码管理' })).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText('当前账号为', { exact: false })).toBeVisible({ timeout: 15_000 });

        const createBtn = page.getByTestId('invite-create-btn');
        await expect(createBtn).toBeVisible();
        await expect(createBtn).toBeDisabled();

        const revokeBtns = page.getByRole('button', { name: '撤销' });
        if ((await revokeBtns.count()) > 0) {
          await expect(revokeBtns.first()).toBeDisabled();
        }
      } finally {
        await page.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      }
    });
  } finally {
    const serverToClose = staticServer as AdminWebStaticServer | null;
    if (serverToClose) {
      await serverToClose.close().catch(() => undefined);
      staticServer = null;
    }
    if (adminWebBuildRoot) {
      await fs.promises.rm(adminWebBuildRoot, { recursive: true, force: true }).catch(() => undefined);
      adminWebBuildRoot = null;
    }
    await stub.close().catch(() => undefined);
  }
});
