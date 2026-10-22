# electron/

The main process and preload script for the desktop app. The renderer lives in `renderer-react/`.

- `main/` builds to `out/main/index.mjs`. It owns the database, filesystem, network and long jobs.
- `preload/` builds to `out/preload/index.cjs` and exposes `electron-trpc` and the `window.omnidex` bridge.
- `test-stubs/` holds the `electron` stub that Vitest aliases in.
- Run it with `pnpm dev` (renderer on `127.0.0.1:5174`; restart for main-process edits) and build it with `pnpm build`.
- For the process boundaries and data path, read [`docs/devbook/src/orientation/architecture.md`](../docs/devbook/src/orientation/architecture.md).
