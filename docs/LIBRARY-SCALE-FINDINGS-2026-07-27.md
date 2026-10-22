# Library-scale findings — real 5.7 TB library audit

Source: a full WizTree/MFT audit of the primary UE library while planning a disk
reorganization. Every number here is measured against real data, not synthetic.

**The library:** 5,770 GB, 1.30M files, 273k folders on E:, plus ~1.1 TB more
spread across three other drives. Omnidex currently indexes **1,277 assets** from it.

The headline: what looked like Omnidex bugs (duplicate cards, blank thumbnails)
were mostly the library's shape. But the audit exposed several real defects and
one significant product gap.

---

## 1. Product gap — the scanner never reports what it skipped

**The single highest-value item here.**

The user believed Omnidex had a duplicate/thumbnail problem. It doesn't. It has a
*silence* problem: it encountered 611 archive-only folders, packs buried past
`MAX_PACK_SEARCH_DEPTH`, and 859 redundant folder wrappers, and reported none of
it. It rendered 1,277 cards, some blank, and let the user assume that was the
whole library.

`findPackFolders` in `electron/main/scanner/walker.ts` already computes everything
needed and throws it away:

```ts
if (depth >= MAX_PACK_SEARCH_DEPTH) {
  if (await subtreeHasUasset(dir, 2)) { packs.push(dir); return true; }
  return false;                      // <- silently drops the folder
}
```

**Proposal: a Library Health view.** Emit scan diagnostics and surface them:

- folders containing only archives (611 on E: alone) — not extracted
- folders abandoned at the depth limit
- packs sharing a product ID across engine versions (duplicate cards)
- thumbnail failures, bucketed by cause: no `.uasset` / too deep / archive-only
- paths within 20 chars of `MAX_PATH`

No other UE asset manager does this. For a hoarded library it's the difference
between a browser and a librarian.

---

## 2. Defect — `MAX_FILES_PER_PACK` silently truncates size on disk

`walker.ts`:

```ts
const MAX_FILES_PER_PACK = 5000;
const MAX_DEPTH_PER_PACK = 8;
```

`walkRecursive` returns early once the cap is hit, so `fileSize` is wrong for any
pack above it. Measured against `Assets\Organized` (1,256 pack folders):

| | |
|---|---|
| packs exceeding 5,000 files | **29** (2.3%) |
| their true size on disk | **247.6 GB** — all under-reported |

Worst cases:

```
 8,173 files   26.7 GB  Complete Projects\Hyper Multiplayer Survival Template Pro
12,549 files   18.4 GB  Environments\Castle Grimguard (Night Day)
 8,238 files   13.0 GB  Textures & Materials\MARS Master Material
12,752 files   10.7 GB  Environments\City Streets - Modular Pack
12,631 files    9.8 GB  Code Plugins\Ascent Combat Framework Ultimate
```

The cap exists because the walker issues one `fs.stat` per file. Fix the scanner
(item 4) and the cap can simply be deleted.

---

## 3. Defect — thumbnails are impossible for non-UE packs

`electron/main/scanner/thumbnail-finder.ts` only ever looks for `.uasset`:

```ts
if (entry.isFile() && entry.name.toLowerCase().endsWith('.uasset')) {
  return join(dir, entry.name);
}
```

Packs shipping FBX/OBJ/Blend source — 757 GB in this library from BigMediumSmall
alone — can never get a thumbnail, no matter how the folders are arranged. Most
such packs include a preview image at or near the root.

**Fix:** before returning `null`, fall back to the largest `.png`/`.jpg`/`.webp`
in the pack. Small change, and it covers every non-UE pack in the library.
Highest value-per-effort item in this document.

---

## 4. Performance — scanning should read the MFT, not walk the tree

`walkRoot` runs `readdir` + one `fs.stat` per file at `CONCURRENCY = 8`. Against
1.3M files that is punishing, and it forces the caps in item 2.

WizTree scanned the same 273k-folder tree in **under a minute** by reading the
NTFS MFT directly. A `Get-ChildItem` recursion over the same tree did not finish
in ten minutes.

