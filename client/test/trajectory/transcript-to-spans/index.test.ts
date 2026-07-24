import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getTranscriptSpanParser,
  addTranscriptSpans,
} from '../../../src/trajectory/transcript-to-spans/index.js';
import { ClaudeCodeStreamJsonParser } from '../../../src/trajectory/transcript-to-spans/claude-code-stream-json.js';
import { CodexExecJsonParser } from '../../../src/trajectory/transcript-to-spans/codex-exec-json.js';
import { HermesSessionJsonParser } from '../../../src/trajectory/transcript-to-spans/hermes-session-json.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, HERMES_AGENT_HARNESS } from '../../../src/harnesses/names.js';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';

const WORKING_DIR = '/tmp/example-working-dir';

describe('getTranscriptSpanParser', () => {
  it('resolves CLAUDE_CODE_HARNESS (production implName) to ClaudeCodeStreamJsonParser + .claude-code/stdout.jsonl', () => {
    expect(CLAUDE_CODE_HARNESS).toBe('claude-code');
    const resolution = getTranscriptSpanParser(CLAUDE_CODE_HARNESS, WORKING_DIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.parser).toBeInstanceOf(ClaudeCodeStreamJsonParser);
    expect(resolution!.transcriptPath).toBe(join(WORKING_DIR, '.claude-code', 'stdout.jsonl'));
  });

  it('resolves CODEX_HARNESS (production implName, "codex" — NOT "codex-code") to CodexExecJsonParser + .codex-code/stdout.jsonl', () => {
    expect(CODEX_HARNESS).toBe('codex');
    const resolution = getTranscriptSpanParser(CODEX_HARNESS, WORKING_DIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.parser).toBeInstanceOf(CodexExecJsonParser);
    // The transcript DIRECTORY name is adapter-owned and unchanged — only the
    // registry KEY moved from 'codex-code' to the real implName 'codex'.
    expect(resolution!.transcriptPath).toBe(join(WORKING_DIR, '.codex-code', 'stdout.jsonl'));
  });

  it('returns null for "codex-code" — never a real task.implName in production (#1473 finding 1)', () => {
    expect(getTranscriptSpanParser('codex-code', WORKING_DIR)).toBeNull();
  });

  it('resolves HERMES_AGENT_HARNESS to HermesSessionJsonParser + .hermes-agent/session.json', () => {
    expect(HERMES_AGENT_HARNESS).toBe('hermes-agent');
    const resolution = getTranscriptSpanParser(HERMES_AGENT_HARNESS, WORKING_DIR);
    expect(resolution).not.toBeNull();
    expect(resolution!.parser).toBeInstanceOf(HermesSessionJsonParser);
    expect(resolution!.transcriptPath).toBe(join(WORKING_DIR, '.hermes-agent', 'session.json'));
  });

  it('returns null for an unknown impl name', () => {
    expect(getTranscriptSpanParser('aider', WORKING_DIR)).toBeNull();
  });

  it('returns null for a null/undefined impl name', () => {
    expect(getTranscriptSpanParser(null, WORKING_DIR)).toBeNull();
    expect(getTranscriptSpanParser(undefined, WORKING_DIR)).toBeNull();
  });
});

// #1473 finding 3: pack() retries in place (the tick loop IS the retry) and
// the collector is only cleared once PACKAGING reaches DELIVERING — so a
// failure after the transcript hook runs but before DELIVERING would
// re-parse the same transcript on the next attempt and duplicate every span,
// unless the hook is idempotent per collector.
describe('addTranscriptSpans (idempotent transcript-to-spans hook, #1473 finding 3)', () => {
  const CLAUDE_CODE_FIXTURE = readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/transcripts/claude-code/stream-json-example.jsonl', import.meta.url),
    ),
    'utf-8',
  );

  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function writeWorkingDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'transcript-to-spans-idempotent-test-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, '.claude-code'), { recursive: true });
    writeFileSync(join(dir, '.claude-code', 'stdout.jsonl'), CLAUDE_CODE_FIXTURE);
    return dir;
  }

  it('adds transcript spans exactly once even when called twice on the same collector (simulated pack() retry)', async () => {
    const workingDir = writeWorkingDir();
    const collector = new TrajectoryCollector({ taskCid: 'bafyidempotent', runId: 'run-idempotent' });

    await addTranscriptSpans(collector, CLAUDE_CODE_HARNESS, workingDir);
    const afterFirst = collector.snapshot().spans;
    const transcriptSpansAfterFirst = afterFirst.filter(
      (s) => typeof s.attributes['jinn.transcript.sourceFormat'] === 'string',
    );
    expect(transcriptSpansAfterFirst.length).toBeGreaterThan(0);

    // Simulated retry: same collector, hook invoked again.
    await addTranscriptSpans(collector, CLAUDE_CODE_HARNESS, workingDir);
    const afterSecond = collector.snapshot().spans;
    const transcriptSpansAfterSecond = afterSecond.filter(
      (s) => typeof s.attributes['jinn.transcript.sourceFormat'] === 'string',
    );

    expect(transcriptSpansAfterSecond.length).toBe(transcriptSpansAfterFirst.length);
    expect(afterSecond.length).toBe(afterFirst.length);
  });

  it('still adds spans on the very first call (guard does not block a clean collector)', async () => {
    const workingDir = writeWorkingDir();
    const collector = new TrajectoryCollector({ taskCid: 'bafyidempotent2', runId: 'run-idempotent-2' });

    await addTranscriptSpans(collector, CLAUDE_CODE_HARNESS, workingDir);

    const spans = collector.snapshot().spans;
    const kinds = spans.map((s) => s.attributes['jinn.span.kind']);
    expect(kinds).toContain('jinn.agent_turn');
  });

  it('is a no-op (no throw) when implName has no resolvable parser', async () => {
    const workingDir = writeWorkingDir();
    const collector = new TrajectoryCollector({ taskCid: 'bafyidempotent3', runId: 'run-idempotent-3' });

    await expect(addTranscriptSpans(collector, 'aider', workingDir)).resolves.not.toThrow();
    expect(collector.snapshot().spans).toEqual([]);
  });

  it('degrades to a no-op (no throw) for a resolvable parser whose transcript is absent (AC-3)', async () => {
    // hermes-agent NOW resolves a parser, but the working dir written above
    // has no .hermes-agent/session.json — the parser returns [] and no spans
    // are added: degradation, not failure.
    const workingDir = writeWorkingDir();
    const collector = new TrajectoryCollector({ taskCid: 'bafyidempotent4', runId: 'run-idempotent-4' });

    await expect(addTranscriptSpans(collector, HERMES_AGENT_HARNESS, workingDir)).resolves.not.toThrow();
    expect(collector.snapshot().spans).toEqual([]);
  });
});
