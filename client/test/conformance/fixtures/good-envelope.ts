/**
 * Fixture builders for conformance tests.
 *
 * buildGoodRestorationFixture() — a portfolio.v0 solution envelope with
 *   all required artifact types: trajectory, system_snapshot, output.portfolio.v0.
 *   One artifact is linked to the emit span from buildGoodTrajectoryFixture.
 *
 * buildGoodVerdictFixture() — a portfolio.v0 verdict envelope that references
 *   the companion solution envelope via payload.solutionEnvelope.
 */

import { vi } from 'vitest';
import { assembleAndSignEnvelope } from '../../../src/harnesses/engine/envelope-assembly.js';
import type {
  EnvelopeInputs,
  EnvelopeAssemblyDeps,
} from '../../../src/harnesses/engine/envelope-assembly.js';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import type { Task } from '../../../src/types/task.js';
import { createHash } from 'node:crypto';
import {
  buildGoodTrajectoryFixture,
  FIXTURE_ARTIFACT_CID,
  FIXTURE_EMIT_SPAN_ID,
} from './good-trajectory.js';

export const TEST_PK: `0x${string}` =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const TEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const STUB_TASK_CID = 'bafy-test-task-001';
const STUB_TRAJ_CID = 'bafy-test-trajectory-001';

// ─── Solution fixture ────────────────────────────────────────────────────────

export interface RestorationFixture {
  task: Task;
  envelope: SignedEnvelope;
  envelopeBytes: Uint8Array;
  envelopeCid: string;
}

const restorationInputs: EnvelopeInputs = {
  solverType: 'portfolio.v0',
  role: 'solution',
  task: {
    cid: STUB_TASK_CID,
    onchainCreationTx: '0x' + 'ab'.repeat(32),
    onchainCreationBlock: 100,
    requestId: '0x' + 'cd'.repeat(32),
  },
  participant: {
    safeAddress: TEST_ADDRESS,
    agentEoa: TEST_ADDRESS,
  },
  window: { startTs: 1, endTs: 86400001 },
  executor: {
    implName: 'claude-mcp-hyperliquid',
    implVersion: '1.0.0',
    clientGitSha: 'abc123',
    codeDigest: 'sha256:' + 'ab'.repeat(32),
    runtimeBundleDigest: 'sha256:' + 'bc'.repeat(32),
    plugins: [],
    signingKey: { kind: 'agent-eoa', pubkey: TEST_ADDRESS },
  },
  trajectory: {
    sha256: 'a'.repeat(64),
    access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
  },
  // Required artifact types: trajectory, system_snapshot, output.portfolio.v0
  // Plus one artifact linked to the emit span from buildGoodTrajectoryFixture.
  artifacts: [
    {
      artifactType: 'trajectory',
      sha256: 'a'.repeat(64),
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    },
    {
      artifactType: 'system_snapshot',
      sha256: 'b'.repeat(64),
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    },
    {
      artifactType: 'output.portfolio.v0',
      sha256: 'c'.repeat(64),
      metadata: {
        description: 'Portfolio output artifact',
        producedBy: {
          spanId: FIXTURE_EMIT_SPAN_ID,
          trajectoryCid: STUB_TRAJ_CID,
        },
      },
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    },
  ],
  payload: {
    preSnapshot: { capturedAt: 1, hlTime: 1, payload: {} },
    postSnapshot: { capturedAt: 2, hlTime: 2, payload: {} },
    fills: [],
    gating: {
      equityReturnPct: '0.05',
      maxDrawdownPct: '0.01',
      closedTradesCount: 25,
      tradedNotionalMultiple: '5.1',
    },
  },
  generatedAt: 1700000000000,
};

const deps: EnvelopeAssemblyDeps = {
  ipfsRegistryUrl: 'http://mock',
  agentEoaPrivateKey: TEST_PK,
};

/** Build a well-formed portfolio.v0 solution fixture. */
export async function buildGoodRestorationFixture(): Promise<RestorationFixture> {
  const result = await assembleAndSignEnvelope(restorationInputs, deps);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(result.envelope));

  const stubTask: Task = {
    id: STUB_TASK_CID,
    description: 'Test restoration Task',
    solverType: 'portfolio.v0',
    role: 'restoration',
    window: { startTs: 1, endTs: 86400001 },
    spec: {},
    eligibility: {},
  };

  return {
    task: stubTask,
    envelope: result.envelope,
    envelopeBytes,
    envelopeCid: 'bafy-test-solution-001',
  };
}

// ─── Verdict fixture ──────────────────────────────────────────────────────────

export interface VerdictFixture {
  envelope: SignedEnvelope;
  envelopeBytes: Uint8Array;
  envelopeCid: string;
  solutionEnvelopeBytes: Uint8Array;
  solutionEnvelopeCid: string;
}

/** Build a well-formed portfolio.v0 verdict fixture. */
export async function buildGoodVerdictFixture(): Promise<VerdictFixture> {
  // First build the solution envelope to get its bytes and sha256.
  const solutionResult = await assembleAndSignEnvelope(restorationInputs, deps);
  const solutionEnvelopeBytes = new TextEncoder().encode(
    JSON.stringify(solutionResult.envelope),
  );
  const solutionSha256 = createHash('sha256')
    .update(solutionEnvelopeBytes)
    .digest('hex');
  const solutionCid = 'bafy-test-solution-001';

  const verdictInputs: EnvelopeInputs = {
    solverType: 'portfolio.v0',
    role: 'verdict',
    task: {
      cid: STUB_TASK_CID,
      onchainCreationTx: '0x' + 'ab'.repeat(32),
      onchainCreationBlock: 100,
      requestId: '0x' + 'cd'.repeat(32),
    },
    participant: {
      safeAddress: TEST_ADDRESS,
      agentEoa: TEST_ADDRESS,
    },
    window: { startTs: 1, endTs: 86400001 },
    executor: {
      implName: 'claude-mcp-hyperliquid',
      implVersion: '1.0.0',
      clientGitSha: 'abc123',
      codeDigest: 'sha256:' + 'ab'.repeat(32),
      runtimeBundleDigest: 'sha256:' + 'bc'.repeat(32),
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: TEST_ADDRESS },
    },
    artifacts: [],
    payload: {
      solutionEnvelope: {
        cid: solutionCid,
        sha256: solutionSha256,
      },
      verificationOfRestoration: {
        claimedTier: 'self-signed',
        sdkVersion: '1.0.0',
        timestamp: 1700000000000,
        checks: [{ name: 'gating', passed: true }],
        overall: 'valid',
      },
      verdict: 'PASS',
      score: '1.0',
      scoreBasis: 'gating',
      scoreVersion: '1.0.0',
      rederived: {
        preSnapshot: { capturedAt: 1, payload: {} },
        postSnapshot: { capturedAt: 2, payload: {} },
        fills: [],
        gating: {},
      },
      claimed: {
        preSnapshot: { capturedAt: 1, payload: {} },
        postSnapshot: { capturedAt: 2, payload: {} },
        fillsHash: 'a'.repeat(64),
        fillsCount: 0,
        gating: {},
      },
      checks: [],
    },
    generatedAt: 1700000000001,
  };

  const result = await assembleAndSignEnvelope(verdictInputs, deps);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(result.envelope));

  return {
    envelope: result.envelope,
    envelopeBytes,
    envelopeCid: 'bafy-test-verdict-001',
    solutionEnvelopeBytes,
    solutionEnvelopeCid: solutionCid,
  };
}
