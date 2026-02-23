import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

function getEvidencePath(): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'task-14-pet.png');
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

async function getWindowLocationSearch(page: Page): Promise<string> {
  if (page.isClosed()) return '';

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 1_000 });
  } catch {
  }

  try {
    const s = await page.evaluate(() => window.location.search);
    return typeof s === 'string' ? s : '';
  } catch {
    return '';
  }
}

async function getPetPage(app: ElectronApplication): Promise<Page> {
  const pages = await waitForWindows(app, 1);

  for (const page of pages) {
    const search = await getWindowLocationSearch(page);
    if (search.includes('window=pet')) return page;
  }

  await expect
    .poll(
      async () => {
        const p = app.windows();
        for (const page of p) {
          const search = await getWindowLocationSearch(page);
          if (search.includes('window=pet')) return true;
        }
        return false;
      },
      { timeout: 10_000 }
    )
    .toBe(true)
    .catch(() => {
    });

  const pages2 = app.windows();
  for (const page of pages2) {
    const search = await getWindowLocationSearch(page);
    if (search.includes('window=pet')) return page;
  }

  let bestPage: Page = pages2[0] ?? pages[0]!;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const page of pages2) {
    const width = await getWindowInnerWidth(page);
    if (width > 0 && width < bestWidth) {
      bestWidth = width;
      bestPage = page;
    }
  }
  return bestPage;
}

type PetBounds = { x: number; y: number; width: number; height: number };

function isFiniteBounds(b: unknown): b is PetBounds {
  if (typeof b !== 'object' || b === null) return false;
  const bb = b as Partial<Record<keyof PetBounds, unknown>>;
  return (
    typeof bb.x === 'number' &&
    Number.isFinite(bb.x) &&
    typeof bb.y === 'number' &&
    Number.isFinite(bb.y) &&
    typeof bb.width === 'number' &&
    Number.isFinite(bb.width) &&
    typeof bb.height === 'number' &&
    Number.isFinite(bb.height)
  );
}

async function getPetBounds(petPage: Page): Promise<PetBounds> {
  const b = await petPage.evaluate(async () => {
    const api = (window as any).desktopApi;
    if (!api?.pet?.getBounds) throw new Error('E2E_NO_DESKTOPAPI_PET_GET_BOUNDS');
    return await api.pet.getBounds();
  });
  if (!isFiniteBounds(b)) throw new Error('E2E_BAD_PET_BOUNDS');
  return b;
}

async function setPetBounds(petPage: Page, bounds: PetBounds): Promise<void> {
  await petPage.evaluate(async (b) => {
    const api = (window as any).desktopApi;
    if (!api?.pet?.setBounds) throw new Error('E2E_NO_DESKTOPAPI_PET_SET_BOUNDS');
    await api.pet.setBounds(b);
  }, bounds);
}

async function readPersistedPetBounds(userDataDir: string): Promise<PetBounds | null> {
  const configPath = path.join(userDataDir, 'para.ui.json');
  let raw = '';
  try {
    raw = await fs.promises.readFile(configPath, { encoding: 'utf8' });
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as { version?: unknown; petWindowBounds?: unknown };
  if (rec.version !== 1) return null;
  const b = rec.petWindowBounds;
  return isFiniteBounds(b) ? b : null;
}

test('Electron pet UI: sprite click opens radial menu and enters chat', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const launchArgs = [mainEntry];
  if (process.env.CI) {
    launchArgs.push('--no-sandbox', '--disable-gpu');
  }

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: launchArgs,
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  });

  try {
    const petPage = await getPetPage(app);

    const petWinInfo = await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      if (!wins.length) {
        return {
          found: false,
          // title 不可靠：渲染进程可能会覆盖 document.title，从而影响窗口 title 的定位逻辑。
          title: null as string | null,
          alwaysOnTop: null as boolean | null,
          bounds: null as { width: number; height: number; x: number; y: number } | null,
          isVisible: null as boolean | null,
          isFocused: null as boolean | null,
          windowCount: 0
        };
      }

      // 两个窗口都会加载同一个 index.html，用 title 查找不稳定；改用 bounds 选面积最小的窗口作为桌宠窗口。
      const withBounds = wins
        .map((w) => {
          const b = w.getBounds();
          const width = typeof b.width === 'number' ? b.width : 0;
          const height = typeof b.height === 'number' ? b.height : 0;
          const area = width > 0 && height > 0 ? width * height : Number.POSITIVE_INFINITY;
          return {
            w,
            b,
            width,
            height,
            area
          };
        })
        .sort((a, b) => a.area - b.area);

      const chosen = withBounds[0];
      if (!chosen) {
        return {
          found: false,
          title: null as string | null,
          alwaysOnTop: null as boolean | null,
          bounds: null as { width: number; height: number; x: number; y: number } | null,
          isVisible: null as boolean | null,
          isFocused: null as boolean | null,
          windowCount: wins.length
        };
      }

      const win = chosen.w;

      win.setIgnoreMouseEvents(false);
      win.show();
      win.focus();

      const b = win.getBounds();
      return {
        found: true,
        title: win.getTitle(),
        alwaysOnTop: typeof win.isAlwaysOnTop === 'function' ? win.isAlwaysOnTop() : null,
        bounds: { width: b.width, height: b.height, x: b.x, y: b.y },
        isVisible: win.isVisible(),
        isFocused: win.isFocused(),
        windowCount: wins.length
      };
    });

    expect(petWinInfo.found).toBe(true);
    expect(petWinInfo.bounds?.width ?? 0).toBeGreaterThan(0);
    expect(petWinInfo.bounds?.height ?? 0).toBeGreaterThan(0);
    if (petWinInfo.alwaysOnTop !== null) {
      expect(petWinInfo.alwaysOnTop).toBe(true);
    }

    const sprite = petPage.locator('[data-testid="pet-sprite"]');
    await expect(sprite).toBeVisible({ timeout: 10_000 });
    await sprite.click();

    const radialMenu = petPage.locator('[data-testid="pet-radial-menu"]');
    await expect(radialMenu).toBeVisible({ timeout: 5_000 });

    const chatItem = petPage.locator('[data-testid="pet-menu-item-chat"]');
    await expect(chatItem).toBeVisible({ timeout: 5_000 });
    await chatItem.click();

    const evidencePath = getEvidencePath();
    await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
    await petPage.screenshot({ path: evidencePath, fullPage: true });
    expect(fs.existsSync(evidencePath)).toBeTruthy();
  } finally {
    await app.close();
  }
});

