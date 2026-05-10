import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  buildConsumerChildEnv,
  buildConsumerConfig,
  ensureConsumerSweEvaluatorState,
  resolveConsumerCodexHome,
  waitForConsumerSolveAndEvaluatorProof,
} from '../../src/scripts/donation-consumption-acceptance.js';
import { Store } from '../../src/store/store.js';

describe('donation consumption acceptance config', () => {
  it('builds an isolated Codex consumer that can run without Claude auth', () => {
    const config = buildConsumerConfig({
      producerConfig: {
        network: 'testnet',
        rpcUrl: 'https://rpc.example',
        harnesses: {
          disabled: ['claude-mcp-hyperliquid'],
          externalImpls: [{ name: '@example/external' }],
        },
        solverNets: {
          'swe-rebench-v2': {
            enabled: true,
            solverType: 'swe-rebench-v2.v1',
            roles: ['solving', 'evaluating'],
            harness: 'codex-code-learner',
            plugins: ['bundled:swe-rebench-v2-runtime'],
            taskGenerator: { enabled: true },
          },
        },
      },
      consumerHome: '/tmp/jinn-consumer',
      consumerPort: 7333,
      subgraphUrl: 'https://subgraph.example',
      ipfsGatewayUrl: 'https://gateway.example',
    });

    expect(config.dbPath).toBe('/tmp/jinn-consumer/.jinn-client/jinn.db');
    expect(config.earningDir).toBe('/tmp/jinn-consumer/.jinn-client/earning');
    expect(config.apiPort).toBe(7333);
    expect(config.operator).toMatchObject({
      publicEndpoint: 'http://localhost:7333',
      donation: { enabled: true },
    });
    expect(config.harnesses).toEqual({
      default: 'codex',
      disabled: [
        'claude-mcp-hyperliquid',
        'legacy-claude',
        'claude-code',
        'claude-mcp-prediction',
        'claude-mcp-prediction-apy',
      ],
    });
    expect(config.solverNets).toMatchObject({
      'swe-rebench-v2': {
        enabled: true,
        harness: 'codex-code-learner',
        taskGenerator: { enabled: false },
      },
    });
  });

  it('keeps Jinn operator state isolated while passing explicit Codex auth home to the harness', () => {
    const codexHome = resolve('/tmp/codex-auth');
    const env = buildConsumerChildEnv('/tmp/jinn-consumer', 'daemon-token', codexHome);

    expect(resolveConsumerCodexHome(codexHome)).toBe(codexHome);
    expect(env.HOME).toBe('/tmp/jinn-consumer');
    expect(env.XDG_CONFIG_HOME).toBe('/tmp/jinn-consumer/.config');
    expect(env.DAEMON_API_TOKEN).toBe('daemon-token');
    expect(env.CODEX_HOME).toBe(codexHome);
  });

  it('enables the isolated consumer evaluator from the producer evaluator checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-donation-consumer-evaluator-'));
    const producerHome = join(root, 'producer-home');
    const consumerHome = join(root, 'consumer-home');
    const producerRoot = join(producerHome, '.jinn-client', 'engine', 'impl-state', 'swe-rebench-v2-evaluator');
    const upstreamRepoDir = join(producerRoot, 'upstream');
    mkdirSync(upstreamRepoDir, { recursive: true });
    writeFileSync(join(producerRoot, 'state.json'), JSON.stringify({
      schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
      enabled: true,
      enabledAt: '2026-05-10T00:00:00.000Z',
      upstreamRepoDir,
    }));

    const statePath = ensureConsumerSweEvaluatorState({
      producerConfig: {},
      producerHome,
      consumerConfig: {},
      consumerHome,
    });

    expect(statePath).toBe(join(
      consumerHome,
      '.jinn-client',
      'engine',
      'impl-state',
      'swe-rebench-v2-evaluator',
      'state.json',
    ));
    expect(existsSync(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      schemaVersion: 'swe-rebench-v2-evaluator-state.v1',
      enabled: true,
      upstreamRepoDir,
    });
  });

  it('accepts cache usage written during acquire_artifact before the call returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-donation-consumption-timestamps-'));
    const dbPath = join(root, 'jinn.db');
    const store = new Store(dbPath);
    const startedAt = new Date('2026-05-10T17:15:00.000Z');
    const acquisitionStartedAt = new Date('2026-05-10T17:15:37.000Z');
    const cacheTouchedAt = '2026-05-10T17:15:37.050Z';
    const acquisitionFinishedAt = new Date('2026-05-10T17:15:37.200Z');
    try {
      store.saveNetworkArtifact({
        sha256: 'donated-sha',
        artifactType: 'swe-rebench-v2_v1_solution',
        envelopeCid: 'bafk-envelope',
        content: Buffer.from('donated'),
        source: 'origin',
        sourceOperator: 'operator-a',
        sourceEndpoint: 'ipfs://bafk-source',
        paidAmountUsdc: '0',
        fetchedAt: cacheTouchedAt,
      });
      store.saveServedArtifact({
        sha256: 'consumer-solution-sha',
        artifactType: 'swe-rebench-v2_v1_solution',
        requestId: 'consumer-request',
        envelopeCid: 'bafk-consumer-solution',
        content: Buffer.from('solution'),
        priceUsdc: '0',
        createdAt: '2026-05-10T17:15:38.000Z',
      });
      store.saveServedArtifact({
        sha256: 'consumer-verdict-sha',
        artifactType: 'swe-rebench-v2_v1_verdict',
        requestId: 'consumer-verdict',
        envelopeCid: 'bafk-consumer-verdict',
        content: Buffer.from('verdict'),
        priceUsdc: '0',
        createdAt: '2026-05-10T17:15:39.000Z',
      });
    } finally {
      store.close();
    }

    const proof = {
      artifact: {
        sha256: 'donated-sha',
        artifactType: 'swe-rebench-v2_v1_solution',
        requestId: 'producer-request',
        envelopeCid: 'bafk-envelope',
        createdAt: startedAt.toISOString(),
      },
      sourceCid: 'bafk-source',
      trajectorySourceCid: 'bafk-trajectory',
      envelope: {},
      redactedEnvelope: {},
      subgraphExecution: {},
    };

    const result = await waitForConsumerSolveAndEvaluatorProof({
      storePath: dbPath,
      proof,
      startedAt,
      acquisitionStartedAt,
      acquisitionFinishedAt,
      reuseExisting: false,
      deadline: Date.now() + 100,
      pollMs: 1,
    });

    expect(result.networkRow.lastUsedAt).toBe(cacheTouchedAt);
    expect(result.solution.sha256).toBe('consumer-solution-sha');
    expect(result.verdict.sha256).toBe('consumer-verdict-sha');
  });
});
