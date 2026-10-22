import { defineConfig } from '@playwright/test';

/**
 * Electron E2E config.
 *
 * `workers: 1` is not a performance preference, it is a correctness
 * requirement. Every spec launches the built app, and `app.setName('omnidex')`
 * pins all of them to the same userData directory and the same SQLite file. A
 * second concurrent launch dies with "electron.launch: Process failed to
 * launch!".
 *
 * Until this file existed Playwright used its default worker count, so whether
 * the suite passed depended on how many spec files you happened to select —
 * one spec passed, three specs failed two of them. Any spec run in isolation
 * looked healthy, which made the failures read as flakes.
 *
 * `globalSetup` makes sure the @omnidex/uasset binary exists before any spec
 * launches Electron, whichever way Playwright was started.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  // Launch + first paint against the real library is comfortably under 30s;
  // 60 leaves room for a cold native-module load.
  timeout: 60_000,
  reporter: 'list',
});
