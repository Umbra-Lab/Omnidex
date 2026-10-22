# omnidex-uasset (napi-rs)

Native Rust addon for `.uasset` binary parsing, consumed by the Electron main process.
This is the one Rust crate retained after the Tauri → Electron migration.

## Status: Phase 0 scaffold

Exposes a napi surface (`parse_uasset`, `extract_thumbnail`) but does not yet implement
the full thumbnail extraction pipeline. That port lands in Phase 2, copying behavior
from `src-tauri/src/uasset_parser/thumbnail_extractor.rs` verbatim and validating
against fixture `.uasset` files.

## Build

```
cd native/uasset
pnpm install
pnpm build
```

Produces a platform-specific `.node` binary. In CI, `@napi-rs/cli`'s `napi prepublish`
packages per-triple artifacts for `x86_64-pc-windows-msvc`, `x86_64-apple-darwin`,
`aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`.

## Usage (main process)

```ts
import { parseUasset, extractThumbnail } from '@omnidex/uasset';

const header = parseUasset('/path/to/Asset.uasset');
const pngPath = await extractThumbnail('/path/to/Asset.uasset', cacheDir, 256);
```
