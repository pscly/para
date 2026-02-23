import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

import { test, expect, chromium } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

test.use({
  actionTimeout: 10_000,
  navigationTimeout: 15_000
});

type BackendStub = {
  baseUrl: string;
  adminEmail: string;
  adminPassword: string;
  adminFeatureFlagsPutBodies: unknown[];
  close: () => Promise<void>;
};

type AdminWebStaticServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type ApprovedPlugin = {
  id: string;
  version: string;
  name: string;
  sha256: string;
  permissions: unknown;
  manifestJson: string;
  code: string;
};

function randomId(): string {
  return randomBytes(8).toString('hex');
}

function sha256HexUtf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function startStubBackend(opts: {
  pluginsEnabledInitial: boolean;
  inviteRegistrationEnabledInitial?: boolean;
  openRegistrationEnabledInitial?: boolean;
  plugin: ApprovedPlugin;
}): Promise<BackendStub> {
  let pluginsEnabled = Boolean(opts.pluginsEnabledInitial);
  let inviteRegistrationEnabled =
    typeof opts.inviteRegistrationEnabledInitial === 'boolean' ? opts.inviteRegistrationEnabledInitial : true;
  let openRegistrationEnabled =
    typeof opts.openRegistrationEnabledInitial === 'boolean' ? opts.openRegistrationEnabledInitial : false;

  const adminFeatureFlagsPutBodies: unknown[] = [];

  const adminEmail = 'admin@local';
  const adminPassword = 'admin-password';
  const adminUserId = 'admin-e2e';
  const adminRole = 'super_admin';
  const adminAccessToken = `stub-admin-${randomId()}`;

  const sockets = new Set<Socket>();
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && (url === '/api/v1/auth/me' || url.startsWith('/api/v1/auth/me?'))) {
      const token = getBearerToken(req);
      if (!token) {
        writeJson(res, 401, { detail: 'unauthorized' });
        return;
      }
      writeJson(res, 200, { user_id: 'e2e', email: 'e2e@local', debug_allowed: false });
      return;
    }

    if (method === 'GET' && (url === '/api/v1/feature_flags' || url.startsWith('/api/v1/feature_flags?'))) {
      writeJson(res, 200, {
        generated_at: new Date().toISOString(),
        feature_flags: {
          plugins_enabled: pluginsEnabled,
          invite_registration_enabled: inviteRegistrationEnabled,
          open_registration_enabled: openRegistrationEnabled
        }
      });
      return;
    }

    if (method === 'GET' && (url === '/api/v1/plugins' || url.startsWith('/api/v1/plugins?'))) {
      writeJson(res, 200, [
        {
          id: opts.plugin.id,
          version: opts.plugin.version,
          name: opts.plugin.name,
          sha256: opts.plugin.sha256,
          permissions: opts.plugin.permissions
        }
      ]);
      return;
    }

    if (method === 'GET') {
      const m = url.match(/^\/api\/v1\/plugins\/([^/]+)\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1] ?? '');
        const version = decodeURIComponent(m[2] ?? '');
        if (id === opts.plugin.id && version === opts.plugin.version) {
          writeJson(res, 200, {
            manifest_json: opts.plugin.manifestJson,
            code: opts.plugin.code,
            sha256: opts.plugin.sha256
          });
          return;
        }
      }
    }

    if (method === 'POST' && url === '/api/v1/admin/auth/login') {
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

      if (email !== adminEmail || password !== adminPassword) {
        writeJson(res, 401, { detail: 'invalid credentials' });
        return;
      }

      writeJson(res, 200, {
        access_token: adminAccessToken,
        token_type: 'bearer',
        admin_user_id: adminUserId,
        role: adminRole
      });
      return;
    }

    if (method === 'GET' && url === '/api/v1/admin/config/feature_flags') {
      const token = getBearerToken(req);
      if (token !== adminAccessToken) {
        writeJson(res, 401, { detail: 'unauthorized' });
        return;
      }
      writeJson(res, 200, {
        plugins_enabled: pluginsEnabled,
        invite_registration_enabled: inviteRegistrationEnabled,
        open_registration_enabled: openRegistrationEnabled
      });
      return;
    }

    if (method === 'PUT' && url === '/api/v1/admin/config/feature_flags') {
      const token = getBearerToken(req);
      if (token !== adminAccessToken) {
        writeJson(res, 401, { detail: 'unauthorized' });
        return;
      }

      const parsed = await readJsonBody(req);

      const hasPluginsEnabled = typeof parsed === 'object' && parsed !== null && 'plugins_enabled' in parsed;
      const hasInviteRegistrationEnabled =
        typeof parsed === 'object' && parsed !== null && 'invite_registration_enabled' in parsed;
      const hasOpenRegistrationEnabled =
        typeof parsed === 'object' && parsed !== null && 'open_registration_enabled' in parsed;
      if (!hasPluginsEnabled && !hasInviteRegistrationEnabled && !hasOpenRegistrationEnabled) {
        writeJson(res, 400, {
          detail:
            'Body must contain at least one of: plugins_enabled, invite_registration_enabled, open_registration_enabled'
        });
        return;
      }

      if (hasPluginsEnabled) {
        const v = (parsed as { plugins_enabled?: unknown }).plugins_enabled;
        if (typeof v !== 'boolean') {
          writeJson(res, 400, { detail: 'plugins_enabled must be a boolean' });
          return;
        }
        pluginsEnabled = v;
      }

      if (hasInviteRegistrationEnabled) {
        const v = (parsed as { invite_registration_enabled?: unknown }).invite_registration_enabled;
        if (typeof v !== 'boolean') {
          writeJson(res, 400, { detail: 'invite_registration_enabled must be a boolean' });
          return;
        }
        inviteRegistrationEnabled = v;
      }

      if (hasOpenRegistrationEnabled) {
        const v = (parsed as { open_registration_enabled?: unknown }).open_registration_enabled;
        if (typeof v !== 'boolean') {
          writeJson(res, 400, { detail: 'open_registration_enabled must be a boolean' });
          return;
        }
        openRegistrationEnabled = v;
      }

      adminFeatureFlagsPutBodies.push(parsed);

      writeJson(res, 200, {
        plugins_enabled: pluginsEnabled,
        invite_registration_enabled: inviteRegistrationEnabled,
        open_registration_enabled: openRegistrationEnabled
      });
      return;
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
    adminFeatureFlagsPutBodies,
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
    { encoding: 'utf8' },
  );
}

