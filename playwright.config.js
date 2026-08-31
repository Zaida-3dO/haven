/**
 * Browser tests — the half of Haven the unit tests structurally cannot reach.
 *
 * The web suite runs against a hand-rolled fake DOM (`web/test/helpers/fake-dom.js`),
 * which is the right call for unit tests: a failure points at the shell rather
 * than at a DOM emulation. What it cannot do is prove the app works in a
 * browser. GridStack is never loaded there at all — its published ESM uses
 * extensionless imports that Node will not resolve — so every rule the grid
 * enforces is currently asserted only in the pure layer beside it.
 *
 * This config runs the real thing: a real server, a real Vite build, real
 * GridStack, real pointer events. It is deliberately NOT part of `npm test` —
 * it needs a browser download and a built bundle, and folding it in would slow
 * the unit suite that every commit runs. It has its own script and its own CI
 * job.
 *
 * Determinism over sleeping: there is not a single fixed wait in the suite.
 * Everything waits on an observable condition (an element, a class, a network
 * response), because a flaky browser test is worse than no browser test.
 */

import { defineConfig, devices } from '@playwright/test';

/** The port the test server binds. Fixed so the webServer URL can match it. */
const PORT = Number(process.env.HAVEN_E2E_PORT ?? 8171);

export default defineConfig({
  testDir: './web/e2e',
  // A browser test that only passes sometimes is worse than no browser test,
  // so a retry is a signal to fix the test, not a way to get green. CI gets
  // one retry to absorb runner noise; locally, none.
  retries: process.env.CI ? 1 : 0,
  // The suite drives one shared server, and several specs mutate the saved
  // layout. Running them in parallel would have them racing over one SQLite
  // row, which is a source of flake rather than of speed.
  workers: 1,
  fullyParallel: false,
  // Nothing may be committed with `test.only` left in it.
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The full Chromium build rather than the headless shell: the shell is
        // a separate download and this suite exercises drag and resize, which
        // want a complete browser. Headless still, so it runs on a CI runner
        // with no display.
        channel: 'chromium',
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],

  /**
   * The real server, not a mock: `node server/src/index.js`, exactly what the
   * container runs.
   *
   * Two things are deliberate. The database is a temp file created per run by
   * `web/e2e/server.js`, so a test that saves a layout never touches a real
   * one. And NO connector credentials are set — every connector renders its
   * "not configured" tile, which is precisely the state a fresh deployment
   * shows and therefore worth pinning.
   */
  webServer: {
    command: `node web/e2e/server.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
