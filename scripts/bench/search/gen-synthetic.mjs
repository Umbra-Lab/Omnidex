// CLI: generate one synthetic Omnidex DB.
//   electron-as-node gen-synthetic.mjs <out.db> <count> [seed]
import { generate } from './lib/generate.mjs';

const [, , outPath, countArg, seedArg] = process.argv;
if (!outPath || !countArg) {
  console.error('usage: gen-synthetic.mjs <out.db> <count> [seed]');
  process.exit(1);
}
const r = generate(
  outPath,
  Number.parseInt(countArg, 10),
  seedArg ? Number.parseInt(seedArg, 10) : undefined,
);
console.log(
  `generated ${r.count} assets (fts ${r.ftsCount}) -> ${r.outPath} [seed=${r.seed}, ${r.genMs.toFixed(0)}ms]`,
);
