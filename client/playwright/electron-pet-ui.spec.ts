import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import electronPath from 'electron';

function getEvidencePath(): string {
  return path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'task-10-pet-ui.png');
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

test('Electron pet UI: sprite click opens radial menu and enters chat', async () => {
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
