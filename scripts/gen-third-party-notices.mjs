#!/usr/bin/env node
// Generate THIRD-PARTY-NOTICES.md — the aggregated attribution file that ships
// inside the packaged app.
//
//   node scripts/gen-third-party-notices.mjs            # write THIRD-PARTY-NOTICES.md
//   node scripts/gen-third-party-notices.mjs --check    # fail if it is stale/out-of-date
//
// WHY this exists: the packaged binary bundles the Inter + JetBrains Mono fonts
// (SIL OFL 1.1) and ~200 npm packages (mostly MIT/ISC/BSD/Apache, plus one
// LGPL libvips binary used by sharp). The MIT/BSD/Apache/OFL licenses all
// REQUIRE their copyright + license text to travel with binary redistributions,
// and electron-builder's `files` block deliberately strips LICENSE files out of
// node_modules to keep the asar small. This script re-aggregates every notice
// into one file so the shipped app stays compliant.
//
// Dependency-free by design: it walks the PRODUCTION dependency tree using
// nothing but `node:fs`/`node:path`, so it runs on a clean checkout with no
// extra install step and cannot drift from a license-collector library's quirks.
//
// HOW the walk works: starting from the root package.json `dependencies` (NOT
// devDependencies), it resolves each package the classic Node way — walk up
// `node_modules` directories looking for `node_modules/<name>/package.json`,
// following pnpm's symlinks via realpath. From each resolved package it recurses
// into that package's own dependencies/optionalDependencies/peerDependencies,
// resolving them from the package's own location. Because it only follows what
// is physically present in node_modules, it naturally captures exactly the
// host-platform binaries that ship (e.g. @img/sharp-darwin-arm64 +
// @img/sharp-libvips-darwin-arm64) and skips the foreign-platform optional
// binaries that do not.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');
const CHECK = process.argv.includes('--check');

function log(msg) {
  console.log(`[notices] ${msg}`);
}

// Candidate license-text filenames, in rough order of preference. Matched
// case-insensitively against each package's top-level directory listing.
const LICENSE_FILENAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENSE-MIT',
  'LICENSE-MIT.txt',
  'LICENSE.BSD',
  'LICENSE.APACHE',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
  'NOTICE',
  'NOTICE.md',
  'NOTICE.txt',
];

// Read a package's package.json, tolerating malformed/missing files.
function readPkgJson(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Classic node_modules resolution that ignores `exports` maps (so it always
// finds package.json) and follows pnpm symlinks via realpath. Returns the real
// directory of `name` as seen from `fromDir`, or null if unresolved.
function resolvePkgDir(name, fromDir) {
  let dir;
  try {
    dir = realpathSync(fromDir);
  } catch {
    return null;
  }
  while (true) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Normalize a package.json `license`/`licenses` value to a single SPDX-ish id.
function licenseId(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  // Deprecated object form: { "type": "MIT", "url": "…" }.
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) {
    return pkg.license.type;
  }
  // Deprecated array form: [{ "type": "MIT" }, …].
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    return pkg.licenses
      .map((l) => (typeof l === 'string' ? l : l?.type))
      .filter(Boolean)
      .join(' OR ');
  }
  return null;
}

// Find and read the first matching license-text file in a package directory.
function readLicenseText(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const wanted of LICENSE_FILENAMES) {
    const actual = lower.get(wanted.toLowerCase());
    if (actual) {
      try {
        const text = readFileSync(join(dir, actual), 'utf8').trim();
        if (text) return { file: actual, text };
      } catch {
        /* unreadable — keep looking */
      }
    }
  }
  return null;
}

// Walk the production dependency tree starting from the root package.json
// `dependencies`. Returns a Map keyed by `name@version`.
function collectProdPackages() {
  const rootPkg = readPkgJson(ROOT);
  if (!rootPkg) throw new Error('cannot read root package.json');
  const collected = new Map();

  function visit(name, fromDir) {
    const dir = resolvePkgDir(name, fromDir);
    if (!dir) return;
    const pkg = readPkgJson(dir);
    if (!pkg || !pkg.name) return;
    const key = `${pkg.name}@${pkg.version}`;
    if (collected.has(key)) return;

    const id = licenseId(pkg);
    const license = readLicenseText(dir);
    collected.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: id,
      licenseFile: license ? license.file : null,
      licenseText: license ? license.text : null,
      homepage:
        pkg.homepage ||
        (pkg.repository &&
          (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url)) ||
        null,
      dir,
    });

    // Recurse into everything physically resolvable from this package: runtime
    // deps, optional native-binary deps, and satisfied peer deps. Whatever
    // resolves here is what is actually present in node_modules and therefore
    // what electron-builder can pack.
    const children = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    for (const child of Object.keys(children)) visit(child, dir);
  }

  for (const dep of Object.keys(rootPkg.dependencies || {})) visit(dep, ROOT);
  return collected;
}

// The bundled webfonts ship from the @fontsource-variable/* packages (imported
// in renderer-react/src/main.tsx); both are SIL OFL 1.1. We attribute them
// explicitly here — by font family, not just by npm package — so the OFL's
// "copyright notice + license must travel with the fonts" condition is met in a
// form a human reader recognizes.
const BUNDLED_FONTS = [
  {
    family: 'Inter',
    designer: 'The Inter Project Authors',
    source: 'https://github.com/rsms/inter',
    license: 'OFL-1.1',
    pkg: '@fontsource-variable/inter',
    note: 'Bundled as the UI sans-serif (--font-sans / --font-display).',
  },
  {
    family: 'JetBrains Mono',
    designer: 'The JetBrains Mono Project Authors',
    source: 'https://github.com/JetBrains/JetBrainsMono',
    license: 'OFL-1.1',
    pkg: '@fontsource-variable/jetbrains-mono',
    note: 'Bundled as the monospace UI face (--font-mono).',
  },
];

