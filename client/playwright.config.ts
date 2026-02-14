import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './playwright',
  outputDir: './playwright-results',
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  use: {
    screenshot: 'off'
  }
});
