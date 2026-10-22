import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'font-licenses.json'), 'utf8'));
const errors = [];
const known = new Set();
for (const font of manifest.fonts) {
  known.add(font.file);
  const path = resolve(root, font.file);
  if (!existsSync(path)) {
    errors.push(`Missing font: ${font.file}`);
    continue;
  }
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (hash !== font.sha256) errors.push(`Font changed without license verification: ${font.file}`);
  const notice = resolve(root, font.license);
  if (
    !existsSync(notice) ||
    !readFileSync(notice, 'utf8').includes('SIL OPEN FONT LICENSE Version 1.1')
  ) {
    errors.push(`Missing OFL notice: ${font.file}`);
  } else if (
    createHash('sha256').update(readFileSync(notice)).digest('hex') !== font.licenseSha256
  ) {
    errors.push(`License notice changed: ${font.license}`);
  }
}
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      [
        'node_modules',
        '.git',
        '.claude',
        '.planning',
        '.trees',
        'dist',
        'build',
        'book',
        'target',
        '.next',
        '.astro',
        '.harness-out',
        'out',
        '.wrangler',
      ].includes(entry.name)
    )
      continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(woff2?|otf|ttf|eot)$/i.test(entry.name)) {
      const file = relative(root, path).replaceAll('\\', '/');
      if (!known.has(file)) errors.push(`Unverified font: ${file}`);
    }
  }
}
walk(root);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Font licenses verified: ${known.size} files, SHA256 and bundled OFL notices.`);
