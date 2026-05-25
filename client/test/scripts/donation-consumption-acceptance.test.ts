import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  buildConsumerChildEnv,
  buildConsumerConfig,
  ensureConsumerSweEvaluatorState,
  findDonatedArtifactRecord,
  resolveConsumerCodexHome,
  scopeConsumerConfigToProducerTask,
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
        joinedSolverNets: {
          'bafkreiswe': {
            manifestCid: 'bafkreiswe',
            name: 'swe-rebench-v2',
            contract: { id: 'swe-rebench-v2', version: 'v1' },
            roles: ['solver', 'evaluator'],
            harness: 'codex-code-learner',
            plugins: ['bundled:swe-rebench-v2-runtime'],
            disabledDefaultPlugins: [],
          },
        },
      },
      consumerHome: '/tmp/jinn-consumer',
      consumerPort: 7333,
      indexerUrl: 'https://jinn-indexer-production.up.railway.app',
      ipfsGatewayUrl: 'https://gateway.example',
    });

    expect(config.dbPath).toBe('/tmp/jinn-consumer/.jinn-client/jinn.db');
    expect(config.earningDir).toBe('/tmp/jinn-consumer/.jinn-client/earning');
    expect(config.apiPort).toBe(7333);
    expect(config.discovery).toEqual({
      mode: 'http',
      url: 'https://jinn-indexer-production.up.railway.app',
      fallbackToOnchain: true,
    });
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
    // Issue #421: the consumer config no longer carries a legacy
    // `solverNets` block — only the inherited joinedSolverNets membership.
    expect((config as Record<string, unknown>).solverNets).toBeUndefined();
    expect(config.joinedSolverNets).toMatchObject({
      bafkreiswe: {
        manifestCid: 'bafkreiswe',
        name: 'swe-rebench-v2',
        roles: ['solver', 'evaluator'],
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

  it('scopes the managed consumer to the producer task id resolved from the Ponder indexer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-donation-consumer-scope-'));
    const configPath = join(root, 'config.json');
    const consumerConfig = {
      network: 'testnet',
      rpcUrl: 'https://rpc.example',
      apiPort: 7333,
    };
    writeFileSync(configPath, JSON.stringify(consumerConfig));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          tasks: {
            items: [{ id: '109', taskCidDigest: '0xaaaa', createdAtTx: '0xabc' }],
          },
        },
      }),
    } as unknown as Response);
    try {
      const taskId = await scopeConsumerConfigToProducerTask({
        consumerConfig,
        consumerConfigPath: configPath,
        indexerUrl: 'https://jinn-indexer-production.up.railway.app',
        proof: {
          artifact: {
            sha256: 'producer-sha',
            artifactType: 'swe-rebench-v2_v1_solution',
            requestId: 'producer-request',
            envelopeCid: 'bafk-envelope',
            createdAt: '2026-05-10T17:15:00.000Z',
          },
          sourceCid: 'bafk-source',
          trajectorySourceCid: 'bafk-trajectory',
          envelope: {
            task: {
              cid: 'f01551220aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              onchainCreationTx: '0xAbC',
            },
          },
          redactedEnvelope: {},
          indexExecution: {},
        },
      });

      expect(taskId).toBe('109');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://jinn-indexer-production.up.railway.app/graphql',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
        taskDiscoveryAllowedTaskIds: ['109'],
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('prefers network discovery records with donated IPFS source args over cached local records', () => {
    const proof = {
      artifact: {
        sha256: 'producer-sha',
        artifactType: 'swe-rebench-v2_v1_solution',
        requestId: 'producer-request',
        envelopeCid: 'bafk-envelope',
        createdAt: '2026-05-10T17:15:00.000Z',
      },
      sourceCid: 'bafk-source',
      trajectorySourceCid: 'bafk-trajectory',
      envelope: {},
      redactedEnvelope: {},
      indexExecution: {},
    } as any;

    const localCachedArtifact = {
      sha256: 'producer-sha',
      envelopeCid: 'bafk-envelope',
      acquisition: {
        arguments: {
          sha256: 'producer-sha',
          access: { endpoint: 'ipfs://bafk-source', priceUsdc: '0' },
          envelopeCid: 'bafk-envelope',
          artifactType: 'swe-rebench-v2_v1_solution',
        },
      },
    };
    const networkArtifact = {
      sha256: 'producer-sha',
      envelopeCid: 'bafk-envelope',
      acquisition: {
        arguments: {
          sha256: 'producer-sha',
          envelopeCid: 'bafk-envelope',
          artifactType: 'swe-rebench-v2_v1_solution',
          sources: [{
            kind: 'ipfs',
            cid: 'bafk-source',
            sha256: 'producer-sha',
            encoding: 'jinn.artifact.donation.v1',
          }],
        },
      },
    };

    const artifact = findDonatedArtifactRecord({
      records: [
        {
          source: 'local',
          envelopeRef: { cid: 'bafk-envelope' },
          artifactRefs: [localCachedArtifact],
        },
        {
          source: 'network',
          envelopeRef: { cid: 'bafk-envelope' },
          artifactRefs: [networkArtifact],
        },
      ],
    }, proof);

    expect(artifact).toBe(networkArtifact);
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
      const insertRun = store.db.prepare(`
        INSERT INTO task_runs (
          request_id, task_id, task_cid, onchain_creation_tx, onchain_creation_block,
          solver_type, task_role, state, state_updated_at, window_start_ts, window_end_ts,
          manifest_cid, delivery_tx_hash, task_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertRun.run(
        'consumer-request',
        '15',
        'cid-consumer-task',
        '0xsolution',
        1,
        'swe-rebench-v2.v1',
        'restoration',
        'COMPLETE',
        acquisitionFinishedAt.getTime(),
        acquisitionStartedAt.getTime(),
        acquisitionFinishedAt.getTime() + 1000,
        'bafk-consumer-solution',
        '0xsolutiondelivery',
        JSON.stringify({ id: 'task-15', role: 'restoration' }),
      );
      insertRun.run(
        'consumer-verdict',
        '15',
        'cid-consumer-task',
        '0xverdict',
        2,
        'swe-rebench-v2.v1',
        'evaluation',
        'COMPLETE',
        acquisitionFinishedAt.getTime(),
        acquisitionStartedAt.getTime(),
        acquisitionFinishedAt.getTime() + 1000,
        'bafk-consumer-verdict',
        '0xverdictdelivery',
        JSON.stringify({ id: 'task-15-evaluation', role: 'evaluation' }),
      );
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
      envelope: {
        participant: {
          safeAddress: 'operator-a',
        },
      },
      redactedEnvelope: {},
      indexExecution: {},
    };

    const result = await waitForConsumerSolveAndEvaluatorProof({
      storePath: dbPath,
      proof,
      allowedTaskId: '15',
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
