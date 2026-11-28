# Marketplace enrichment

Enrichment attaches metadata to a local pack that the folder name alone cannot supply: a real title, seller, category, price, rating, and gallery images. Two sources, both optional and both explicitly triggered.

| Source | What it gives | Auth |
|---|---|---|
| **Orbital Market** | Public listing metadata for Unreal marketplace assets | None |
| **Epic FAB** | Your own purchased library, from the local VaultCache | Epic OAuth |

Nothing here runs on a timer. Enrichment happens when you press the button or run the flag.

## Orbital Market

`electron/main/orbital/`:

| File | Role |
|---|---|
| `client.ts` | Rate-limited fetch, retry, circuit breaker |
| `search.ts` | Query construction |
| `matcher.ts` | Local pack → listing candidate scoring |
| `product.ts`, `product-mapping.ts` | Response → column mapping |
| `cache.ts` | TTL cache |
| `enrich.ts` | The batch operation |

### The client is deliberately slow

```
MIN_REQUEST_INTERVAL_MS   300      one request per 300 ms
ATTEMPT_TIMEOUT_MS        15_000   per attempt
OVERALL_DEADLINE_MS       45_000   across retries
BREAKER_THRESHOLD         5        consecutive failures opens the breaker
BREAKER_COOLDOWN_MS       60_000   how long it stays open
```

300 ms was calibrated against observed human browsing on the live site, which is roughly one request per second. This is a third-party service with no published quota, being used for bulk enrichment across thousands of packs.

```admonish warning title="Do not raise the request rate to make a batch finish sooner"
The interval is a politeness budget for someone else's server, not a tuning parameter. If a run is too slow, narrow the batch.
```

Responses are cached for 24 hours (`cache.ts`).

Only a definitive answer marks a pack `orbital_match_attempted`: a match, or a confirmed no-match (404 or no candidate). Network trouble (429, 5xx, a transport failure, an open breaker) throws `RateLimitError` and leaves the pack for the next run. An open breaker stops the run, because every remaining request would fail instantly. Other 4xx responses and unreadable bodies throw `OrbitalRequestError`, which is never retried and never trips the breaker. The FAB sync returns `fetchError` when the library could not be fetched in full, and enriches nothing from a partial library.

### The API takes `skip`, not `offset`

```ts
{ searchText, limit, skip, sortField, sortDirection }
```

Not `query`, not `offset`. Getting either wrong returns results that look plausible and are silently wrong — the first page, repeatedly.

### Matching and rejection

`matcher.ts` scores listing candidates against a local pack. Matching is fuzzy by necessity: local folders carry vendor prefixes, version suffixes, and engine numbers the listing does not.

When a match is wrong, the rejection **persists**, in `orbital_match_rejections`:

| Operation | Effect |
|---|---|
| `reject(assetId, slug)` | This candidate is wrong for this asset |
| `dismiss(assetId)` | This asset has no match; stop offering any |
| `undoRejection` | Reverse either |

The unique index is `(asset_id, COALESCE(product_slug, ''))`.

```admonish note title="Why COALESCE in the index"
SQLite treats `NULL`s as distinct in a unique index, so a plain `UNIQUE (asset_id, product_slug)` would allow unlimited duplicate "dismissed" rows for the same asset. Collapsing `NULL` to `''` makes the constraint mean what it reads as.
```

Rejections are consulted on every subsequent match, so re-running enrichment does not resurrect a candidate you already rejected.

## Epic FAB

`electron/main/fab/` imports from Epic's local VaultCache. The default path resolver and a live watcher live there.

Auth uses Epic's interactive authorization-code flow, which the renderer cannot run itself. On stale credentials the service throws `FabAuthRequiredError` carrying a redirect URL, and the renderer offers an "open Epic login" action.

```admonish warning title="The redirect URL cannot travel on a thrown error"
The superjson patch bypasses tRPC's `errorFormatter`, so custom `data` on a thrown `TRPCError` never reaches the renderer. The URL must be returned in the procedure's result. See [IPC and the tRPC layer](ipc.md).
```

Tokens are stored via `keytar` in the OS keychain, never in the database.

For headless runs without stored credentials:

```bash
pnpm enrich-fab --fab-token <bearer> --fab-account <id>
```

## AI search keywords

`pnpm enrich-tags` (`electron/main/tagging/`) asks Claude, through the user's own Claude Code CLI, for search keywords each pack's name does not say: what it contains, its setting and style, what it is for, and synonyms ("hallway" for a corridor kit). It runs `claude -p --model opus --output-format json` with the prompt on stdin, about 40 packs per call, most-rated packs first. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the child's environment (`claudeCliEnv` in `ask/providers.ts`), so a run uses the subscription login and never bills the API.

Keywords go in `assets.ai_tags`, not the user's `tags`, and into their own `assets_fts` column ranked below every other text (weight 1.5 against the name's 10). `NULL` means never tagged and `''` means the model had nothing to add, so a rerun only asks about new packs. A pack missing from a reply stays `NULL` and is asked about again next run. `pnpm clear-ai-tags` empties the column if a run went wrong.

The model sees only what the library already holds: name, marketplace title, seller, categories, the first 400 characters of the description, and the split folder or file names. It is told not to guess beyond them, and the reply is reduced to at most 12 lowercase phrases of one to three words per pack.

## Running enrichment

| Where | How |
|---|---|
| UI | Settings → Marketplace → **Enrich now** / **Sync now** (FAB Marketplace card) |
| CLI | `pnpm enrich-orbital` / `pnpm enrich-fab` / `pnpm enrich-tags` |

Orbital and FAB call the same services from both and publish to the same `progressBus`. `enrich-tags` is CLI-only for now and logs `[tags]` lines.

## Not yet wired

- **Per-asset match correction.** `orbital.match`, `orbital.candidates`, and `orbital.search` exist on the router; the inspector does not call them yet.
- **Auto-match on scan.** The "Auto-match on scan" switch is intentionally disabled. Enrichment is a network operation with a politeness budget, and coupling it to every scan would make a routine re-index a thousand-request batch.

## Next steps

- [Run a data operation](../guides/run-a-data-operation.md) — driving enrichment headless
- [tRPC API](../reference/trpc-api.md) — the `orbital` and `fab` procedures
