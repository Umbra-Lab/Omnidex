import { spawn } from 'node:child_process';
import { claudeCliEnv } from '../ask/providers';

/**
 * One headless `claude -p` call on the user's subscription login, as the Ask panel's
 * Claude Code provider does it: no API key reaches the child (claudeCliEnv), so a run
 * can never bill per token.
 */
export type RunClaude = (
  prompt: string,
  opts: { model: string; signal?: AbortSignal },
) => Promise<string>;

/** A tagging batch is one short answer; anything slower is stuck. */
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

/** `--model` rides a shell:true command line, so only a model-name shape may pass. */
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.\-[\]]{0,63}$/;

/**
 * The reply text from `--output-format json`, which prints one object holding `result`
 * and `is_error`. A login or quota failure arrives as `is_error` with the reason in
 * `result`, and is thrown so the caller can stop instead of burning the batch list.
 */
export function readCliJson(stdout: string): string {
  let obj: { result?: unknown; is_error?: unknown };
  try {
    obj = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      `Claude Code printed something other than JSON: ${stdout.trim().slice(0, 200)}`,
    );
  }
  const result = typeof obj.result === 'string' ? obj.result : '';
  if (obj.is_error) throw new Error(result || 'Claude Code reported an error.');
  return result;
}

export const runClaudeCli: RunClaude = (prompt, { model, signal }) => {
  if (!MODEL_SHAPE.test(model)) return Promise.reject(new Error(`Not a model name: ${model}`));
  const args = ['-p', '--model', model, '--output-format', 'json'];
  // shell:true so Windows resolves the `claude.cmd` shim; every arg is a fixed token or
  // a checked model name. The prompt goes in on stdin.
  const child = spawn('claude', args, { shell: true, windowsHide: true, env: claudeCliEnv() });
  child.stdin.on('error', () => {});
  child.stdin.write(prompt);
  child.stdin.end();

  return new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => {
      try {
        // On Windows child.pid is the cmd.exe shim; /T takes the real CLI down with it.
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill();
        }
      } catch {
        // already gone
      }
    };
    const onAbort = () => {
      kill();
      finish(() => reject(new Error('Cancelled.')));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error('Claude Code took longer than 10 minutes; stopped.')));
    }, CALL_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort);

    child.on('error', (e) =>
      finish(() => reject(new Error(`Could not launch the Claude Code CLI (${e.message}).`))),
    );
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on('close', (code) =>
      finish(() => {
        if (stdout.trim()) {
          try {
            resolve(readCliJson(stdout));
          } catch (e) {
            reject(e);
          }
          return;
        }
        reject(
          new Error(`Claude Code exited ${code} with no answer. ${stderr.trim().slice(-300)}`),
        );
      }),
    );
  });
};
