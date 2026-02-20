import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Locator, Page } from 'playwright';

import electronPath from 'electron';

import { TEST_IDS } from '../src/renderer/app/testIds';

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

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return;
    try {
      el.blur();
    } catch {
    }
  });
}

async function locatorIsFocused(locator: Locator): Promise<boolean> {
  try {
    return await locator.evaluate((el) => el === document.activeElement);
  } catch {
    return false;
  }
}

async function tabUntilFocused(page: Page, locator: Locator, maxTabs: number): Promise<void> {
  for (let i = 0; i < maxTabs; i += 1) {
    if (await locatorIsFocused(locator)) return;
    await page.keyboard.press('Tab');
  }

  await expect(locator).toBeFocused({ timeout: 1_000 });
}

async function expectFocusVisible(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    try {
      return el.matches(':focus-visible');
    } catch {
      return false;
    }
  });

  expect(ok).toBeTruthy();
}

type AnonymousIconButtonHit = {
  tag: string;
  testId: string | null;
  className: string;
  ariaLabel: string | null;
  ariaLabelledBy: string | null;
  title: string | null;
  text: string;
};

async function findAnonymousIconButtons(page: Page): Promise<AnonymousIconButtonHit[]> {
  return await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const e = el as HTMLElement;
      const style = window.getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = e.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const nodes = Array.from(document.querySelectorAll('button,[role="button"]'));

    const hits: AnonymousIconButtonHit[] = [];
    for (const n of nodes) {
      if (!isVisible(n)) continue;
      const el = n as HTMLElement;

      const text = (el.textContent ?? '').trim();
      if (text !== '') continue;

      const hasIcon = Boolean(el.querySelector('svg, img'));
      if (!hasIcon) continue;

      const ariaLabel = el.getAttribute('aria-label');
      const ariaLabelledBy = el.getAttribute('aria-labelledby');
      const title = el.getAttribute('title');

      const hasName =
        (typeof ariaLabel === 'string' && ariaLabel.trim() !== '') ||
        (typeof title === 'string' && title.trim() !== '') ||
        (typeof ariaLabelledBy === 'string' && ariaLabelledBy.trim() !== '');

      if (hasName) continue;

      hits.push({
        tag: el.tagName.toLowerCase(),
        testId: el.getAttribute('data-testid'),
        className: el.className || '',
        ariaLabel,
        ariaLabelledBy,
        title,
        text
      });
    }

    return hits;
  });
}

async function expectNoAnonymousIconButtons(page: Page): Promise<void> {
  const hits = await findAnonymousIconButtons(page);
  if (hits.length === 0) return;
  throw new Error(`E2E_A11Y_ANONYMOUS_ICON_BUTTONS\n${JSON.stringify(hits, null, 2)}`);
}

test('Electron a11y baseline: keyboard usable + focus-visible + icon-only buttons have accessible names', async () => {
  const mainEntry = path.resolve(process.cwd(), 'dist/main/index.js');
  expect(fs.existsSync(mainEntry)).toBeTruthy();

  const env = { ...process.env, NODE_ENV: 'test' };
  delete (env as any).PARA_LABS;

  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [mainEntry],
    env
  });

  try {
    const page = await getDebugPanelPage(app);

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
    } catch {
    }

    await page.evaluate(() => {
      window.location.hash = '#/login';
    });
    await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible({ timeout: 15_000 });

    await blurActiveElement(page);
    await tabUntilFocused(page, page.getByTestId(TEST_IDS.loginEmail), 40);
    await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeFocused();
    await expectFocusVisible(page);

    await page.keyboard.press('Tab');
    await expect(page.getByTestId(TEST_IDS.loginPassword)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId(TEST_IDS.loginSubmit)).toBeFocused();

    await expectNoAnonymousIconButtons(page);

    await page.evaluate(() => {
      window.location.hash = '#/chat';
    });
    await expect(page.getByTestId(TEST_IDS.chatInput)).toBeVisible({ timeout: 15_000 });
    await blurActiveElement(page);
    await tabUntilFocused(page, page.getByTestId(TEST_IDS.chatInput), 60);
    await expect(page.getByTestId(TEST_IDS.chatInput)).toBeFocused();
    await expectFocusVisible(page);
    await expectNoAnonymousIconButtons(page);

    await page.evaluate(() => {
      window.location.hash = '#/settings';
    });
    await expect(page.getByTestId(TEST_IDS.userDataCard)).toBeVisible({ timeout: 15_000 });
    await blurActiveElement(page);
    await tabUntilFocused(page, page.getByTestId(TEST_IDS.updateCheck), 80);
    await expect(page.getByTestId(TEST_IDS.updateCheck)).toBeFocused();
    await expectFocusVisible(page);
    await expectNoAnonymousIconButtons(page);

    await page.evaluate(() => {
      window.location.hash = '#/plugins';
    });
    await expect(page.getByTestId(TEST_IDS.pluginsCard)).toBeVisible({ timeout: 15_000 });
    await blurActiveElement(page);
    await tabUntilFocused(page, page.getByTestId(TEST_IDS.pluginsToggle), 80);
    await expect(page.getByTestId(TEST_IDS.pluginsToggle)).toBeFocused();
    await expectFocusVisible(page);
    await expectNoAnonymousIconButtons(page);

    await page.evaluate(() => {
      window.location.hash = '#/login';
    });
    await expect(page.getByTestId(TEST_IDS.loginEmail)).toBeVisible({ timeout: 15_000 });
    await blurActiveElement(page);
    await tabUntilFocused(page, page.getByTestId(TEST_IDS.loginEmail), 40);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId(TEST_IDS.loginSubmit)).toBeFocused();

    const evidencePath = path.resolve(process.cwd(), '..', '.sisyphus', 'evidence', 'task-17-a11y.png');
    await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
    await page.screenshot({ path: evidencePath, fullPage: true });
    expect(fs.existsSync(evidencePath)).toBeTruthy();
  } finally {
    await app.close();
  }
});
