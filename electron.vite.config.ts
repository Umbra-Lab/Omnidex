import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Copies main-process SQL/asset files that Rollup does not bundle.
const copyMainAssetsPlugin = () => ({
  name: 'omnidex:copy-main-assets',
  closeBundle() {
    const src = resolve(__dirname, 'electron/main/db/migrations');
    const dest = resolve(__dirname, 'out/main/migrations');
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
  },
});

const SHARED_TYPES = resolve(__dirname, 'shared/types');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMainAssetsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') },
        output: { format: 'es', entryFileNames: '[name].mjs' },
      },
    },
    resolve: {
      alias: {
        '@omnidex/types': SHARED_TYPES,
      },
    },
  },
  preload: {
    // Sandboxed preloads can only `require` a small whitelist (electron, path,
    // events, timers, url) plus anything bundled into the script. Everything
    // we use from npm — electron-trpc here — must be bundled, not externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-trpc'] })],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    resolve: {
      alias: {
        '@omnidex/types': SHARED_TYPES,
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer-react'),
    // The React Compiler is a Babel plugin, which plugin-react-swc cannot run.
    plugins: [react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'renderer-react/src'),
        '@omnidex/types': SHARED_TYPES,
      },
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer-react'),
      emptyOutDir: true,
      sourcemap: true,
      cssMinify: 'esbuild' as const,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        input: { index: resolve(__dirname, 'renderer-react/index.html') },
        output: {
          manualChunks: (id: string) => {
            if (id.includes('node_modules/@tanstack/')) return 'tanstack';
            if (id.includes('node_modules/@radix-ui/')) return 'radix';
            if (id.includes('node_modules/motion/') || id.includes('node_modules/framer-motion/'))
              return 'motion';
            if (id.includes('node_modules/react-aria') || id.includes('node_modules/@react-aria/'))
              return 'aria';
            if (id.includes('node_modules/lucide-react')) return 'icons';
            if (
              id.includes('node_modules/@trpc/') ||
              id.includes('node_modules/electron-trpc') ||
              id.includes('node_modules/superjson') ||
              id.includes('node_modules/zod')
            )
              return 'trpc';
            return undefined;
          },
        },
      },
    },
    server: {
      port: 5174,
      strictPort: true,
      host: '127.0.0.1',
      watch: {
        ignored: ['**/out/**'],
      },
    },
    envPrefix: ['VITE_', 'OMNIDEX_'],
  },
});
