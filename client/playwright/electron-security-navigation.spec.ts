import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

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

async function waitForStableWindowCount(app: ElectronApplication): Promise<number> {
  const timeoutMs = 10_000;
  const pollIntervalMs = 100;
  const stableForMs = 750;
  const deadline = Date.now() + timeoutMs;

  let lastCount = app.windows().length;
  let lastChangeAt = Date.now();

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const currentCount = app.windows().length;
    if (currentCount !== lastCount) {
      lastCount = currentCount;
      lastChangeAt = Date.now();
    }

    if (Date.now() - lastChangeAt >= stableForMs) {
      return lastCount;
    }
  }

  return app.windows().length;
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

function getEvidencePath(): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'task-18-security.txt');
}

test('Electron security: deny window.open to javascript/file/non-allowlist https', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PARA_EXTERNAL_OPEN_ORIGINS: '',
      PARA_EXTERNAL_OPEN_HOSTS: ''
    }
  });

  let newWindowCount = 0;
  let trackNewWindows = false;
  app.on('window', () => {
    if (!trackNewWindows) return;
    newWindowCount += 1;
  });

  try {
    const sandboxExpect = await app.evaluate(() => {
      const flagTruthy = (name: string): boolean => {
        const v = process.env[name];
        if (typeof v !== 'string') return false;
        const s = v.trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'yes' || s === 'on';
      };

      if (flagTruthy('PARA_DISABLE_SANDBOX')) return false;
      if (flagTruthy('PARA_FORCE_SANDBOX')) return true;

      if (process.platform === 'linux') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          const uid = typeof process.getuid === 'function' ? process.getuid() : null;
          if (uid === 0) return false;
        } catch {
        }
      }
      return true;
    });

    const sandboxed = await app.evaluate(({ app }) => {
      const a = app as unknown as { isSandboxed?: () => boolean };
      return typeof a.isSandboxed === 'function' ? a.isSandboxed() : null;
    });
    if (sandboxed !== null) {
      expect(sandboxed).toBe(sandboxExpect);
    }

    const webPrefs = await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      return wins.map((w) => {
        const prefs = (w.webContents as unknown as { getLastWebPreferences?: () => unknown }).getLastWebPreferences?.();
        return prefs;
      });
    });

    expect(Array.isArray(webPrefs)).toBe(true);
    expect(webPrefs.length).toBeGreaterThanOrEqual(2);
    for (const prefs of webPrefs) {
      const p = prefs as any;
      expect(p?.contextIsolation).toBe(true);
      expect(p?.nodeIntegration).toBe(false);
      expect(p?.sandbox).toBe(sandboxExpect);
      expect(p?.webviewTag).toBe(false);
      expect(Boolean(p?.spellcheck)).toBe(false);
      expect(Boolean(p?.navigateOnDragDrop)).toBe(false);
      expect(p?.webSecurity ?? true).toBe(true);
      expect(p?.allowRunningInsecureContent ?? false).toBe(false);
      expect(Boolean(p?.devTools)).toBe(false);
    }

    const page = await getDebugPanelPage(app);

    const initialWindowCount = await waitForStableWindowCount(app);
    trackNewWindows = true;
    newWindowCount = 0;

    const initialHref = await page.evaluate(() => window.location.href);

    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });

    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as Record<string, unknown>;
      const existing = g.__e2eOpenExternalCalls;
      if (Array.isArray(existing)) {
        existing.length = 0;
        return;
      }

      const calls: string[] = [];
      const orig = shell.openExternal;

      (shell as unknown as { openExternal: (url: string) => Promise<boolean> }).openExternal = async (url: string) => {
        calls.push(String(url));
        return true;
      };

      g.__e2eOpenExternalCalls = calls;
      g.__e2eRestoreOpenExternal = () => {
        (shell as unknown as { openExternal: unknown }).openExternal = orig;
      };
    });

    const cases = [
      { name: 'javascript', url: 'javascript:alert(1)' },
      { name: 'file', url: 'file:///etc/passwd' },
      { name: 'https-not-allowlisted', url: 'https://evil.example' }
    ];

    const navigateCases = [
      { name: 'navigate-file', url: 'file:///etc/passwd' },
      { name: 'navigate-https-not-allowlisted', url: 'https://evil.example' }
    ];

    const evidenceLines: string[] = [];

    for (const tc of cases) {
      newWindowCount = 0;
      const baselineWindowCount = app.windows().length;

      const beforeExternalCalls = await app.evaluate(() => {
        const g = globalThis as unknown as Record<string, unknown>;
        const calls = g.__e2eOpenExternalCalls;
        return Array.isArray(calls) ? calls.length : -1;
      });

      const opened = await page.evaluate((targetUrl) => {
        const w = window.open(targetUrl);
        return w !== null;
      }, tc.url);

      await new Promise((r) => setTimeout(r, 500));

      const afterExternalCalls = await app.evaluate(() => {
        const g = globalThis as unknown as Record<string, unknown>;
        const calls = g.__e2eOpenExternalCalls;
        return Array.isArray(calls) ? calls.length : -1;
      });

      const deltaExternalCalls = afterExternalCalls - beforeExternalCalls;
      const currentWindowCount = app.windows().length;

      expect(opened).toBe(false);
      expect(newWindowCount).toBe(0);
      expect(currentWindowCount).toBe(baselineWindowCount);
      expect(deltaExternalCalls).toBe(0);
      expect(dialogs.length).toBe(0);

      evidenceLines.push(
        [
          `case=open:${tc.name}`,
          `opened=${opened}`,
          `newWindows=${newWindowCount}`,
          `windowCount=${currentWindowCount}`,
          `externalCallsDelta=${deltaExternalCalls}`,
          `hrefSame=true`
        ].join('\t')
      );
    }

    for (const tc of navigateCases) {
      newWindowCount = 0;
      const baselineWindowCount = app.windows().length;

      const beforeExternalCalls = await app.evaluate(() => {
        const g = globalThis as unknown as Record<string, unknown>;
        const calls = g.__e2eOpenExternalCalls;
        return Array.isArray(calls) ? calls.length : -1;
      });

      await page.evaluate((targetUrl) => {
        window.location.href = targetUrl;
      }, tc.url);

      await new Promise((r) => setTimeout(r, 800));

      const afterExternalCalls = await app.evaluate(() => {
        const g = globalThis as unknown as Record<string, unknown>;
        const calls = g.__e2eOpenExternalCalls;
        return Array.isArray(calls) ? calls.length : -1;
      });

      const href = await page.evaluate(() => window.location.href);
      const hrefSame = href === initialHref;
      const deltaExternalCalls = afterExternalCalls - beforeExternalCalls;
      const currentWindowCount = app.windows().length;

      expect(hrefSame).toBe(true);
      expect(newWindowCount).toBe(0);
      expect(currentWindowCount).toBe(baselineWindowCount);
      expect(deltaExternalCalls).toBe(0);
      expect(dialogs.length).toBe(0);

      evidenceLines.push(
        [
          `case=navigate:${tc.name}`,
          `opened=false`,
          `newWindows=${newWindowCount}`,
          `windowCount=${currentWindowCount}`,
          `externalCallsDelta=${deltaExternalCalls}`,
          `hrefSame=${hrefSame}`
        ].join('\t')
      );
    }

    const evidencePath = getEvidencePath();
    await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.promises.writeFile(evidencePath, `${evidenceLines.join('\n')}\n`, 'utf8');
    expect(fs.existsSync(evidencePath)).toBeTruthy();

    expect(initialWindowCount).toBeGreaterThanOrEqual(2);
  } finally {
    await app.evaluate(() => {
      const g = globalThis as unknown as Record<string, unknown>;
      const restore = g.__e2eRestoreOpenExternal;
      if (typeof restore === 'function') {
        restore();
      }
    });
    await app.close();
  }
});