This is architecturally cheap for us: `native/uasset` is already a Rust napi-rs
addon (napi 3.8), so an MFT reader follows a pattern already solved and built.

**Follow-up:** the **USN change journal** turns rescans incremental — read what
changed since the last sequence number instead of re-walking. For a 5.7 TB
library that is the difference between minutes and instant.

Benefits: exact sizes, no caps, no truncation, near-instant rescans.

---

## 5. Feature — Duplicates view

Measured across the four library locations: **1,037 GB of duplicate data**,
49,150 groups, 117,091 files.

The important part is that duplicates split into two kinds that need *opposite*
treatment:

| Kind | Size | Correct action |
|---|---|---|
| Same pack filed in two places | 640.6 GB | delete redundant copies |
| Engine/starter content shipped inside many packs | 396.6 GB | **hardlink — deleting breaks packs** |

`HDRI_Epic_Courtyard_Daylight.uasset` appears **15 times** because fifteen packs
legitimately ship Epic's starter content. A naive dedupe tool destroys fourteen
packs. An asset manager that understands pack boundaries can tell the difference —
that is a genuine differentiator over any generic dedupe utility.

**Proposal:** group by content hash, show *"Spiders pack — 3 copies · 12.4 GB
reclaimable"* with `[keep newest]` and `[hardlink]` actions.

Pipeline shape is known-good (built and run during the audit): name+size grouping
off the manifest → SHA-256 confirm only the candidates → cluster. Hashing every
file is days; hashing candidates is hours.

---

## 6. Feature — archives as a first-class state

**611 archive-only folders on E: (537 GB), 844 archives / 706 GB across all drives.**
Each currently renders as a card with no thumbnail and a mangled name, because
there is no `.uasset` to find.

**Proposal:** detect `.rar`/`.zip`/`.7z`, run `7z l` to read the listing *without
extracting*, and render *"Not extracted · 4.2 GB · 18 parts"* with an Extract
action.

Two details that matter, both learned the hard way during the audit:

- **Multi-part sets** must collapse to one entry. Only the first part is passed to
  7-Zip; it pulls in the rest. Testing each part separately reports spurious
  failures. Working skip pattern:
  `\.part(?!0*1\.)\d+\.rar$|\.r\d\d$|\.z\d\d$|\.\d{3}$`
- **Integrity is not free.** A `7z t` pass over C:/D:/F: found **14 genuinely
  corrupt archives** (CRC Failed / Data Error), plus 18 `__MACOSX` AppleDouble
  stubs that always fail and should be ignored rather than reported.

---

## 7. Already-stored data that is never displayed

`supported_versions` — populated by both `fab/enrich.ts` and
`orbital/product-mapping.ts`, defined in
`20260125120000_normalize_asset_schema.up.sql:115`, and referenced **nowhere** in
`renderer-react`.

Surfacing *"Supports 4.26 – 5.3 · you have 5.3"* is what makes it safe to keep a
single engine version on disk instead of one folder per version — which is the
root cause of duplicate cards like `VR Swords and Slicing System` /
`VRSwordsandSlicingSystem4.26` / `VRSwordsandSlicingSystem4.27`.

---

## 8. Environment note — long paths

**594,815 files exceed 240 characters; the longest is 610**, past the 260-char
`MAX_PATH` limit.

Verified on the target machine: `LongPathsEnabled = 1`, and
`[System.IO.File]::Open` succeeds on the 610-char path under both PowerShell 5.1
(5.1.26100) and 7.6.4. Node/Electron on Windows handles long paths through the
same mechanism.

Worth an explicit test case — a library this deep is exactly where a naive
`path.join` + native API call fails on other machines where the policy is off.

---

## Suggested order

1. **Thumbnail image fallback** (§3) — tiny, unlocks every non-UE pack
2. **Library Health view** (§1) — mostly surfacing data already computed
3. **`supported_versions` in inspector** (§7) — data is already in the DB
4. **Duplicates view** (§5)
5. **Archive state** (§6)
6. **MFT + USN scanning** (§4) — biggest win, biggest job; retires §2
