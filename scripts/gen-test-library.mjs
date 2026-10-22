// Generate an on-disk UE asset library of REAL marketplace packs for testing
// Omnidex end-to-end: scanner pack-detection, Orbital Market matching, and the
// enrichment pipeline (search -> product detail -> DB).
//
//   node scripts/gen-test-library.mjs [outDir]      (default: ./test-library)
//
// Every folder name below is a genuine product on orbital-market.com (which
// mirrors the Fab / old Unreal Engine Marketplace catalog). Each name was
// verified to (a) return its intended slug as a top search hit through the
// matcher's cleanAssetName() pipeline, and (b) resolve on the product-detail
// endpoint — so a scan of this folder produces real titles, sellers, prices,
// ratings, descriptions, and thumbnail URLs, not fabricated data.
//
// Folder shapes exercise all three scanner pack-detection branches plus the
// folder-style fallback:
//   - content   : a Content/<Category>/ tree with .uasset/.umap files
//   - categories: 2+ bare UE interior category folders (Blueprints/Materials/…)
//   - loose      : no UE markers — recorded as a folder-style asset
//
// Deliberately messy names (version suffixes, separators, [brackets]) confirm
// cleanAssetName() still lands the match.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// folder = on-disk name (as a user would have it) ; slug = expected Orbital hit.
// The marketplace entries below were pulled live from orbital-market.com's
// popularity-sorted search and each folder name was re-verified to return its
// slug within the top results — so a scan + enrich yields real titles, sellers,
// prices, ratings, and Fab thumbnail URLs. Regenerate with scripts/refresh-popular.mjs.
const PACKS = [
  // --- 3d-model (orbital category) ---
  {
    folder: "SciFi Dark Fantasy Environment — 'The Orb",
    slug: 'scifi-environment-the-orb',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'Stylized Japan Environment',
    slug: 'stylized-asian-environment-stylized-fantasy-japanese-open-world-environment',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'Watermills / Nature Environment',
    slug: 'watermills-nature-environment',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'Buddhist Monastery Environment',
    slug: 'buddhist-monastery-environment',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'Procedural Oak Forest',
    slug: 'procedural-oak-forest-winter-forest-spring-forest-autumn-forest',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'Forest Essentials',
    slug: 'forest-essentials-forest-environment-procedural-mountain-forest-landscape-',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'Fantasy Forest',
    slug: 'fantasy-forest-magic-forest-elven-forest-stylized-forest-forest',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'FOREST Stylized Forest Pack',
    slug: 'forest-stylized-forest-pack-forest-assets-forest-foliage-forest-landscape',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'City Bus',
    slug: 'city-bus',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'City Core',
    slug: 'city-core-post-soviet-city',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  {
    folder: 'Modern City Downtown Megapack',
    slug: 'modern-city-downtown-megapack-modern-modular-urban-buildings',
    shape: 'content',
    cats: ['Meshes', 'Materials', 'Textures'],
  },
  // --- material (orbital category) ---
  {
    folder: 'Brushify',
    slug: 'brushify-environment-shaders-pack',
    shape: 'categories',
    cats: ['Materials', 'Textures'],
  },
  {
    folder: 'terrain materials" pack of 21 materials',
    slug: 'terrain-materials-pack-of-21-materials',
    shape: 'categories',
    cats: ['Materials', 'Textures'],
  },
  {
    folder: '56 Fabric & Textile Materials',
    slug: 'fabric-materials-56-4k-pbr-pack',
    shape: 'categories',
    cats: ['Materials', 'Textures'],
  },
  {
    folder: 'Urban Material Pack',
    slug: 'urban-material-pack',
    shape: 'categories',
    cats: ['Materials', 'Textures'],
  },
  // --- game-system (orbital category) ---
  {
    folder: 'City Traffic Pro',
    slug: 'city-traffic-pro',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Character Interaction',
    slug: 'character-interaction',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Drivable Cars: Advanced Multiplayer Vehicles',
    slug: 'drivable-cars-advanced-multiplayer-pack',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Ridable Bikes: Advanced Multiplayer Vehicles',
    slug: 'ridable-motorbikes-multiplayer-advanced-pack-3-bikes-damage-animations',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Open World Audio System',
    slug: 'open-world-audio-system',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Horror Engine SE',
    slug: 'horror-engine-se',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Horror Security Camera System',
    slug: 'horror-security-camera-system',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Hyper Interactive Foliage v4',
    slug: 'hyper-interactive-foliage-v2',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Calysto Dungeon Procedural dungeon with PCG',
    slug: 'massive-dungeon-procedural-dungeon-with-pcg-and-substrate',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Modular Spaceship Construction Kit',
    slug: 'modular-spaceship-construction-kit',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  {
    folder: 'Stoopid Zombies',
    slug: 'stoopid-zombies',
    shape: 'categories',
    cats: ['Blueprints', 'Maps'],
  },
  // --- vfx (orbital category) ---
  {
    folder: 'Melee Weapon Aura VFX',
    slug: 'melee-weapon-aura-vfx-energy-auras-glowing-effects-for-melee-weapons',
    shape: 'content',
    cats: ['Materials', 'Textures', 'Blueprints'],
  },
  {
    folder: 'Character VFX Material',
    slug: 'character-vfx-material-support-overlay-material-',
    shape: 'content',
    cats: ['Materials', 'Textures', 'Blueprints'],
  },
  {
    folder: 'Realistic Blood VFX',
    slug: 'realistic-blood-vfx-niagara-blood-effects-gore-effects-blood',
    shape: 'content',
    cats: ['Materials', 'Textures', 'Blueprints'],
  },
  {
    folder: 'Ultimate Niagara VFX Bundle',
    slug: 'ultimate-niagara-vfx-bundle-blood-vfx-gun-vfx-smoke-vfx-fog-vfx-vfx',
    shape: 'content',
    cats: ['Materials', 'Textures', 'Blueprints'],
  },
  {
    folder: 'Realistic Fire VFX',
    slug: 'realistic-fire-vfx-niagara-fire-vfx-flame-vfx-fireplace-vfx-torch-vfx-fire',
    shape: 'content',
    cats: ['Materials', 'Textures', 'Blueprints'],
  },
  {
    folder: 'Niagara AOE Magic Abilities',
    slug: 'niagara-aoe-magic-abilities-niagara-magic-vfx-spell-vfx-ability-vfx',
    shape: 'content',
    cats: ['Materials', 'Textures', 'Blueprints'],
  },
  {
    folder: 'Niagara Muzzle Flash & Ejection VFX',
    slug: 'niagara-muzzle-flash-ejection-vfx-muzzle-flash-gun-vfx-bullet-vfx',
    shape: 'content',
    cats: ['Materials', 'Textures', 'Blueprints'],
  },
  // --- tool-and-plugin (orbital category) ---
  {
    folder: 'Advanced Vehicle System',
    slug: 'advanced-vehicle-system',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'R-Tune Vehicle Physics 2.0',
    slug: 'r-tune-vehicle-physics',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Advanced Cars And Bikes System',
    slug: 'advanced-cars-and-bikes-system-vehicle-physics-vehicle-system-drift-police',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Online Material Library',
    slug: 'online-material-library-1500-one-click-materials',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Generic Movement System',
    slug: 'generic-movement-system-a-powerful-movement-control-and-locomotion-system',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Logic Driver Pro',
    slug: 'logic-driver-pro-dialogue-quests-combat-systems-and-more-in-blueprints',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Generic Gameplay Ability System',
    slug: 'generic-gameplay-ability-system-gas-for-blueprint-users-no-c-required',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Generic Combat System',
    slug: 'generic-combat-system-advanced-gas-based-multiplayer-combat-framework',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'ANIM MOD TOOL [Animation Modifier: blend',
    slug: 'anim-mod-tool-animation-modifier-blend-mirror-reverse-animations-and-mocap',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Actor animator',
    slug: 'actor-animator-animate-any-actor-using-curves-and-splines',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Landscaping',
    slug: 'landscaping',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  {
    folder: 'Ocean ology Legacy',
    slug: 'oceanology-legacy',
    shape: 'categories',
    cats: ['Blueprints', 'Materials'],
  },
  // --- ui (orbital category) ---
  {
    folder: 'OG Main Menu System',
    slug: 'main-menu-system-pro-by-og',
    shape: 'categories',
    cats: ['Blueprints', 'Textures'],
  },
  // --- animation (orbital category) ---
  {
    folder: 'Customizable Arm Animations',
    slug: 'customizable-shooter-arms-animations',
    shape: 'content',
    cats: ['Animations', 'Characters'],
  },
  {
    folder: '105 Zombie Animations Mocap',
    slug: '105-zombie-animations-mocap-281-bonus-zombie-audio',
    shape: 'content',
    cats: ['Animations', 'Characters'],
  },
  // --- audio (orbital category) ---
  {
    folder: 'Ultimate Music Bundle',
    slug: 'ultimate-music-bundle-game-music-bundle-113-music-tracks',
    shape: 'content',
    cats: ['Blueprints'],
  },
  {
    folder: 'RPG Music',
    slug: 'rpg-music-fantasy-music-cinematic-music-game-music-background-music',
    shape: 'content',
    cats: ['Blueprints'],
  },
  {
    folder: 'Mega Game Music Collection',
    slug: 'mega-game-music-collection',
    shape: 'content',
    cats: ['Blueprints'],
  },
  {
    folder: 'Action Music',
    slug: 'action-music-thriller-music-shooter-music',
    shape: 'content',
    cats: ['Blueprints'],
  },
  // --- game-template (orbital category) ---
  {
    folder: 'Modern Survival Horror Framework',
    slug: 'modern-survival-horror-framework',
    shape: 'content',
    cats: ['Blueprints', 'Maps', 'Characters'],
  },
  {
    folder: 'FPS Zombie Starter Kit',
    slug: 'fps-zombie-starter-kit',
    shape: 'content',
    cats: ['Blueprints', 'Maps', 'Characters'],
  },

  // --- Loose, non-marketplace folders: recorded as folder-style assets and
  //     NOT matched on Orbital (exercises the unmatched path). ---
  {
    folder: 'UE5 Lighting Tutorial (YouTube)',
    slug: null,
    shape: 'loose',
    files: ['01-intro.mp4', '02-lumen.mp4', 'notes.pdf'],
  },
  {
    folder: 'My Greybox Blockout',
    slug: null,
    shape: 'loose',
    files: ['blockout.fbx', 'reference.png'],
  },
];

const UE_CATEGORY_FOLDERS = new Set([
  'Blueprints',
  'Materials',
  'Textures',
  'Meshes',
  'Characters',
  'Animations',
  'Maps',
]);

function placeholderUasset(label) {
  // Minimal byte payload so file_size > 0. Not a real .uasset header — the
  // scanner detects by extension; thumbnail extraction simply skips it.
  return Buffer.from(`OMNIDEX-TEST-PLACEHOLDER:${label}\n`);
}

function writeAssetFiles(dir, cat, i) {
  mkdirSync(dir, { recursive: true });
  const ext = cat === 'Maps' ? '.umap' : '.uasset';
  const prefix =
    cat === 'Meshes'
      ? 'SM_'
      : cat === 'Materials'
        ? 'M_'
        : cat === 'Textures'
          ? 'T_'
          : cat === 'Blueprints'
            ? 'BP_'
            : cat === 'Characters'
              ? 'SK_'
              : cat === 'Animations'
                ? 'AS_'
                : '';
  for (let n = 1; n <= 2; n++) {
    const file = join(dir, `${prefix}${cat}_${i}_${n}${ext}`);
    writeFileSync(file, placeholderUasset(`${cat}/${i}/${n}`));
  }
}

/**
 * Strip characters Windows forbids in a path segment: < > : " / \ | ? * and
 * trailing dots/spaces.
 *
 * One entry above carries a stray double quote as a deliberately-messy name.
 * A quote is legal on macOS and Linux and IMPOSSIBLE on Windows, so this script
 * — a documented helper, `pnpm gen:test-library` — crashed with ENOENT on the
 * platform the app actually ships an installer for. Sanitizing here rather than
 * editing the entry keeps one corpus across all three platforms, which is the
 * point of a fixture; the messy-name coverage that still matters (version
 * suffixes, separators, brackets, mixed case) is all legal everywhere and is
 * untouched.
 */
function safeSegment(name) {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/[. ]+$/, '');
}

function buildPack(root, pack, idx) {
  const packDir = join(root, safeSegment(pack.folder));
  mkdirSync(packDir, { recursive: true });

  if (pack.shape === 'loose') {
    for (const f of pack.files ?? ['readme.txt']) {
      writeFileSync(join(packDir, f), `placeholder: ${f}\n`);
    }
    return { type: 'folder (loose)', files: (pack.files ?? []).length };
  }

  let fileCount = 0;
  if (pack.shape === 'content') {
    // Content/<Category>/<files> — satisfies the "Content/ subdirectory" branch.
    for (const cat of pack.cats) {
      writeAssetFiles(join(packDir, 'Content', cat), cat, idx);
      fileCount += 2;
    }
  } else if (pack.shape === 'categories') {
    // Bare top-level category folders — satisfies the "2+ UE category folders"
    // branch. Drop a .uasset only in the first so detection also covers the
    // direct-file branch.
    pack.cats.forEach((cat, i) => {
      const dir = join(packDir, cat);
      mkdirSync(dir, { recursive: true });
      if (i === 0) {
        writeAssetFiles(dir, cat, idx);
        fileCount += 2;
      }
    });
  }
  return { type: 'unreal_pack', files: fileCount };
}

function main() {
  const outDir = resolve(process.argv[2] ?? './test-library');
  mkdirSync(outDir, { recursive: true });

  console.log(`Generating Omnidex test library at:\n  ${outDir}\n`);
  let unrealPacks = 0;
  let looseFolders = 0;
  let totalFiles = 0;

  PACKS.forEach((pack, idx) => {
    const r = buildPack(outDir, pack, idx);
    totalFiles += r.files;
    if (r.type === 'unreal_pack') unrealPacks++;
    else looseFolders++;
    const slug = pack.slug ? `→ orbital:${pack.slug}` : '(no match expected)';
    console.log(`  [${r.type.padEnd(14)}] ${pack.folder.padEnd(40)} ${slug}`);
  });

  // Sanity: every 'categories' pack must keep ≥2 recognised UE folders.
  for (const pack of PACKS) {
    if (pack.shape === 'categories') {
      const known = pack.cats.filter((c) => UE_CATEGORY_FOLDERS.has(c)).length;
      if (known < 2) {
        console.error(`  ! WARNING: "${pack.folder}" has <2 known UE category folders`);
      }
    }
  }

  console.log(
    `\nDone: ${PACKS.length} folders (${unrealPacks} UE packs, ${looseFolders} loose), ${totalFiles} placeholder files.\n`,
  );
  console.log('Next steps:');
  console.log(`  pnpm smoke:scan "${outDir}"            # dry-run the walker`);
  console.log('  # In the app: add this folder as a scan location, scan, then');
  console.log('  # Settings → enrich (or `pnpm enrich-orbital`) to pull live metadata.');
}

main();