test('Electron security: reject IPC from untrusted window (data:)', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  });

  try {
    const page = await getDebugPanelPage(app);

    const trustedRes = await page.evaluate(async () => {
      const api = (globalThis as unknown as {
        desktopApi?: { plugins?: { getStatus?: () => Promise<unknown> } };
      }).desktopApi;
      const fn = api?.plugins?.getStatus;
      if (typeof fn !== 'function') return { ok: false, err: 'NO_DESKTOP_API' };
      try {
        const v = await fn();
        return { ok: true, v };
      } catch (err: any) {
        return { ok: false, err: String(err?.message || err) };
      }
    });
    expect(trustedRes.ok).toBe(true);
    const trustedV = (trustedRes as any).v;
    expect(typeof trustedV).toBe('object');
    expect(trustedV).not.toBeNull();
    expect(typeof (trustedV as any).enabled).toBe('boolean');
    expect(Array.isArray((trustedV as any).menuItems)).toBe(true);

    const preloadPath = path.resolve(process.cwd(), 'dist/preload/index.js');
    expect(fs.existsSync(preloadPath)).toBeTruthy();

    await app.evaluate(({ BrowserWindow }, passedPreloadPath) => {
      const preloadPathStr = typeof passedPreloadPath === 'string' ? passedPreloadPath : '';
      if (preloadPathStr === '') throw new Error('E2E_PRELOAD_PATH_EMPTY');
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          preload: preloadPathStr
        }
      });
      void w.loadURL('data:text/html,<html><body>untrusted</body></html>');
    }, preloadPath);

    const pages = await waitForWindows(app, 3);
    const untrusted = pages.find((p) => p.url().startsWith('data:')) ?? pages[pages.length - 1]!;
    await untrusted.waitForURL(/^data:/, { timeout: 10_000 });
    await untrusted.waitForLoadState('domcontentloaded', { timeout: 10_000 });
    await untrusted.waitForFunction(
      () => {
        const api = (globalThis as any).desktopApi;
        return Boolean(api?.plugins?.getStatus);
      },
      { timeout: 10_000 }
    );

    const res = await untrusted.evaluate(async () => {
      const api = (globalThis as unknown as {
        desktopApi?: { plugins?: { getStatus?: () => Promise<unknown> } };
      }).desktopApi;
      const fn = api?.plugins?.getStatus;
      if (typeof fn !== 'function') return { ok: false, err: 'NO_DESKTOP_API' };
      try {
        const v = await fn();
        return { ok: true, v };
      } catch (err: any) {
        return { ok: false, err: String(err?.message || err) };
      }
    });

    expect(res.ok).toBe(false);
    expect(String((res as any).err || '')).toContain('UNTRUSTED_IPC_SENDER');
  } finally {
    await app.close();
  }
});
