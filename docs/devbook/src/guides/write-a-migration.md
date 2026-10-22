# Write a migration

Migrations are forward-only SQL files applied in filename order and tracked in `_omnidex_migrations`.

## 1. Create the file

```
electron/main/db/migrations/<UTC timestamp>_<snake_case_name>.up.sql
```

The timestamp is `YYYYMMDDHHMMSS`. Existing files use `000000` for the time component when ordering within a day is all that matters:

```
20260806000000_transcript_cues_external_content.up.sql
```

There is no `.down.sql`. Migrations are not reversible; to undo one, write another.

## 2. Write the SQL

Every migration runs inside a transaction the migrator opens. Do not write your own `BEGIN`.

```sql
-- Why this migration exists, in the terms a reader six months from now needs.
-- State the measured problem, not just the change.

ALTER TABLE assets ADD COLUMN retired_at TEXT;

CREATE INDEX assets_retired ON assets (retired_at) WHERE retired_at IS NOT NULL;
```

```admonish warning title="Comment the reason, not the diff"
The SQL already says what changed. The comment exists to say why — ideally with a number. "Dropped 2,794,345 orphan rows (60% of the table)" tells the next reader whether the migration was worth its cost; "clean up cues" does not.
```

## 3. Watch the constraints SQLite actually has

**`VACUUM` cannot run inside a transaction.** A migration that deletes many rows leaves free pages rather than shrinking the file. That is usually fine — later growth reuses them — but say so in the comment.

**`NULL`s are distinct in a unique index.** `UNIQUE (asset_id, product_slug)` permits unlimited rows where `product_slug IS NULL`. If that is not what you mean:

```sql
CREATE UNIQUE INDEX orbital_match_rejections_unique
  ON orbital_match_rejections (asset_id, COALESCE(product_slug, ''));
```

**`ALTER TABLE` is limited.** SQLite cannot drop or retype a column in older forms. Rebuilding a table means create-new, copy, drop-old, rename — inside the one transaction.

**Foreign keys need the pragma.** `PRAGMA foreign_keys = ON` is set on the connection. A test fixture that omits it will not enforce cascades, and a bug that depends on them will pass in tests and fail in production.

## 4. Rebuild before any CLI run

electron-vite copies `electron/main/db/migrations/` verbatim into `out/main/migrations/`. A CLI operation runs the **built** output:

```bash
pnpm build
```

Skip this and `pnpm refresh-scans` silently runs the old schema.

## 5. Apply and verify

Any app or CLI start runs pending migrations and logs the count:

```bash
pnpm refresh-scans
```

```
[omnidex] db ready at C:\Users\you\AppData\Roaming\omnidex\omnidex.db — 36 migrations applied
```

## 6. Measure it if it touches a lot of rows

A migration runs on the user's machine at boot. If it rewrites a large table, know the cost before shipping it, on a copy:

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const src=new DatabaseSync(process.env.APPDATA+'/omnidex/omnidex.db',{readOnly:true});
src.exec(\"VACUUM INTO 'probe.db'\");
"
```

Then apply the migration to `probe.db` and time it. The external-content migration was measured at 11.4 seconds against 4.6 million cues before it shipped.

```admonish tip title="VACUUM INTO is safe on a live database"
It takes a read transaction and writes a clean copy. You can snapshot a running install without stopping it.
```

## 7. Update the test fixtures

Fixtures in `electron/main/db/repos/__tests__/fixtures/` declare the slice of schema each suite needs; they do not run the migrations. A new table or column used by a tested repo function needs adding there too, **including its constraints** — a fixture without the real `ON DELETE CASCADE` will pass tests production would fail.

## Next steps

- [The database](../subsystems/database.md) — the migrator and transaction rules
- [Database schema](../reference/schema.md) — the current tables
