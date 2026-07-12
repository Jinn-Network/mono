/**
 * Publish-path tests (plan Task 4, issue #1311).
 *
 * The three automated-verification nets from the plan:
 *  - no-bypass: `publish(raw)` is not constructible — only a PendingEnvelope
 *    from `capture()` (which scrubbed) can publish, enforced by type AND a
 *    runtime kind gate;
 *  - veto: `opts.veto` means zero publish/anchor calls and a ledger entry
 *    marked `vetoed (local only)`;
 *  - anchor-recorded: the anchor tx lands in the result and the ledger.
 *
 * All deps are mocked — automated tests never anchor to live testnet
 * (docs/runbooks/testing.md); live publish is the human surface.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrubPipeline } from '../../../src/trajectory/scrub/pipeline.js';
import { SignedEnvelopeSchema } from '../../../src/types/envelope.js';
import { capture, type CapturedTask, type PendingEnvelope } from '../src/capture.js';
import { parseTraceEnvelopeV0 } from '../src/envelope.js';
import {
  publish,
  toTraceEnvelope,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  type HarnessPublishDeps,
} from '../src/publish.js';
import {
  createFileLedger,
  createMemoryLedger,
  ledger,
  type LedgerEntry,
  type LedgerRow,
} from '../src/ledger.js';
import { runJinnLayerCli } from '../src/cli.js';

// Well-known Anvil dev key #0 — test-only, never a real operator key.
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;
const TEST_TX = `0x${'ab'.repeat(32)}` as const;

function validTask(overrides: Partial<CapturedTask> = {}): CapturedTask {
  return {
    session: {
      sessionId: '9f2c1e4a-7b3d-4e8f-a1c2-d5e6f7a8b9c0',
      capturedAt: '2026-07-02T10:41:22.000Z',
    },
    task: {
      summary: 'Fix failing vitest suite after zod v4 upgrade',
      distributionTags: ['typescript', 'testing'],
    },
    environment: {
      harness: { name: 'jinn-test-harness', version: '0.0.1' },
      model: 'claude-haiku-4-5',
      tools: ['run_command'],
    },
    steps: [
      {
        spanId: 'span-1',
        parentSpanId: null,
        name: 'tool:run_command',
        startTimeUnixNano: '1751450482000000000',
        endTimeUnixNano: '1751450483000000000',
        attributes: { 'tool.command': 'yarn test' },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    cost: { durationMs: 61_000 },
    provenance: 'contributed',
    ...overrides,
  };
}

async function pendingFixture(): Promise<PendingEnvelope> {
  // Empty injected base pipeline keeps these tests fast; the scrub itself is
  // Task 3's test surface, not this one's.
  return capture(validTask(), { pipeline: new ScrubPipeline([]) });
}

interface MockDeps {
  deps: HarnessPublishDeps;
  calls: {
    publishArtifact: Array<{ artifactType: string; payload: unknown }>;
    publishEnvelope: unknown[];
    anchorEnvelope: Array<{ envelopeCid: string }>;
  };
  entries: LedgerEntry[];
}

function mockDeps(): MockDeps {
  const memory = createMemoryLedger();
  const calls: MockDeps['calls'] = {
    publishArtifact: [],
    publishEnvelope: [],
    anchorEnvelope: [],
  };
  const deps: HarnessPublishDeps = {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: memory,
    publishArtifact: async (input) => {
      calls.publishArtifact.push(input);
      return { cid: 'bafy-trace-artifact', sha256: 'a'.repeat(64) };
    },
    publishEnvelope: async (envelope) => {
      calls.publishEnvelope.push(envelope);
      return { cid: 'bafy-signed-envelope', sha256: 'b'.repeat(64) };
    },
    anchorEnvelope: async ({ envelopeCid }) => {
      calls.anchorEnvelope.push({ envelopeCid });
      return { txHash: TEST_TX, blockNumber: 42 };
    },
  };
  return { deps, calls, entries: memory.list() };
}

describe('toTraceEnvelope', () => {
  it('converts a PendingEnvelope by attaching the literal-true consent block', async () => {
    const pending = await pendingFixture();
    const envelope = toTraceEnvelope(pending);
    expect(envelope.consent).toEqual({ contributionConsent: true, scrubCompleted: true });
    // The conversion output is a valid frozen envelope.
    expect(() => parseTraceEnvelopeV0(envelope)).not.toThrow();
  });

  it('rejects anything that is not a capture()-produced PendingEnvelope', async () => {
    const pending = await pendingFixture();
    const raw = { ...pending, kind: 'jinn.trace-envelope.v0' };
    expect(() => toTraceEnvelope(raw as unknown as PendingEnvelope)).toThrow(TypeError);
  });
});

describe('publish', () => {
  it('no-bypass: a raw (non-PendingEnvelope) value is rejected before any dep call', async () => {
    const { deps, calls } = mockDeps();
    const pending = await pendingFixture();
    const raw = { draft: pending.draft, redactions: [] };
    await expect(publish(raw as unknown as PendingEnvelope, deps)).rejects.toThrow(TypeError);
    expect(calls.publishArtifact).toHaveLength(0);
    expect(calls.publishEnvelope).toHaveLength(0);
    expect(calls.anchorEnvelope).toHaveLength(0);
  });

  it('publishes the TraceEnvelopeV0 artifact, a signed wrapper envelope, and anchors', async () => {
    const { deps, calls } = mockDeps();
    const pending = await pendingFixture();
    const result = await publish(pending, deps);

    // The published artifact is the consented, schema-valid trace envelope.
    expect(calls.publishArtifact).toHaveLength(1);
    expect(calls.publishArtifact[0]!.artifactType).toBe(TRACE_ENVELOPE_ARTIFACT_TYPE);
    const trace = parseTraceEnvelopeV0(calls.publishArtifact[0]!.payload);
    expect(trace.consent).toEqual({ contributionConsent: true, scrubCompleted: true });

    // The wrapper is a valid SignedEnvelope carrying the trace artifact —
    // this is what makes the ref resolvable via `corpus get`.
    expect(calls.publishEnvelope).toHaveLength(1);
    const signed = SignedEnvelopeSchema.parse(calls.publishEnvelope[0]);
    expect(signed.artifacts.map((a) => a.artifactType)).toContain(TRACE_ENVELOPE_ARTIFACT_TYPE);
    expect(signed.participant.safeAddress).toBe(TEST_SAFE);

    // Anchored under the published envelope CID; anchor recorded in the result.
    expect(calls.anchorEnvelope).toEqual([{ envelopeCid: 'bafy-signed-envelope' }]);
    expect(result).toEqual({
      vetoed: false,
      envelopeRef: 'bafy-signed-envelope',
      anchorTx: TEST_TX,
    });
  });

  it('records a published ledger entry with the anchor tx and verifiability tier', async () => {
    const { deps } = mockDeps();
    const pending = await pendingFixture();
    await publish(pending, deps);
    const entries = deps.ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      taskSummary: 'Fix failing vitest suite after zod v4 upgrade',
      envelopeRef: 'bafy-signed-envelope',
      anchorTx: TEST_TX,
      verifiabilityTier: 'tests-passed',
      status: 'published',
    });
  });

  it('veto: publishes nothing, anchors nothing, ledger entry marked vetoed (local only)', async () => {
    const { deps, calls } = mockDeps();
    const pending = await pendingFixture();
    const result = await publish(pending, deps, { veto: true });
    expect(result).toEqual({ vetoed: true });
    expect(calls.publishArtifact).toHaveLength(0);
    expect(calls.publishEnvelope).toHaveLength(0);
    expect(calls.anchorEnvelope).toHaveLength(0);
    const entries = deps.ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      envelopeRef: null,
      anchorTx: null,
      status: 'vetoed (local only)',
    });
  });
});

describe('ledger persistence', () => {
  it('file ledger round-trips entries and ledger() reads them back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-ledger-'));
    const path = join(dir, 'nested', 'ledger.jsonl');
    const store = createFileLedger(path);
    const { deps } = mockDeps();
    const filedDeps = { ...deps, ledger: store };
    await publish(await pendingFixture(), filedDeps);
    await publish(await pendingFixture(), filedDeps, { veto: true });

    const entries = ledger(path);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.status).toBe('published');
    expect(entries[1]!.status).toBe('vetoed (local only)');
    // JSONL on disk: one parseable object per line, no `before` values anywhere.
    const linesRaw = readFileSync(path, 'utf-8').trim().split('\n');
    expect(linesRaw).toHaveLength(2);
    for (const line of linesRaw) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('skips malformed ledger lines instead of failing the whole read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const store = createFileLedger(path);
    store.append({
      ts: '2026-07-02T12:00:00.000Z',
      taskSummary: 'ok entry',
      envelopeRef: 'bafy-x',
      anchorTx: null,
      verifiabilityTier: 'user-accepted',
      status: 'published',
    });
    appendFileSync(path, 'not json\n');
    const entries = ledger(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.taskSummary).toBe('ok entry');
  });

  it('ledger() on a missing file is an empty ledger, not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-ledger-'));
    expect(ledger(join(dir, 'never-written.jsonl'))).toEqual([]);
  });
});

describe('jinn-layer ledger CLI', () => {
  function writerSink(): { write: (s: string) => boolean; output: () => string } {
    let buf = '';
    return {
      write(s: string) {
        buf += s;
        return true;
      },
      output: () => buf,
    };
  }

  it('renders the ledger table with testnet explorer URLs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const store = createFileLedger(path);
    store.append({
      ts: '2026-07-02T12:00:00.000Z',
      taskSummary: 'Fix failing vitest suite',
      envelopeRef: 'bafy-signed-envelope',
      anchorTx: TEST_TX,
      verifiabilityTier: 'tests-passed',
      status: 'published',
    });
    const sink = writerSink();
    const code = await runJinnLayerCli(['ledger', '--path', path], { writer: sink });
    expect(code).toBe(0);
    const out = sink.output();
    expect(out).toContain('bafy-signed-envelope');
    expect(out).toContain(`https://sepolia.basescan.org/tx/${TEST_TX}`);
    expect(out).toContain('tests-passed');
  });

  it('--json emits the fork row shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-ledger-'));
    const path = join(dir, 'ledger.jsonl');
    writeFileSync(
      path,
      JSON.stringify({
        ts: '2026-07-02T12:00:00.000Z',
        taskSummary: 'entry',
        envelopeRef: 'bafy-1',
        anchorTx: null,
        verifiabilityTier: 'user-accepted',
        status: 'published',
      }) + '\n',
    );
    const sink = writerSink();
    const code = await runJinnLayerCli(['ledger', '--path', path, '--json'], { writer: sink });
    expect(code).toBe(0);
    const parsed = JSON.parse(sink.output()) as LedgerRow[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.env).toBe('bafy-1');
  });

  it('an empty ledger renders an explicit empty state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-ledger-'));
    const sink = writerSink();
    const code = await runJinnLayerCli(
      ['ledger', '--path', join(dir, 'none.jsonl')],
      { writer: sink },
    );
    expect(code).toBe(0);
    expect(sink.output().toLowerCase()).toContain('no contributions');
  });

  it('publish <task-file> captures, publishes and prints the ref + anchor link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-publish-'));
    const taskFile = join(dir, 'task.json');
    writeFileSync(taskFile, JSON.stringify(validTask()));
    const { deps, calls } = mockDeps();
    const sink = writerSink();
    const code = await runJinnLayerCli(['publish', taskFile], {
      writer: sink,
      publishDeps: deps,
    });
    expect(code).toBe(0);
    expect(calls.anchorEnvelope).toHaveLength(1);
    const out = sink.output();
    expect(out).toContain('bafy-signed-envelope');
    expect(out).toContain(`https://sepolia.basescan.org/tx/${TEST_TX}`);
  });

  it('publish --veto records locally and publishes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-publish-'));
    const taskFile = join(dir, 'task.json');
    writeFileSync(taskFile, JSON.stringify(validTask()));
    const { deps, calls } = mockDeps();
    const sink = writerSink();
    const code = await runJinnLayerCli(['publish', taskFile, '--veto'], {
      writer: sink,
      publishDeps: deps,
    });
    expect(code).toBe(0);
    expect(calls.publishArtifact).toHaveLength(0);
    expect(calls.anchorEnvelope).toHaveLength(0);
    expect(sink.output().toLowerCase()).toContain('vetoed');
    expect(deps.ledger.list()[0]!.status).toBe('vetoed (local only)');
  });
});
