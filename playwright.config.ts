import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.VANTAGE_BROWSER_PORT || 8797);

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node tests/browser/server.ts`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VANTAGE_BROWSER_PORT: String(port) },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: undefined } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
});
