# AGENTS.md

Instructions for AI coding agents (and the humans driving them) working in this repository. Claude Code and Gemini CLI read this file through `CLAUDE.md` and `GEMINI.md`. Codex, Cursor, Copilot and most other agents read it directly.

Omnidex is an Electron + React desktop app that indexes local Unreal Engine asset packs and video courses into a searchable SQLite library. The main process owns all data; the renderer talks to it over tRPC. A Rust napi addon in `native/uasset/` parses `.uasset` files. Depth lives in the devbook: start at [`docs/devbook/src/SUMMARY.md`](docs/devbook/src/SUMMARY.md).

## Commands

pnpm only (`packageManager` pins pnpm 11.1.3). Node 24 from `.nvmrc`; on Node 26 the Electron download unpacks only partially. Rust 1.88+ for the addon.

```bash
pnpm install          # also builds/copies the uasset addon, downloads Electron, rebuilds native modules, applies patches
pnpm dev              # run the app; renderer hot-reloads, main-process edits need a restart
pnpm lint             # Biome lint (electron, renderer-react, shared, scripts)
pnpm check            # TypeScript, three tsconfigs, no emit
pnpm test:run         # Vitest once; no Electron binary needed
pnpm build            # build into out/
```

Fast loop while editing: `pnpm exec vitest run <path-to-test-file>` and `pnpm exec vitest run <file> -t "<name fragment>"`.

Other checks, run when you touch their area:

| You changed | Also run |
|---|---|
| `native/uasset/` | `cargo test` and `cargo clippy --all-targets` in `native/uasset`, then `pnpm build:uasset` |
| Dependencies | `pnpm notices` (regenerates `THIRD-PARTY-NOTICES.md`; checked by `pnpm notices:check`) |
| Anything under `public/fonts` or `renderer-react/src/assets/fonts` | `pnpm check:fonts` |
| Main-process startup, IPC or windowing | `pnpm build && pnpm test:electron tests/<spec>.spec.ts` (Playwright, one spec at a time) |

## Definition of done

A change is done when `pnpm lint`, `pnpm check` and `pnpm test:run` all pass, plus the area checks above. In the pull request, paste the commands you ran and their summary lines. UI changes need a screenshot. Do not claim a check passed that you did not run.

## Rules that are not obvious from the code

**Data access**
- New renderer data access is a tRPC procedure in `electron/main/trpc/routers/`, never a new `ipcMain` channel. Routers call repos in `electron/main/db/repos/`; routers never contain SQL. Guide: `docs/devbook/src/guides/add-a-trpc-procedure.md`.
- `window.omnidex` and `electron/main/ipc/` are for shell, dialog, menu and platform calls only. Do not extend them for data.
- Custom `data` on a thrown `TRPCError` never reaches the renderer (the superjson patch bypasses `errorFormatter`). Return error detail in the result object instead.

**Database**
- Migrations are up-only files: `electron/main/db/migrations/<YYYYMMDDHHMMSS>_<name>.up.sql`. Never edit an applied migration; add a new one. Guide: `docs/devbook/src/guides/write-a-migration.md`.
- DB tests use Node's `node:sqlite`, not `better-sqlite3` (which is built for Electron's ABI).

**Native code and untrusted input**
- `.uasset` files come from downloaded marketplace packs. Treat every byte as hostile: no `unwrap`, no unchecked indexing, cap every count and size before allocating. A panic or `abort()` kills the process, which is why thumbnails run in disposable child processes (`electron/main/scanner/thumbnail-pool.ts`).
- Modules imported by unit tests must not import `@omnidex/uasset`; CI has no native binary.

**Patches and install**
- `patches/*.patch` are applied by `scripts/apply-patches.mjs`, not pnpm. Add a fix as a new `<pkg>@<version>.<topic>.patch`; never amend an applied one.
- Use `pnpm run rebuild`, never `pnpm rebuild` (pnpm's built-in targets the wrong ABI).
- Run Electron through the `pnpm` scripts. `scripts/run-electron.mjs` clears `ELECTRON_RUN_AS_NODE`, which VS Code sets.
- If `pnpm-workspace.yaml` gains an `allowBuilds:` block after install, delete it; it is not committed.

**Renderer and design**
- `DESIGN.md` is the design spec and `renderer-react/src/styles/global.css` mirrors it. Use its tokens: mono for every number, exact counts (`2,799`, never `2.8K`), radius at most 6px, no shadows on content cards, one accent colour for primary actions.
- Type sizes come from generated Capsize classes (`cap-N`); regenerate with `pnpm capsize`.

**Licensing**
- Every shipped font must be free for commercial use and recorded with its SHA-256 hash, source and notice in `font-licenses.json`. Keep license notices embedded in native fonts and beside web fonts. Never add proprietary, trial or unverified downloaded fonts. A substitute font must keep the design role of the one it replaces.
- Never commit third-party content: marketplace screenshots or thumbnails, course videos or transcripts, scraped catalog dumps, or real user libraries. Test data is synthetic (`pnpm gen:test-library`).

**Third-party services**
- Orbital Market and Fab have no public API. Keep requests rate-limited and cached, do not add endpoints or scraping without an issue that discusses it first, and never log or persist Epic tokens outside the OS keychain.

## Where things live

| Path | Contents |
|---|---|
| `electron/main/` | Main process: tRPC routers, repos, migrations, scanner, enrichment, CLI jobs |
| `electron/preload/` | Context bridge |
| `renderer-react/src/` | React UI: routes in `router/index.tsx`, Zustand stores in `stores/`, primitives in `components/ui/` |
| `shared/` | Types shared by main and renderer |
| `native/uasset/` | Rust napi addon, with its own `AGENTS.md` |
| `tests/` | Playwright end-to-end specs (Vitest tests sit next to their source in `__tests__/`) |
| `docs/devbook/` | mdBook developer handbook; one Diátaxis mode per page, one `SUMMARY.md` line per page |

## Git and pull requests

- Branch from `main`; commit with Conventional Commits (`feat(scope):`, `fix(scope):`, `docs(scope):`).
- The pre-commit hook runs `biome check --write` on staged files and blocks on unfixable issues. Its fixes land unstaged, so run `pnpm lint:fix` before committing.
- One change per pull request. Follow `.github/pull_request_template.md`, including the AI-assistance disclosure described in `CONTRIBUTING.md`.
- Do not edit `LICENSE`, `font-licenses.json`, `.github/workflows/` or the release settings in `package.json` unless the task is about them.