async function waitForWindows(app: ElectronApplication, minCount: number): Promise<Page[]> {
  const timeoutMs = 10_000;
  const pollIntervalMs = 100;
  const deadline = Date.now() + timeoutMs;

  let pages: Page[] = app.windows();
  while (pages.length < minCount && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pages = app.windows();
  }
  if (pages.length < minCount) throw new Error(`E2E_ELECTRON_WINDOWS_LT_${minCount}`);
  return pages;
}

async function getWindowInnerWidth(page: Page): Promise<number> {
  if (page.isClosed()) return 0;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 1_000 });
  } catch {
  }
  try {
    const w = await page.evaluate(() => window.innerWidth);
    return typeof w === 'number' ? w : 0;
  } catch {
    return 0;
  }
}

async function getDebugPanelPage(app: ElectronApplication): Promise<Page> {
  const pages = await waitForWindows(app, 2);
  let bestPage: Page = pages[0]!;
  let bestWidth = -1;
  for (const page of pages) {
    const width = await getWindowInnerWidth(page);
    if (width > bestWidth) {
      bestWidth = width;
      bestPage = page;
    }
  }
  return bestPage;
}

async function pollPluginsStatus(
  page: Page,
): Promise<{ enabled: boolean; running: boolean; installedKey: string | null; menuCount: number; lastError: string | null }> {
  const v = await page.evaluate(async () => {
    const api = (window as unknown as { desktopApi?: unknown }).desktopApi as
      | {
          plugins?: {
            getStatus?: () => Promise<{
              enabled?: unknown;
              running?: unknown;
              installed?: { id?: unknown; version?: unknown } | null;
              menuItems?: unknown;
              lastError?: unknown;
            }>;
          };
        }
      | undefined;
    if (!api?.plugins?.getStatus) {
      return { enabled: false, running: false, installedKey: null, menuCount: 0, lastError: 'NO_DESKTOP_API' };
    }

    const st = await api.plugins.getStatus();
    const enabled = Boolean(st?.enabled);
    const running = Boolean(st?.running);
    const installed = st?.installed ?? null;
    const installedId = installed && typeof installed.id === 'string' ? installed.id : '';
    const installedVersion = installed && typeof installed.version === 'string' ? installed.version : '';
    const installedKey = installedId && installedVersion ? `${installedId}@@${installedVersion}` : null;

    const menuItems = st?.menuItems;
    const menuCount = Array.isArray(menuItems) ? menuItems.length : 0;
    const lastError = typeof st?.lastError === 'string' ? st.lastError : null;
    return { enabled, running, installedKey, menuCount, lastError };
  });
  return v as { enabled: boolean; running: boolean; installedKey: string | null; menuCount: number; lastError: string | null };
}

