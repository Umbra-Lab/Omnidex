import { describe, expect, it } from 'vitest';
import { claudeCodeAvailable, streamClaudeCode } from '../providers';

/**
 * Live-fire smoke of the Claude Code provider — spawns the real CLI, so it
 * needs an installed, authenticated `claude` and spends a sliver of quota.
 * Gated the same way the uasset FFI smoke is (#30): set
 * OMNIDEX_TEST_CLAUDE_CODE=1 to run it; CI and normal `pnpm test` skip it.
 */
const enabled = process.env.OMNIDEX_TEST_CLAUDE_CODE === '1';

describe.skipIf(!enabled)('streamClaudeCode (live)', () => {
  it('detects the CLI', () => {
    expect(claudeCodeAvailable()).toBe(true);
  });

  it(
    'streams an answer and reports a session id',
    { timeout: 120_000 },
    async () => {
      const deltas: string[] = [];
      const result = await streamClaudeCode(
        'Reply with exactly the word PONG and nothing else.',
        null,
        (t) => deltas.push(t),
        new AbortController().signal,
      );
      expect(result.text).toContain('PONG');
      expect(deltas.join('')).toContain('PONG');
      expect(result.sessionId).toBeTruthy();
    },
  );
});
