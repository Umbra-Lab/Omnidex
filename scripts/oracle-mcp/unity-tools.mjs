/**
 * Unity tools for the Oracle MCP server: read-only lookups over what a `scan_mode =
 * 'unity'` location indexed (unity_projects, unity_packages, unity_assets, unity_refs,
 * and unity_known_guids for references into Unity's own packages).
 *
 * They answer from the database alone, so an agent can learn a project's structure
 * without the Unity Editor open and without spending Editor MCP calls. A database from
 * before the Unity migration has none of these tables; every tool then says so instead
 * of failing.
 */

export const unityTools = [
  {
    name: 'unity_projects',
    description:
      'List indexed Unity projects, loose Assets folders and .unitypackage files: Editor ' +
      'version, render pipeline ' +
      '(URP/HDRP/Built-in), installed packages and how many scenes, prefabs, materials, ' +
      'scripts etc. each holds. Start here to learn what Unity content exists.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional name substring filter' },
        packages: {
          type: 'boolean',
          description: "Also list each project's Package Manager dependencies (default false)",
        },
      },
    },
  },
  {
    name: 'unity_find_asset',
    description:
      'Find files inside Unity projects and packages by path words (ANDed, case-insensitive), ' +
      'optionally by kind: scene, prefab, prefab_variant, material, shader, shader_graph, ' +
      'vfx_graph, animation_clip, animator_controller, timeline, scriptable_object, script, ' +
      'texture, model, audio. Returns the project or package, path, kind and GUID.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match against the asset path' },
        kind: { type: 'string', description: 'Optional asset kind filter' },
        container: {
          type: 'string',
          description: 'Optional project or package name substring',
        },
        limit: { type: 'number', description: 'Max hits, default 30' },
      },
      required: ['query'],
    },
  },
  {
    name: 'unity_dependencies',
    description:
      'What a Unity asset uses and what uses it, from GUID references in text-serialized ' +
      'scenes, prefabs, materials, controllers and other assets. Use before changing or ' +
      'deleting an asset to see what would break. Identify the asset by GUID or by a path ' +
      'fragment that matches one file.',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'GUID, or a path fragment such as Ship.prefab' },
        direction: {
          type: 'string',
          enum: ['uses', 'used_by', 'both'],
          description: 'Default both',
        },
        container: { type: 'string', description: 'Optional project or package name substring' },
        limit: { type: 'number', description: 'Max rows per direction, default 50' },
      },
      required: ['asset'],
    },
  },
  {
    name: 'unity_scene_outline',
    description:
      'Outline a Unity scene or prefab without opening the Editor: its root GameObjects ' +
      '(with child counts, components and source prefab), component totals, the scripts its ' +
      'MonoBehaviours run, and the parent prefab when it is a variant.',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'GUID, or a path fragment of a .unity or .prefab' },
        container: { type: 'string', description: 'Optional project or package name substring' },
      },
      required: ['asset'],
    },
  },
];

const NOT_INDEXED =
  'No Unity index in this database yet. Add a folder in Omnidex with "Unity projects and ' +
  '.unitypackage files" selected, then scan it.';

function likeEscape(s) {
  return s.replaceAll(/[\\%_]/g, (c) => `\\${c}`);
}

