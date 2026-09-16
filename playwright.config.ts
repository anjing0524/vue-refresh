import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  use: {
    baseURL: 'http://127.0.0.1:4174', headless: true,
    channel: process.env.PW_CHANNEL === 'bundled' ? undefined : process.env.PW_CHANNEL ?? 'chrome',
  },
  webServer: {
    command: 'pnpm dev --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
