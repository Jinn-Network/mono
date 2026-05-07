import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import {
  loadSolverPluginManifest,
  validateSolverPluginManifest,
} from '../../src/plugins/index.js';
import { SOLVER_NET_CONTRACTS } from '../../src/solver-nets/contracts.js';

const pluginRoot = fileURLToPath(new URL('../../plugins/jinn-prediction-plugin/', import.meta.url));

interface PredictionMcpServerModule {
  listToolDeclarations(): Array<{ name: string }>;
  getMarket(args: unknown, config: unknown): Promise<Record<string, unknown>>;
  getOrderbook(args: unknown, config: unknown): Promise<Record<string, unknown>>;
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginRoot, rel), 'utf-8')) as Record<string, unknown>;
}

async function readMcpServerModule(): Promise<PredictionMcpServerModule> {
  return import(pathToFileURL(join(pluginRoot, 'mcp/polymarket-server.mjs')).href) as Promise<PredictionMcpServerModule>;
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
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 30 * 60,
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

describe('jinn prediction plugin manifests', () => {
  it('loads jinn.plugin.json before host manifests and declares prediction.v1 support', () => {
    const { path, manifest } = loadSolverPluginManifest(pluginRoot);
    expect(path.endsWith('jinn.plugin.json')).toBe(true);
    expect(manifest.name).toBe('@jinn-network/prediction-plugin');
    expect(manifest.jinn?.supports).toEqual(['prediction.v1']);
    expect(manifest.jinn).not.toHaveProperty('schemas');
    expect(manifest.jinn).not.toHaveProperty('solverType');
  });

  it('keeps prediction.v1 schemas in the SolverNet contract registry', () => {
    const contract = SOLVER_NET_CONTRACTS['prediction.v1'];
    expect(contract).toBeDefined();
    contract!.schemas.task.zod.parse(sampleTask());
    contract!.schemas.solution.zod.parse(sampleSolution);
    contract!.schemas.verdict.zod.parse(sampleVerdict);
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

  it('declares prediction skills for Claude and Jinn hosts', () => {
    const claude = readJson('.claude-plugin/plugin.json');
    const manifest = readJson('jinn.plugin.json');
    const jinn = manifest.jinn as Record<string, unknown>;
    const servers = jinn.mcpServers as Record<string, { args: string[] }>;
    const skills = jinn.skills as string[];
    const claudeSkills = claude.skills as string[];
    const expectedSkills = [
      'skills/base-rate-forecasting/SKILL.md',
      'skills/calibration/SKILL.md',
      'skills/common-biases/SKILL.md',
      'skills/prediction-corpus-retrieval/SKILL.md',
      'skills/polymarket-task-handling/SKILL.md',
    ];

    expect(servers.polymarket.args).toEqual(['mcp/polymarket-server.mjs']);
    expect(skills).toEqual(expectedSkills);
    expect(claudeSkills).toEqual(expectedSkills);
  });

  it('teaches prediction agents to use Network Tools for corpus retrieval', () => {
    const skill = readFileSync(
      join(pluginRoot, 'skills/prediction-corpus-retrieval/SKILL.md'),
      'utf-8',
    );
    const geminiContext = readFileSync(join(pluginRoot, 'GEMINI.md'), 'utf-8');

    expect(skill).toContain('get_task');
    expect(skill).toContain('search_records');
    expect(skill).toContain('inspect_record');
    expect(skill).toContain('acquire_artifact');
    expect(skill).toContain('polymarket_get_market');
    expect(skill).toContain('polymarket_get_orderbook');
    expect(skill).toContain('conditionId');
    expect(skill).toContain('scored Verdicts');
    expect(skill).toContain('read-only');
    expect(skill).toContain('price-aware');
    expect(skill).toContain('only acquisition/payment path');
    expect(skill).toContain('cite');
    expect(skill).toContain('Plugins provide runtime tools and skills only');
    expect(geminiContext).toContain('Network Tools');
    expect(geminiContext).toContain('search_records');
    expect(geminiContext).toContain('price-aware');
  });

  it('declares only read-only task-scoped Polymarket MCP tools', async () => {
    const mcp = await readMcpServerModule();
    const declarations = mcp.listToolDeclarations();
    const names = declarations.map((tool: { name: string }) => tool.name);

    expect(names).toEqual(['polymarket_get_market', 'polymarket_get_orderbook']);
    expect(names.join(' ')).not.toMatch(/submit|trade|order_place|sign|wallet|post|search/i);
    expect(JSON.stringify(declarations)).toContain('Read-only CLOB market data only');
    expect(JSON.stringify(declarations)).toContain('current prediction task');
  });

  it('serves the Polymarket tool list from the stdio MCP entrypoint', async () => {
    const client = new Client({ name: 'prediction-plugin-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [join(pluginRoot, 'mcp/polymarket-server.mjs')],
      cwd: pluginRoot,
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'polymarket_get_market',
        'polymarket_get_orderbook',
      ]);
    } finally {
      await client.close();
    }
  });

  it('reads exact Polymarket market and orderbook identifiers without network search', async () => {
    const mcp = await readMcpServerModule();
    const requested: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      const href = String(url);
      requested.push(href);
      if (href === 'https://gamma.test/markets/mkt-1') {
        return new Response(JSON.stringify({
          id: 'mkt-1',
          conditionId: '0xabc',
          slug: 'test-market',
          question: 'Will test pass?',
          description: 'A test market.',
          outcomes: '["YES","NO"]',
          clobTokenIds: '["yes-token","no-token"]',
          endDate: '2026-05-04T00:00:00.000Z',
          active: true,
          closed: false,
          archived: false,
          liquidity: 12000,
          volume24hr: 2600,
        }), { status: 200 });
      }
      if (href === 'https://clob.test/book?token_id=yes-token') {
        return new Response(JSON.stringify({
          timestamp: 1777852800,
          bids: [{ price: '0.60' }, { price: '0.58' }],
          asks: [{ price: '0.64' }, { price: '0.66' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
    };

    const market = await mcp.getMarket(
      { marketId: 'mkt-1', conditionId: '0xabc' },
      { gammaBaseUrl: 'https://gamma.test', fetchImpl },
    );
    const orderbook = await mcp.getOrderbook(
      { marketId: 'mkt-1', conditionId: '0xabc', yesTokenId: 'yes-token' },
      { clobBaseUrl: 'https://clob.test', fetchImpl },
    );

    expect(market.marketId).toBe('mkt-1');
    expect(market.conditionId).toBe('0xabc');
    expect(market.tokenIds).toEqual({ yes: 'yes-token', no: 'no-token' });
    expect(orderbook).toMatchObject({
      marketId: 'mkt-1',
      conditionId: '0xabc',
      bestBidYes: '0.6000',
      bestAskYes: '0.6400',
      midpointYes: '0.6200',
      spread: '0.0400',
      source: 'polymarket-clob',
    });
    expect(requested).toEqual([
      'https://gamma.test/markets/mkt-1',
      'https://clob.test/book?token_id=yes-token',
    ]);
  });

  it('rejects schema fields in plugin manifests because SolverNet contracts own schemas', () => {
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