function fontSection(packages) {
  const lines = [];
  lines.push('## Bundled fonts');
  lines.push('');
  lines.push(
    'The packaged application embeds the following typefaces, licensed under ' +
      'the SIL Open Font License, Version 1.1. The full OFL-1.1 text for each is ' +
      'reproduced from its npm package below.',
  );
  lines.push('');
  const fontManifest = JSON.parse(readFileSync(join(ROOT, 'font-licenses.json'), 'utf8'));
  const notices = [...new Set(fontManifest.fonts.map((font) => font.license))];
  for (const notice of notices) {
    lines.push('### Self-hosted font (' + notice.split('/').pop().replace('-OFL.txt', '') + ')');
    lines.push('');
    lines.push('```');
    lines.push(readFileSync(join(ROOT, notice), 'utf8'));
    lines.push('```');
    lines.push('');
  }
  for (const font of BUNDLED_FONTS) {
    lines.push(`### ${font.family} (${font.license})`);
    lines.push('');
    lines.push(`- Designer / Copyright: ${font.designer}`);
    lines.push(`- Source: ${font.source}`);
    lines.push(`- npm package: \`${font.pkg}\``);
    lines.push(`- ${font.note}`);
    lines.push('');
    // Re-use the OFL text from the resolved fontsource package so the copyright
    // header (which names the actual font authors) is exact, not paraphrased.
    const match = [...packages.values()].find((p) => p.name === font.pkg);
    if (match?.licenseText) {
      lines.push('```');
      lines.push(match.licenseText);
      lines.push('```');
    } else {
      lines.push(
        '_License text not found on disk; see ' +
          'https://scripts.sil.org/OFL for the full SIL Open Font License 1.1._',
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function dependencySection(packages) {
  const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));

  const lines = [];
  lines.push('## Bundled npm packages');
  lines.push('');
  lines.push(
    `The packaged application bundles the ${sorted.length} production ` +
      'dependencies listed below. Each entry gives the package name, version, ' +
      'SPDX license identifier, and — where the package ships one — its full ' +
      'license text. First-party Omnidex code is covered by the root ' +
      '[LICENSE](./LICENSE) (MIT).',
  );
  lines.push('');

  // Summary table.
  lines.push('| Package | Version | License |');
  lines.push('| --- | --- | --- |');
  for (const p of sorted) {
    lines.push(`| \`${p.name}\` | ${p.version} | ${p.license || 'See below'} |`);
  }
  lines.push('');

  // Full text per package.
  lines.push('### Full license texts');
  lines.push('');
  for (const p of sorted) {
    lines.push(`#### ${p.name}@${p.version}`);
    lines.push('');
    lines.push(`- License: ${p.license || 'UNKNOWN — see source repository'}`);
    if (p.homepage) lines.push(`- Homepage: ${p.homepage}`);
    lines.push('');
    if (p.name === '@omnidex/uasset') {
      lines.push('First-party Omnidex package; covered by the root [LICENSE](./LICENSE) (MIT).');
    } else if (p.licenseText) {
      lines.push(`<details><summary>${p.licenseFile}</summary>`);
      lines.push('');
      lines.push('```');
      lines.push(p.licenseText);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
    } else {
      lines.push(
        '_No license file shipped in this package. License is declared as ' +
          `\`${p.license || 'unknown'}\` in its package.json; consult the ` +
          'package homepage for the full terms._',
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function render(packages) {
  const generatedNote =
    '<!-- GENERATED FILE — do not edit by hand. Run `pnpm notices` to regenerate. -->';
  const header = [
    generatedNote,
    '',
    '# Third-party notices',
    '',
    'Omnidex is distributed as a packaged Electron application. The binary ' +
      'embeds open-source fonts and npm packages whose licenses require their ' +
      'copyright and permission notices to be redistributed alongside the ' +
      'software. This file aggregates those notices.',
    '',
    'It is generated by `scripts/gen-third-party-notices.mjs` from the ' +
      'production dependency tree and the bundled fonts. Regenerate it with ' +
      '`pnpm notices` whenever dependencies change; the macOS and Windows ' +
      'packaging scripts also regenerate it automatically before each ' +
      'installer build.',
    '',
    '---',
    '',
  ].join('\n');

  return [header, fontSection(packages), '---', '', dependencySection(packages), '']
    .join('\n')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

function main() {
  const packages = collectProdPackages();
  log(`walked ${packages.size} production packages`);
  const content = render(packages);

  if (CHECK) {
    const existing = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (existing !== content) {
      console.error(
        '[notices] THIRD-PARTY-NOTICES.md is out of date. Run `pnpm notices` and commit the result.',
      );
      process.exit(1);
    }
    log('THIRD-PARTY-NOTICES.md is up to date.');
    return;
  }

  writeFileSync(OUTPUT, content);
  log(`wrote ${OUTPUT} (${packages.size} packages + ${BUNDLED_FONTS.length} fonts)`);
}

main();