test('Electron pet UI: drag handle moves window and bounds persist across restart', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-userdata-'));
  const xdgConfigHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'para-e2e-xdg-config-'));

  const launchArgs = [mainEntry];
  if (process.env.CI) {
    launchArgs.push('--no-sandbox', '--disable-gpu');
  }

  let movedBounds: PetBounds | null = null;
  let persistedBounds: PetBounds | null = null;

  const app1 = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: launchArgs,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PARA_USER_DATA_DIR: userDataDir,
      XDG_CONFIG_HOME: xdgConfigHome
    }
  });

  try {
    const petPage = await getPetPage(app1);
    await petPage.bringToFront();
    await expect(petPage.getByTestId('pet-drag-handle')).toBeVisible({ timeout: 15_000 });

    await setPetBounds(petPage, { x: 200, y: 200, width: 260, height: 260 });
    await expect
      .poll(
        async () => {
          const b = await getPetBounds(petPage);
          return Math.abs(b.x - 200) + Math.abs(b.y - 200);
        },
        { timeout: 15_000 }
      )
      .toBeLessThan(30);

    const before = await getPetBounds(petPage);

    const handle = petPage.getByTestId('pet-drag-handle');
    const box = await handle.boundingBox();
    if (!box) throw new Error('E2E_NO_PET_DRAG_HANDLE_BOX');

    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height / 2;

    await petPage.mouse.move(fromX, fromY);
    await petPage.mouse.down();
    await petPage.mouse.move(fromX + 140, fromY + 90, { steps: 8 });
    await petPage.mouse.up();

    await expect
      .poll(async () => {
        const b = await getPetBounds(petPage);
        return Math.abs(b.x - before.x) + Math.abs(b.y - before.y);
      })
      .toBeGreaterThan(20);

    movedBounds = await getPetBounds(petPage);

    await expect
      .poll(
        async () => {
          persistedBounds = await readPersistedPetBounds(userDataDir);
          if (!persistedBounds) return 0;
          return Math.abs(persistedBounds.x - before.x) + Math.abs(persistedBounds.y - before.y);
        },
        { timeout: 15_000 }
      )
      .toBeGreaterThan(10);
  } finally {
    await app1.close();
  }

  if (!movedBounds) throw new Error('E2E_NO_MOVED_BOUNDS');
  if (!persistedBounds) throw new Error('E2E_NO_PERSISTED_BOUNDS');

  const app2 = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: launchArgs,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PARA_USER_DATA_DIR: userDataDir,
      XDG_CONFIG_HOME: xdgConfigHome
    }
  });

  try {
    const petPage2 = await getPetPage(app2);
    await petPage2.bringToFront();
    await expect(petPage2.getByTestId('pet-drag-handle')).toBeVisible({ timeout: 15_000 });

    await expect
      .poll(async () => {
        const b = await getPetBounds(petPage2);
        const dx = Math.abs(b.x - persistedBounds!.x);
        const dy = Math.abs(b.y - persistedBounds!.y);
        return dx + dy;
      }, { timeout: 15_000 })
      .toBeLessThan(120);
  } finally {
    await app2.close();
    try {
      await fs.promises.rm(userDataDir, { recursive: true, force: true });
    } catch {
    }
    try {
      await fs.promises.rm(xdgConfigHome, { recursive: true, force: true });
    } catch {
    }
  }
});
