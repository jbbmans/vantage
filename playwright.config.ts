import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const port = Number(process.env.VANTAGE_BROWSER_PORT || 8797);
// Some hosts pre-install a Chromium at a fixed path; use it instead of downloading one that matches the package version.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: `node tests/browser/server.ts`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VANTAGE_BROWSER_PORT: String(port) },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: undefined }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
});
