import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import { Store } from '../../store/store.js';
import { CapturesStore } from '../../store/captures.js';
import type { TranscriptEvent, TranscriptParser } from '../../trajectory/transcript-parsers/types.js';
import { ClaudeCodeJsonlParser } from '../../trajectory/transcript-parsers/claude-code-jsonl.js';
import { CodexSessionParser } from '../../trajectory/transcript-parsers/codex-session.js';
import { GeminiSessionParser } from '../../trajectory/transcript-parsers/gemini-session.js';
import { AiderHistoryParser } from '../../trajectory/transcript-parsers/aider-history.js';
import { ContinueDevDataParser } from '../../trajectory/transcript-parsers/continue-devdata.js';

export interface CaptureImportResult {
  ok: true;
  action: 'capture import';
  file: string;
  tool: string;
  repo?: string;
  license?: string;
  bytes: number;
  format: 'json' | 'jsonl' | 'text';
  sessionId?: string;
  spans?: number;
}

export function captureImportCommand(args: {
  file: string;
  tool?: string;
  repo?: string;
  license?: string;
  readFile?: (path: string) => Buffer;
}): CaptureImportResult {
  const readFile = args.readFile ?? ((path) => readFileSync(path));
  const bytes = readFile(args.file);
  return {
    ok: true,
    action: 'capture import',
    file: args.file,
    tool: args.tool ?? inferTool(args.file),
    ...(args.repo ? { repo: args.repo } : {}),
    ...(args.license ? { license: args.license } : {}),
    bytes: bytes.length,
    format: inferFormat(args.file, bytes),
  };
}

interface CaptureImportStoreInput {
  file: string;
  tool: string;
  repo?: string;
  sessionId?: string;
  dbPath: string;
}

async function importCaptureToStore(input: CaptureImportStoreInput): Promise<{
  sessionId: string;
  spans: number;
}> {
  const file = resolve(input.file);
  const parser = parserForTool(input.tool);
  const sessionId = input.sessionId ?? defaultSessionId(input.tool, file);
  const events = parser
    ? await parser.parseFull({ sessionId, path: file })
    : fallbackTextEvents(sessionId, file);
  if (events.length === 0) {
    throw new Error(`No transcript events could be parsed from ${file}`);
  }

  const store = new Store(input.dbPath);
  try {
    const captures = new CapturesStore(store);
    const repo = input.repo ? repoMetadata(input.repo) : {};
    const times = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
    const firstMs = times.length > 0 ? Math.min(...times) : Date.now();
    const lastMs = times.length > 0 ? Math.max(...times) : firstMs;
    captures.savePending({
      sessionId,
      capturedAt: new Date(firstMs).toISOString(),
      originatingTool: { name: input.tool },
      capturePath: 'B',
      status: 'pending',
      spanCount: events.length,
      durationMs: Math.max(1, lastMs - firstMs),
      redactedSpanCount: 0,
      ...repo,
    });

    const traceId = sha256(`${sessionId}:${file}`).slice(0, 32);
    events.forEach((event, index) => {
      const startMs = Date.parse(event.timestamp);
      const startNs = BigInt(Number.isFinite(startMs) ? startMs : firstMs) * 1_000_000n;
      captures.appendSpan({
        sessionId,
        spanId: sha256(`${sessionId}:${index}:${event.kind}`).slice(0, 16),
        traceId,
        parentSpanId: null,
        name: `jinn.transcript.${event.kind}`,
        startTimeUnixNano: startNs.toString(),
        endTimeUnixNano: (startNs + 1_000_000n).toString(),
        attributes: eventAttributes(event),
        redactedKeys: [],
      });
    });
  } finally {
    store.close();
  }

  return { sessionId, spans: events.length };
}

function inferTool(file: string): string {
  if (file.includes('claude')) return 'claude-code';
  if (file.includes('codex')) return 'codex';
  if (file.includes('aider')) return 'aider';
  if (file.endsWith('.jsonl')) return 'generic-jsonl';
  return 'generic';
}

function inferFormat(file: string, bytes: Buffer): CaptureImportResult['format'] {
  if (file.endsWith('.jsonl')) return 'jsonl';
  const text = bytes.toString('utf8').trimStart();
  if (file.endsWith('.json') || text.startsWith('{') || text.startsWith('[')) return 'json';
  return 'text';
}

