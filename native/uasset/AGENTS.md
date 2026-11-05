# AGENTS.md: native/uasset

Rust napi-rs addon that parses Unreal `.uasset`/`.umap` package headers and extracts embedded thumbnails. The root [`AGENTS.md`](../../AGENTS.md) still applies.

## Commands

Run from this directory:

```bash
cargo test
cargo clippy --all-targets
```

Then, from the repo root, `pnpm build:uasset` rebuilds the `.node` binary the app loads.

## Rules

- Input is hostile. Files come from downloaded marketplace packs. No `unwrap`/`expect` outside tests, no unchecked slice indexing, and every length, count or dimension read from the file is capped before it drives an allocation or a loop.
- `image::load_from_memory` applies no dimension limit, so a small PNG or JPEG can declare a huge canvas. New decoding code uses `image::ImageReader` with `image::Limits`; move existing calls over when you touch them.
- A panic or `abort()` here crashes the worker process. Return a `Parse` error instead.
- `index.js` and `index.d.ts` are committed; `*.node` is not. If you change the exported surface, regenerate both and update callers in `electron/main/`.
- New parsing paths need a test that feeds truncated and corrupted input, not only a well-formed file.
