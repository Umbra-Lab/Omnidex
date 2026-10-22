// Run the Electron scanner walker against a real directory without spinning up
// the Electron runtime. Useful for validating pipeline parity vs the Tauri
// scanner on a known asset library.
//
//   node scripts/smoke-scan.mjs <path>
//
// Prints one line per detected asset folder with (name, size-in-MB, file-count,
// hasUassetFiles) plus a summary. No DB writes, no IPC.

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const UASSET_EXTENSIONS = new Set(['.uasset', '.umap']);
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.vs',
  'Intermediate',
  'DerivedDataCache',
  'Build',
  'Saved',
  'Binaries',
]);

async function walkRecursive(dir, stats) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      await walkRecursive(full, stats);
    } else if (entry.isFile()) {
      try {
        const info = await stat(full);
        stats.size += info.size;
        stats.count += 1;
      } catch {
        continue;
      }
      if (!stats.hasUasset) {
        const dot = entry.name.lastIndexOf('.');
        if (dot >= 0) {
          const ext = entry.name.slice(dot).toLowerCase();
          if (UASSET_EXTENSIONS.has(ext)) stats.hasUasset = true;
        }
      }
    }
  }
}

async function walkRoot(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = entries.filter(
    (entry) =>
      entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED_DIR_NAMES.has(entry.name),
  );

  const CONCURRENCY = 8;
  const results = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (entry) => {
        const absolutePath = join(root, entry.name);
        const stats = { size: 0, count: 0, hasUasset: false };
        await walkRecursive(absolutePath, stats);
        return {
          name: entry.name,
          absolutePath,
          fileSize: stats.size,
          fileCount: stats.count,
          hasUassetFiles: stats.hasUasset,
        };
      }),
    );
    results.push(...resolved);
  }
  return results;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/smoke-scan.mjs <path>');
    process.exit(1);
  }
  const root = resolve(target);
  console.log(`Scanning: ${root}\n`);

  const start = Date.now();
  const folders = await walkRoot(root);
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);

  let totalSize = 0;
  let totalFiles = 0;
  let uassetCount = 0;
  for (const folder of folders) {
    const sizeMb = (folder.fileSize / 1024 / 1024).toFixed(1);
    const flag = folder.hasUassetFiles ? '[UE]' : '    ';
    console.log(
      `${flag} ${sizeMb.padStart(10)} MB  ${String(folder.fileCount).padStart(6)} files  ${folder.name}`,
    );
    totalSize += folder.fileSize;
    totalFiles += folder.fileCount;
    if (folder.hasUassetFiles) uassetCount += 1;
  }

  console.log(
    `\nTotal: ${folders.length} folders (${uassetCount} UE), ` +
      `${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB across ${totalFiles} files, ` +
      `${elapsed}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
