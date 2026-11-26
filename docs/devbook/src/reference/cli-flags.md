# CLI flags

Flags parsed by `electron/main/index.ts`. Each boots Electron through the normal path — database open, migrations, IPC registration — runs one job, and exits.

```bash
electron . --refresh-scans
```

Most have a `package.json` wrapper; see [Commands](commands.md).

## Data operations

| Flag | Script | Does |
|---|---|---|
| `--refresh-scans` | `pnpm refresh-scans` | Scan every location with `is_active = 1` |
| `--extract-missing-thumbs` | `pnpm extract-thumbs` | Extract thumbnails for assets that still lack one |
| `--enrich-orbital` | `pnpm enrich-orbital` | Match packs against Orbital Market and write metadata |
| `--enrich-fab` | `pnpm enrich-fab` | Pull the Epic FAB library and enrich matches |
| `--backfill-course-sources` | `pnpm backfill:course-sources` | Fill `tutorial_source` on courses that already have a manifest |

## FAB credential overrides

Used when no Epic credentials are stored in the OS keychain — headless machines and CI-like runs.

| Flag | Argument |
|---|---|
| `--fab-token` | Bearer token |
| `--fab-account` | Epic account id |

```bash
pnpm enrich-fab --fab-token <bearer> --fab-account <id>
```

Handled near the `runEnrichFabAndQuit` block in `electron/main/index.ts`.

```admonish warning title="Tokens on a command line are visible"
A process command line is readable by other processes and lands in shell history. Prefer the stored-credential path; use these flags only where the keychain is unavailable.
```

## Test fixtures

Used by the Playwright suite so a spec can install its own data without a separate seeding step.

| Flag | Does |
|---|---|
| `--check-fixture` | Report whether the gallery fixture is installed |
| `--inject-gallery-fixture` | Install it |
| `--revert-gallery-fixture` | Remove it |

## Rules

**Build first.** Flags run `out/main/index.mjs`, not your source. `pnpm build` after any main-process change.

**One job per invocation.** Each flag runs its job and quits. They do not compose; run them in sequence.

**Exit codes.** `0` on success. `1` when the job fails: a scan location failed, `enrich-fab` could not fetch the library or re-authorize, `enrich-orbital` got no answer for any pack (an outage), the job threw, or the database did not open. `enrich-orbital` exits `0` when only some packs failed and prints `N of M failed` to stderr: a failed pack is marked attempted and not retried, so a rerun could not fix it. A native abort surfaces as a platform code — `3221226505` (`0xC0000409`) on Windows is a Rust abort, not an application error. See [The uasset addon](../subsystems/native-uasset.md).

**No window.** These runs are headless. Progress goes to stdout, errors to stderr, and the `progressBus` still publishes even with no renderer attached. No modal dialog is shown, so nothing waits for a click.

**Close the app first.** A job flag cannot run while the Omnidex window is open (single-instance lock). It prints `Omnidex is already running; close it and run this again.` and exits `1`. The reverse holds too: while a job runs, opening the app prints `Another Omnidex process is running…` to stderr and exits without a window.

**`--refresh-scans` waits for thumbnails.** The UI gets a scan's result before thumbnail extraction ends; the CLI run waits for extraction to finish before it exits.

**`--enrich-fab` and stdin.** When stored credentials are stale it prompts for an Epic authorization code on stdin. With stdin closed (cron, `</dev/null`) it exits `1` instead of waiting; pass `--fab-token`/`--fab-account` for unattended runs.

## Next steps

- [Commands](commands.md) — the wrappers
- [Run a data operation](../guides/run-a-data-operation.md) — reading the output
