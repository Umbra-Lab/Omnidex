/**
 * Unity tools for the Oracle MCP server: read-only lookups over what a `scan_mode =
 * 'unity'` location indexed (unity_projects, unity_packages, unity_assets, unity_refs).
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
      'List indexed Unity projects and .unitypackage files: Editor version, render pipeline ' +
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

  const containersStmt = db.prepare(`
    SELECT a.id, a.name, a.asset_type, a.file_path, a.file_size,
           p.editor_version, p.render_pipeline, p.packages_json
    FROM assets a LEFT JOIN unity_projects p ON p.asset_id = a.id
    WHERE a.asset_type IN ('unity_project', 'unity_package') AND a.missing_since IS NULL
      AND a.name LIKE ? ESCAPE '\\'
    ORDER BY a.asset_type DESC, a.name`);
  const kindCountsStmt = db.prepare(
    'SELECT kind, COUNT(*) AS n FROM unity_assets WHERE container_id = ? GROUP BY kind ORDER BY n DESC',
  );
  // Every term is a LIKE in SQL, so the limit applies after all of them, not before.
  const MAX_TERMS = 8;
  const findStmts = new Map();
  function find(terms, container, kind, limit) {
    const n = Math.min(terms.length, MAX_TERMS);
    let stmt = findStmts.get(n);
    if (!stmt) {
      stmt = db.prepare(`
        SELECT u.id, u.container_id, u.guid, u.rel_path, u.kind, u.size, u.variant_of,
               u.summary_json, a.name AS container
        FROM unity_assets u JOIN assets a ON a.id = u.container_id
        WHERE a.missing_since IS NULL AND a.name LIKE ? ESCAPE '\\'
          AND (? IS NULL OR u.kind = ?)
          ${"AND u.rel_path LIKE ? ESCAPE '\\' ".repeat(n)}
        ORDER BY length(u.rel_path)
        LIMIT ?`);
      findStmts.set(n, stmt);
    }
    return stmt.all(
      `%${likeEscape(String(container ?? ''))}%`,
      kind,
      kind,
      ...terms.slice(0, n).map((term) => `%${likeEscape(term)}%`),
      limit,
    );
  }
  const byGuidStmt = db.prepare(`
    SELECT u.id, u.container_id, u.guid, u.rel_path, u.kind, u.variant_of, u.summary_json,
           a.name AS container
    FROM unity_assets u JOIN assets a ON a.id = u.container_id
    WHERE u.guid = ? AND a.missing_since IS NULL AND a.name LIKE ? ESCAPE '\\'`);
  const usesStmt = db.prepare(`
    SELECT r.to_guid AS guid,
      (SELECT u.rel_path FROM unity_assets u WHERE u.guid = r.to_guid
        ORDER BY u.container_id = r.container_id DESC LIMIT 1) AS rel_path,
      (SELECT u.kind FROM unity_assets u WHERE u.guid = r.to_guid
        ORDER BY u.container_id = r.container_id DESC LIMIT 1) AS kind
    FROM unity_refs r WHERE r.container_id = ? AND r.from_guid = ?
    ORDER BY rel_path IS NULL, rel_path LIMIT ?`);
  const usedByStmt = db.prepare(`
    SELECT r.from_guid AS guid, u.rel_path, u.kind
    FROM unity_refs r
    LEFT JOIN unity_assets u ON u.container_id = r.container_id AND u.guid = r.from_guid
    WHERE r.container_id = ? AND r.to_guid = ?
    ORDER BY u.rel_path LIMIT ?`);
  const guidPathStmt = db.prepare(
    'SELECT rel_path FROM unity_assets WHERE guid = ? ORDER BY container_id = ? DESC LIMIT 1',
  );

  function resolve(asset, container, kinds) {
    const text = String(asset ?? '').trim();
    const scope = `%${likeEscape(String(container ?? ''))}%`;
    if (!text) return { error: 'Name an asset by GUID or path fragment.' };
    let rows;
    if (/^[0-9a-f]{32}$/i.test(text)) rows = byGuidStmt.all(text.toLowerCase(), scope);
    else rows = find([text], container, null, 200);
    if (kinds) rows = rows.filter((row) => kinds.includes(row.kind));
    if (rows.length === 0) return { error: `No Unity asset matches "${text}".` };
    if (rows.length > 1) {
      const exact = rows.filter(
        (row) =>
          row.rel_path.toLowerCase() === text.toLowerCase() ||
          row.rel_path.toLowerCase().endsWith(`/${text.toLowerCase()}`),
      );
      if (exact.length === 1) return { row: exact[0] };
      return {
        error:
          `"${text}" matches ${rows.length} assets; pass a GUID or a longer path:\n` +
          rows
            .slice(0, 15)
            .map((row) => `  [${row.container}] ${row.rel_path}  guid=${row.guid}`)
            .join('\n'),
      };
    }
    return { row: rows[0] };
  }

  function nameOf(guid, containerId) {
    const row = guidPathStmt.get(guid, containerId);
    return row ? row.rel_path : `guid ${guid} (not in the index: built-in, a package, or missing)`;
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
            return `PACKAGE ${row.name} — ${size(row.file_size)}\n  ${row.file_path}\n  ${counts || 'empty'}`;
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
          return (
            `PROJECT ${row.name} — Unity ${row.editor_version ?? 'unknown'}, ` +
            `${row.render_pipeline ?? 'built-in'}, ${size(row.file_size)} in Assets/Packages\n` +
            `  ${row.file_path}\n  ${counts || 'no assets'}${depLine}`
          );
        })
        .join('\n');
    }

    if (name === 'unity_find_asset') {
      const terms = String(args.query ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (terms.length === 0) return 'Empty query.';
      const kind = args.kind ? String(args.kind) : null;
      const rows = find(terms, args.container, kind, limitOf(args.limit, 30, 200));
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
      const line = (r) =>
        r.rel_path ? `  ${r.rel_path} (${r.kind})` : `  guid ${r.guid} (not in the index)`;
      if (direction !== 'used_by') {
        const uses = usesStmt.all(row.container_id, row.guid, limit);
        out.push(`Uses ${uses.length}${uses.length === limit ? '+' : ''}:`);
        out.push(...(uses.length ? uses.map(line) : ['  nothing found (binary file, or no refs)']));
      }
      if (direction !== 'uses') {
        const usedBy = usedByStmt.all(row.container_id, row.guid, limit);
        out.push(`Used by ${usedBy.length}${usedBy.length === limit ? '+' : ''}:`);
        out.push(...(usedBy.length ? usedBy.map(line) : ['  nothing in this project or package']));
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
