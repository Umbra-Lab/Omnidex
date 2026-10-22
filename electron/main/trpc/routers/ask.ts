import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { type AskStreamEvent, askBus, emitAsk } from '../../ask/bus';
import { assembleCourseContext, estimateTokens } from '../../ask/context';
import {
  type ChatMessage,
  claudeCodeAvailable,
  streamClaudeCode,
  streamLocal,
} from '../../ask/providers';
import { readAskSettings } from '../../ask/settings';
import { openDatabase } from '../../db';
import { publicProcedure, router } from '../init';
import { idSchema } from '../schemas';

/**
 * Ask-this-course: question in, streamed cited answer out.
 *
 * `start` validates, assembles the course context, and returns immediately with
 * a request id plus a description of what went into the prompt; the answer
 * itself streams over the `onStream` subscription via `ask/bus`, the same shape
 * `progress.onProgress` uses. Failures the user must act on come back as
 * discriminated results, never as thrown TRPCErrors — the patched electron-trpc
 * drops custom error `data` on the floor (see `fab.ts` for the precedent).
 */

const historySchema = z
  .array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().max(20_000),
    }),
  )
  .max(20);

const startSchema = z.object({
  assetId: idSchema,
  question: z.string().trim().min(1).max(4_000),
  history: historySchema.default([]),
});

let nextRequestId = 1;
const activeRequests = new Map<number, AbortController>();
/** Claude Code conversation per course, so follow-ups `--resume` instead of resending 100k tokens. */
const claudeSessions = new Map<number, string>();

function systemPrompt(courseTitle: string): string {
  return [
    `You are the course tutor for "${courseTitle}".`,
    'Answer from the course transcript below and nothing else. When a claim comes from the course,',
    'cite the moment it is taught with an inline marker of the exact form [[lesson_id@seconds]],',
    'using the lesson_id from the transcript section headers and converting the nearest [m:ss]',
    'timestamp to seconds. Example: "set the tangent source to Custom [[4812@754]]". Cite where a',
    'topic is introduced, not every mention. If the transcript does not answer the question, say so',
    'plainly instead of guessing.',
  ].join(' ');
}

export const askRouter = router({
  /** Provider configuration plus what is actually available on this machine. */
  status: publicProcedure.query(async () => {
    const settings = readAskSettings(openDatabase());
    return { ...settings, claudeCodeAvailable: await claudeCodeAvailable() };
  }),

  start: publicProcedure.input(startSchema).mutation(async ({ input }) => {
    const db = openDatabase();
    const settings = readAskSettings(db);

    if (settings.provider === 'claude-code' && !(await claudeCodeAvailable())) {
      return { ok: false as const, reason: 'claude-code-missing' as const };
    }

    const course = db
      .prepare('SELECT COALESCE(display_title, name) AS title FROM assets WHERE id = ?')
      .get(input.assetId) as { title: string } | undefined;
    if (!course) return { ok: false as const, reason: 'no-course' as const };

    const requestId = nextRequestId++;
    const abort = new AbortController();
    activeRequests.set(requestId, abort);
    const onDelta = (text: string) => emitAsk({ requestId, type: 'delta', text });

    // Everything heavy — the transcript assembly included, which can take a
    // second on the largest courses — happens after this mutation returns, so
    // the IPC round-trip stays instant and failures ride the event stream.
    void (async () => {
      try {
        // Follow-ups on a resumable Claude Code session skip assembly outright:
        // the session already holds the transcript, and re-assembling would
        // both waste the scan and mislead the renderer about what the model saw.
        const resume =
          settings.provider === 'claude-code' && input.history.length > 0
            ? (claudeSessions.get(input.assetId) ?? null)
            : null;

        let contextText: string | null = null;
        if (!resume) {
          const overhead =
            estimateTokens(input.history.map((m) => m.content).join('\n')) +
            estimateTokens(input.question) +
            2_000;
          const budget = Math.max(4_000, settings.contextBudget - overhead);
          const context = assembleCourseContext(db, input.assetId, budget, input.question);
          if (!context) {
            emitAsk({
              requestId,
              type: 'error',
              message:
                'No transcript is indexed for this course yet. Run a scan once subtitles exist.',
            });
            return;
          }
          contextText = context.text;
          emitAsk({
            requestId,
            type: 'context',
            context: {
              mode: context.mode,
              lessonCount: context.lessonCount,
              includedCount: context.includedCount,
              tokenEstimate: context.tokenEstimate,
              lessons: context.lessons,
            },
          });
        }

        if (settings.provider === 'local') {
          const messages: ChatMessage[] = [
            {
              role: 'system',
              content: `${systemPrompt(course.title)}\n\nCOURSE TRANSCRIPT:${contextText ?? ''}`,
            },
            ...input.history,
            { role: 'user', content: input.question },
          ];
          const result = await streamLocal(
            settings.localBaseUrl,
            settings.localModel,
            messages,
            onDelta,
            abort.signal,
          );
          emitAsk({ requestId, type: 'done', text: result.text, usage: result.usage });
        } else {
          // A fresh CLI session with visible history (provider switched, or the
          // old session errored away) folds that history into the prompt so the
          // conversation the user sees is the one the model sees.
          const historyBlock =
            !resume && input.history.length > 0
              ? `\n\nCONVERSATION SO FAR:\n${input.history
                  .map((m) => `${m.role === 'user' ? 'User' : 'Tutor'}: ${m.content}`)
                  .join('\n')}`
              : '';
          const prompt = resume
            ? input.question
            : `${systemPrompt(course.title)}\n\nCOURSE TRANSCRIPT:${contextText ?? ''}${historyBlock}\n\nQuestion: ${input.question}`;
          try {
            const result = await streamClaudeCode(prompt, resume, onDelta, abort.signal);
            if (result.sessionId) claudeSessions.set(input.assetId, result.sessionId);
            emitAsk({ requestId, type: 'done', text: result.text, usage: result.usage });
          } catch (e) {
            // A dead session id must not poison every follow-up; the next ask
            // rebuilds from scratch with the folded history.
            claudeSessions.delete(input.assetId);
            throw e;
          }
        }
      } catch (e) {
        emitAsk({ requestId, type: 'error', message: (e as Error).message });
      } finally {
        activeRequests.delete(requestId);
      }
    })();

    return { ok: true as const, requestId };
  }),

  cancel: publicProcedure
    .input(z.object({ requestId: z.number().int().positive() }))
    .mutation(({ input }) => {
      activeRequests.get(input.requestId)?.abort();
      return true;
    }),

  onStream: publicProcedure.subscription(() =>
    observable<AskStreamEvent>((emit) => {
      const handler = (e: AskStreamEvent) => emit.next(e);
      askBus.on('ask', handler);
      return () => {
        askBus.off('ask', handler);
      };
    }),
  ),
});
