# The database

One SQLite file, opened synchronously with `better-sqlite3`, owned entirely by the main process. WAL journal mode, foreign keys on.

## Layout

| Concern | Location |
|---|---|
| Connection and pragmas | `electron/main/db/index.ts` |
| File paths | `electron/main/db/paths.ts` |
| Migrator | `electron/main/db/migrator.ts` |
| Migrations | `electron/main/db/migrations/*.up.sql` (36 files) |
| Query layer | `electron/main/db/repos/` |

## The repo layer is the only SQL

Every query lives in `electron/main/db/repos/`. tRPC routers, CLI operations, and the scanner all call the same exported functions.

```
assets.ts · courses.ts · collections.ts · notes.ts · tags.ts
scan-locations.ts · scan-diagnostics.ts · orbital-rejections.ts
app-settings.ts · row-helpers.ts
```

A repo function takes a `Database` as its first argument and knows nothing about IPC. That is what makes the CLI and the UI genuinely share behaviour rather than merely resemble each other, and it is why repo functions are directly unit-testable.

```admonish warning title="No SQL outside repos"
A query in a tRPC router is a bug, even a small one. It cannot be reached by the CLI, it cannot be unit-tested without standing up a router, and it will drift from the equivalent query in the repo layer.
```

## Migrations

Forward-only. Each file is `<timestamp>_<name>.up.sql`, applied in filename order, tracked in `_omnidex_migrations`.

Each migration runs inside an explicit `BEGIN`/`COMMIT`/`ROLLBACK` rather than `db.transaction()`, so the same code path works under the `node:sqlite` engine used by tests. A failing migration rolls back and throws `MigrationError`.

```admonish warning title="VACUUM cannot run in a migration"
`VACUUM` is not allowed inside a transaction, and the migrator wraps every migration in one. A migration that deletes a lot of rows leaves free pages behind rather than shrinking the file. That is usually fine — subsequent growth reuses them — but say so in the migration comment rather than letting a reviewer wonder.
```

Migrations are copied verbatim into `out/main/migrations/` by electron-vite. A new migration therefore needs a `pnpm build` before a CLI run will see it.

See [Write a migration](../guides/write-a-migration.md) for the procedure.

## Transactions

Batch. The scanner's per-folder upsert loop and its prune share one transaction; committing per row would mean one WAL commit per pack.

```ts
db.exec('BEGIN');
try {
  // ... many statements
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
```

Use raw statements rather than `db.transaction()` on any path the tests exercise, because `node:sqlite` does not implement it.

## Full-text search

Two independent FTS5 indexes with different shapes. Do not assume a change to one applies to the other.

**`assets_fts`** indexes pack names and marketplace titles, BM25-weighted to favour the name.

**`transcript_fts`** is an **external-content** index over `transcript_cues`:

```sql
CREATE VIRTUAL TABLE transcript_fts USING fts5 (
  text, content = 'transcript_cues', content_rowid = 'id',
  tokenize = 'porter unicode61'
);
```

Triggers on `transcript_cues` keep it in sync. Writing to `transcript_cues` is an ordinary indexed write; the index follows.

```admonish danger title="External content does not clean itself up"
Deleting a row from `transcript_cues` without the `AFTER DELETE` trigger leaves the text permanently matchable in the FTS index. The triggers are not optional bookkeeping — they are the only thing keeping search results from referencing rows that no longer exist.
```

### Why the cues moved out of the virtual table

`transcript_fts` originally held `file_id` and `start_ms` as `UNINDEXED` FTS5 columns. Such columns are not indexed for anything except `MATCH`, so every non-`MATCH` filter scanned the whole corpus. Three hot paths did:

| Path | Cost at 4.6M cues |
|---|---|
| `get_context` (oracle MCP) | ~1140 ms per call |
| The Ask layer's `file_id IN (...)` gather | full scan |
| `DELETE ... WHERE file_id = ?` | full scan, **once per lesson, per re-scan** |

The move to a real table with an index on `(file_id, start_ms)` took `get_context` to under a millisecond.

It also fixed a correctness bug. A virtual table cannot carry a foreign key, and re-scanning reassigns `course_files` ids, so every scan stranded the previous scan's cues: **2,794,345 of 4,648,463 rows (60%)** belonged to 18,078 file ids that no longer existed. Those rows were not inert — BM25 computes IDF over the whole corpus, so ranking was being scored against a corpus that was mostly stale duplicates.

Migration: `20260806000000_transcript_cues_external_content.up.sql`.

## Testing against the schema

Unit tests use Node's built-in `node:sqlite` (`--experimental-sqlite`), not `better-sqlite3`, because the latter is built against Electron's ABI and will not load under plain Node in CI.

The two are close but not identical. `db.transaction()` is the main gap. Test fixtures declare the slice of schema they need rather than running all 36 migrations — see `electron/main/db/repos/__tests__/fixtures/test-db.ts`.

```admonish note title="Fixtures must mirror real constraints"
A fixture that omits `ON DELETE CASCADE` or forgets `PRAGMA foreign_keys = ON` will pass tests that production would fail. The cue-orphan bug was invisible for exactly this reason.
```

## Inspecting a live database

```bash
pnpm inspect-db
```

```bash
pnpm audit:dbs
```

`audit:dbs` finds stray database files, which matter because of a specific footgun:

```admonish warning title="app.setName must be pinned early"
Without `app.setName('omnidex')` before `app.whenReady()`, dev, test, and packaged launches resolve different `userData` directories and therefore different databases. The symptom is work that "did not save" but actually landed in a second file.
```

## Next steps

- [Database schema](../reference/schema.md) — the table list
- [Write a migration](../guides/write-a-migration.md) — the procedure
- [The data model](../orientation/data-model.md) — what the tables mean
