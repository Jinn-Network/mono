import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { projectEnvelope } from '../../src/corpus/envelope-projection.js';
import { Store } from '../../src/store/store.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';
import type { Task } from '../../src/types/task.js';

const TASK_CID = 'bafy-task-shared';
const TASK_ID = '42';

describe('Store envelope projection index', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('queries Solution and Verdict projections grouped under one Task projection', () => {
    const task = makePredictionTask();
    const solutionA = projectEnvelope(makeEnvelope({
      role: 'solution',
      generatedAt: 1000,
      taskCid: TASK_CID,
      requestId: `0x${'1'.repeat(64)}`,
      signatureHash: `0x${'a'.repeat(64)}`,
      payload: { probabilityYes: '0.5700', submittedAt: '2026-05-02T01:00:00.000Z', modelId: 'solver-a' },
    }), { envelopeCid: 'bafy-solution-a', task, taskId: TASK_ID });
    const solutionB = projectEnvelope(makeEnvelope({
      role: 'solution',
      generatedAt: 1100,
      taskCid: TASK_CID,
      requestId: `0x${'2'.repeat(64)}`,
      signatureHash: `0x${'b'.repeat(64)}`,
      payload: { probabilityYes: '0.6300', submittedAt: '2026-05-02T01:01:00.000Z', modelId: 'solver-b' },
    }), { envelopeCid: 'bafy-solution-b', task, taskId: TASK_ID });
    const verdictA = projectEnvelope(makeEnvelope({
      role: 'verdict',
      generatedAt: 2000,
      taskCid: 'bafy-eval-a',
      requestId: `0x${'3'.repeat(64)}`,
      signatureHash: `0x${'c'.repeat(64)}`,
      payload: verdictPayload('bafy-solution-a', '3'.repeat(64), 'SCORED'),
    }), { task: makeEvaluationTask(), taskId: TASK_ID });
    const verdictB = projectEnvelope(makeEnvelope({
      role: 'verdict',
      generatedAt: 2100,
      taskCid: 'bafy-eval-b',
      requestId: `0x${'4'.repeat(64)}`,
      signatureHash: `0x${'d'.repeat(64)}`,
      payload: verdictPayload('bafy-solution-b', '4'.repeat(64), 'SCORED'),
    }), { task: makeEvaluationTask(), taskId: TASK_ID });

    for (const projection of [solutionA, solutionB, verdictA, verdictB]) {
      store.saveEnvelopeProjection(projection);
    }

    const solutions = store.queryEnvelopeProjections({
      solverType: 'prediction.v1',
      role: 'solution',
      taskCid: TASK_CID,
    });
    const verdicts = store.queryEnvelopeProjections({
      solverType: 'prediction.v1',
      role: 'verdict',
      taskCid: TASK_CID,
      metadata: { verdict: 'SCORED' },
    });
    const all = store.queryEnvelopeProjections({ solverType: 'prediction.v1', taskId: TASK_ID });

    expect(solutions.map((p) => p.envelopeCid).sort()).toEqual(['bafy-solution-a', 'bafy-solution-b']);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.map((p) => p.solutionEnvelopeRef).sort()).toEqual(['bafy-solution-a', 'bafy-solution-b']);
    expect(all).toHaveLength(4);

    const groupKeys = new Set(all.map((p) => `${p.taskCid}:${p.taskId}`));
    expect(groupKeys).toEqual(new Set([`${TASK_CID}:${TASK_ID}`]));
  });

  it('persists generic envelope projections without prediction metadata', () => {
    const projection = projectEnvelope(makeEnvelope({
      solverType: 'legacy.v0',
      role: 'solution',
      generatedAt: 1000,
      taskCid: 'bafy-generic-task',
      requestId: `0x${'5'.repeat(64)}`,
      signatureHash: `0x${'e'.repeat(64)}`,
      payload: { text: 'generic' },
    }));

    store.saveEnvelopeProjection(projection);
    const results = store.queryEnvelopeProjections({ solverType: 'legacy.v0' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      solverType: 'legacy.v0',
      role: 'solution',
      taskCid: 'bafy-generic-task',
      solutionEnvelopeRef: null,
    });
    expect(results[0].metadata['source.venue']).toBeUndefined();
  });

  it('queries and normalizes legacy restoration projection rows through solution role filters', () => {
    const projection = projectEnvelope(makeEnvelope({
      solverType: 'legacy.v0',
      role: 'solution',
      generatedAt: 1000,
      taskCid: 'bafy-legacy-task',
      requestId: `0x${'6'.repeat(64)}`,
      signatureHash: `0x${'f'.repeat(64)}`,
      payload: { text: 'legacy' },
    }));

    store.saveEnvelopeProjection(projection);
    store.db.prepare('UPDATE envelope_projections SET role = ? WHERE envelope_id = ?')
      .run('restoration', projection.envelopeId);

    const results = store.queryEnvelopeProjections({ solverType: 'legacy.v0', role: 'solution' });

    expect(results).toHaveLength(1);
    expect(results[0].role).toBe('solution');
    expect(results[0].taskCid).toBe('bafy-legacy-task');
  });

  it('migrates older envelope projection tables with missing Task scoreboard columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-projection-migration-'));
    const dbPath = join(dir, 'store.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE envelope_projections (
        envelope_id TEXT PRIMARY KEY,
        envelope_cid TEXT,
        envelope_sha256 TEXT,
        signature_hash TEXT NOT NULL,
        solver_type TEXT NOT NULL,
        role TEXT NOT NULL,
        task_cid TEXT,
        request_id TEXT,
        generated_at INTEGER NOT NULL,
        evidence_tier TEXT NOT NULL,
        participant_safe_address TEXT,
        participant_agent_eoa TEXT,
        executor_impl_name TEXT,
        executor_impl_version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.close();

    const migrated = new Store(dbPath);
    try {
      const cols = migrated.db.prepare(`PRAGMA table_info(envelope_projections)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((col) => col.name));
      expect(names.has('task_id')).toBe(true);
      expect(names.has('executor_runtime_bundle_digest')).toBe(true);
      expect(names.has('executor_plugins_json')).toBe(true);
      expect(names.has('solution_envelope_ref')).toBe(true);
      expect(names.has('metadata_json')).toBe(true);
      expect(migrated.queryEnvelopeProjections({ solverType: 'prediction.v1' })).toEqual([]);
    } finally {
      migrated.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makePredictionTask(): Task {
  return {
    id: 'prediction-v1-polymarket-abc',
    description: 'Forecast a binary externally resolved prediction market.',
    solverType: 'prediction.v1',
    role: 'restoration',
    window: { startTs: 1000, endTs: 2000 },
    spec: {
      question: { kind: 'binary', text: 'Will test pass?', yesLabel: 'YES', noLabel: 'NO' },
      source: {
        type: 'prediction-market',
        venue: 'polymarket',
        url: 'https://polymarket.com/event/test-market',
        identifiers: {
          marketId: 'mkt-1',
          conditionId: '0xabc',
          yesTokenId: 'yes-token',
          noTokenId: 'no-token',
        },
      },
      consensusSnapshot: {
        sampledAt: '2026-05-02T00:00:00.000Z',
        probabilityYes: '0.6200',
        method: 'best-bid-ask-midpoint',
      },
    },
    eligibility: { dedupKey: 'polymarket:0xabc' },
  };
}

function makeEvaluationTask(): Task {
  return {
    ...makePredictionTask(),
    id: 'prediction-v1-eval',
    role: 'evaluation',
    context: { solutionTaskCid: TASK_CID },
  };
}

function verdictPayload(solutionCid: string, solutionSha256: string, verdict: string): Record<string, unknown> {
  return {
    verdict,
    resolutionSource: {
      venue: 'polymarket',
      marketId: 'mkt-1',
      conditionId: '0xabc',
    },
    task: { cid: TASK_CID, id: TASK_ID },
    solutionEnvelope: { cid: solutionCid, sha256: solutionSha256 },
    scores: {
      solverBrier: '0.184900',
      consensusBrier: '0.144400',
      brierSpread: '0.040500',
    },
  };
}

function makeEnvelope(overrides: {
  solverType?: string;
  role: 'solution' | 'verdict';
  generatedAt: number;
  taskCid: string;
  requestId: string;
  signatureHash: `0x${string}`;
  payload: Record<string, unknown>;
}): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: overrides.solverType ?? 'prediction.v1',
    role: overrides.role,
    generatedAt: overrides.generatedAt,
    task: {
      cid: overrides.taskCid,
      onchainCreationTx: `0x${'0'.repeat(64)}`,
      onchainCreationBlock: 123,
      requestId: overrides.requestId,
    },
    participant: {
      safeAddress: `0x${'2'.repeat(40)}`,
      agentEoa: `0x${'3'.repeat(40)}`,
    },
    window: { startTs: 1000, endTs: 2000 },
    executor: {
      implName: 'prediction-v1-baseline',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: `sha256:${'0'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: `0x${'3'.repeat(40)}` },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: overrides.payload,
    signature: {
      algo: 'secp256k1',
      signer: `0x${'3'.repeat(40)}`,
      hash: overrides.signatureHash,
      sig: `0x${'4'.repeat(130)}`,
    },
  } as SignedEnvelope;
}
