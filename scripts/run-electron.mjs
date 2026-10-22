#!/usr/bin/env node
// Strip ELECTRON_RUN_AS_NODE before invoking the wrapped command.
//
// VS Code spawns the Claude Code extension (and any integrated terminal it
// owns) as a Node-flavored utility process, which it does by re-exec'ing
// Code.exe with `ELECTRON_RUN_AS_NODE=1`. That flag inherits down through
// every child — bash → pnpm → electron.exe — and forces our own Electron
// binary to launch as plain Node. Without scrubbing it, `require('electron')`
// returns the npm shim's path string and `import { BrowserWindow } from
// 'electron'` throws "no named export". Setting the var to "" doesn't help;
// Electron's check treats any defined value as truthy, so it must be deleted.
//
// Wraps any command: `node scripts/run-electron.mjs <cmd> [...args]`.
//
// Commands that start the app (`electron .`, `electron-vite dev|preview`) first
// run ensure-uasset.mjs and stop if it fails: the main process imports the
// @omnidex/uasset addon at startup, and without its binary Electron raises a
// blocking "Cannot find native binding" dialog instead of exiting.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , cmd, ...args] = process.argv;
if (!cmd) {
  console.error('run-electron: no command given');
  process.exit(1);
}

const launchesApp =
  (cmd === 'electron' && args[0] === '.') ||
  (cmd === 'electron-vite' && ['dev', 'preview'].includes(args[0]));
if (launchesApp) {
  const ensure = join(dirname(fileURLToPath(import.meta.url)), 'ensure-uasset.mjs');
  const { status } = spawnSync(process.execPath, [ensure], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(cmd, args, { stdio: 'inherit', shell: true, env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
