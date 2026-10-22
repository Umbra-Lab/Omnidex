import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Every spec launches the built app, whose main process imports the
 * @omnidex/uasset addon at startup. Without the binary, each launch raises a
 * modal "Cannot find native binding" dialog on the desktop, one per spec.
 * Build or copy it once here, and stop the run if that is impossible.
 */
export default function globalSetup() {
  const script = fileURLToPath(new URL('../scripts/ensure-uasset.mjs', import.meta.url));
  const { status } = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (status !== 0) {
    throw new Error('ensure-uasset failed: native/uasset/*.node is missing (see output above).');
  }
}