function size(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

function limitOf(value, fallback, max) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function createUnityTools(db) {
  const hasIndex =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'unity_assets'")
      .get() !== undefined;
  if (!hasIndex) {
    return { names: new Set(unityTools.map((t) => t.name)), call: () => NOT_INDEXED };
  }

  // Assets-only folders arrived in a later migration; an older database just lacks them.
  const hasFolders = db
    .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
    .get('unity_projects', 'assets_only');
  const containersStmt = db.prepare(`
    SELECT a.id, a.name, a.asset_type, a.file_path, a.file_size,
           p.editor_version, p.render_pipeline, p.packages_json,
           ${hasFolders ? 'p.assets_only, p.settings_from' : '0 AS assets_only, NULL AS settings_from'}
    FROM assets a LEFT JOIN unity_projects p ON p.asset_id = a.id
    WHERE a.asset_type IN ('unity_project', 'unity_package') AND a.missing_since IS NULL
      AND a.name LIKE ? ESCAPE '\\'
    ORDER BY a.asset_type DESC, a.name`);
  // Asset Store columns arrived in a later migration; an older database just lacks them.
  const hasStore = db
    .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
    .get('unity_packages', 'store_id');
  const storeStmt = hasStore
    ? db.prepare(
        `SELECT store_id, store_title, store_publisher, store_category, store_version,
                store_unity_version, store_published_on
           FROM unity_packages WHERE asset_id = ? AND store_id IS NOT NULL`,
      )
    : null;
  function storeLine(id) {
    const s = storeStmt?.get(id);
    if (!s) return '';
    const parts = [
      `${s.store_title ?? 'untitled'}${s.store_publisher ? ` by ${s.store_publisher}` : ''}` +
        `${s.store_category ? ` (${s.store_category})` : ''}`,
      s.store_version ? `v${s.store_version.replace(/^v/i, '')}` : null,
      s.store_unity_version ? `Unity ${s.store_unity_version}` : null,
      s.store_published_on ? `published ${s.store_published_on}` : null,
    ].filter(Boolean);
    return `\n  Asset Store ${s.store_id}: ${parts.join(', ')}`;
  }
  const kindCountsStmt = db.prepare(
    'SELECT kind, COUNT(*) AS n FROM unity_assets WHERE container_id = ? GROUP BY kind ORDER BY n DESC',
  );
  // Every term is a LIKE in SQL, so the limit applies after all of them, not before.
  const MAX_TERMS = 8;
  const findStmts = new Map();
  /** `container` matches a project or package by name or by part of its folder path. */
  const scopeOf = (container) => `%${likeEscape(String(container ?? '').normalize('NFC'))}%`;
  function find(terms, container, kinds, limit) {
    const n = Math.min(terms.length, MAX_TERMS);
    let stmt = findStmts.get(n);
    if (!stmt) {
      stmt = db.prepare(`
        SELECT u.id, u.container_id, u.guid, u.rel_path, u.kind, u.size, u.variant_of,
               u.summary_json, a.name AS container, a.file_path AS container_path
        FROM unity_assets u JOIN assets a ON a.id = u.container_id
        WHERE a.missing_since IS NULL
          AND (a.name LIKE ?1 ESCAPE '\\' OR a.file_path LIKE ?1 ESCAPE '\\')
          AND (?2 IS NULL OR u.kind IN (SELECT value FROM json_each(?2)))
          ${Array.from({ length: n }, (_, i) => `AND u.rel_path LIKE ?${i + 4} ESCAPE '\\' `).join('')}
        ORDER BY length(u.rel_path)
        LIMIT ?3`);
      findStmts.set(n, stmt);
    }
    return stmt.all(
      scopeOf(container),
      kinds ? JSON.stringify(kinds) : null,
      limit,
      // LIKE folds ASCII case only, so a query is matched as typed, in NFC form.
      ...terms.slice(0, n).map((term) => `%${likeEscape(term.normalize('NFC'))}%`),
    );
  }
  const byGuidStmt = db.prepare(`
    SELECT u.id, u.container_id, u.guid, u.rel_path, u.kind, u.variant_of, u.summary_json,
           a.name AS container, a.file_path AS container_path
    FROM unity_assets u JOIN assets a ON a.id = u.container_id
    WHERE u.guid = ?1 AND a.missing_since IS NULL
      AND (a.name LIKE ?2 ESCAPE '\\' OR a.file_path LIKE ?2 ESCAPE '\\')`);
  // What an asset uses is looked up in its own project or package only; anything else is
  // named afterwards (a Unity package, or another container, said as such).
  const usesStmt = db.prepare(`
    SELECT r.to_guid AS guid, u.rel_path, u.kind
    FROM unity_refs r
    LEFT JOIN unity_assets u ON u.container_id = r.container_id AND u.guid = r.to_guid
    WHERE r.container_id = ? AND r.from_guid = ?
    ORDER BY u.rel_path IS NULL, u.rel_path LIMIT ?`);
  const otherStmt = db.prepare(`
    SELECT u.rel_path, u.kind, a.name AS container
    FROM unity_assets u JOIN assets a ON a.id = u.container_id
    WHERE u.guid = ? AND u.container_id <> ? AND a.missing_since IS NULL
    ORDER BY a.name LIMIT 1`);
  const usedByStmt = db.prepare(`
    SELECT r.from_guid AS guid, u.rel_path, u.kind
    FROM unity_refs r
    LEFT JOIN unity_assets u ON u.container_id = r.container_id AND u.guid = r.from_guid
    WHERE r.container_id = ? AND r.to_guid = ?
    ORDER BY u.rel_path LIMIT ?`);
  const guidPathStmt = db.prepare(
    'SELECT rel_path FROM unity_assets WHERE guid = ? AND container_id = ? LIMIT 1',
  );
  // Known Unity package GUIDs arrived in a later migration too.
  const hasKnown =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'unity_known_guids'")
      .get() !== undefined;
  const knownStmt = hasKnown
    ? db.prepare('SELECT package, version, rel_path FROM unity_known_guids WHERE guid = ?')
    : null;
  /** "Unity package com.unity.ugui: Runtime/UI/Core/Image.cs", or null. */
  function knownName(guid) {
    const k = knownStmt?.get(guid);
    return k ? `Unity package ${k.package}: ${k.rel_path}` : null;
  }
  // References that leave their own project or package: to a Unity package, to another
  // indexed container, or to nothing Omnidex knows (missing, or content never scanned).
  const outsideStmt = db.prepare(`
    SELECT r.to_guid AS guid,
      EXISTS (SELECT 1 FROM unity_assets o JOIN assets oa ON oa.id = o.container_id
              WHERE o.guid = r.to_guid AND oa.missing_since IS NULL) AS elsewhere,
      ${hasKnown ? '(SELECT k.package FROM unity_known_guids k WHERE k.guid = r.to_guid)' : 'NULL'} AS package
    FROM unity_refs r
    WHERE r.container_id = ? AND NOT EXISTS
      (SELECT 1 FROM unity_assets u WHERE u.container_id = r.container_id AND u.guid = r.to_guid)`);
  function outsideLine(containerId) {
    const rows = outsideStmt.all(containerId);
    if (rows.length === 0) return '';
    // Counted as distinct assets: one missing shader used by 300 materials is one.
    const elsewhere = new Set();
    const missing = new Set();
    const byPackage = new Map();
    for (const row of rows) {
      if (row.package) {
        const set = byPackage.get(row.package) ?? new Set();
        set.add(row.guid);
        byPackage.set(row.package, set);
      } else if (row.elsewhere) elsewhere.add(row.guid);
      else missing.add(row.guid);
    }
    const n = (v) => v.toLocaleString('en-US');
    const parts = [];
    if (byPackage.size) {
      const top = [...byPackage.entries()]
        .map(([k, set]) => [k, set.size])
        .sort((a, b) => b[1] - a[1]);
      const total = top.reduce((sum, [, v]) => sum + v, 0);
      parts.push(
        `${n(total)} in Unity packages (${top
          .slice(0, 4)
          .map(([k, v]) => `${k.replace(/^com\.unity\./, '')} ${n(v)}`)
          .join(', ')}${top.length > 4 ? ', …' : ''})`,
      );
    }
    if (elsewhere.size) parts.push(`${n(elsewhere.size)} in other indexed projects or packages`);
    if (missing.size) parts.push(`${n(missing.size)} not found`);
    return `\n  assets used from outside: ${parts.join('; ')}`;
  }

  function resolve(asset, container, kinds) {
    const text = String(asset ?? '').trim();
    if (!text) return { error: 'Name an asset by GUID or path fragment.' };
    const isGuid = /^[0-9a-f]{32}$/i.test(text);
    let rows;
    if (isGuid) {
      rows = byGuidStmt.all(text.toLowerCase(), scopeOf(container));
      if (kinds) rows = rows.filter((row) => kinds.includes(row.kind));
    } else rows = find([text], container, kinds ?? null, 200);
    if (rows.length === 0) return { error: `No Unity asset matches "${text}".` };
    if (rows.length > 1) {
      const exact = rows.filter(
        (row) =>
          row.rel_path.toLowerCase() === text.toLowerCase() ||
          row.rel_path.toLowerCase().endsWith(`/${text.toLowerCase()}`),
      );
      if (exact.length === 1) return { row: exact[0] };
      const hint = isGuid
        ? 'pass container= with part of its folder path'
        : 'pass a GUID, a longer path, or container= with part of its folder path';
      return {
        error:
          `"${text}" matches ${rows.length} assets; ${hint}:\n` +
          rows
            .slice(0, 15)
            .map(
              (row) =>
                `  [${row.container}] ${row.rel_path}  guid=${row.guid}  (${row.container_path})`,
            )
            .join('\n'),
      };
    }
    return { row: rows[0] };
  }

  /** Name a GUID used by an asset in `containerId`: own file, Unity package, elsewhere. */
  function nameOf(guid, containerId, own = guidPathStmt.get(guid, containerId)) {
    if (own) return own.kind ? `${own.rel_path} (${own.kind})` : own.rel_path;
    const known = knownName(guid);
    if (known) return known;
    const other = otherStmt.get(guid, containerId);
    if (other) return `[${other.container}] ${other.rel_path} (${other.kind}, not in this one)`;
    return `guid ${guid} (not found: missing, or from content not scanned)`;
  }

  function call(name, args) {
    if (name === 'unity_projects') {
      const rows = containersStmt.all(`%${likeEscape(String(args.query ?? ''))}%`);
      if (rows.length === 0) return 'No Unity projects or packages indexed.';
      return rows
        .map((row) => {
          const counts = kindCountsStmt
            .all(row.id)
            .map((c) => `${c.n.toLocaleString('en-US')} ${c.kind}`)
            .join(', ');
          if (row.asset_type === 'unity_package') {
            return `PACKAGE ${row.name} — ${size(row.file_size)}${storeLine(row.id)}\n  ${row.file_path}\n  ${counts || 'empty'}${outsideLine(row.id)}`;
          }
          let deps = {};
          try {
            deps = JSON.parse(row.packages_json ?? '{}');
          } catch {
            deps = {};
          }
          const depLine = args.packages
            ? `\n  packages: ${
                Object.entries(deps)
                  .map(([k, v]) => `${k}@${v}`)
                  .join(', ') || 'none'
              }`
            : `\n  ${Object.keys(deps).length} packages (pass packages=true to list)`;
          const head = row.assets_only
            ? `ASSETS FOLDER ${row.name} — ${
                row.settings_from
                  ? `inside project ${row.settings_from}, Unity ${row.editor_version ?? 'unknown'}, ` +
                    `${row.render_pipeline ?? 'built-in'}`
                  : 'no project settings, Editor version unknown'
              }, ${size(row.file_size)} in Assets\n`
            : `PROJECT ${row.name} — Unity ${row.editor_version ?? 'unknown'}, ` +
              `${row.render_pipeline ?? 'built-in'}, ${size(row.file_size)} in Assets/Packages\n`;
          return `${head}  ${row.file_path}\n  ${counts || 'no assets'}${outsideLine(row.id)}${depLine}`;
        })
        .join('\n');
    }

    if (name === 'unity_find_asset') {
      const terms = String(args.query ?? '')
        .split(/\s+/)
        .filter(Boolean);
      if (terms.length === 0) return 'Empty query.';
      const kinds = args.kind ? [String(args.kind)] : null;
      const rows = find(terms, args.container, kinds, limitOf(args.limit, 30, 200));
      if (rows.length === 0) return 'No Unity assets matched.';
      return rows
        .map(
          (row) =>
            `[${row.container}] ${row.rel_path} — ${row.kind}, ${size(row.size)}` +
            `${row.guid ? `, guid=${row.guid}` : ''}`,
        )
        .join('\n');
    }

    if (name === 'unity_dependencies') {
      const found = resolve(args.asset, args.container);
      if (found.error) return found.error;
      const { row } = found;
      if (!row.guid) return `${row.rel_path} has no .meta GUID, so nothing can reference it.`;
      const direction = ['uses', 'used_by'].includes(args.direction) ? args.direction : 'both';
      const limit = limitOf(args.limit, 50, 500);
      const out = [`[${row.container}] ${row.rel_path} — ${row.kind}, guid=${row.guid}`];
      if (row.variant_of) out.push(`Variant of: ${nameOf(row.variant_of, row.container_id)}`);
      const line = (r) => `  ${nameOf(r.guid, row.container_id, r.rel_path ? r : undefined)}`;
      if (direction !== 'used_by') {
        const uses = usesStmt.all(row.container_id, row.guid, limit);
        out.push(`Uses ${uses.length}${uses.length === limit ? '+' : ''}:`);
        out.push(...(uses.length ? uses.map(line) : ['  nothing found (binary file, or no refs)']));
      }
      if (direction !== 'uses') {
        const usedBy = usedByStmt.all(row.container_id, row.guid, limit);
        out.push(`Used by ${usedBy.length}${usedBy.length === limit ? '+' : ''}:`);
        out.push(
          ...(usedBy.length
            ? usedBy.map((r) => (r.rel_path ? `  ${r.rel_path} (${r.kind})` : `  guid ${r.guid}`))
            : ['  nothing in this project or package']),
        );
      }
      return out.join('\n');
    }

    if (name === 'unity_scene_outline') {
      const found = resolve(args.asset, args.container, ['scene', 'prefab', 'prefab_variant']);
      if (found.error) return found.error;
      const { row } = found;
      if (!row.summary_json) {
        return `[${row.container}] ${row.rel_path} has no outline (binary serialization?).`;
      }
      const outline = JSON.parse(row.summary_json);
      const out = [
        `[${row.container}] ${row.rel_path} — ${row.kind}`,
        `${outline.objects.toLocaleString('en-US')} GameObjects, ` +
          `${outline.prefabInstances.toLocaleString('en-US')} prefab instances` +
          `${outline.partial ? ' (file too large; outline partial)' : ''}`,
      ];
      if (row.variant_of) out.push(`Variant of: ${nameOf(row.variant_of, row.container_id)}`);
      out.push(`Roots (${outline.roots.length}${outline.rootsTruncated ? '+' : ''}):`);
      for (const root of outline.roots) {
        const bits = [];
        if (root.prefab) bits.push(`prefab ${nameOf(root.prefab, row.container_id)}`);
        if (root.children) bits.push(`${root.children} children`);
        if (root.components.length) bits.push(root.components.join(', '));
        out.push(`  ${root.name}${bits.length ? ` — ${bits.join('; ')}` : ''}`);
      }
      const components = Object.entries(outline.components).sort((a, b) => b[1] - a[1]);
      if (components.length) {
        out.push(`Components: ${components.map(([k, v]) => `${k} ${v}`).join(', ')}`);
      }
      if (outline.scripts.length) {
        out.push('Scripts:');
        out.push(...outline.scripts.map((guid) => `  ${nameOf(guid, row.container_id)}`));
      }
      return out.join('\n');
    }
    return undefined;
  }

  return { names: new Set(unityTools.map((t) => t.name)), call };
}
