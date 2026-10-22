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
| `search_assets` | "Do I already own something for this?" — the pack library, BM25 over `assets_fts` |

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

`ORACLE_DB` defaults to the standard `%APPDATA%/omnidex/omnidex.db` location.

## Verify it

```bash
node scripts/oracle-mcp/server.test.mjs
```

```
OK — 115 courses, search 2ms, context 1ms
```

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
