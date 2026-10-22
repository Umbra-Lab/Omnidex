import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AskUsage } from './bus';
import { parseClaudeLine, parseOpenAiEvent, splitSseEvents } from './parsers';

/**
 * The two free Ask providers.
 *
 * Local speaks OpenAI-compatible SSE to the llama-swap stack on :8080 — no
 * auth, no cost, prefix cache makes same-context follow-ups fast. Claude Code
 * runs `claude -p` headless on the user's existing subscription login: frontier
 * quality at zero marginal cost, but only on machines where the CLI exists, so
 * availability is feature-detected and the option hidden elsewhere.
 *
 * Both run in the main process only; the renderer never touches a socket or a
 * child process.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderResult {
  text: string;
  usage: AskUsage | null;
  /** Claude Code session id, for `--resume` on the next question. */
  sessionId: string | null;
}

/** Hard ceiling on one answer; both providers are killed past this. */
const ANSWER_TIMEOUT_MS = 300_000;

export async function streamLocal(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<ProviderResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // stream_options is the only way OpenAI-compatible servers report token
      // usage on a streamed response; llama.cpp honors it.
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(ANSWER_TIMEOUT_MS)]),
    });
  } catch (e) {
    throw new Error(
      `Could not reach the local model server at ${url} — is the llama-swap stack running? (${(e as Error).message})`,
    );
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`Local model server returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: AskUsage | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSseEvents(buffer);
      buffer = rest;
      for (const event of events) {
        const parsed = parseOpenAiEvent(event);
        if (parsed.delta) {
          text += parsed.delta;
          onDelta(parsed.delta);
        }
        if (parsed.usage) usage = parsed.usage;
      }
    }
  } finally {
    // A throw mid-stream (renderer gone, abort) must release the connection,
    // or llama.cpp keeps generating the rest of the answer on the GPU.
    void reader.cancel().catch(() => {});
  }
  return { text, usage, sessionId: null };
}

let claudeCodeProbe: Promise<boolean> | null = null;

/**
 * Is the Claude Code CLI on PATH? Async — the CLI is a node app whose cold
 * `--version` takes seconds on Windows, and a synchronous probe would freeze
 * every IPC call in the main process while it runs. Cached; PATH does not
 * change mid-run.
 */
export function claudeCodeAvailable(): Promise<boolean> {
  claudeCodeProbe ??= new Promise<boolean>((resolve) => {
    try {
      const probe = spawn('claude', ['--version'], { shell: true, windowsHide: true });
      const timer = setTimeout(() => {
        probe.kill();
        resolve(false);
      }, 10_000);
      probe.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      probe.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
  return claudeCodeProbe;
}

/** `--resume` rides a shell:true command line; only a UUID shape may pass. */
const SESSION_ID_SHAPE = /^[0-9a-fA-F-]{1,64}$/;

export async function streamClaudeCode(
  prompt: string,
  resumeSessionId: string | null,
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<ProviderResult> {
  const resume = resumeSessionId && SESSION_ID_SHAPE.test(resumeSessionId) ? resumeSessionId : null;
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(resume ? ['--resume', resume] : []),
  ];
  // shell:true so Windows resolves the `claude.cmd` shim; every arg above is a
  // fixed token and the session id is a UUID, so there is nothing to escape.
  //
  // The environment is scrubbed on two counts. Claude-session variables leak in
  // when Omnidex itself was launched from a Claude Code session and break the
  // child's OAuth refresh. ANTHROPIC_API_KEY is deliberate: with it set the CLI
  // bills the API per token instead of using the subscription login, silently
  // violating this provider's "free" contract.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') delete env[key];
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn('claude', args, { shell: true, windowsHide: true, env });
  // The first-question prompt is hundreds of KB of transcript — far past the
  // pipe buffer — so the write settles asynchronously. If the CLI exits before
  // draining it (not logged in, bad --resume, missing binary behind a cached
  // probe), the pending write errors; without a listener that is an uncaught
  // exception in the main process rather than the graceful close-path reject.
  child.stdin.on('error', () => {});
  child.stdin.write(prompt);
  child.stdin.end();

  return await new Promise<ProviderResult>((resolve, reject) => {
    let sessionId: string | null = resumeSessionId;
    let streamedText = '';
    let bufferedText = '';
    let settled = false;
    const stderrTail: string[] = [];

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => {
      try {
        // shell:true means child.pid is the cmd.exe shim on Windows; killing it
        // orphans the actual CLI, which keeps generating (and keeps spending
        // quota). taskkill /T takes the whole tree down.
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
      finish(() => reject(new Error('Claude Code took longer than 5 minutes; stopped.')));
    }, ANSWER_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort);

    child.on('error', (e) =>
      finish(() =>
        reject(new Error(`Could not launch the Claude Code CLI (${(e as Error).message}).`)),
      ),
    );
    child.stderr.on('data', (d: Buffer) => {
      stderrTail.push(d.toString());
      if (stderrTail.length > 20) stderrTail.shift();
    });

    createInterface({ input: child.stdout }).on('line', (line) => {
      // Late lines after cancel/timeout must not stream deltas for a request
      // the renderer was already told is over.
      if (settled) return;
      const out = parseClaudeLine(line);
      if (out.sessionId) sessionId = out.sessionId;
      if (out.delta) {
        streamedText += out.delta;
        onDelta(out.delta);
      }
      if (out.assistantText) bufferedText = out.assistantText;
      if (out.error) {
        kill();
        finish(() => reject(new Error(out.error ?? 'Claude Code failed.')));
      }
      if (out.result) {
        const text = out.result.text || streamedText || bufferedText;
        // Older CLI builds emit no partial deltas; surface the buffered answer
        // in one piece so the renderer still gets the text.
        if (!streamedText && text) onDelta(text);
        finish(() => resolve({ text, usage: out.result?.usage ?? null, sessionId }));
      }
    });

    child.on('close', (code) => {
      finish(() =>
        reject(
          new Error(
            `Claude Code exited (${code ?? 'killed'}) without a result${
              stderrTail.length ? `: ${stderrTail.join('').trim().slice(0, 300)}` : '.'
            }`,
          ),
        ),
      );
    });
  });
}
