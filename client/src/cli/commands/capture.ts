import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';

export interface CaptureImportResult {
  ok: true;
  action: 'capture import';
  file: string;
  tool: string;
  repo?: string;
  license?: string;
  bytes: number;
  format: 'json' | 'jsonl' | 'text';
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

function inferTool(file: string): string {
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

const command: CommandModule = {
  name: 'capture',
  summary: 'Import local capture traces or transcripts',
  helpText: `Usage: jinn capture import <file> [--tool <name>] [--repo <path>] [--license <spdx>]

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
      },
    });
    const file = parsed.positionals[0];
    if (!file) {
      ctx.writer.write(JSON.stringify({ error: { code: 'invalid_invocation', message: 'Missing capture file path' } }) + '\n');
      ctx.exit(1);
      return;
    }
    const result = captureImportCommand({
      file,
      tool: parsed.values.tool,
      repo: parsed.values.repo,
      license: parsed.values.license,
    });
    ctx.writer.write(JSON.stringify(result) + '\n');
  },
};

export default command;
