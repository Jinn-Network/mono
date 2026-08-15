import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod/v3';

export const StopHookToolSchema = z.enum([
  'claude-code',
  'codex',
  'gemini-cli',
  'cursor',
]);

export const StopHookPayloadSchema = z.object({
  tool: StopHookToolSchema,
  sessionId: z.string().min(1),
  stoppedAt: z.string().datetime(),
  transcriptPath: z.string().optional(),
  repoRoot: z.string().optional(),
  raw: z.unknown().optional(),
});

export type StopHookPayload = z.infer<typeof StopHookPayloadSchema>;
export type StopHookTool = z.infer<typeof StopHookToolSchema>;

export interface StopHookRoutesDeps {
  onStopHook: (payload: StopHookPayload) => Promise<void> | void;
}

function readString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function parseRawInput(input: string): unknown {
  const trimmed = input.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { text: input };
  }
}

export function normalizeStopHookPayload(input: {
  tool?: string;
  stdin: string;
  now?: Date;
}): StopHookPayload {
  const raw = parseRawInput(input.stdin);
  const obj = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const tool = input.tool ?? readString(obj, ['tool', 'source', 'app']);
  const parsedTool = StopHookToolSchema.parse(tool);
  const sessionId = readString(obj, ['sessionId', 'session_id', 'conversationId', 'conversation_id'])
    ?? randomUUID();
  const transcriptPath = readString(obj, [
    'transcriptPath',
    'transcript_path',
    'transcript',
    'sessionPath',
    'session_path',
  ]);
  const repoRoot = readString(obj, ['repoRoot', 'repo_root', 'workspace', 'cwd']);

  return StopHookPayloadSchema.parse({
    tool: parsedTool,
    sessionId,
    stoppedAt: (input.now ?? new Date()).toISOString(),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(repoRoot ? { repoRoot } : {}),
    raw,
  });
}

export function addStopHookRoutes(app: Hono, deps: StopHookRoutesDeps): void {
  app.post('/api/stop-hook', async (c) => {
    const body = await c.req.json().catch(() => null) as unknown;
    const parsed = StopHookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: 'invalid_stop_hook_payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }, 400);
    }
    await deps.onStopHook(parsed.data);
    return c.json({ ok: true, sessionId: parsed.data.sessionId });
  });
}