test('Plan 5.1: admin-web toggles feature_flags -> Electron client observes plugins flag', async () => {
  test.setTimeout(180_000);

  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const pluginId = 'e2e-plugin-web-admin-flag';
  const pluginVersion = '0.0.1';
  const pluginName = 'E2E Web Admin Flag Plugin';

  const code = [`addMenuItem({ id: 'hello', label: 'Hello' });`].join('\n');
  const sha256 = sha256HexUtf8(code);
  const manifestJson = JSON.stringify({ id: pluginId, version: pluginVersion, name: pluginName, permissions: [] });

  const approved: ApprovedPlugin = {
    id: pluginId,
    version: pluginVersion,
    name: pluginName,
    sha256,
    permissions: [],
    manifestJson,
    code
  };

  const stub = await startStubBackend({ pluginsEnabledInitial: false, plugin: approved });
  let staticServer: AdminWebStaticServer | null = null;
  let adminWebBuildRoot: string | null = null;

  try {
    await test.step('Build admin-web (VITE_SERVER_BASE_URL -> stub backend)', async () => {
      const buildRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-admin-web-feature-flags-'));
      adminWebBuildRoot = buildRoot;
      await runViteBuildAdminWeb({
        serverBaseUrl: stub.baseUrl,
        outDir: path.join(buildRoot, 'dist')
      });
    });

    await test.step('Serve admin-web dist (SPA fallback)', async () => {
      staticServer = await startStaticAdminWebServer(path.join(adminWebBuildRoot!, 'dist'));
    });

    await test.step('Playwright web: login -> enable plugins_enabled -> save', async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      try {
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(15_000);

        await page.goto(`${staticServer!.baseUrl}/config/feature-flags`, { waitUntil: 'domcontentloaded' });

        await expect(page.getByText('Para Admin')).toBeVisible({ timeout: 15_000 });
        await page.getByLabel('Email').fill(stub.adminEmail);
        await page.getByLabel('Password').fill(stub.adminPassword);

        const loginBtn = page.getByRole('button', { name: '登录' });
        await expect(loginBtn).toBeVisible();
        await loginBtn.click();

        await expect(page.getByRole('heading', { name: 'Feature Flags' })).toBeVisible({ timeout: 15_000 });

        await expect(
          page.getByText('开启仅表示允许邀请码注册，不代表开放无邀请码注册。', { exact: true })
        ).toBeVisible({ timeout: 15_000 });

        await expect(
          page.getByText('开启后允许无邀请码注册（但仍建议保留邀请码注册开关作为兼容）。', { exact: true })
        ).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(/注册仍会被关闭/)).toBeVisible({ timeout: 15_000 });

        const saveBtn = page.getByRole('button', { name: '保存' });
        await expect(saveBtn).toBeVisible();

        const statusClean = page.getByText('与后端一致', { exact: true });
        await expect(statusClean).toBeVisible({ timeout: 15_000 });

        const pluginsKv = page.locator('.kv').filter({ hasText: 'plugins_enabled' });
        const inviteKv = page.locator('.kv').filter({ hasText: 'invite_registration_enabled' });
        const openKv = page.locator('.kv').filter({ hasText: 'open_registration_enabled' });

        const pluginsSwitchLabel = pluginsKv.locator('label.switch');
        const inviteSwitchLabel = inviteKv.locator('label.switch');
        const openSwitchLabel = openKv.locator('label.switch');
        await expect(pluginsSwitchLabel).toBeVisible();
        await expect(inviteSwitchLabel).toBeVisible();
        await expect(openSwitchLabel).toBeVisible();

        const pluginsCheckbox = pluginsSwitchLabel.locator('input[type="checkbox"]');
        await expect(pluginsCheckbox).toBeEnabled({ timeout: 15_000 });
        await expect(pluginsCheckbox).not.toBeChecked();
        await expect(pluginsKv.getByText('DISABLED', { exact: true })).toBeVisible();

        const inviteCheckbox = inviteSwitchLabel.locator('input[type="checkbox"]');
        await expect(inviteCheckbox).toBeEnabled({ timeout: 15_000 });
        await expect(inviteCheckbox).toBeChecked();
        await expect(inviteKv.getByText('ENABLED', { exact: true })).toBeVisible();

        const openCheckbox = openSwitchLabel.locator('input[type="checkbox"]');
        await expect(openCheckbox).toBeEnabled({ timeout: 15_000 });
        await expect(openCheckbox).not.toBeChecked();
        await expect(openKv.getByText('DISABLED', { exact: true })).toBeVisible();

        await expect(saveBtn).toBeDisabled();

        await pluginsSwitchLabel.click();

        const dirtyText = page.getByText('存在未保存更改', { exact: true });
        await expect(dirtyText).toBeVisible({ timeout: 10_000 });
        await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
        await expect(pluginsKv.getByText('ENABLED', { exact: true })).toBeVisible();

        await saveBtn.click();
        await expect(page.getByText('已保存', { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(statusClean).toBeVisible({ timeout: 15_000 });
        await expect(pluginsKv.getByText('ENABLED', { exact: true })).toBeVisible();

        expect(stub.adminFeatureFlagsPutBodies.length).toBe(1);
        expect(stub.adminFeatureFlagsPutBodies[0]).toEqual({ plugins_enabled: true });

        await inviteSwitchLabel.click();
        await expect(dirtyText).toBeVisible({ timeout: 10_000 });
        await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
        await expect(inviteKv.getByText('DISABLED', { exact: true })).toBeVisible();
        await expect(pluginsKv.getByText('ENABLED', { exact: true })).toBeVisible();

        await saveBtn.click();
        await expect(page.getByText('已保存', { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(statusClean).toBeVisible({ timeout: 15_000 });
        await expect(inviteKv.getByText('DISABLED', { exact: true })).toBeVisible();
        await expect(pluginsKv.getByText('ENABLED', { exact: true })).toBeVisible();

        expect(stub.adminFeatureFlagsPutBodies.length).toBe(2);
        expect(stub.adminFeatureFlagsPutBodies[1]).toEqual({ invite_registration_enabled: false });

        await openSwitchLabel.click();
        await expect(dirtyText).toBeVisible({ timeout: 10_000 });
        await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
        await expect(openKv.getByText('ENABLED', { exact: true })).toBeVisible();
        await expect(inviteKv.getByText('DISABLED', { exact: true })).toBeVisible();
        await expect(pluginsKv.getByText('ENABLED', { exact: true })).toBeVisible();

        await saveBtn.click();
        await expect(page.getByText('已保存', { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(statusClean).toBeVisible({ timeout: 15_000 });
        await expect(openKv.getByText('ENABLED', { exact: true })).toBeVisible();

        expect(stub.adminFeatureFlagsPutBodies.length).toBe(3);
        expect(stub.adminFeatureFlagsPutBodies[2]).toEqual({ open_registration_enabled: true });
      } finally {
        await page.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      }
    });

    await test.step('Electron: launch -> debug panel shows plugins card + menu item appears', async () => {
      await withTempUserDataDir(async (userDataDir) => {
        await writeStubAuthTokens(userDataDir);

        const electronApp = await electron.launch({
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
          const debugPage = await getDebugPanelPage(electronApp);
          await debugPage.bringToFront();
          try {
            await debugPage.waitForLoadState('domcontentloaded', { timeout: 5_000 });
          } catch {
          }
          await debugPage.evaluate(() => {
            window.location.hash = '#/plugins';
          });

          const pluginsCard = debugPage.getByTestId(TEST_IDS.pluginsCard);
          await expect(pluginsCard).toBeVisible({ timeout: 15_000 });
          await pluginsCard.scrollIntoViewIfNeeded();

          const toggle = debugPage.getByTestId(TEST_IDS.pluginsToggle);
          await expect(toggle).toBeVisible();
          await toggle.click();

          const consentPanel = debugPage.getByTestId(TEST_IDS.pluginsConsentPanel);
          const needsConsent =
            (await consentPanel.isVisible().catch(() => false)) ||
            (await consentPanel
              .waitFor({ state: 'visible', timeout: 1_500 })
              .then(() => true)
              .catch(() => false));
          if (needsConsent) {
            const accept = debugPage.getByTestId(TEST_IDS.pluginsConsentAccept);
            await expect(accept).toBeVisible();
            await accept.click();
            await consentPanel.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
          }

          await expect
            .poll(async () => {
              const st = await pollPluginsStatus(debugPage);
              return st.enabled;
            }, { timeout: 15_000 })
            .toBe(true);

          const refresh = debugPage.getByTestId(TEST_IDS.pluginsRefresh);
          await expect(refresh).toBeVisible();
          await refresh.click();

          const select = debugPage.getByTestId(TEST_IDS.pluginsSelect);
          await expect(select).toBeVisible();
          await expect(select).toBeEnabled({ timeout: 10_000 });
          const pluginKey = `${pluginId}@@${pluginVersion}`;
          await expect(select.locator(`option[value="${pluginKey}"]`)).toHaveCount(1, { timeout: 10_000 });
          await select.selectOption({ value: pluginKey });

          const install = debugPage.getByTestId(TEST_IDS.pluginsInstall);
          await expect(install).toBeVisible();
          await install.click();

          await expect
            .poll(async () => {
              return pollPluginsStatus(debugPage);
            }, { timeout: 30_000 })
            .toMatchObject({ enabled: true, running: true, installedKey: pluginKey, lastError: null });

          await expect
            .poll(async () => {
              const st = await pollPluginsStatus(debugPage);
              return st.menuCount > 0;
            }, { timeout: 30_000 })
            .toBe(true);

          const firstMenuItem = debugPage.getByTestId(TEST_IDS.pluginsMenuItem).first();
          await expect(firstMenuItem).toBeVisible({ timeout: 20_000 });
        } finally {
          await electronApp.close().catch(() => undefined);
        }
      });
    });
  } finally {
    if (staticServer) {
      await (staticServer as unknown as { close: () => Promise<void> }).close().catch(() => undefined);
      staticServer = null;
    }
    if (adminWebBuildRoot) {
      await fs.promises.rm(adminWebBuildRoot, { recursive: true, force: true }).catch(() => undefined);
      adminWebBuildRoot = null;
    }
    await (stub as unknown as { close: () => Promise<void> }).close().catch(() => undefined);
  }
});
