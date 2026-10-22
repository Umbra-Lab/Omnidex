# Index your first library

An empty Omnidex is hard to develop against. This page gets real rows into the database. You do not need an actual Unreal library — the repo can generate one.

## Generate a test library

```bash
pnpm gen:test-library
```

This writes a synthetic Unreal library to `./test-library` with the folder shapes the walker cares about: packs containing `.uasset` files, packs whose only thumbnail is a shipped preview image, nested vendor folders, and pathological names.

To put it somewhere else:

```bash
pnpm gen:test-library D:/omnidex-fixtures
```

## Check what the walker sees

Before committing anything to the database, do a dry run:

```bash
pnpm smoke:scan ./test-library
```

This prints the folders the walker would register, with no database writes. Use it whenever you change detection logic — it is much faster than a real scan and it cannot corrupt anything.

## Add the folder and scan

Start the app:

```bash
pnpm dev
```

Then, in the UI:

1. Open **Settings → Folders**.
2. Choose **Add folder** and select `test-library`.
3. Leave the format as packs (a course root is a different setting — see below).
4. Choose **Scan** on the new folder's row. Adding a folder saves it but does not scan it.

Progress streams into the scan panel. On success the asset grid populates and thumbnails fill in behind it, because extraction runs as a background job after the scan returns.

## Or scan from the command line

Every data operation also runs headless, against the same services:

```bash
pnpm refresh-scans
```

This boots Electron through `electron/main/index.ts`, runs every active scan location, and exits. It shares the normal boot path, so migrations run first.

```admonish tip title="The CLI and the UI are the same code"
`pnpm refresh-scans` and the Command Palette's **Refresh library** command both call `refreshAllScans` in `electron/main/scanner/refresh-all.ts`. A bug in one is a bug in both, and a fix to the service fixes both.
```

## Add a course library

Courses use the same mechanism with one setting changed: the scan location's **content format** is set to *course*.

The important part is where you point it. A course location treats **each top-level folder as one course**. Point it at a folder of courses, not at a folder of *categories*:

```
D:/Courses/                     <-- WRONG. Nine disciplines become nine "courses".
├── Blender/                    <-- RIGHT. Twelve real courses inside.
│   ├── Hard Surface Modelling/
│   └── Geometry Nodes/
└── Houdini/                    <-- RIGHT. Twenty-six real courses inside.
```

Adding `D:/Courses` produces nine courses named after disciplines, each with a manifest that flattens every lesson of every real course inside it. Add each discipline folder as its own location instead.

## Confirm it worked

```bash
pnpm inspect-db
```

Or query the database directly. Its location is [documented in Paths and files](../reference/paths.md).

## Next steps

- [Run a data operation](../guides/run-a-data-operation.md) — enrichment, thumbnails, re-scans
- [The scanner](../subsystems/scanner.md) — what the walk actually does
- [Add a tRPC procedure](../guides/add-a-trpc-procedure.md) — your first code change
