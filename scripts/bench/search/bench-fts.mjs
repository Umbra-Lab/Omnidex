// CLI: benchmark one DB and optionally dump JSON.
//   electron-as-node bench-fts.mjs <db> [--iters=N] [--warmup=N] [--json=out] [--label=name]
import { writeFileSync } from 'node:fs';
import { benchDb, printReport } from './lib/bench.mjs';

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => {
  const m = args.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : d;
};
if (!dbPath) {
  console.error('usage: bench-fts.mjs <db> [--iters=N] [--warmup=N] [--json=out] [--label=name]');
  process.exit(1);
}

const r = benchDb(dbPath, {
  iters: Number.parseInt(opt('iters', '500'), 10),
  warmup: Number.parseInt(opt('warmup', '50'), 10),
  label: opt('label', dbPath),
});
printReport(r);

const jsonOut = opt('json', null);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(r, null, 2));
  console.log(`wrote ${jsonOut}`);
}
