/**
 * Tests for the `jinn evidence` CLI verb (stage-3 W1 read verbs).
 *
 * The IPFS byte fetch, the conformance harness, and the HTTP discovery API are
 * all stubbed — these are pure CLI-surface tests.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import evidence from '../../../src/cli/commands/evidence.js';
import type { CommandContext } from '../../../src/cli/command.js';

const fetchSignedEnvelopeBytesRawMock = vi.hoisted(() =>
  vi.fn(async (_gateway: string, _cid: string) => new Uint8Array()),
);
const runConformanceMock = vi.hoisted(() => vi.fn(async (_args: unknown) => ({})));
const getAutopilotDeliveryCandidatesMock = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => ({}) as Record<string, unknown>),
);
const createHttpDiscoveryAPIMock = vi.hoisted(() =>
  vi.fn((_opts: { url: string }) => ({
    getAutopilotDeliveryCandidates: getAutopilotDeliveryCandidatesMock,
  })),
);

vi.mock('../../../src/adapters/mech/ipfs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchSignedEnvelopeBytesRaw: fetchSignedEnvelopeBytesRawMock,
}));
vi.mock('../../../src/conformance/harness.js', () => ({
  runConformance: runConformanceMock,
}));
vi.mock('../../../src/discovery/http.js', () => ({
  createHttpDiscoveryAPI: createHttpDiscoveryAPIMock,
}));

// ── fixtures ─────────────────────────────────────────────────────────────────

const SAFE = `0x${'11'.repeat(20)}`;
const EOA = `0x${'22'.repeat(20)}`;

function buildEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'portfolio.v0',
    role: 'solution',
    generatedAt: 1700000000000,
    task: {
      cid: 'bafy-task-001',
      onchainCreationTx: `0x${'ab'.repeat(32)}`,
      onchainCreationBlock: 100,
      requestId: `0x${'cd'.repeat(32)}`,
    },
    participant: { safeAddress: SAFE, agentEoa: EOA },
    window: { startTs: 1, endTs: 86400001 },
    executor: {
      implName: 'claude-mcp',
      implVersion: '1.0.0',
      clientGitSha: 'abc123',
      codeDigest: `sha256:${'ab'.repeat(32)}`,
      runtimeBundleDigest: `sha256:${'bc'.repeat(32)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: EOA },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: {
      sha256: 'a'.repeat(64),
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      sources: [
        {
          kind: 'ipfs',
          cid: 'bafy-trajectory-001',
          sha256: 'a'.repeat(64),
          encoding: 'jinn.artifact.donation.v1',
        },
      ],
    },
    artifacts: [
      {
        artifactType: 'output.portfolio.v0',
        sha256: 'c'.repeat(64),
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      },
    ],
    payload: {},
    signature: {
      algo: 'secp256k1',
      signer: EOA,
      hash: `0x${'ee'.repeat(32)}`,
      sig: `0x${'ff'.repeat(65)}`,
    },
    ...overrides,
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const tempDirs: string[] = [];

/** Writes a config file and returns argv with `--config <path>` appended. */
function withConfig(argv: string[], config: Record<string, unknown>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-evidence-config-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return [...argv, '--config', configPath];
}

const HTTP_DISCOVERY_CONFIG = {
  network: 'testnet',
  discovery: { mode: 'http', url: 'https://indexer.example' },
};
const ONCHAIN_DISCOVERY_CONFIG = {
  network: 'testnet',
  discovery: { mode: 'onchain' },
};

function makeCtx(argv: string[]): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: {},
  };
  return { ctx, writes, exits };
}

