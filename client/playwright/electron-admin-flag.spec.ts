import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

type StubServer = {
  baseUrl: string;
  close: () => Promise<void>;
  getPluginsEnabled: () => boolean;
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

function sanitizeTestId(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return sanitized.length > 0 ? sanitized : 'item';
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

function json(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function startAdminFlagStubServer(opts: {
  plugin: ApprovedPlugin;
  pluginsEnabledInitial: boolean;
  adminEmail: string;
  adminPassword: string;
}): Promise<StubServer> {
  let pluginsEnabled = Boolean(opts.pluginsEnabledInitial);
  const adminAccessToken = 'stub-admin-token';

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url === '/api/v1/auth/me' || url.startsWith('/api/v1/auth/me?'))) {
      json(res, 200, { user_id: 'e2e', email: 'e2e@local', debug_allowed: false });
      return;
    }

    if (method === 'GET' && (url === '/api/v1/feature_flags' || url.startsWith('/api/v1/feature_flags?'))) {
      json(res, 200, { feature_flags: { plugins_enabled: pluginsEnabled } });
      return;
    }

    if (method === 'GET' && (url === '/api/v1/plugins' || url.startsWith('/api/v1/plugins?'))) {
      json(res, 200, [
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
          json(res, 200, {
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
        json(res, 400, { detail: 'bad payload' });
        return;
      }

      if (email !== opts.adminEmail || password !== opts.adminPassword) {
        json(res, 401, { detail: 'invalid credentials' });
        return;
      }

      json(res, 200, { access_token: adminAccessToken, token_type: 'bearer' });
      return;
    }

    if (method === 'PUT' && url === '/api/v1/admin/config/feature_flags') {
      const token = getBearerToken(req);
      if (token !== adminAccessToken) {
        json(res, 401, { detail: 'unauthorized' });
        return;
      }

      const parsed = await readJsonBody(req);
      const next =
        typeof parsed === 'object' && parsed !== null && 'feature_flags' in parsed
          ? (parsed as { feature_flags?: unknown }).feature_flags
          : undefined;

      const nextEnabled =
        typeof next === 'object' && next !== null && 'plugins_enabled' in next
          ? (next as { plugins_enabled?: unknown }).plugins_enabled
          : undefined;

      if (typeof nextEnabled !== 'boolean') {
        json(res, 400, { detail: 'bad payload' });
        return;
      }

      pluginsEnabled = nextEnabled;
      json(res, 200, { feature_flags: { plugins_enabled: pluginsEnabled } });
      return;
    }

    json(res, 404, { detail: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('STUB_SERVER_NO_ADDRESS');
  const port = (addr as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    getPluginsEnabled: () => pluginsEnabled,
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

async function getPetPage(app: ElectronApplication): Promise<Page> {
  const pages = await waitForWindows(app, 2);

  let bestPage: Page = pages[0]!;
  let bestWidth = Number.POSITIVE_INFINITY;

  for (const page of pages) {
    const width = await getWindowInnerWidth(page);
    if (width > 0 && width < bestWidth) {
      bestWidth = width;
      bestPage = page;
    }
  }

  return bestPage;
}

async function navigateToPluginsPage(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
  } catch {
  }

  await page.evaluate(() => {
    window.location.hash = '#/plugins';
  });

  await expect(page.getByTestId(TEST_IDS.pluginsCard)).toBeVisible({ timeout: 15_000 });
}

async function ensurePetWindowNotClickThrough(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) return;

    const withBounds = wins
      .map((w) => {
        const b = w.getBounds();
        const width = typeof b.width === 'number' ? b.width : 0;
        const height = typeof b.height === 'number' ? b.height : 0;
        const area = width > 0 && height > 0 ? width * height : Number.POSITIVE_INFINITY;
        return { w, area };
      })
      .sort((a, b) => a.area - b.area);

    const chosen = withBounds[0];
    if (!chosen) return;

    chosen.w.setIgnoreMouseEvents(false);
    chosen.w.show();
    chosen.w.focus();
  });
}

async function requestJson(baseUrl: string, reqPath: string, opts: { method: string; headers?: Record<string, string>; body?: unknown }) {
  const u = new URL(reqPath, baseUrl);
  const method = opts.method;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let bodyText: string | undefined;
  if (opts.body !== undefined) {
    bodyText = JSON.stringify(opts.body);
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
  }

  const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        method,
        path: `${u.pathname}${u.search}`,
        headers
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
        resp.on('end', () => {
          resolve({ status: resp.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    if (bodyText) req.write(bodyText, 'utf8');
    req.end();
  });

  let jsonBody: unknown = null;
  try {
    jsonBody = res.text.trim() ? (JSON.parse(res.text) as unknown) : null;
  } catch {
    jsonBody = null;
  }

  return { status: res.status, json: jsonBody };
}

test('Task 22: admin flag toggles plugins kill-switch live (with evidence screenshot)', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const pluginId = 'e2e-plugin-admin-flag';
  const pluginVersion = '0.0.1';
  const pluginName = 'E2E Admin Flag Plugin';
  const menuItemId = 'hello';
  const menuItemLabel = 'Hello';

  const code = [
    `addMenuItem({ id: ${JSON.stringify(menuItemId)}, label: ${JSON.stringify(menuItemLabel)} });`,
    `onMenuClick(${JSON.stringify(menuItemId)}, () => {`,
    `  say('e2e: admin flag enabled -> plugin bubble');`,
    `});`
  ].join('\n');

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

  const adminEmail = 'admin@local';
  const adminPassword = 'admin-password';
  const stub = await startAdminFlagStubServer({
    plugin: approved,
    pluginsEnabledInitial: false,
    adminEmail,
    adminPassword
  });

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
        const debugPage = await getDebugPanelPage(app);
        const petPage = await getPetPage(app);
        await ensurePetWindowNotClickThrough(app);

        const sprite = petPage.getByTestId('pet-sprite');
        const expectedPetPluginMenuTestId = `pet-plugin-menu-item-${sanitizeTestId(`${pluginId}-${menuItemId}`)}`;

        await test.step('Debug panel: enable local execution + refresh + install plugin (remote flag still false)', async () => {
          await debugPage.bringToFront();

          await navigateToPluginsPage(debugPage);

          const pluginsCard = debugPage.getByTestId(TEST_IDS.pluginsCard);
          await pluginsCard.scrollIntoViewIfNeeded();
          await expect(pluginsCard).toBeVisible();

          const toggle = debugPage.getByTestId(TEST_IDS.pluginsToggle);
          await expect(toggle).toBeVisible();
          await toggle.click();

          const consentPanel = debugPage.getByTestId(TEST_IDS.pluginsConsentPanel);
          if (await consentPanel.isVisible().catch(() => false)) {
            const accept = debugPage.getByTestId(TEST_IDS.pluginsConsentAccept);
            await expect(accept).toBeVisible();
            await accept.click();
          }

          const refresh = debugPage.getByTestId(TEST_IDS.pluginsRefresh);
          await expect(refresh).toBeVisible();
          await refresh.click();

          const select = debugPage.getByTestId(TEST_IDS.pluginsSelect);
          await expect(select).toBeVisible();
          await expect(select).toBeEnabled({ timeout: 10_000 });
          const pluginKey = `${pluginId}@@${pluginVersion}`;
          await select.selectOption({ value: pluginKey });

          const install = debugPage.getByTestId(TEST_IDS.pluginsInstall);
          await expect(install).toBeVisible();
          await install.click();

          await expect
            .poll(
              async () => {
                return debugPage.evaluate(async () => {
                  const api = (window as unknown as { desktopApi?: any }).desktopApi;
                  const status = await api?.plugins?.getStatus?.();
                  return {
                    enabled: Boolean(status?.enabled),
                    installedId: status?.installed?.id ?? null,
                    installedVersion: status?.installed?.version ?? null
                  };
                });
              },
              { timeout: 15_000 }
            )
            .toEqual({ enabled: true, installedId: pluginId, installedVersion: pluginVersion });
        });

        await test.step('Pet: remote kill-switch=false => plugin entry stays hidden even if installed+enabled', async () => {
          expect(stub.getPluginsEnabled()).toBe(false);
          await petPage.bringToFront();
          await expect(sprite).toBeVisible({ timeout: 10_000 });

          await sprite.click();
          await expect(petPage.getByTestId('pet-radial-menu')).toBeVisible({ timeout: 5_000 });
          await expect(petPage.getByTestId(expectedPetPluginMenuTestId)).toHaveCount(0);

          await sprite.click();
        });

        await test.step('Admin: login + PUT feature_flags.plugins_enabled=true', async () => {
          const loginResp = await requestJson(stub.baseUrl, '/api/v1/admin/auth/login', {
            method: 'POST',
            body: { email: adminEmail, password: adminPassword }
          });
          expect(loginResp.status).toBe(200);
          const token =
            typeof loginResp.json === 'object' && loginResp.json !== null && 'access_token' in loginResp.json
              ? (loginResp.json as { access_token?: unknown }).access_token
              : null;
          expect(typeof token).toBe('string');

          const putResp = await requestJson(stub.baseUrl, '/api/v1/admin/config/feature_flags', {
            method: 'PUT',
            headers: { Authorization: `Bearer ${String(token)}` },
            body: { feature_flags: { plugins_enabled: true } }
          });
          expect(putResp.status).toBe(200);
          expect(stub.getPluginsEnabled()).toBe(true);
        });

        await test.step('Pet: wait for poller -> plugin menu appears -> click -> bubble visible', async () => {
          await petPage.bringToFront();
          await expect(sprite).toBeVisible({ timeout: 10_000 });

          await sprite.click();
          await expect(petPage.getByTestId('pet-radial-menu')).toBeVisible({ timeout: 5_000 });

          const petPluginButton = petPage.getByTestId(expectedPetPluginMenuTestId);
          await expect(petPluginButton).toBeVisible({ timeout: 15_000 });
          await petPluginButton.click();

          const bubble = petPage.getByTestId('pet-plugin-bubble');
          await expect(bubble).toBeVisible({ timeout: 15_000 });
          await expect(petPage.getByTestId('pet-plugin-bubble-text')).toHaveText(/\S+/, { timeout: 5_000 });
        });

        const evidencePath = getEvidencePath('task-22-admin-flag.png');
        await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
        await petPage.screenshot({ path: evidencePath, fullPage: true });
        expect(fs.existsSync(evidencePath)).toBeTruthy();
      } finally {
        await app.close();
      }
    });
  } finally {
    await stub.close();
  }
});
