# tRPC API

Thirteen sub-routers mounted on the root router. Source of truth: `electron/main/trpc/router.ts` and the files in `electron/main/trpc/routers/`.

Call from the renderer as `trpc.<router>.<procedure>.useQuery()` or `.useMutation()`.

```admonish note title="This list drifts"
Procedure names were read from the router files at the time of writing. When this page and the code disagree, the code is right.
```

## assets

The largest surface. Browsing, filtering, faceting, and curation.

| Procedure | Kind | Purpose |
|---|---|---|
| `list`, `listCards` | query | Paged asset rows; `listCards` returns the grid projection |
| `get` | query | One asset with full detail |
| `search`, `searchCount` | query | FTS over names and marketplace titles |
| `count`, `totalCount`, `favoriteCount`, `fabCount` | query | Counts for the status bar and sidebar |
| `categoryCounts`, `ecosystemCounts`, `marketplaceSourceCounts` | query | Facet counts |
| `duplicates` | query | Suspected duplicate packs |
| `setFavorite` | mutation | Toggle favourite |
| `delete` | mutation | Remove an asset row |
| `getTags`, `setTags`, `addTags` | query / mutation | Tagging. `addTags` is additive across a selection; `setTags` replaces. |
| `learnList`, `learnCounts` | query | The course-side listing |
| `stats`, `dbStats` | query | Library and database statistics |

## scanLocations

| Procedure | Kind | Purpose |
|---|---|---|
| `list`, `get` | query | Configured locations |
| `stats` | query | Per-location counts |
| `create`, `update`, `delete` | mutation | Manage locations |
| `setActive` | mutation | Include or exclude from `refreshAll` |

## scanner

| Procedure | Kind | Purpose |
|---|---|---|
| `refreshAll` | mutation | Scan every active location |
| `refreshOne` | mutation | Scan one |
| `cancel` | mutation | Abort the running scan |
| `activeCount` | query | How many scans are in flight |

## courses

| Procedure | Kind | Purpose |
|---|---|---|
| `list`, `get` | query | Courses and detail |
| `files` | query | The lesson manifest |
| `setProgress` | mutation | Playback position and completion |
| `lastPlayed` | query | Resume target |
| `subtitleTrack` | query | WebVTT for a lesson, English preferred |
| `searchTranscripts` | query | BM25 across every cue |

## collections

| Procedure | Kind | Purpose |
|---|---|---|
| `list`, `get`, `assets` | query | Collections and membership |
| `create`, `delete` | mutation | Manage collections |
| `addAssets`, `removeAssets` | mutation | Membership |

## orbital

| Procedure | Kind | Purpose |
|---|---|---|
| `enrichAll` | mutation | Batch enrichment |
| `search`, `candidates` | query | Listing lookup and match candidates |
| `match` | mutation | Attach a listing to an asset |
| `reject`, `dismiss`, `undoRejection` | mutation | Persistent match rejection |
| `rejectedSlugs` | query | What was already rejected for an asset |

`match`, `candidates`, and `search` exist but no inspector UI calls them yet.

## fab

| Procedure | Kind | Purpose |
|---|---|---|
| `enrich` | mutation | Sync the FAB library |
| `startWatch`, `stopWatch`, `isWatching` | mutation / query | Live VaultCache watching |
| `defaultVaultPath` | query | Resolved default path |

## Others

| Router | Procedures |
|---|---|
| `notes` | `get`, `upsert`, `delete` |
| `settings` | `list`, `get`, `set`, `delete`, `storage`, `purgeThumbnails`, `openLogFolder` |
| `libraryHealth` | `summary`, `list` |
| `progress` | `onProgress` (subscription) |
| `ask` | `status`, `start`, `cancel`, `onStream` (subscription) |
| `updates` | `state`, `check`, `download`, `install`, `setAutoCheck`, `openRelease`. Changes after `state` arrive as an IPC event, not a subscription. See [Software updates](../subsystems/updates.md) |

## Conventions

**Input validation** is Zod, centralised in `electron/main/trpc/schemas.ts`. Do not inline schemas in a router.

**Every procedure calls a repo function.** No SQL in a router.

**`query` versus `mutation`** drives caching in the renderer. A write declared as a query gets cached; a read declared as a mutation never does.

```admonish danger title="Error data does not reach the renderer"
The electron-trpc superjson patch bypasses tRPC's `errorFormatter`, because v11 has no `router.getErrorShape`. Custom `data` on a thrown `TRPCError` is silently dropped.

Return anything the renderer must act on — an error code, a redirect URL, a retry hint — **in the result**.
```

## Next steps

- [Add a tRPC procedure](../guides/add-a-trpc-procedure.md) — the worked example
- [IPC and the tRPC layer](../subsystems/ipc.md) — how the transport works
