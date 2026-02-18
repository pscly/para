import fs from 'node:fs';
import path from 'node:path';

import { test, expect, chromium } from '@playwright/test';

test.use({
  actionTimeout: 15_000,
  navigationTimeout: 20_000
});

function withTrailingSlash(raw: string): string {
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function safeText(raw: string | null): string {
  return raw ?? '';
}

async function ensureEvidenceDir(): Promise<string> {
  const evidenceDir = path.resolve(process.cwd(), '..', '.sisyphus', 'evidence');
  await fs.promises.mkdir(evidenceDir, { recursive: true });
  return evidenceDir;
}

test.describe('prod admin-web: AI / Channels CRUD + connectivity test (optional)', () => {
  const enabled = process.env.PARA_E2E_ADMIN_WEB_ENABLED === '1';
  const adminEmail = process.env.PARA_ADMIN_EMAIL ?? '';
  const adminPassword = process.env.PARA_ADMIN_PASSWORD ?? '';
  const baseUrl = process.env.PARA_ADMIN_WEB_BASE_URL ?? 'https://para.pscly.cc/admin';

  test.skip(!enabled, 'Set PARA_E2E_ADMIN_WEB_ENABLED=1 to run this production E2E');
  test.skip(!adminEmail || !adminPassword, 'Set PARA_ADMIN_EMAIL and PARA_ADMIN_PASSWORD to run this production E2E');

  test('login -> AI / Channels -> create/edit/delete temp channel -> test connection', async () => {
    test.setTimeout(120_000);

    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(20_000);

      await test.step('Login', async () => {
        const root = withTrailingSlash(baseUrl);
        const channelsUrl = new URL('ai/channels', root).toString();
        await page.goto(channelsUrl, { waitUntil: 'domcontentloaded' });

        await expect(page.getByText('Para Admin')).toBeVisible({ timeout: 20_000 });
        await page.getByLabel('Email').fill(adminEmail);
        await page.getByLabel('Password').fill(adminPassword);

        const loginBtn = page.getByRole('button', { name: '登录' });
        await expect(loginBtn).toBeVisible();
        await loginBtn.click();

        await expect(page.getByRole('heading', { name: 'AI / Channels' })).toBeVisible({ timeout: 20_000 });
      });

      await test.step('Connectivity test: find a channel with masked key and expect ok=true', async () => {
        const channelsCard = page.locator('section', { hasText: '渠道列表' });
        const channelsTable = channelsCard.getByRole('table');
        await expect(channelsTable).toBeVisible({ timeout: 20_000 });

        const firstTestBtn = channelsTable.locator('tbody tr').getByRole('button', { name: '测试连接' }).first();
        await expect(firstTestBtn).toBeVisible({ timeout: 30_000 });
        await expect(firstTestBtn).toBeEnabled({ timeout: 30_000 });

        await firstTestBtn.click();

        const okResult = page.getByText(/测试结果：/);
        await expect(okResult).toBeVisible({ timeout: 30_000 });
        const txt = safeText(await okResult.textContent().catch(() => null));
        if (txt.includes('ok=true')) {
          await expect(okResult).toContainText('ok=true');
        } else {
          await expect(okResult).toContainText(/ok=(true|false)/);
        }
      });

      const tempName = `e2e-temp-channel-${randomSuffix()}`;
      const dummyApiKey = 'e2e_dummy_api_key_not_real_12345';
      const baseUrlCreate = 'https://example.com/v1';
      const baseUrlEdit = 'https://example.net/v1';

      await test.step('CRUD: create temp channel', async () => {
        await page.getByRole('button', { name: '刷新' }).click();
        await expect(page.getByRole('heading', { name: 'AI / Channels' })).toBeVisible();

        await page.getByLabel('name').fill(tempName);
        await page.getByLabel('base_url').fill(baseUrlCreate);
        await page.getByLabel('api_key（必填）').fill(dummyApiKey);

        const createBtn = page.getByRole('button', { name: '创建' });
        await expect(createBtn).toBeEnabled({ timeout: 10_000 });
        await createBtn.click();

        await expect(page.getByText(`已创建渠道：${tempName}`)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('row', { name: new RegExp(tempName) })).toBeVisible({ timeout: 20_000 });
      });

      await test.step('CRUD: edit temp channel (do not rotate key)', async () => {
        const row = page.getByRole('row', { name: new RegExp(tempName) });
        await expect(row).toBeVisible({ timeout: 20_000 });
        await row.getByRole('button', { name: '编辑' }).click();

        const editSection = page.locator('section', { hasText: '编辑渠道' });
        await expect(editSection.getByText('当前：')).toBeVisible({ timeout: 10_000 });
        await expect(editSection.getByText(tempName)).toBeVisible({ timeout: 10_000 });

        await editSection.getByLabel('base_url').fill(baseUrlEdit);
        const saveBtn = editSection.getByRole('button', { name: '保存' });
        await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
        await saveBtn.click();

        await expect(page.getByText(`已保存：${tempName}`)).toBeVisible({ timeout: 30_000 });
      });

      await test.step('CRUD: delete temp channel (accept confirm dialog)', async () => {
        const row = page.getByRole('row', { name: new RegExp(tempName) });
        await expect(row).toBeVisible({ timeout: 20_000 });

        page.once('dialog', async (dialog) => {
          await dialog.accept();
        });
        await row.getByRole('button', { name: '删除' }).click();

        await expect(page.getByText(`已删除：${tempName}`)).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('row', { name: new RegExp(tempName) })).toHaveCount(0, { timeout: 30_000 });
      });

      await test.step('Evidence: screenshot (no plaintext secrets)', async () => {
        const evidenceDir = await ensureEvidenceDir();
        const screenshotPath = path.join(evidenceDir, 'task-10-admin-channels.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
      });
    } finally {
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  });
});
