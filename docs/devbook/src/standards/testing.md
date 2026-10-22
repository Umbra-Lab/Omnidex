# Testing

Two suites. Vitest for units, Playwright for a real Electron window.

```bash
pnpm test:run
```

```
Test Files  46 passed | 3 skipped (49)
     Tests  645 passed | 11 skipped (656)
```

```bash
pnpm test:electron
```

CI runs `pnpm lint`, `pnpm check`, and `pnpm test:coverage` on Ubuntu. It installs with `--ignore-scripts`, so there is no native rebuild — which is why unit tests use `node:sqlite` rather than `better-sqlite3`.

## What to test

Test the **repo layer**, not the router. That is where the logic is, and it needs no IPC harness.

Fixtures live in `electron/main/db/repos/__tests__/fixtures/test-db.ts` and declare only the schema slice a suite needs.

```admonish danger title="A fixture missing a constraint tests nothing"
A fixture without the real `ON DELETE CASCADE`, or without `PRAGMA foreign_keys = ON`, will pass tests that production fails.

The cue-orphan bug — 60% of a 4.6-million-row index belonging to deleted lessons — was invisible for exactly this reason. Mirror the real constraints.
```

## Traps that have produced false greens

Each of these has actually happened here.

### Measuring the viewport instead of the result set

The asset grid is virtualized, so only visible rows mount. A test that counts rendered cards is measuring viewport height. Two entirely different filters both "have 60".

Assert against the status bar's authoritative count.

### Asserting a length instead of the contents

```ts
assert.equal(list.result.tools.length, 3);
```

Fails on every addition while saying nothing about what is missing, and passes if one tool is swapped for another. Assert the sorted names:

```ts
assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [
  'get_context', 'list_courses', 'search_assets', 'search_lessons', 'search_transcripts',
]);
```

### A harness that reimplements production selection logic

If a test or repro harness decides *which inputs* to feed the code under test, it must use the real function or replicate it exactly.

A harness hunting a crash walked depth-first where `findThumbnailSource` walks breadth-first, and filtered out course locations — which is where the crash occurred. It reported "0 of 2,672 files abort" and that result meant nothing. A clean result from the wrong input set is worse than no result: it argues against a fix that is needed.

### Reproducing a concurrency bug sequentially

The `.uasset` allocation failure only occurs when four parses land at once. Two sequential harnesses both found nothing. Match the concurrency of the real failure.

### Ambiguous locators

A chip and a sidebar row sharing an accessible name makes `getByRole` ambiguous. Scope the locator to a region.

### Stubs proving the protocol but not the payload

Unit tests for the thumbnail pool use a stub child. They prove crash recovery and prove nothing about whether the real addon still produces images — and a native call silently returning `null` for everything looks identical to a library of unextractable files.

Where a native path cannot be tested in CI, add an **opt-in live check** that skips without an environment variable:

```bash
POOL_LIVE_LIST=/path/to/uassets.json pnpm exec vitest run electron/main/scanner/__tests__/pool-live.local.test.ts
```

## End-to-end tests

Playwright drives a real Electron window over CDP.

```admonish tip title="Playwright, not computer-use, for desktop verification"
Synthetic keystrokes sent at the OS level get eaten by focus changes. Driving the app over CDP does not.
```

Specs install their own data through CLI fixture flags (`--inject-gallery-fixture`), so there is no separate seeding step.

Useful hooks:

- `data-asset-id` on grid rows.
- The **no horizontal overflow** assertion, which catches an entire class of layout bug — most often Radix `ScrollArea`, whose viewport uses `display: table; min-width: 100%` and therefore sizes to its widest child instead of clipping.

## Before merging

```bash
pnpm check && pnpm lint && pnpm test:run
```

Local green plus CI green is the merge bar; there is no human review step.

```admonish warning title="Verify CI ran, not just that it is not red"
A branch-filter mismatch produces no run at all, which looks identical to green. This repository ran no CI for five weeks after a `master` → `main` rename. Check the date of the last run.

If a push did not trigger one, force it: `gh workflow run ci.yml --ref <branch>`.
```

## Claiming something works

Match the claim to the evidence. "It compiles" is not "tests pass" is not "verified against real data".

Say which one you did.

## Next steps

- [Code conventions](code.md) — the rules the linter cannot express
- [The uasset addon](../subsystems/native-uasset.md) — the live-check example in context
