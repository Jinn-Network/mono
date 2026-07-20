import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';
import type { CapturedTask } from './capture.js';
import { DEFAULT_CAPTURES_DIR, DEFAULT_DISTILL_CAPTURE_LIMIT, loadRecentCaptures } from './distill-captures.js';
import {
  clusterTraceCards,
  readTrace,
  searchTraceCards,
  traceCardFromCapture,
  type TraceReadMode,
} from './distill-traces.js';
import { recordDistillFeedback } from './distill-feedback.js';

interface McpToolResponse extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

type SpawnFn = typeof spawn;

export interface DistillMcpDeps {
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}

const traceReadModes = ['summary', 'events', 'tool_calls', 'transcript_excerpt', 'full_transcript'] as const satisfies readonly TraceReadMode[];

export function createDistillMcpServer(deps: DistillMcpDeps = {}): McpServer {
  const server = new McpServer({
    name: 'jinn-local-distill',
    version: '0.1.0',
  });

  server.tool(
    'distill_trace_search',
    'Search local trace cards from the shared local distill capture directory. Use this before reading full traces; returns compact cards only.',
    {
      capturesDir: z.string().optional().describe('Directory containing CapturedTask JSON files. Defaults to JINN_LAYER_CAPTURES_DIR or ~/.jinn-client/harness-layer/captures.'),
      limit: z.number().int().positive().max(500).optional().describe('Maximum captures to load and maximum cards to return.'),
      query: z.string().optional().describe('Free-text query across summary, tools, commands, files, errors, and outcome.'),
      command: z.string().optional().describe('Command substring filter.'),
      file: z.string().optional().describe('Touched-file substring filter.'),
      error: z.string().optional().describe('Error substring filter.'),
      tool: z.string().optional().describe('Tool-name substring filter.'),
      outcome: z.enum(['completed', 'failed', 'abandoned']).optional().describe('Outcome status filter.'),
    },
    async (args) => {
      const capturesDir = args.capturesDir ?? capturesDirFromEnv(deps.env);
      const limit = args.limit ?? DEFAULT_DISTILL_CAPTURE_LIMIT;
      const captures = loadRecentCaptures(capturesDir, limit);
      const cards = searchTraceCards(captures.map(traceCardFromCapture), {
        query: args.query,
        command: args.command,
        file: args.file,
        error: args.error,
        tool: args.tool,
        outcome: args.outcome,
        limit,
      });
      return jsonResponse({ capturesDir, count: cards.length, cards });
    },
  );

  server.tool(
    'distill_trace_read',
    'Read a selected local trace by traceId or sessionId. Prefer summary, transcript_excerpt, or tool_calls before requesting full_transcript.',
    {
      capturesDir: z.string().optional().describe('Directory containing CapturedTask JSON files.'),
      limit: z.number().int().positive().max(500).optional().describe('Maximum captures to load while locating the trace.'),
      traceId: z.string().optional().describe('Trace id returned by distill_trace_search, e.g. local-capture:<sessionId>.'),
      sessionId: z.string().optional().describe('Raw session id when traceId is not available.'),
      mode: z.enum(traceReadModes).optional().describe('Read mode. full_transcript requires allowFullTranscript=true.'),
      query: z.string().optional().describe('Optional excerpt filter for transcript_excerpt mode.'),
      readLimit: z.number().int().positive().max(200).optional().describe('Maximum events returned for transcript_excerpt mode.'),
      allowFullTranscript: z.boolean().optional().describe('Required explicit opt-in for full_transcript reads.'),
    },
    async (args) => {
      const capturesDir = args.capturesDir ?? capturesDirFromEnv(deps.env);
      const captures = loadRecentCaptures(capturesDir, args.limit ?? DEFAULT_DISTILL_CAPTURE_LIMIT);
      const capture = findCapture(captures, { traceId: args.traceId, sessionId: args.sessionId });
      if (!capture) return errorResponse(`Trace not found: ${args.traceId ?? args.sessionId ?? '(missing id)'}`);
      try {
        return jsonResponse(readTrace(capture, {
          mode: args.mode ?? 'summary',
          query: args.query,
          limit: args.readLimit,
          allowFullTranscript: args.allowFullTranscript,
        }));
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    'distill_trace_cluster',
    'Group local trace cards into candidate skill opportunities using repeated commands, files, and error signals. This is a cheap pre-distill scan.',
    {
      capturesDir: z.string().optional().describe('Directory containing CapturedTask JSON files.'),
      limit: z.number().int().positive().max(500).optional().describe('Maximum captures to load.'),
    },
    async (args) => {
      const capturesDir = args.capturesDir ?? capturesDirFromEnv(deps.env);
      const captures = loadRecentCaptures(capturesDir, args.limit ?? DEFAULT_DISTILL_CAPTURE_LIMIT);
      const candidates = clusterTraceCards(captures.map(traceCardFromCapture));
      return jsonResponse({ capturesDir, count: candidates.length, candidates });
    },
  );

  server.tool(
    'distill_local',
    'Run local skill distillation over captured traces by delegating to jinn-layer distill. Requires confirm:true because it can call an LLM and write staged or installed skills.',
    {
      confirm: z.boolean().optional().describe('Must be true to execute. Omit or false to receive a preview envelope.'),
      capturesDir: z.string().optional().describe('Directory containing CapturedTask JSON files.'),
      out: z.string().optional().describe('Output directory for distilled skills.'),
      limit: z.number().int().positive().max(500).optional().describe('Maximum captures to distill.'),
      traceIds: z.array(z.string()).optional().describe('Optional selected trace IDs to distill, as returned by distill_trace_search or distill_trace_cluster.'),
      sessionIds: z.array(z.string()).optional().describe('Optional selected raw session IDs to distill.'),
      install: z.string().optional().describe('Install choice passed to --install: all, none, or a specific skill name.'),
      resume: z.boolean().optional().describe('Pass --resume so already-covered sessions are skipped.'),
      distiller: z.enum(['claude', 'codex']).optional().describe('LLM provider to use for the distiller pass.'),
      distillerModel: z.string().optional().describe('Distiller model name. This is separate from the runtime model recorded in the skill.'),
    },
    async (args) => {
      if (!args.confirm) {
        return jsonResponse({
          schemaVersion: 1,
          status: 'preview',
          tool: 'distill_local',
          description: 'Run local distillation over captured traces.',
          effects: [
            'Reads local captured-task JSON files.',
            'Calls the selected user LLM provider through the existing jinn-layer distill flow.',
            'Writes distilled skill packages under the output/staging directory and may install selected skills.',
          ],
          followUp: {
            tool: 'distill_local',
            arguments: { ...args, confirm: true },
          },
        });
      }
      return runLocalDistill({
        capturesDir: args.capturesDir,
        out: args.out,
        limit: args.limit,
        traceIds: args.traceIds,
        sessionIds: args.sessionIds,
        install: args.install,
        resume: args.resume,
        distiller: args.distiller,
        distillerModel: args.distillerModel,
      }, deps);
    },
  );

  server.tool(
    'distill_feedback_record',
    'Record local user feedback for an experimental distilled skill. Use this after a later session uses the skill and the user accepts a helped/hurt/mixed/unused verdict.',
    {
      skillName: z.string().min(1).describe('Distilled skill name.'),
      verdict: z.enum(['helped', 'hurt', 'mixed', 'unused']).describe('User-visible outcome of using the skill.'),
      sessionId: z.string().optional().describe('Session where the skill was used, if known.'),
      notes: z.string().optional().describe('Short user-approved note about what to improve or preserve.'),
      acceptedChanges: z.array(z.string()).optional().describe('Concrete user-approved changes to apply in a later skill improvement pass.'),
      feedbackPath: z.string().optional().describe('Override feedback JSONL path. Defaults to JINN_LAYER_DISTILL_FEEDBACK_PATH or ~/.jinn-client/harness-layer/distill-feedback.jsonl.'),
    },
    async (args) => {
      const record = recordDistillFeedback({
        skillName: args.skillName,
        verdict: args.verdict,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
        ...(args.acceptedChanges ? { acceptedChanges: args.acceptedChanges } : {}),
      }, {
        ...(args.feedbackPath ? { path: args.feedbackPath } : {}),
        ...(deps.env ? { env: deps.env } : {}),
      });
      return jsonResponse({ recorded: record });
    },
  );

  return server;
}

export interface LocalDistillRunArgs {
  capturesDir?: string;
  out?: string;
  limit?: number;
  traceIds?: string[];
  sessionIds?: string[];
  install?: string;
  resume?: boolean;
  distiller?: 'claude' | 'codex';
  distillerModel?: string;
}

export async function runLocalDistill(args: LocalDistillRunArgs, deps: DistillMcpDeps = {}): Promise<McpToolResponse> {
  const resolved = resolveJinnLayerCommand(deps.env);
  const selected = materializeSelectedCaptures(args, deps.env);
  if (selected.error) return errorResponse(selected.error);
  const argv = [
    ...resolved.prefixArgs,
    'distill',
    '--where',
    'local',
    '--json',
  ];
  const capturesDir = selected.capturesDir ?? args.capturesDir;
  if (capturesDir) argv.push('--captures', capturesDir);
  if (args.out) argv.push('--out', args.out);
  if (args.limit !== undefined) argv.push('--limit', String(args.limit));
  if (args.install) argv.push('--install', args.install);
  if (args.resume) argv.push('--resume');
  if (args.distiller) argv.push('--distiller', args.distiller);
  if (args.distillerModel) argv.push('--distiller-model', args.distillerModel);

  const spawnFn = deps.spawn ?? spawn;
  const child = spawnFn(resolved.command, argv, {
    env: { ...process.env, ...(deps.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const result = await collectChild(child);
    return jsonResponse({
      command: [basename(resolved.command), ...argv],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(selected.traceCount !== undefined ? { selectedTraceCount: selected.traceCount } : {}),
    }, result.exitCode === 0 ? undefined : true);
  } finally {
    if (selected.tempDir) rmSync(selected.tempDir, { recursive: true, force: true });
  }
}

function jsonResponse(value: unknown, isError?: true): McpToolResponse {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  };
}

function errorResponse(message: string): McpToolResponse {
  return jsonResponse({ error: { message } }, true);
}

function capturesDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['JINN_LAYER_CAPTURES_DIR'] ?? DEFAULT_CAPTURES_DIR;
}

function findCapture(
  captures: CapturedTask[],
  ids: { traceId?: string; sessionId?: string },
): CapturedTask | undefined {
  const sessionId = ids.sessionId ?? ids.traceId?.replace(/^local-capture:/, '');
  if (!sessionId) return undefined;
  return captures.find((capture) => capture.session.sessionId === sessionId);
}

function resolveJinnLayerCommand(env: NodeJS.ProcessEnv = process.env): { command: string; prefixArgs: string[] } {
  if (env['JINN_LAYER_BIN']) return { command: env['JINN_LAYER_BIN'], prefixArgs: [] };
  const sibling = fileURLToPath(new URL('./bin/jinn-layer.js', import.meta.url));
  if (existsSync(sibling)) return { command: process.execPath, prefixArgs: [sibling] };
  return { command: 'jinn-layer', prefixArgs: [] };
}

function materializeSelectedCaptures(
  args: LocalDistillRunArgs,
  env: NodeJS.ProcessEnv = process.env,
): { capturesDir?: string; tempDir?: string; traceCount?: number; error?: string } {
  const selectedIds = new Set([
    ...(args.sessionIds ?? []),
    ...(args.traceIds ?? []).map((id) => id.replace(/^local-capture:/, '')),
  ].filter((id) => id.trim() !== ''));
  if (selectedIds.size === 0) return {};

  const sourceDir = args.capturesDir ?? capturesDirFromEnv(env);
  const captures = loadRecentCaptures(sourceDir, args.limit ?? DEFAULT_DISTILL_CAPTURE_LIMIT)
    .filter((capture) => selectedIds.has(capture.session.sessionId));
  if (captures.length === 0) {
    return { error: `No selected traces found in ${sourceDir}` };
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'jinn-distill-selected-'));
  for (const capture of captures) {
    writeFileSync(
      join(tempDir, `${safeFilePart(capture.session.sessionId)}.json`),
      `${JSON.stringify(capture, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return { capturesDir: tempDir, tempDir, traceCount: captures.length };
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return safe || 'capture';
}

function collectChild(child: ChildProcess): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}
