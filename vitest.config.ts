import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Root vitest config. Vitest's default discovery scans the entire repo,
// including `.claude/worktrees/` (agent checkouts), which once put
// `pnpm test` at 3,673 test files. Discovery is scoped to three roots below,
// and the excludes keep build output and the Playwright specs out of them.
export default defineConfig({
  // Same transform as the shipping renderer (electron.vite.config.ts), so component
  // tests exercise the compiled output.
  plugins: [react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'renderer-react/src'),
      '@omnidex/types': resolve(__dirname, 'shared/types'),
      // Unit tests must not require the real Electron binary (CI installs with
      // --ignore-scripts, so it isn't downloaded). Pure-logic modules pull in
      // `electron` only for app.getPath(...); the stub satisfies that. The real
      // app build (electron-vite) is unaffected.
      electron: resolve(__dirname, 'electron/test-stubs/electron.ts'),
    },
  },
  test: {
    // Three test homes: the React renderer, the shared type/util layer, and
    // the Electron main process. Don't add a `**/src/**` exclude — it would
    // swallow `renderer-react/src/**` and silently drop every renderer test.
    include: [
      'renderer-react/src/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'shared/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'electron/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist-installer*/**',
      '**/out/**',
      '**/.claude/**',
      '**/tests/**', // Playwright E2E
      '**/test-results/**',
      '**/playwright-report/**',
      '**/coverage/**',
    ],
    environment: 'jsdom',
    globals: true,
    // A real React unit suite now exists — fail loudly if discovery breaks.
    passWithNoTests: false,
    // Cap worker count so a runaway test doesn't pin all cores.
    // Vitest 4 moved per-pool options to the top level.
    pool: 'threads',
    maxWorkers: 4,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // Scope coverage to the modules under test so the headline number is an
      // honest reflection of *tested* code, not diluted by the entire app
      // (views, IPC wiring, native bindings) that this suite doesn't claim.
      include: [
        'shared/types/errors.ts',
        'electron/main/db/repos/assets.ts',
        'electron/main/db/repos/row-helpers.ts',
        'renderer-react/src/lib/format.ts',
        'renderer-react/src/lib/assetUrl.ts',
        'renderer-react/src/lib/cn.ts',
        'renderer-react/src/stores/ui.ts',
        'renderer-react/src/hooks/useHotkey.ts',
      ],
      // Gate set comfortably below the current actuals (lines ~99%, stmts ~97%,
      // funcs 100%, branch ~93%) so CI fails on a real regression, not noise.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 95,
        lines: 90,
      },
    },
  },
});
