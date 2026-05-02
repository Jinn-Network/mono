import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadSolverPluginManifest,
  validateSolverPluginManifest,
} from '../../src/plugins/index.js';
import { SOLVER_NET_CONTRACTS } from '../../src/solver-nets/contracts.js';

const pluginRoot = fileURLToPath(new URL('../../plugins/jinn-prediction-plugin/', import.meta.url));

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginRoot, rel), 'utf-8')) as Record<string, unknown>;
}

function sampleTask() {
  return {
    id: 'prediction-v1-polymarket-abc',
    description: 'Forecast a binary externally resolved prediction market.',
    solverType: 'prediction.v1',
    role: 'restoration',
    window: {
      startTs: Date.parse('2026-05-02T00:00:00.000Z'),
      endTs: Date.parse('2026-05-02T06:00:00.000Z'),
    },
    claimPolicy: {
      kind: 'parallel',
      maxClaims: 25,
      maxClaimsPerSolver: 1,
      claimWindow: 'task-window',
      selection: 'all-valid-solutions-scored',
      economics: 'testnet-flat',
    },
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
      resolution: {
        expectedResolutionTime: '2026-05-04T00:00:00.000Z',
        rulesText: 'Resolve according to UMA final market resolution.',
        rulesUrl: 'https://polymarket.com/event/test-market',
        timezone: 'UTC',
      },
      consensusSnapshot: {
        sampledAt: '2026-05-02T00:00:00.000Z',
        probabilityYes: '0.6200',
        method: 'best-bid-ask-midpoint',
        bestBidYes: '0.6000',
        bestAskYes: '0.6400',
        spread: '0.0400',
        source: 'polymarket-clob',
      },
      eligibilitySnapshot: {
        sampledAt: '2026-05-02T00:00:00.000Z',
        timeToResolutionHours: 48,
        liquidityUsd: '12000',
        volume24hUsd: '2600',
        orderbookAgeSeconds: 1,
        selectionReason: 'weekly-binary-liquid-clear-rules',
      },
    },
    eligibility: {
      dedupKey: 'polymarket:0xabc',
    },
  };
}

const sampleSolution = {
  probabilityYes: '0.5700',
  submittedAt: '2026-05-02T01:00:00.000Z',
  format: 'decimal',
  modelId: 'prediction-v1-baseline/consensus',
  confidence: 'medium',
};

const sampleVerdict = {
  verdict: 'SCORED',
  outcome: 'YES',
  resolvedAt: '2026-05-04T00:00:00.000Z',
  resolutionSource: {
    venue: 'polymarket',
    url: 'https://polymarket.com/event/test-market',
    marketId: 'mkt-1',
    conditionId: '0xabc',
  },
  task: { cid: 'bafy-task', id: 'prediction-v1-polymarket-abc' },
  solutionEnvelope: { cid: 'bafy-solution', sha256: 'a'.repeat(64) },
  claimed: {
    probabilityYes: '0.5700',
    submittedAt: '2026-05-02T01:00:00.000Z',
    modelId: 'prediction-v1-baseline/consensus',
  },
  benchmark: {
    probabilityYes: '0.6200',
    sampledAt: '2026-05-02T00:00:00.000Z',
    method: 'best-bid-ask-midpoint',
  },
  scores: {
    scoreBasis: 'brier-loss.v1',
    solverBrier: '0.184900',
    consensusBrier: '0.144400',
    brierSpread: '0.040500',
  },
  checks: [{ name: 'solution.schema', status: 'PASS' }],
};

describe('jinn prediction reference pack manifests', () => {
  it('loads jinn.plugin.json before host manifests and declares prediction.v1 support', () => {
    const { path, manifest } = loadSolverPluginManifest(pluginRoot);
    expect(path.endsWith('jinn.plugin.json')).toBe(true);
    expect(manifest.name).toBe('@jinn-network/prediction-plugin');
    expect(manifest.jinn?.supports).toEqual(['prediction.v1']);
    expect(manifest.jinn).not.toHaveProperty('schemas');
    expect(manifest.jinn).not.toHaveProperty('solverType');
  });

  it('keeps canonical prediction.v1 schemas in the SolverNet contract registry', () => {
    const contract = SOLVER_NET_CONTRACTS['prediction.v1'];
    expect(contract).toBeDefined();
    contract!.schemas.task.parse(sampleTask());
    contract!.schemas.solution.parse(sampleSolution);
    contract!.schemas.verdict.parse(sampleVerdict);
    expect(contract!.evaluationFunction.id).toBe('prediction.brier-loss.v1');
  });

  it('keeps Claude and Gemini host manifests portable and host-specific', () => {
    const claude = readJson('.claude-plugin/plugin.json');
    const gemini = readJson('gemini-extension.json');
    const mcp = readJson('.mcp.json');

    expect(claude).not.toHaveProperty('jinn');
    expect(gemini).not.toHaveProperty('jinn');
    expect(JSON.stringify(claude)).toContain('${CLAUDE_PLUGIN_ROOT}/mcp/polymarket-server.mjs');
    expect(JSON.stringify(gemini)).toContain('${extensionPath}/mcp/polymarket-server.mjs');
    expect(JSON.stringify(mcp)).toContain('${CLAUDE_PLUGIN_ROOT}/mcp/polymarket-server.mjs');
  });

  it('uses root-relative MCP and skill paths in the Jinn pack manifest', () => {
    const manifest = readJson('jinn.plugin.json');
    const jinn = manifest.jinn as Record<string, unknown>;
    const servers = jinn.mcpServers as Record<string, { args: string[] }>;
    const skills = jinn.skills as string[];

    expect(servers.polymarket.args).toEqual(['mcp/polymarket-server.mjs']);
    expect(skills).toEqual([
      'skills/base-rate-forecasting/SKILL.md',
      'skills/calibration/SKILL.md',
    ]);
  });

  it('rejects old canonical schema fields in plugin manifests', () => {
    expect(() =>
      validateSolverPluginManifest({
        name: '@bad/plugin',
        version: '1.0.0',
        jinn: {
          solverType: 'prediction.v1',
          schemas: { task: {}, solution: {}, verdict: {} },
        },
      }),
    ).toThrow(/SolverNet contracts/);
  });
});
