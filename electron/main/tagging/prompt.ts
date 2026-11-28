import type { TaggablePack } from '../db/repos/ai-tags';

/**
 * The enrich-tags prompt and the parsing of its reply. Pure, so the contract with the
 * model is tested without spawning anything.
 *
 * Tags exist for search, so they are the words a game developer would type that the
 * pack's name and marketplace text do not already hold: what is in it, its setting and
 * style, what it is for, and common synonyms. Nothing is trusted from the reply beyond
 * short lowercase phrases for ids that were asked about.
 */

/** Most tags kept per pack. */
export const MAX_TAGS = 12;

/** Cut text to `n` characters on a word boundary, with markup and runs of space removed. */
function clip(text: string | null, n: number): string {
  if (!text) return '';
  const flat = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= n) return flat;
  const cut = flat.slice(0, n);
  const space = cut.lastIndexOf(' ');
  return `${space > n / 2 ? cut.slice(0, space) : cut}…`;
}

/** One pack as the model sees it: only fields that hold something. */
export function packCard(p: TaggablePack): string {
  const lines = [`id ${p.id}: ${p.name}`];
  const title = p.orbital_title ?? p.display_title;
  if (title && title !== p.name) lines.push(`  title: ${title}`);
  lines.push(`  type: ${p.asset_type}`);
  if (p.orbital_seller_name) lines.push(`  seller: ${p.orbital_seller_name}`);
  if (p.orbital_categories) lines.push(`  categories: ${clip(p.orbital_categories, 120)}`);
  const about = clip(p.orbital_description ?? p.description, 400);
  if (about) lines.push(`  about: ${about}`);
  // The split folder name plus, for Unity and DCC rows, file names inside the pack.
  const words = clip(p.scan_search_text, 240);
  if (words) lines.push(`  contents: ${words}`);
  return lines.join('\n');
}

export function buildTagPrompt(packs: readonly TaggablePack[]): string {
  return [
    'You are tagging game-development asset packs (Unreal Engine, Unity, Blender and similar)',
    'so a search box can find them. For each pack below, give 4 to 12 search keywords that a',
    'developer might type to find it and that its name does not already say. Cover, where the',
    'data supports it:',
    '- what it contains (rocks, cliffs, swords, footstep sounds, muzzle flash)',
    '- setting or genre (sci-fi, medieval, post-apocalyptic, horror, fantasy)',
    '- art style (stylized, realistic, low poly, pixel art, anime)',
    '- what it is for (environment, vfx, animation, character, ui, audio, gameplay system)',
    '- common synonyms of the name words (corridor: hallway; dagger: knife)',
    '',
    'Rules: lowercase; one to three words each; no marketing words (ultimate, pro, awesome,',
    'high quality); no engine names or version numbers; do not guess what the data does not',
    'support, and give fewer tags when the pack says little. Reply with only a JSON object',
    'mapping each id (as a string) to an array of tags, nothing before or after it, like:',
    '{"12": ["hallway", "sci-fi", "modular", "environment"]}',
    '',
    'Packs:',
    ...packs.map(packCard),
  ].join('\n');
}

/** A tag as stored: lowercase words, at most three, letters, digits and "-+&'" only. */
export function cleanTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tag = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-+&']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (tag.length < 2 || tag.length > 32) return null;
  if (tag.split(' ').length > 3) return null;
  return tag;
}

/**
 * Tags per pack id from the model's reply. Ids that were not asked about and anything
 * that is not a list of strings are dropped; a reply with no JSON object gives an empty
 * map, so every pack in the batch stays untagged and is tried again next run.
 */
export function parseTagReply(text: string, ids: ReadonlySet<number>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || !ids.has(id) || !Array.isArray(value)) continue;
    const tags = [...new Set(value.map(cleanTag).filter((t): t is string => t !== null))];
    out.set(id, tags.slice(0, MAX_TAGS));
  }
  return out;
}
