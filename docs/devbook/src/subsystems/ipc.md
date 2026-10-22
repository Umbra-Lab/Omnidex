# IPC and the tRPC layer

The renderer and the main process talk over two surfaces. One is the data path; the other is a small set of things tRPC is a bad fit for, plus some dead weight.

## The tRPC surface

`electron-trpc` carries tRPC v11 over Electron IPC, serialized with superjson. The root router is `electron/main/trpc/router.ts`.

```
assets · scanLocations · collections · courses · notes · settings
scanner · orbital · fab · libraryHealth · progress · ask · updates
```

Sub-routers live in `electron/main/trpc/routers/`. Zod input schemas are centralised in `electron/main/trpc/schemas.ts`. The renderer consumes them through `createTRPCReact` in `renderer-react/src/ipc/trpc.ts`, with the provider in `TrpcProvider.tsx`.

Only the `AppRouter` **type** crosses to the renderer, so no server code is bundled into the client and a renamed procedure is a compile error.

### Why superjson

Without a transformer, `Date` arrives as a string and `undefined` collapses into `null`. superjson preserves them across the boundary.

```admonish danger title="The patch is required, not optional"
`patches/electron-trpc@1.0.0-alpha.0.patch` wires superjson into electron-trpc's transformer. Without it **every** call fails with:

`Cannot read properties of undefined (reading 'serialize')`

`pnpm install` applies it via `postinstall`. If a dependency change wipes it, run `pnpm apply-patches`.
```

### The errorFormatter does not work

That same patch bypasses tRPC's `errorFormatter`, because electron-trpc v11 has no `router.getErrorShape`. Custom error `data` never reaches the renderer.

```admonish warning title="Return errors, do not throw them"
Anything the renderer must act on — a redirect URL, an error code, a retry hint — has to be returned **in the result**, not attached to a thrown `TRPCError`'s `data`. The data will be silently dropped.

The FAB auth flow is the live example: a stale Epic credential needs to surface a login URL, and it is carried in the procedure's return value.
```

## Subscriptions

`progress.onProgress` streams scan and enrichment progress from a shared `progressBus` in `electron/main/progress/`. The renderer subscribes through the `useActionProgress` hook, which `ScanProgressPanel` mounts once in `AppShell`. `ask.onStream` streams Ask answers the same way.

Publishers are the scanner and the enrichment services; both the CLI and the UI paths publish, so a headless run still emits events even with nobody listening.

```admonish warning title="Subscriptions have to survive route changes"
electron-trpc closes every subscription of a frame on `did-start-navigation`, and the renderer uses hash routing, so each in-app route change fires that event. Unpatched, a subscription opened once at mount delivers until the first route change and then stops, while the renderer still believes it is listening. The shell's scan progress panel went silent this way.

`patches/electron-trpc@1.0.0-alpha.0.same-document-navigation.patch` makes the handler skip same-document navigations (a hash change, `pushState`). They keep the renderer's JavaScript context, so its subscriptions are still live. A reload is a cross-document navigation and still closes them, which is correct because the renderer resubscribes on mount.

With the patch in place a tRPC subscription is enough for state that must outlive a route change; it does not need a separate IPC channel. If progress stops arriving after you switch routes, the patch is missing: run `pnpm apply-patches`. `tests/electron-progress-navigation.spec.ts` navigates before it starts a scan, so it fails when the patch is absent.

The update banner predates the patch and pushes its state with `webContents.send` on `UPDATE_STATE_CHANNEL` (`shared/types/updates.ts`), read with `useIpcEvent`. That still works and is unaffected by navigation; it is not a pattern new code has to copy.
```

## The legacy bridge

`electron/preload/index.ts` also exposes `window.omnidex`, backed by `ipcMain.handle('omnidex:*')` handlers in `electron/main/ipc/`:

```
db.ts · scanner.ts · uasset.ts · orbital.ts · fab.ts
dialog.ts · shell.ts · credentials.ts · commands.ts · menu.ts
```

| Handler | Status |
|---|---|
| `dialog`, `shell`, `credentials`, `menu`, `commands` | **Live.** Native affordances with no sensible tRPC shape — folder pickers, "reveal in explorer", OS keychain. |
| `db`, `scanner`, `uasset`, `orbital`, `fab` | **Vestigial.** Superseded by tRPC routers. The React renderer does not call them. |

```admonish warning title="Do not add ipcRenderer.invoke to renderer code"
New renderer-facing data access goes in the tRPC router. If something genuinely needs the bridge, add a preload method plus a type entry in `renderer-react/src/types/` — never redeclare `Window.omnidex` inline at the call site.
```

## Preload ordering

`exposeElectronTRPC()` must run **before** `contextBridge.exposeInMainWorld('omnidex', …)`. The preload emits CommonJS (`.cjs`); that is a build constraint, not a style choice.

## Adding a procedure

The short version, with the full walkthrough in [Add a tRPC procedure](../guides/add-a-trpc-procedure.md):

1. Write the query in the relevant file under `electron/main/db/repos/`.
2. Add a Zod schema to `electron/main/trpc/schemas.ts` if it takes input.
3. Add the procedure to the sub-router in `electron/main/trpc/routers/`.
4. Call it with `trpc.<domain>.<op>.useQuery()` or `.useMutation()`.
5. Invalidate the right query keys on mutation.

## Next steps

- [Add a tRPC procedure](../guides/add-a-trpc-procedure.md) — the worked example
- [tRPC API](../reference/trpc-api.md) — the full procedure list
- [The renderer](renderer.md) — what consumes it
