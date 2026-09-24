import { defineConfig, devices } from '@playwright/test';

// End-to-end tests that play the game in real (Chromium) browsers emulating phones
// and a desktop. Run `npm run test:e2e` (first time: `npx playwright install chromium`).
//
// There's no GPU in CI, so WebGL runs on SwiftShader and the game renders at a few
// frames a second at best. The tests therefore drive the UI with real touch input but
// fast-forward the simulation when they're waiting on a puppy (see e2e/helpers.ts).

const chromium = { browserName: 'chromium' as const };

export default defineConfig({
  testDir: 'e2e',
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4178',
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
    screenshot: 'only-on-failure',
  },
  // test the production build (what gets deployed), served on its own port
  webServer: {
    command: 'npx vite build && npx vite preview --host 127.0.0.1 --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], ...chromium } },
    { name: 'iphone-landscape', use: { ...devices['iPhone 13 landscape'], ...chromium } },
    { name: 'small-phone', use: { ...devices['iPhone SE'], ...chromium } },
    { name: 'android', use: { ...devices['Pixel 7'], ...chromium } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
});