describe('evidence command', () => {
  beforeEach(() => {
    fetchSignedEnvelopeBytesRawMock.mockReset();
    fetchSignedEnvelopeBytesRawMock.mockResolvedValue(encode(buildEnvelope()));
    runConformanceMock.mockReset();
    getAutopilotDeliveryCandidatesMock.mockReset();
    createHttpDiscoveryAPIMock.mockClear();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('prints help for an empty invocation and rejects unknown subverbs', async () => {
    const helped = makeCtx([]);
    await evidence.run(helped.ctx);
    expect(helped.writes.join('')).toMatch(/jinn evidence show/);
    expect(helped.exits).toEqual([]);

    const bogus = makeCtx(['bogus']);
    await evidence.run(bogus.ctx);
    expect(JSON.parse(bogus.writes[0]!)).toMatchObject({
      code: 'invalid_invocation',
      details: { expected: 'show|find' },
    });
    expect(bogus.exits).toEqual([11]);
  });

  // ── show ───────────────────────────────────────────────────────────────────

  describe('show', () => {
    it('requires --envelope-cid', async () => {
      const { ctx, writes, exits } = makeCtx(['show']);
      await evidence.run(ctx);
      expect(JSON.parse(writes[0]!)).toMatchObject({
        code: 'invalid_invocation',
        message: '--envelope-cid is required',
      });
      expect(exits).toEqual([11]);
    });

    it('emits the envelope identifying fields as JSON and does not exit', async () => {
      const { ctx, writes, exits } = makeCtx(
        withConfig(['show', '--envelope-cid', 'bafy-envelope-001'], {}),
      );
      await evidence.run(ctx);

      const result = JSON.parse(writes.join(''));
      expect(result.verb).toBe('evidence show');
      expect(result.envelope).toMatchObject({
        envelopeCid: 'bafy-envelope-001',
        schemaVersion: 'jinn.execution.v1',
        kind: 'portfolio.v0',
        solverType: 'portfolio.v0',
        role: 'solution',
        evidenceTier: 'self-signed',
        operator: { safeAddress: SAFE, agentEoa: EOA, agentId: null },
        task: { cid: 'bafy-task-001' },
        trajectory: { cid: 'bafy-trajectory-001', sha256: 'a'.repeat(64) },
        verdict: null,
      });
      expect(result.envelope.envelopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.envelope.artifacts).toEqual([
        { artifactType: 'output.portfolio.v0', sha256: 'c'.repeat(64) },
      ]);
      expect(result.conformance).toBeUndefined();
      expect(exits).toEqual([]);
      expect(runConformanceMock).not.toHaveBeenCalled();
    });

    it('surfaces the verdict when the envelope carries one', async () => {
      fetchSignedEnvelopeBytesRawMock.mockResolvedValue(
        encode(
          buildEnvelope({
            role: 'verdict',
            payload: { verdict: 'PASS', score: '1.0' },
          }),
        ),
      );
      const { ctx, writes } = makeCtx(
        withConfig(['show', '--envelope-cid', 'bafy-verdict-001'], {}),
      );
      await evidence.run(ctx);
      const result = JSON.parse(writes.join(''));
      expect(result.envelope.role).toBe('verdict');
      expect(result.envelope.verdict).toEqual({ verdict: 'PASS', score: '1.0' });
    });

    it('renders human output when --human is set', async () => {
      const { ctx, writes } = makeCtx(
        withConfig(['show', '--envelope-cid', 'bafy-envelope-001', '--human'], {}),
      );
      await evidence.run(ctx);
      const out = writes.join('');
      expect(out).toMatch(/Envelope bafy-envelope-001/);
      expect(out).toMatch(/Kind\s+: portfolio\.v0/);
    });

    it('--verify folds the conformance report in without changing the exit code on FAIL', async () => {
      runConformanceMock.mockResolvedValue({
        envelopeCid: 'bafy-envelope-001',
        envelopeTier: 'self-signed',
        checks: [{ id: 'envelope.schema', layer: 1, passed: false, detail: 'nope' }],
        summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
        overall: 'FAIL',
        layer1Passed: false,
        layer2Passed: 'N/A',
      });
      const { ctx, writes, exits } = makeCtx(
        withConfig(['show', '--envelope-cid', 'bafy-envelope-001', '--verify'], {}),
      );
      await evidence.run(ctx);

      const result = JSON.parse(writes.join(''));
      expect(result.conformance).toMatchObject({ overall: 'FAIL', layer1Passed: false });
      // The read succeeded; a failing conformance report must not red-exit it.
      expect(exits).toEqual([]);
      expect(runConformanceMock).toHaveBeenCalledOnce();
    });

    it('reports a transient_error when the gateway fetch fails', async () => {
      fetchSignedEnvelopeBytesRawMock.mockRejectedValue(new Error('gateway 504'));
      const { ctx, writes, exits } = makeCtx(
        withConfig(['show', '--envelope-cid', 'bafy-missing'], {}),
      );
      await evidence.run(ctx);
      expect(JSON.parse(writes[0]!)).toMatchObject({
        code: 'transient_error',
        message: expect.stringContaining('gateway 504'),
      });
      expect(exits).toEqual([40]);
    });

    it('rejects bytes that are not a signed envelope', async () => {
      fetchSignedEnvelopeBytesRawMock.mockResolvedValue(encode({ not: 'an envelope' }));
      const { ctx, writes, exits } = makeCtx(
        withConfig(['show', '--envelope-cid', 'bafy-junk'], {}),
      );
      await evidence.run(ctx);
      expect(JSON.parse(writes[0]!)).toMatchObject({
        code: 'invalid_invocation',
        details: { field: '--envelope-cid' },
      });
      expect(exits).toEqual([11]);
    });
  });

  // ── find ───────────────────────────────────────────────────────────────────

  describe('find', () => {
    it('requires --task-id', async () => {
      const { ctx, writes, exits } = makeCtx(['find']);
      await evidence.run(ctx);
      expect(JSON.parse(writes[0]!)).toMatchObject({
        code: 'invalid_invocation',
        message: '--task-id is required',
      });
      expect(exits).toEqual([11]);
    });

    it('rejects an unknown --role', async () => {
      const { ctx, writes, exits } = makeCtx(['find', '--task-id', '42', '--role', 'bogus']);
      await evidence.run(ctx);
      expect(JSON.parse(writes[0]!)).toMatchObject({
        code: 'invalid_invocation',
        details: { field: '--role', expected: 'solution|verdict' },
      });
      expect(exits).toEqual([11]);
    });

    it('names the config key and env var when HTTP discovery is not configured', async () => {
      const { ctx, writes, exits } = makeCtx(
        withConfig(['find', '--task-id', '42'], ONCHAIN_DISCOVERY_CONFIG),
      );
      await evidence.run(ctx);
      const envelope = JSON.parse(writes[0]!);
      expect(envelope.code).toBe('invalid_invocation');
      expect(envelope.details).toMatchObject({
        field: 'discovery.mode',
        expected: 'http',
        actual: 'onchain',
        configKeys: ['discovery.mode', 'discovery.url'],
        envVars: ['JINN_DISCOVERY_MODE', 'JINN_DISCOVERY_URL'],
      });
      expect(envelope.hint).toMatch(/JINN_DISCOVERY_URL/);
      expect(exits).toEqual([11]);
      // No silent fall-through to the on-chain floor.
      expect(createHttpDiscoveryAPIMock).not.toHaveBeenCalled();
    });

    it('returns the envelope CID for a ready lookup', async () => {
      getAutopilotDeliveryCandidatesMock.mockResolvedValue({
        status: 'ready',
        role: 'solution',
        task: {
          taskId: '42',
          taskCidDigest: `0x${'11'.repeat(32)}`,
          createdAtBlock: 10,
          createdAtTx: `0x${'22'.repeat(32)}`,
        },
        attempt: {
          taskId: '42',
          attemptIndex: 0,
          requestId: `0x${'33'.repeat(32)}`,
          operator: SAFE,
          createdAtBlock: 11,
        },
        solutionOperator: SAFE,
        envelope: {
          requestId: `0x${'33'.repeat(32)}`,
          manifestCid: 'bafy-envelope-001',
          publisherAgentId: '7',
          manifestHash: `0x${'44'.repeat(32)}`,
          enrichedAtBlock: 12,
        },
      });

      const { ctx, writes, exits } = makeCtx(
        withConfig(['find', '--task-id', '42'], HTTP_DISCOVERY_CONFIG),
      );
      await evidence.run(ctx);

      const result = JSON.parse(writes.join(''));
      expect(result).toMatchObject({
        verb: 'evidence find',
        taskId: '42',
        role: 'solution',
        chainId: 84532,
        status: 'ready',
        envelopeCids: ['bafy-envelope-001'],
        publisherAgentId: '7',
      });
      expect(exits).toEqual([]);
      expect(createHttpDiscoveryAPIMock).toHaveBeenCalledWith({
        url: 'https://indexer.example',
      });
      expect(getAutopilotDeliveryCandidatesMock).toHaveBeenCalledWith({
        chainId: 84532,
        taskId: '42',
        role: 'solution',
      });
    });

    it('reports a pending lookup with an empty CID list and exit 0', async () => {
      getAutopilotDeliveryCandidatesMock.mockResolvedValue({
        status: 'pending',
        reason: 'attempt-not-indexed',
        taskId: '42',
        role: 'verdict',
      });
      const { ctx, writes, exits } = makeCtx(
        withConfig(['find', '--task-id', '42', '--role', 'verdict'], HTTP_DISCOVERY_CONFIG),
      );
      await evidence.run(ctx);
      expect(JSON.parse(writes.join(''))).toMatchObject({
        status: 'pending',
        reason: 'attempt-not-indexed',
        role: 'verdict',
        envelopeCids: [],
      });
      expect(exits).toEqual([]);
    });

    it('emits a transient_error when the indexer is unreachable', async () => {
      getAutopilotDeliveryCandidatesMock.mockRejectedValue(new Error('indexer not ready: 503'));
      const { ctx, writes, exits } = makeCtx(
        withConfig(['find', '--task-id', '42'], HTTP_DISCOVERY_CONFIG),
      );
      await evidence.run(ctx);
      expect(JSON.parse(writes[0]!)).toMatchObject({
        code: 'transient_error',
        message: expect.stringContaining('indexer not ready: 503'),
      });
      expect(exits).toEqual([40]);
    });
  });
});
