/**
 * Tests for the `jinn conformance` CLI verb.
 *
 * Mocks `runConformance` to avoid real IPFS fetches. Verifies:
 *   - Missing --envelope-cid → emits error envelope + no exit
 *   - PASS result → human output + exit 0
 *   - FAIL result → human output + exit 1
 *   - --json flag → JSON output
 *   - Unknown flag → emits error envelope
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import conformance from '../../../src/cli/commands/conformance.js';
import type { CommandContext } from '../../../src/cli/command.js';

// Mock runConformance to avoid IPFS
const runConformanceMock = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => ({
    envelopeCid: 'bafy-test-cid',
    envelopeTier: 'self-signed' as const,
    checks: [
      { id: 'envelope.schema', layer: 1 as const, passed: true },
      { id: 'envelope.hash-signature', layer: 1 as const, passed: true },
    ],
    summary: { total: 2, passed: 2, failed: 0, skipped: 0 },
    overall: 'PASS' as const,
    layer1Passed: true,
    layer2Passed: 'N/A' as const,
  })),
);

vi.mock('../../../src/conformance/harness.js', () => ({
  runConformance: runConformanceMock,
}));

const tempDirs: string[] = [];

function withTempConfig(argv: string[]): string[] {
  if (argv.includes('--config')) return argv;
  const dir = mkdtempSync(join(tmpdir(), 'jinn-conformance-config-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({}), 'utf-8');
  return [...argv, '--config', configPath];
}

function makeCtx(argv: string[] = []): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: argv.some((arg) => arg === '--envelope-cid') ? withTempConfig(argv) : argv,
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: {},
  };
  return { ctx, writes, exits };
}

describe('conformance command', () => {
  beforeEach(() => {
    runConformanceMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits an error envelope when --envelope-cid is missing', async () => {
    const { ctx, writes, exits } = makeCtx([]);
    await conformance.run(ctx);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.message).toMatch(/envelope-cid/i);
    expect(exits).toHaveLength(1);
    expect(exits[0]).not.toBe(0);
  });

  it('emits human-readable output and exits 0 on PASS', async () => {
    const { ctx, writes, exits } = makeCtx(['--envelope-cid', 'bafy-test-cid']);
    await conformance.run(ctx);
    const output = writes.join('');
    expect(output).toMatch(/bafy-test-cid/);
    expect(output).toMatch(/PASS/);
    expect(output).toMatch(/Overall/);
    expect(exits).toContain(0);
    expect(runConformanceMock).toHaveBeenCalledOnce();
    expect(runConformanceMock.mock.calls[0][0]).toMatchObject({
      envelopeCid: 'bafy-test-cid',
    });
  });

  it('exits 1 on FAIL', async () => {
    runConformanceMock.mockResolvedValueOnce({
      envelopeCid: 'bafy-bad-cid',
      envelopeTier: 'self-signed' as const,
      checks: [
        { id: 'envelope.schema', layer: 1 as const, passed: false, detail: 'bad schema' },
      ],
      summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
      overall: 'FAIL' as const,
      layer1Passed: false,
      layer2Passed: 'N/A' as const,
    });
    const { ctx, exits } = makeCtx(['--envelope-cid', 'bafy-bad-cid']);
    await conformance.run(ctx);
    expect(exits).toContain(1);
  });

  it('emits JSON when --json flag is set', async () => {
    const { ctx, writes } = makeCtx(['--envelope-cid', 'bafy-test-cid', '--json']);
    await conformance.run(ctx);
    const combined = writes.join('');
    const parsed = JSON.parse(combined);
    expect(parsed.envelopeCid).toBe('bafy-test-cid');
    expect(parsed.overall).toBe('PASS');
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it('passes skipLayer2 option when --skip-layer2 flag is set', async () => {
    const { ctx } = makeCtx(['--envelope-cid', 'bafy-test-cid', '--skip-layer2']);
    await conformance.run(ctx);
    const callArgs = runConformanceMock.mock.calls[0][0] as { options?: { skipLayer2?: boolean } };
    expect(callArgs.options?.skipLayer2).toBe(true);
  });

  it('emits an error envelope on unknown flags', async () => {
    const { ctx, writes } = makeCtx(['--bogus-flag']);
    await conformance.run(ctx);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.code).toBe('invalid_invocation');
  });
});
