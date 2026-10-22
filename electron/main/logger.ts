import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Minimal, dependency-free file logger for the main process.
 *
 * Why this exists: today the only diagnostics are `console.*` calls, which
 * vanish the instant the user quits (or the process dies). A distributed
 * desktop app needs logs that SURVIVE a quit/crash so a user can zip them up
 * and send them. This writes timestamped lines to a rotating file under
 * `app.getPath('logs')` (the OS-conventional log dir — `~/Library/Logs/Omnidex`
 * on macOS, `%APPDATA%/Omnidex/logs` on Windows) AND mirrors every line to the
 * original console method, so dev-terminal output is unchanged.
 *
 * Rotation is size-based and synchronous (append + stat are cheap; we want the
 * line on disk before a crash, not buffered in an async queue that a hard exit
 * would drop). When `omnidex.log` crosses MAX_BYTES we rename it to
 * `omnidex.1.log` (shifting any existing `.1` to `.2`, …) and start a fresh
 * file, keeping at most MAX_FILES generations.
 */

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MAX_FILES = 5; // omnidex.log + omnidex.1.log … omnidex.4.log

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';

let logFilePath: string | null = null;
let initialized = false;

// Capture the real console methods up front so the patched versions below can
// still write to the terminal without recursing into themselves.
const original: Record<Level, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function logsDir(): string {
  // app.getPath('logs') is only valid after the app name is set and (on some
  // platforms) the app is ready; callers invoke initLogger() at the very top of
  // boot, after app.setName(), which is sufficient.
  return app.getPath('logs');
}

/** Serialize one console argument to a flat string (Errors keep their stack). */
function format(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Shift omnidex.(N).log → omnidex.(N+1).log, dropping the oldest generation. */
function rotate(): void {
  if (!logFilePath) return;
  const dir = logsDir();
  // Walk from the second-oldest down so each rename targets a free slot.
  for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
    const from = i === 1 ? logFilePath : join(dir, `omnidex.${i - 1}.log`);
    const to = join(dir, `omnidex.${i}.log`);
    try {
      renameSync(from, to);
    } catch {
      // Source generation may not exist yet (first few rotations) — skip.
    }
  }
}

/** Append one already-formatted line to the active log file, rotating first. */
function writeLine(line: string): void {
  if (!logFilePath) return;
  try {
    let size = 0;
    try {
      size = statSync(logFilePath).size;
    } catch {
      // File doesn't exist yet — size stays 0, append creates it.
    }
    if (size >= MAX_BYTES) rotate();
    appendFileSync(logFilePath, line);
  } catch {
    // Disk full / permission error: never let logging take down the app. The
    // mirrored console.* call (in the patched method) still surfaces the line.
  }
}

/** Build a `2026-06-14T12:34:56.789Z [warn] message` line from console args. */
function composeLine(level: Level, args: unknown[]): string {
  const ts = new Date().toISOString();
  const body = args.map(format).join(' ');
  return `${ts} [${level}] ${body}\n`;
}

/**
 * Append a line to the log file directly, bypassing console. Used by the
 * Electron process-death handlers (logger.ts can't rely on console.* there
 * because the renderer process that produced the event is already gone).
 */
export function logLine(level: Level, message: string): void {
  original[level](message);
  if (initialized) writeLine(composeLine(level, [message]));
}

/** Absolute path of the active log file (for surfacing in a "send logs" UI). */
export function getLogFilePath(): string | null {
  return logFilePath;
}

/**
 * Patch console.{log,info,warn,error,debug} to mirror into the rotating log
 * file, and record the log location. Idempotent. Call ONCE, as early in boot as
 * possible (right after app.setName), so subsequent console.* diagnostics are
 * captured. Returns the log file path (or null if the logs dir couldn't be
 * created — in which case console is left un-patched and behaves as before).
 */
export function initLogger(): string | null {
  if (initialized) return logFilePath;
  try {
    const dir = logsDir();
    mkdirSync(dir, { recursive: true });
    logFilePath = join(dir, 'omnidex.log');
  } catch (err) {
    // Couldn't establish a log dir — leave console untouched and bail. The app
    // still runs; we just don't get persistent logs.
    original.error('[omnidex] logger: failed to initialize log dir:', err);
    return null;
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as Level[]) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      writeLine(composeLine(level, args));
    };
  }

  initialized = true;
  // First line of the session: a marker the user (and we) can grep for.
  writeLine(composeLine('info', [`[omnidex] log started — ${app.getVersion()} (pid ${process.pid})`]));
  return logFilePath;
}
