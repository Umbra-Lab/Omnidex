# The renderer

React 19 under Vite (`@vitejs/plugin-react`) with the React Compiler enabled. It holds no authoritative state — everything of consequence lives in the main process and arrives over tRPC.

Entry: `renderer-react/src/main.tsx` → `App.tsx`.

## Routing

TanStack Router with **hash history**, because a packaged Electron app is served from `file://` and path-based routing does not survive a reload there.

Routes (`renderer-react/src/router/index.tsx`):

```
/  ·  /assets  ·  /collections  ·  /collections/$collectionId
/match  ·  /learn  ·  /health  ·  /settings  ·  /settings/$tab
```

Anything else renders `NotFoundView`.

## State: three layers, on purpose

| Layer | Owns | Where |
|---|---|---|
| TanStack Query | Server state — everything from tRPC | `renderer-react/src/ipc/` |
| Zustand | UI state that outlives a component (sidebar, selection, modals) | `stores/ui.ts`, `stores/modals.ts` |
| `useState` | Genuinely local state | components |

```admonish warning title="Never mirror server state into a store"
Copying query results into Zustand creates a second source of truth that goes stale the moment a mutation invalidates the cache. Read from the query; keep the store for things the server does not know about.
```

Derived values are computed during render from query data. The React Compiler memoizes them, so no separate derived-state library is needed.

## React Compiler

The compiler is a Babel plugin, and `@vitejs/plugin-react-swc` cannot run Babel plugins. The renderer therefore uses `@vitejs/plugin-react` with `babel-plugin-react-compiler` in `electron.vite.config.ts` (the shipping build) and in `vitest.config.ts`, so component tests run against compiled output.

The compiler memoizes components and hooks automatically. Do not add `useMemo`, `useCallback` or `memo` for performance.

```admonish warning title="A function the compiler cannot prove safe is skipped, not rejected"
The build does not fail when the compiler bails out; the function is left unmemoized. This is intended for `AssetGrid` and `AssetTable` (`useVirtualizer`) and `EditLocationModal` (`react-hook-form`), because those libraries return values that go stale when cached. To exclude a function yourself, put the `'use no memo'` directive at the top of its body.
```

To list what the compiler skipped and why, pass `logger: { logEvent }` in the plugin's `babel-plugin-react-compiler` options and read the `CompileError` events. Each one carries the reason and the source location.

The compiler adds a few seconds to the renderer build and roughly 7% to the JavaScript bundle (measured at compiler 1.0.0).

## Structure

```
renderer-react/src/
├── views/        one per route — AssetsView, LearnView, SettingsView, …
├── features/     assets, collections, learn, locations, onboarding,
│                 scanning, settings, tagging
├── components/
│   └── ui/       shadcn-style Radix wrappers
├── stores/       Zustand slices
├── hooks/        useActionProgress, useAskStream, useHotkey,
│                 useIpcEvent, useNativeContextMenu, useViewTransitions
├── ipc/          trpc.ts, TrpcProvider.tsx
├── motion/       presets.ts
└── runtime/      useRuntime.ts
```

A **view** owns a route and composes features. A **feature** owns a domain slice and may span views. UI primitives know nothing about either.

## Virtualization

The asset grid uses `@tanstack/react-virtual`. A library of thousands of packs cannot mount a card per row.

```admonish danger title="Do not assert on what the grid renders"
A virtualized list only mounts what is visible. A test that counts rendered cards is measuring viewport height, not the result set — two different filters will both "have 60". Assert against the status bar's authoritative count instead.

This has produced a false green before. See [Testing](../standards/testing.md).
```

Rows carry `data-asset-id`, which is the stable hook for end-to-end tests.

## Motion

`motion` presets live in `renderer-react/src/motion/presets.ts`.

```admonish warning title="Gate every animation on prefers-reduced-motion"
Attaching a preset without the check is an accessibility defect, not a polish issue. The gate goes before the preset is attached, not inside the animation.
```

## Media playback

Video and audio load over `omnidex-asset://`, never a raw path. The protocol handler answers range requests with `206 Partial Content`; without that, Chromium refuses to seek and playback position cannot be restored.

Some course video ships in containers Chromium will not play — most often MPEG-2 Transport Stream with a `.ts` extension. The Learn player says so explicitly rather than showing a dead element, and `pnpm remux` converts them by stream copy.

## Layout traps

```admonish danger title="Radix ScrollArea does not contain horizontal overflow"
Radix's `ScrollArea` viewport uses `display: table; min-width: 100%`, which lets content size to its widest child instead of clipping. A single long path in an inspector field pushes the whole panel sideways.

Use native `overflow-y-auto overflow-x-hidden` where strict containment is required. An automated "no horizontal overflow" assertion in the Playwright suite catches this entire bug class.
```

## Conventions

- Tabular numerics (`font-mono` / `tabular-nums`) for any size, count, price, or rating, so columns do not jitter.
- Buttons: imperative verb plus noun, sentence case, three words maximum.
- Status text in sentence case, never all caps.
- Empty states get one call to action and no "Welcome to…" preamble.
- Every action produces visible feedback — a toast, a spinner, or a state change.
- Say "folder" in user-facing copy; `scan_location` stays in code.

## Next steps

- [IPC and the tRPC layer](ipc.md) — where the data comes from
- [Code conventions](../standards/code.md) — linting and formatting rules
- [Testing](../standards/testing.md) — including the virtualization traps
