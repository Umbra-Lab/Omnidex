# Code conventions

Biome handles formatting and most linting. This page covers what a linter cannot express.

## Formatting

`biome.json`:

| Setting | Value |
|---|---|
| Indent | 2 spaces |
| Quotes | single |
| Trailing commas | all |
| Line width | 100 |
| `noExplicitAny` | warn |
| `useConst` | off |

```bash
pnpm lint
```

```bash
pnpm format
```

```bash
pnpm lint:fix
```

`pnpm lint:fix` is `biome check --write`: safe fixes, formatting, and import sorting. `pnpm lint:fix:unsafe` adds `--unsafe`, which can change behavior, so read the diff.

`pnpm install` wires `.husky/pre-commit` through the `prepare` script. The hook runs `biome check --write --staged --no-errors-on-unmatched` and blocks the commit on anything unfixable. Biome writes its fixes to the working tree without staging them, so run `pnpm lint:fix` before you commit. See [Commands](../reference/commands.md#native-and-install) if the hook is not wired.

```admonish note title="pnpm check is not a linter"
`pnpm check` is `tsc --noEmit` across three tsconfigs. It type-checks and does nothing else. Run both.
```

## Architectural rules

These are the ones that cause real damage when broken.

**SQL lives only in `electron/main/db/repos/`.** A query in a tRPC router cannot be reached by the CLI, cannot be unit-tested without a router harness, and will drift from its equivalent in the repo layer.

**Renderer data access goes through tRPC.** No `ipcRenderer.invoke` in renderer code. If the legacy bridge is genuinely required, add a preload method and a type entry in `renderer-react/src/types/` — never redeclare `Window.omnidex` inline.

**Never call the `.uasset` extractor in-process.** It can abort the process on malformed input. Use `extractThumbnailsIsolated`. See [The uasset addon](../subsystems/native-uasset.md).

**Gate motion on `prefers-reduced-motion`** before attaching any preset.

**Return errors the renderer must act on**, rather than throwing them with custom `data`. The superjson patch drops it.

## Comments

Comment the **why**, not the what. The code already says what it does.

A comment earns its place when it records something the next reader would otherwise have to rediscover: a measurement, a constraint from an external library, a bug that motivated an unobvious shape.

```admonish example title="A comment worth keeping"
```ts
// Whisper guesses a language for music and room tone too (a run of these scored
// as Nynorsk). Below this confidence the audio is treated as English and the
// translate pass is skipped, so noise can't cost a second decode.
const MIN_LANG_PROB = 0.6;
```
The number is arbitrary without the observation that produced it.
```

Do not narrate:

```ts
// increment the counter
processed += 1;
```

## Naming

- **"Folder" in user-facing copy, `scan_location` in code and schema.** A UI string reading `scan_location` is a bug; so is a column named `folder`.
- Booleans read as assertions: `isActive`, `hasLocalThumbnail`, `sizeIsPartial`.
- Repo functions are verb-first: `listAssets`, `replaceTranscript`, `pruneAssetsNotIn`.
- Scripts use colons; their files use hyphens. `pnpm smoke:scan` runs `scripts/smoke-scan.mjs`.

## UI copy

- Buttons: imperative verb plus noun, sentence case, three words maximum.
- Status text: sentence case, never all caps.
- Empty states: one call to action, no "Welcome to…" preamble.
- Every action gets visible feedback — a toast, a spinner, or a state change.
- Tabular numerics (`font-mono` / `tabular-nums`) for any size, count, price, or rating.

## Commits and branches

- Feature branches only. Never commit to `main`.
- Conventional commit prefixes: `feat`, `fix`, `perf`, `docs`, `test`, `chore`, `style`.
- The subject says what changed; the body says why, with numbers where they exist.
- No AI or assistant attribution anywhere — commits, pull requests, comments, or documentation.

```admonish example title="A commit body worth writing"
`perf(transcripts): index cues in a real table, drop 2.8M orphans`

Then the body states the measurement (~1140 ms per call), the cause (`UNINDEXED` FTS5 columns), and the count (2,794,345 of 4,648,463 rows). A reviewer can judge the change without re-deriving it.
```

## Next steps

- [Testing](testing.md) — what a change must prove
- [Writing for this devbook](documentation.md) — the prose standard
