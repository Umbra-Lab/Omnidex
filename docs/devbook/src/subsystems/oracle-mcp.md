# The oracle MCP server

`scripts/oracle-mcp/server.mjs` exposes the Omnidex library over the Model Context Protocol, so an AI assistant can search what your courses actually say — and what you already own — instead of guessing.

It is a standalone stdio server speaking newline-delimited JSON-RPC. It opens the database **read-only** through `node:sqlite`, so it needs no build step and cannot corrupt anything.

## The tools

| Tool | Answers |
|---|---|
| `search_transcripts` | "Where does anyone explain X?" — BM25 over every cue, returns course, lesson, timestamp |
| `search_lessons` | "Is X taught anywhere?" — matches lesson **titles**, ANDed as substrings |
| `get_context` | "What was said around that timestamp?" — cues in a window |
| `list_courses` | What is in the library, with video counts and hours |
| `search_assets` | "Do I already own something for this?" — packs and indexed DCC files, BM25 over `assets_fts` |
| `docs_search` | "What do the official docs say about X?" — sections of the local vendor docs mirror, with citations. Only docs for the installed version are searched unless `version` or `all_versions` is given |
| `docs_outline` | The heading tree of one mirrored page, with section sizes |
| `docs_read` | A whole page or section, in chunks of about 20,000 characters that report `has_more` and `next_offset` |
| `docs_verify` | Whether a cited `path#anchor@version` and quote really exist in the mirror |
| `docs_versions` | Which docs versions are mirrored, and whether they match the installed apps |

DCC results include the file kind, ecosystem and path. Search covers the filename and path as well as the ecosystem and kind. Archive results describe the archive itself; Oracle does not search inside it.

## Why the docs tools read in chunks

Web fetch tools cut long pages off, or summarize them, without saying so. An agent then reasons from a fraction of the page. `docs_read` never summarizes. It returns chunks of about 20,000 characters, broken at a line end, with a header that gives the percentage read, `has_more` and `next_offset`, and it ends an unfinished chunk with an explicit instruction to keep reading.

`docs_verify` checks a citation against the stored text with a string match, ignoring whitespace, emphasis and link markup, without spending model tokens. Quotes shorter than 12 characters are refused, because they match almost anywhere. A match proves the words are in the docs, not that the agent drew the right conclusion from them.

The mirror lives in its own database, `docs.db`, built by `scripts/docs-mirror/docs_mirror.py` ([Mirror vendor docs for agents](../guides/mirror-vendor-docs.md)). The server opens it per call and closes it again, so the mirror can be rebuilt while the server runs. Until it is built, every docs tool answers with the command that builds it. The index tokenizes with `unicode61 tokenchars '_'` and no stemming, so API names such as `primitive_cube_add` match whole.

## Why both transcript and title search

They fail in opposite directions, which is the whole reason both exist.

**Transcripts miss titles.** Instructors do not say their own lesson titles out loud. A cue search for "outline effect theory" returns nothing while a sixteen-lesson module by that name sits in the library.

**Titles miss content.** A lesson called "Part 4" contains twenty minutes of specific technique that its name does not describe.

Titles are also *complete*: every video has one, including the ones with no transcript yet.

```admonish tip title="Ask about titles first"
When the question is "does my library cover X at all", `search_lessons` is the better first call. Use `search_transcripts` when the question is "where specifically is X explained".
```

## Configure it

```json
{
  "mcpServers": {
    "omnidex-oracle": {
      "command": "node",
      "args": ["C:/Users/you/Desktop/Omnidex/scripts/oracle-mcp/server.mjs"],
      "env": { "ORACLE_DB": "C:/Users/you/AppData/Roaming/omnidex/omnidex.db" }
    }
  }
}
```

`ORACLE_DB` defaults to the standard `%APPDATA%/omnidex/omnidex.db` location. `ORACLE_DOCS_DB` defaults to `docs-mirror/docs.db` in the same folder.

## Verify it

```bash
node scripts/oracle-mcp/server.test.mjs
```

```
OK — 115 courses, search 2ms, context 1ms
```

```bash
node scripts/oracle-mcp/docs-tools.test.mjs
```

The docs-tools check builds a small mirror with the real Python indexer and exercises every `docs_*` tool, including reading a long page back in full across chunks.

The self-check drives the real protocol against the live database: initialize, `tools/list`, a search, a `get_context` derived from that search's own result, and a set of malformed-input cases.

```admonish note title="Assert names, not counts"
The tools test asserts the sorted **list of tool names**, not `tools.length`. A bare length check fails on every addition while saying nothing about what is missing, and passes if one tool is swapped for another.
```

## Performance

`get_context` used to take 650 ms to 5.6 seconds. `file_id` lived on the FTS5 table as an `UNINDEXED` column, so filtering by it scanned all 4.6 million cues.

After moving cues into a real indexed table it is **about 1 ms**. See [The database](database.md#why-the-cues-moved-out-of-the-virtual-table).

## Design constraints

**Read-only, always.** The server opens the database with `readOnly: true`. An assistant should never be able to mutate the library through it.

**Clamp every input.** A negative `limit` clamps to 1 rather than becoming unlimited. FTS5 columns have no type affinity, so string ids are coerced before use.

**Never crash on bad input.** A raw `null` line must not kill the process; unknown tools return a protocol error (`-32602`); a missing required argument returns a message explaining what was expected. All of these are pinned by the self-check.

**Never ship a number you have not verified.** An earlier version reported a cue count per lesson that was always `0`, because it counted transcript rows keyed on the *video's* id while cues key to the *subtitle* file. The field was removed rather than shipped wrong.

## Next steps

- [Learn: courses and transcripts](learn.md) — where the cues come from
- [The database](database.md) — the index the oracle reads
- [Mirror vendor docs for agents](../guides/mirror-vendor-docs.md) — build `docs.db`