function parserForTool(tool: string): TranscriptParser | null {
  switch (tool) {
    case 'claude-code':
      return new ClaudeCodeJsonlParser();
    case 'codex':
      return new CodexSessionParser();
    case 'gemini-cli':
      return new GeminiSessionParser();
    case 'aider':
      return new AiderHistoryParser();
    case 'continue':
      return new ContinueDevDataParser();
    default:
      return null;
  }
}

function fallbackTextEvents(sessionId: string, file: string): TranscriptEvent[] {
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return [{
    kind: 'user-message',
    timestamp: new Date().toISOString(),
    content: `Imported transcript ${basename(file)} for session ${sessionId}:\n${text.slice(0, 8_000)}`,
  }];
}

function defaultSessionId(tool: string, file: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${tool}-${stamp}-${sha256(file).slice(0, 8)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function eventAttributes(event: TranscriptEvent): Record<string, unknown> {
  switch (event.kind) {
    case 'user-message':
      return { 'jinn.capture.event.kind': event.kind, 'message.content': event.content };
    case 'assistant-message':
      return { 'jinn.capture.event.kind': event.kind, 'message.content': event.content };
    case 'tool-call':
      return { 'jinn.capture.event.kind': event.kind, 'tool.name': event.name, 'tool.args': JSON.stringify(event.args) };
    case 'tool-result':
      return {
        'jinn.capture.event.kind': event.kind,
        'tool.name': event.name,
        'tool.result': event.content,
        'tool.is_error': event.isError ?? false,
      };
    case 'edit':
      return { 'jinn.capture.event.kind': event.kind, 'file.path': event.path, 'file.diff': event.diff };
  }
}

function repoMetadata(repoPath: string): { repoRemoteUrl?: string; repoCommitHash?: string } {
  const repo = resolve(repoPath);
  const remote = gitOutput(repo, ['config', '--get', 'remote.origin.url']);
  const commit = gitOutput(repo, ['rev-parse', 'HEAD']);
  return {
    ...(remote ? { repoRemoteUrl: remote } : {}),
    ...(commit ? { repoCommitHash: commit } : {}),
  };
}

function gitOutput(repo: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const out = result.stdout.trim();
  return out || undefined;
}

const command: CommandModule = {
  name: 'capture',
  summary: 'Import local capture traces or transcripts',
  helpText: `Usage: jinn capture import <file> [--tool <name>] [--repo <path>] [--license <spdx>] [--session <id>]

Examples:
  jinn capture import path/to/otel-trace.json --repo .
  jinn capture import path/to/transcript.jsonl --tool aider --repo .
`,
  async run(ctx: CommandContext): Promise<void> {
    const [subverb, ...rest] = ctx.argv;
    if (subverb !== 'import') {
      ctx.writer.write(JSON.stringify({ error: { code: 'invalid_invocation', message: 'Usage: jinn capture import <file>' } }) + '\n');
      ctx.exit(1);
      return;
    }
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        tool: { type: 'string' },
        repo: { type: 'string' },
        license: { type: 'string' },
        session: { type: 'string' },
        config: { type: 'string' },
      },
    });
    const file = parsed.positionals[0];
    if (!file) {
      ctx.writer.write(JSON.stringify({ error: { code: 'invalid_invocation', message: 'Missing capture file path' } }) + '\n');
      ctx.exit(1);
      return;
    }
    const result: CaptureImportResult = captureImportCommand({
      file,
      tool: parsed.values.tool,
      repo: parsed.values.repo,
      license: parsed.values.license,
    });
    try {
      const config = loadConfig(getConfigPathFromArgs(ctx.argv));
      const imported = await importCaptureToStore({
        file,
        tool: result.tool,
        repo: result.repo,
        sessionId: parsed.values.session,
        dbPath: config.dbPath,
      });
      result.sessionId = imported.sessionId;
      result.spans = imported.spans;
    } catch (err) {
      ctx.writer.write(JSON.stringify({
        error: {
          code: 'capture_import_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      }) + '\n');
      ctx.exit(1);
      return;
    }
    ctx.writer.write(JSON.stringify(result) + '\n');
  },
};

export default command;
