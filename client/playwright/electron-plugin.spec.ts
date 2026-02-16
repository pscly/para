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

async function startPluginsStubServer(plugin: ApprovedPlugin): Promise<StubServer> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url === '/api/v1/auth/me' || url.startsWith('/api/v1/auth/me?'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user_id: 'e2e', email: 'e2e@local' }));
      return;
    }

    if (method === 'GET' && (url === '/api/v1/feature_flags' || url.startsWith('/api/v1/feature_flags?'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ feature_flags: { plugins_enabled: true } }));
      return;
    }

    if (method === 'GET' && (url === '/api/v1/plugins' || url.startsWith('/api/v1/plugins?'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: plugin.id,
            version: plugin.version,
            name: plugin.name,
            sha256: plugin.sha256,
            permissions: plugin.permissions
          }
        ])
      );
      return;
    }

    if (method === 'GET') {
      const m = url.match(/^\/api\/v1\/plugins\/([^/]+)\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1] ?? '');
        const version = decodeURIComponent(m[2] ?? '');

        if (id === plugin.id && version === plugin.version) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              manifest_json: plugin.manifestJson,
              code: plugin.code,
              sha256: plugin.sha256
            })
          );
          return;
        }
      }
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

  if (pages.length < minCount) {
    throw new Error(`E2E_ELECTRON_WINDOWS_LT_${minCount}`);
  }

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

test('Task 21: plugin default-off + enable + install + pet bubble (with evidence screenshot)', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const pluginId = 'e2e-plugin-hello';
  const pluginVersion = '0.0.1';
  const pluginName = 'E2E Hello Plugin';
  const menuItemId = 'hello';
  const menuItemLabel = 'Hello';

  const code = [
    `addMenuItem({ id: ${JSON.stringify(menuItemId)}, label: ${JSON.stringify(menuItemLabel)} });`,
    `onMenuClick(${JSON.stringify(menuItemId)}, () => {`,
    `  suggestion('e2e: suggestion line');`,
    `  let hasProcess = 'unknown';`,
    `  try { hasProcess = typeof process; } catch { hasProcess = 'throw'; }`,
    `  let hasRequire = 'unknown';`,
    `  try { hasRequire = typeof require; } catch { hasRequire = 'throw'; }`,
    `  let requireFs = 'unknown';`,
    `  try { require('fs'); requireFs = 'yes'; } catch { requireFs = 'no'; }`,
    `  say('e2e: plugin bubble says hello | process=' + hasProcess + ' require=' + hasRequire + ' requireFs=' + requireFs);`,
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

  const stub = await startPluginsStubServer(approved);

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

        await test.step('Default off: pet radial menu has no plugin entry', async () => {
          await petPage.bringToFront();
          await expect(sprite).toBeVisible({ timeout: 10_000 });
          await sprite.click();
          await expect(petPage.getByTestId('pet-radial-menu')).toBeVisible({ timeout: 5_000 });
          await expect(petPage.getByTestId(expectedPetPluginMenuTestId)).toHaveCount(0);
          await sprite.click();
        });

        await test.step('Enable + refresh + install approved plugin in debug panel', async () => {
          await debugPage.bringToFront();
          const pluginsCard = debugPage.getByTestId(TEST_IDS.pluginsCard);
          await pluginsCard.scrollIntoViewIfNeeded();
          await expect(pluginsCard).toBeVisible();

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
          }

          const refresh = debugPage.getByTestId(TEST_IDS.pluginsRefresh);
          await expect(refresh).toBeVisible();
          await refresh.click();

          const select = debugPage.getByTestId(TEST_IDS.pluginsSelect);
          await expect(select).toBeVisible();
          const pluginKey = `${pluginId}@@${pluginVersion}`;
          await expect(select).toBeEnabled({ timeout: 10_000 });
          await select.selectOption({ value: pluginKey });

          const install = debugPage.getByTestId(TEST_IDS.pluginsInstall);
          await expect(install).toBeVisible();
          await install.click();

          const firstMenuItem = debugPage.getByTestId(TEST_IDS.pluginsMenuItem).first();
          await expect(firstMenuItem).toBeVisible({ timeout: 15_000 });
        });

        await test.step('Pet: plugin entry appears; click shows bubble output', async () => {
          await petPage.bringToFront();
          await sprite.click();
          await expect(petPage.getByTestId('pet-radial-menu')).toBeVisible({ timeout: 5_000 });

          const petPluginButton = petPage.getByTestId(expectedPetPluginMenuTestId);
          await expect(petPluginButton).toBeVisible({ timeout: 15_000 });
          await petPluginButton.click();

          const bubble = petPage.getByTestId('pet-plugin-bubble');
          await expect(bubble).toBeVisible({ timeout: 15_000 });
          const bubbleText = petPage.getByTestId('pet-plugin-bubble-text');
          await expect(bubbleText).toHaveText(/\S+/, { timeout: 5_000 });
          await expect(bubbleText).toContainText('process=undefined');
          await expect(bubbleText).toContainText('require=undefined');
          await expect(bubbleText).toContainText('requireFs=no');
        });

        const evidencePath = getEvidencePath('task-21-plugin.png');
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
