# Writing for this devbook

This page is the standard. A page that follows it belongs in the book; a page that does not gets rewritten before it merges.

The rules exist because documentation rots in two specific ways, and both are preventable. It rots when nobody can tell which section a new page belongs in, so pages accumulate in a flat pile. It rots when pages assert facts that drift from the code with nothing pointing back at the source. Everything below is aimed at those two failures.

## Toolchain

```bash
cargo install mdbook mdbook-mermaid mdbook-admonish
cd docs/devbook && mdbook serve --open
```

`mdbook build` writes to `docs/devbook/book/`, which is gitignored. Do not commit rendered output.

## Rule 1: every page has exactly one mode

Before writing, decide which of these the page is. If you cannot pick one, you have two pages.

| Mode | Section | Reader's question | Never contains |
|---|---|---|---|
| Explanation | Orientation, Subsystems | "Why is it like this?" | Step-by-step instructions |
| Tutorial | Getting started | "Teach me, I'm new" | Edge cases, alternatives |
| How-to | Guides | "How do I do X?" | Background, theory |
| Reference | Reference | "What is the exact value?" | Opinions, narrative |

This is the [Diátaxis](https://diataxis.fr/) split. The common failure is a subsystem page that starts explaining an area and drifts into a numbered install procedure. Move the procedure to a guide and link to it.

A page may go general → specific within its own mode. A subsystem page can open with the concept and end with a table of the relevant functions. It may not switch to teaching.

## Rule 2: state the source of truth

Any fact that lives in code must name the file that owns it.

```admonish success title="Do this"
The root router exposes thirteen sub-routers (`electron/main/trpc/router.ts`).
```

```admonish failure title="Not this"
The root router exposes thirteen sub-routers.
```

The first version survives the count changing, because the next reader knows where to check. The second becomes a lie the moment someone adds a router, and nothing signals it.

For anything that changes often — counts, versions, table lists — say it is approximate and point at the source. Never paste a generated list into prose and imply it is current.

## Rule 3: the reader's task comes first

Lead with the answer. Caveats, history, and background go below it. Readers scan the first screen and leave.

- Second person, present tense, active voice. "You edit `biome.json`", not "the configuration can be edited".
- One idea per sentence.
- Sentence case headings. Verb-first for tasks ("Add a migration"), noun phrases for reference ("Environment variables").
- Descriptive link text. Never "click here" or "see this page".
- Define a term once, in bold, then use it plainly.

## Rule 4: no marketing language

Cut these on sight: *powerful, robust, seamless, blazing-fast, simply, just, easily, obviously, in order to, utilize, leverage, it's important to note that*.

They either make a claim the reader has to verify or insult someone for whom it was not simple. Replace a claim with a number or a file path, and delete the filler outright.

```admonish example title="Before and after"
**Before:** "Omnidex leverages a powerful FTS5 index to blazingly search transcripts. It's important to note that the index can be configured."

**After:** "Transcript search runs against an FTS5 external-content index over `transcript_cues`, with BM25 ranking. The tokenizer is set in the migration that creates it (`20260806000000_transcript_cues_external_content.up.sql`)."
```

## Rule 5: examples must be runnable

Code blocks are copy-pasteable and complete. Real paths, real values. Placeholders only when the placeholder is the point, and then make its shape obvious.

Show output when the output is the reason the reader ran the command:

```bash
pnpm test:run
```

```
Test Files  42 passed | 3 skipped (45)
     Tests  568 passed | 11 skipped (579)
```

One command per fenced block, no leading `$`, no interleaved output inside the fence.

## Rule 6: callouts are rare

A `warning` earns its box by preventing a real footgun. A `danger` means data loss. If every third paragraph is a callout, the reader learns to skip all of them.

| Callout | Use for |
|---|---|
| `note` | An aside that is genuinely optional |
| `tip` | A shortcut that is not obvious |
| `warning` | Something that will break if ignored |
| `danger` | Data loss or an unrecoverable state |
| `example` | A worked before/after |

## Rule 7: end by pointing somewhere

Close every page with where to go next, as real links. A reader who finished a page is ready for the next thing, and a dead end sends them back to the sidebar to guess.

## Adding a page

1. Decide the mode (Rule 1). That picks the section, which picks the directory.
2. Create the file under `src/<section>/`.
3. Add exactly one line to `src/SUMMARY.md`, in reading order. A page missing from `SUMMARY.md` is not built and is silently invisible.
4. Run `mdbook build` and confirm no warnings.

```admonish warning title="Broken links fail quietly"
mdBook does not fail the build on a dead internal link. Check the console output of `mdbook build` for `[WARN]` lines before merging.
```

## What does not belong here

This book is curated. It is not an archive.

- **Historical planning documents, audit reports, sprint summaries, and one-off analyses** stay in the pull request that produced them. The failure mode to avoid is a book whose `src` is the whole `docs/` directory: every stale report becomes a permanent page with equal billing to the architecture, and search returns four contradictory answers.
- **Changelogs** belong in git history and release notes.
- **Anything you would not want a stranger to read as current fact.**

If a page is worth keeping but no longer true, fix it or delete it. Do not leave it and add a newer page beside it.

## Next steps

- [Code conventions](code.md) for the rules the linter cannot express
- [Testing](testing.md) for what a change has to prove before it merges
