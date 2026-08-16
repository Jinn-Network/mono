/**
 * Integration tests for ClaudeMcpHyperliquidImpl.
 *
 * Claude is mocked via _testDeps.runSession. HL API calls are mocked.
 * Tests verify the full run() → Solution shape.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeMcpHyperliquidImpl, _writeHlMcpServerScript } from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/index.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';
import type { HlClearinghouseState, HlFill, HlSpotClearinghouseState } from '../../../../src/venues/hyperliquid/types.js';

// Mock uploadToIpfs for envelope-assembly integration tests (no real network)
vi.mock('../../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafy-mock-envelope-cid'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000'),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// ── Shared test data ───────────────────────────────────────────────────────────

const NOW = 1_750_000_000_000;
const START_TS = NOW - 86_400_000;
const END_TS = NOW;

const MASTER_ADDRESS = '0x' + 'a'.repeat(40);

function mockClearinghouseState(accountValue = '10000'): HlClearinghouseState {
  return {
    marginSummary: { accountValue, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
    crossMarginSummary: { accountValue, totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
    crossMaintenanceMarginUsed: '0',
    withdrawable: accountValue,
    assetPositions: [],
    time: NOW,
  };
}

function mockSpotClearinghouseState(usdc = '0'): HlSpotClearinghouseState {
  return {
    balances: usdc === '0'
      ? []
      : [{ coin: 'USDC', token: 0, total: usdc, hold: '0.0', entryNtl: '0.0' }],
  };
}

/** 25 fills that satisfy eligibility defaults (20 closed trades, 5x notional) */
function mockFills(preValue = 10_000): HlFill[] {
  return Array.from({ length: 25 }, (_, i) => ({
    coin: 'BTC',
    px: '50000',
    sz: '0.004', // 0.004 * 50000 = 200 notional each; total = 25 * 200 = 5000; 5000/10000 = 0.5x
    side: 'B' as const,
    time: START_TS + i * (86_400_000 / 25),
    startPosition: '0',
    dir: 'Open Long',
    closedPnl: i < 20 ? '50.0' : '0.0', // 20 closed, 5 not closed
    hash: `0x${i.toString(16).padStart(64, '0')}`,
    oid: i,
    crossed: false,
    fee: '0.1',
    tid: i + 1,
    feeToken: 'USDC',
    twapId: null,
  }));
}

function makePortfolioV0Task(): Task {
  return {
    id: 'test-portfolio-v0-intent',
    description: 'Grow HL portfolio by 5% over 24h with max 10% drawdown.',
    solverType: 'portfolio.v0',
    role: 'restoration',
    window: { startTs: START_TS, endTs: END_TS },
    spec: {
      kind: 'portfolio.v0',
      account: {
        venue: 'hyperliquid-testnet',
        masterAddress: MASTER_ADDRESS,
      },
      target: {
        metric: 'equity_return_pct',
        minReturnPct: 5.0,
      },
      constraint: {
        maxDrawdownPct: 10.0,
      },
    },
    eligibility: {
      minClosedTrades: 20,
      minTradedNotionalMultiple: 5.0,
    },
  };
}

function makeContext(workingDir: string, implStateDir: string): HarnessContext {
  const abortController = new AbortController();
  return {
    task: makePortfolioV0Task(),
    implStateDir,
    workingDir,
    log: () => {},
    abort: abortController.signal,
    msUntilEndTs: () => 60_000,
    trajectory: new (class {
      taskCid = '';
      runId = 'test';
      addSpan() { return undefined as never; }
      snapshot() { return { spans: [], redactionManifest: { spans: [], totalRedactions: 0 } }; }
    })() as HarnessContext['trajectory'],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ClaudeMcpHyperliquidImpl', () => {
  let workingDir: string;
  let implStateDir: string;

  afterEach(() => {
    if (workingDir) rmSync(workingDir, { recursive: true, force: true });
    if (implStateDir) rmSync(implStateDir, { recursive: true, force: true });
  });

  function setup() {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-hl-impl-test-working-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-hl-impl-test-state-'));
    return { workingDir, implStateDir };
  }

  // ── supports / canAttempt ──────────────────────────────────────────────────

  describe('supports()', () => {
    it('returns true for portfolio.v0', () => {
      const impl = new ClaudeMcpHyperliquidImpl();
      expect(impl.supports({ solverType: 'portfolio.v0' })).toBe(true);
    });

    it('returns false for other kinds', () => {
      const impl = new ClaudeMcpHyperliquidImpl();
      expect(impl.supports({ solverType: 'portfolio.v0.eval' })).toBe(false);
      expect(impl.supports({ solverType: 'codegen.v0' })).toBe(false);
      expect(impl.supports({ solverType: '' })).toBe(false);
    });
  });

  describe('canAttempt()', () => {
    it('returns ok:true for valid portfolio.v0 intent', async () => {
      const impl = new ClaudeMcpHyperliquidImpl();
      const result = await impl.canAttempt(makePortfolioV0Task());
      expect(result.ok).toBe(true);
    });

    it('returns ok:false for non-portfolio.v0 intent', async () => {
      const impl = new ClaudeMcpHyperliquidImpl();
      const result = await impl.canAttempt({
        id: 'other',
        description: 'Some other intent',
        solverType: 'codegen.v0',
        spec: {},
      });
      expect(result.ok).toBe(false);
    });

    it('returns ok:false for intent with no spec', async () => {
      const impl = new ClaudeMcpHyperliquidImpl();
      const result = await impl.canAttempt({ id: 'x', description: 'no spec' });
      expect(result.ok).toBe(false);
    });

    it('returns ok:false for malformed portfolio.v0 intent', async () => {
      const impl = new ClaudeMcpHyperliquidImpl();
      const result = await impl.canAttempt({
        id: 'x',
        description: 'bad intent',
        window: { startTs: 1000, endTs: 2000 }, // window != 24h → invalid
        spec: {
          kind: 'portfolio.v0',
          account: { venue: 'hyperliquid-testnet', masterAddress: MASTER_ADDRESS },
          target: { metric: 'equity_return_pct', minReturnPct: 5 },
          constraint: { maxDrawdownPct: 10 },
        },
      });
      expect(result.ok).toBe(false);
    });
  });

  // ── run() ──────────────────────────────────────────────────────────────────

  describe('run()', () => {
    it('returns a Solution with expected shape', async () => {
      const { workingDir, implStateDir } = setup();

      const fills = mockFills();
      const hlClientMock = {
        clearinghouseState: vi.fn()
          .mockResolvedValueOnce(mockClearinghouseState('10000'))  // pre-snapshot
          .mockResolvedValue(mockClearinghouseState('10600')),     // post-snapshot
        spotClearinghouseState: vi.fn().mockResolvedValue(mockSpotClearinghouseState()),
        userFills: vi.fn().mockResolvedValue(fills),
        userFillsByTime: vi.fn().mockResolvedValue({ fills, startTimeClamped: false }),
        meta: vi.fn().mockResolvedValue({ universe: [] }),
        allMids: vi.fn().mockResolvedValue({ BTC: '50000' }),
        portfolio: vi.fn().mockResolvedValue([]),
      };

      const impl = new ClaudeMcpHyperliquidImpl({
        _testDeps: {
          runSession: async (sessionId, prompt) => ({ stdout: `[test] session ${sessionId} complete` }),
          hlClient: hlClientMock as any,
        },
      });

      const ctx = makeContext(workingDir, implStateDir);
      const output = await impl.run(ctx);

      // Shape checks
      expect(output.venueRef.name).toMatch(/hyperliquid/);
      expect(output.preSnapshot).toBeDefined();
      expect(output.postSnapshot).toBeDefined();
      expect(output.fills).toBeInstanceOf(Array);
      expect(output.gating).toBeDefined();
      expect(output.gating['equityReturnPct']).toBeTypeOf('string');
      expect(output.gating['maxDrawdownPct']).toBeTypeOf('string');
      expect(output.gating['closedTradesCount']).toBeTypeOf('number');
      expect(output.gating['tradedNotionalMultiple']).toBeTypeOf('string');
    });

    it('pre/post snapshot payloads wrap unified equity with raw perps + spot payloads', async () => {
      const { workingDir, implStateDir } = setup();

      const prePerps = mockClearinghouseState('10000');
      const postPerps = mockClearinghouseState('10500');
      const spot = mockSpotClearinghouseState('250');

      const hlClientMock = {
        clearinghouseState: vi.fn()
          .mockResolvedValueOnce(prePerps)
          .mockResolvedValue(postPerps),
        spotClearinghouseState: vi.fn().mockResolvedValue(spot),
        userFills: vi.fn().mockResolvedValue([]),
        userFillsByTime: vi.fn().mockResolvedValue({ fills: [], startTimeClamped: false }),
        meta: vi.fn().mockResolvedValue({ universe: [] }),
        allMids: vi.fn().mockResolvedValue({}),
        portfolio: vi.fn().mockResolvedValue([]),
      };

      const impl = new ClaudeMcpHyperliquidImpl({
        _testDeps: {
          runSession: async () => ({ stdout: 'done' }),
          hlClient: hlClientMock as any,
        },
      });

      const ctx = makeContext(workingDir, implStateDir);
      const output = await impl.run(ctx);

      const pre = output.preSnapshot!.payload as Record<string, unknown>;
      const post = output.postSnapshot!.payload as Record<string, unknown>;

      // Unified equity = perps + spot USDC
      expect(pre['accountValue']).toBe('10250');
      expect(pre['perpsAccountValue']).toBe('10000');
      expect(pre['spotUsdc']).toBe('250');
      expect(pre['clearinghouseState']).toEqual(prePerps);
      expect(pre['spotClearinghouseState']).toEqual(spot);

      expect(post['accountValue']).toBe('10750');
      expect(post['perpsAccountValue']).toBe('10500');
      expect(post['spotUsdc']).toBe('250');
      expect(post['clearinghouseState']).toEqual(postPerps);
      expect(post['spotClearinghouseState']).toEqual(spot);
    });

    it('computes equity return against unified accountValue (spot-funded account)', async () => {
      const { workingDir, implStateDir } = setup();

      // Perps=0 throughout, spot starts at 1000 then grows to 1050 (trader moved USDC
      // from spot to perps and earned 5%). Unified pre=1000, post=1050 → return=5%.
      const perps = mockClearinghouseState('0');
      const spotPre = mockSpotClearinghouseState('1000');
      const spotPost = mockSpotClearinghouseState('1050');

      const hlClientMock = {
        clearinghouseState: vi.fn().mockResolvedValue(perps),
        spotClearinghouseState: vi.fn()
          .mockResolvedValueOnce(spotPre)
          .mockResolvedValue(spotPost),
        userFills: vi.fn().mockResolvedValue([]),
        userFillsByTime: vi.fn().mockResolvedValue({ fills: [], startTimeClamped: false }),
        meta: vi.fn().mockResolvedValue({ universe: [] }),
        allMids: vi.fn().mockResolvedValue({}),
        portfolio: vi.fn().mockResolvedValue([]),
      };

      const impl = new ClaudeMcpHyperliquidImpl({
        _testDeps: {
          runSession: async () => ({ stdout: 'done' }),
          hlClient: hlClientMock as any,
        },
      });

      const ctx = makeContext(workingDir, implStateDir);
      const output = await impl.run(ctx);

      expect(parseFloat(output.gating['equityReturnPct'] as string)).toBeCloseTo(5.0, 2);
      expect(output.informational!['preAccountValue']).toBe('1000');
      expect(output.informational!['postAccountValue']).toBe('1050');
    });

    it('computes gating metrics using canonical formulas', async () => {
      const { workingDir, implStateDir } = setup();

      // pre=10000, post=10500 → equityReturn = 5%
      // fills: 20 with closedPnl!=0, 5 with closedPnl=0 → closedTrades=20
      const preState = mockClearinghouseState('10000');
      const postState = mockClearinghouseState('10500');
      const fills = mockFills(10_000);

      const hlClientMock = {
        clearinghouseState: vi.fn()
          .mockResolvedValueOnce(preState)
          .mockResolvedValue(postState),
        spotClearinghouseState: vi.fn().mockResolvedValue(mockSpotClearinghouseState()),
        userFills: vi.fn().mockResolvedValue(fills),
        userFillsByTime: vi.fn().mockResolvedValue({ fills, startTimeClamped: false }),
        meta: vi.fn().mockResolvedValue({ universe: [] }),
        allMids: vi.fn().mockResolvedValue({}),
        portfolio: vi.fn().mockResolvedValue([]),
      };

      const impl = new ClaudeMcpHyperliquidImpl({
        _testDeps: {
          runSession: async () => ({ stdout: 'done' }),
          hlClient: hlClientMock as any,
        },
      });

      const ctx = makeContext(workingDir, implStateDir);
      const output = await impl.run(ctx);

      // equityReturn = 100 * (10500 - 10000) / 10000 = 5
      expect(parseFloat(output.gating['equityReturnPct'] as string)).toBeCloseTo(5.0, 2);

      // closedTradesCount = 20 (fills with closedPnl != '0.0')
      expect(output.gating['closedTradesCount']).toBe(20);

      // tradedNotionalMultiple = sum(|sz*px|) / preValue = (25 * 0.004 * 50000) / 10000 = 0.5
      expect(parseFloat(output.gating['tradedNotionalMultiple'] as string)).toBeCloseTo(0.5, 2);
    });

    it('writes session transcripts to workingDir/sessions/', async () => {
      const { workingDir, implStateDir } = setup();

      const { existsSync } = await import('node:fs');

      const hlClientMock = {
        clearinghouseState: vi.fn().mockResolvedValue(mockClearinghouseState()),
        spotClearinghouseState: vi.fn().mockResolvedValue(mockSpotClearinghouseState()),
        userFills: vi.fn().mockResolvedValue([]),
        userFillsByTime: vi.fn().mockResolvedValue({ fills: [], startTimeClamped: false }),
        meta: vi.fn().mockResolvedValue({ universe: [] }),
        allMids: vi.fn().mockResolvedValue({}),
        portfolio: vi.fn().mockResolvedValue([]),
      };

      const impl = new ClaudeMcpHyperliquidImpl({
        _testDeps: {
          runSession: async (sessionId) => ({ stdout: `transcript for ${sessionId}` }),
          hlClient: hlClientMock as any,
        },
      });

      const ctx = makeContext(workingDir, implStateDir);
      const output = await impl.run(ctx);

      // Should have at least one artifact with role session_transcript
      const transcriptArtifacts = output.artifacts?.filter((a) => a.artifactType === 'session_transcript') ?? [];
      expect(transcriptArtifacts.length).toBeGreaterThan(0);

      // transcript file should exist
      const transcriptPath = join(workingDir, transcriptArtifacts[0]!.path);
      expect(existsSync(transcriptPath)).toBe(true);
    });

    it('provisions API wallet in implStateDir', async () => {
      const { workingDir, implStateDir } = setup();
      const { existsSync } = await import('node:fs');
      const { walletStatePath } = await import('../../../../src/harnesses/impls/claude-mcp-hyperliquid/api-wallet.js');

      const hlClientMock = {
        clearinghouseState: vi.fn().mockResolvedValue(mockClearinghouseState()),
        spotClearinghouseState: vi.fn().mockResolvedValue(mockSpotClearinghouseState()),
        userFills: vi.fn().mockResolvedValue([]),
        userFillsByTime: vi.fn().mockResolvedValue({ fills: [], startTimeClamped: false }),
        meta: vi.fn().mockResolvedValue({ universe: [] }),
        allMids: vi.fn().mockResolvedValue({}),
        portfolio: vi.fn().mockResolvedValue([]),
      };

      const impl = new ClaudeMcpHyperliquidImpl({
        _testDeps: {
          runSession: async () => ({ stdout: 'done' }),
          hlClient: hlClientMock as any,
        },
      });

      const ctx = makeContext(workingDir, implStateDir);
      await impl.run(ctx);

      expect(existsSync(walletStatePath(implStateDir))).toBe(true);
    });

    it('handles HL post-snapshot failure gracefully (uses pre-snapshot as fallback)', async () => {
      const { workingDir, implStateDir } = setup();

      const preState = mockClearinghouseState('10000');

      const hlClientMock = {
        clearinghouseState: vi.fn()
          .mockResolvedValueOnce(preState)
          .mockRejectedValue(new Error('network error')),
        spotClearinghouseState: vi.fn().mockResolvedValue(mockSpotClearinghouseState()),
        userFills: vi.fn().mockResolvedValue([]),
        userFillsByTime: vi.fn().mockResolvedValue({ fills: [], startTimeClamped: false }),
        meta: vi.fn().mockResolvedValue({ universe: [] }),
        allMids: vi.fn().mockResolvedValue({}),
        portfolio: vi.fn().mockResolvedValue([]),
      };

      const impl = new ClaudeMcpHyperliquidImpl({
        _testDeps: {
          runSession: async () => ({ stdout: 'done' }),
          hlClient: hlClientMock as any,
        },
      });

      const ctx = makeContext(workingDir, implStateDir);
      // Should not throw
      const output = await impl.run(ctx);
      expect(output.postSnapshot).toBeDefined();
    });
  });
});

// ── Envelope-compatibility: run() output passes through engine pack() pipeline ─

describe('envelope compatibility (portfolio.v0 restoration payload)', () => {
  let workingDir: string;
  let implStateDir: string;

  afterEach(() => {
    if (workingDir) rmSync(workingDir, { recursive: true, force: true });
    if (implStateDir) rmSync(implStateDir, { recursive: true, force: true });
  });

  function setup() {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-hl-envelope-test-working-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-hl-envelope-test-state-'));
    return { workingDir, implStateDir };
  }

  it('run() output gating matches PortfolioV0RestorationPayloadSchema.gating', async () => {
    const { PortfolioV0RestorationPayloadSchema } = await import('../../../../src/types/payloads/portfolio-v0.js');
    const { workingDir, implStateDir } = setup();

    const fills = mockFills();
    const hlClientMock = {
      clearinghouseState: vi.fn()
        .mockResolvedValueOnce(mockClearinghouseState('10000'))
        .mockResolvedValue(mockClearinghouseState('10600')),
      spotClearinghouseState: vi.fn().mockResolvedValue(mockSpotClearinghouseState()),
      userFills: vi.fn().mockResolvedValue(fills),
      userFillsByTime: vi.fn().mockResolvedValue({ fills, startTimeClamped: false }),
      meta: vi.fn().mockResolvedValue({ universe: [] }),
      allMids: vi.fn().mockResolvedValue({ BTC: '50000' }),
      portfolio: vi.fn().mockResolvedValue([]),
    };

    const impl = new ClaudeMcpHyperliquidImpl({
      _testDeps: {
        runSession: async (sessionId) => ({ stdout: `[test] session ${sessionId} complete` }),
        hlClient: hlClientMock as any,
      },
    });

    const ctx = makeContext(workingDir, implStateDir);
    const output = await impl.run(ctx);

    // Construct the envelope payload exactly as engine.ts pack() does
    const envelopePayload: Record<string, unknown> = {
      preSnapshot: {
        capturedAt: output.preSnapshot!.capturedAt,
        hlTime: (output.preSnapshot as any).hlTime ?? 0,
        payload: (output.preSnapshot as any).payload ?? {},
      },
      postSnapshot: {
        capturedAt: output.postSnapshot!.capturedAt,
        hlTime: (output.postSnapshot as any).hlTime ?? 0,
        payload: (output.postSnapshot as any).payload ?? {},
      },
      fills: output.fills ?? [],
      gating: output.gating,
      ...(output.informational != null ? { informational: output.informational } : {}),
      ...(output.rationale != null ? { rationale: output.rationale } : {}),
    };

    // Validate the envelope payload against the portfolio.v0 restoration schema
    expect(() => PortfolioV0RestorationPayloadSchema.parse(envelopePayload)).not.toThrow();
  });

  it('run() output passes assembleAndSignEnvelope with role=restoration, solverType=portfolio.v0', async () => {
    const { assembleAndSignEnvelope } = await import('../../../../src/harnesses/engine/envelope-assembly.js');
    const { SignedEnvelopeSchema } = await import('../../../../src/types/envelope.js');
    const { workingDir, implStateDir } = setup();

    const fills = mockFills();
    const hlClientMock = {
      clearinghouseState: vi.fn()
        .mockResolvedValueOnce(mockClearinghouseState('10000'))
        .mockResolvedValue(mockClearinghouseState('10600')),
      spotClearinghouseState: vi.fn().mockResolvedValue(mockSpotClearinghouseState()),
      userFills: vi.fn().mockResolvedValue(fills),
      userFillsByTime: vi.fn().mockResolvedValue({ fills, startTimeClamped: false }),
      meta: vi.fn().mockResolvedValue({ universe: [] }),
      allMids: vi.fn().mockResolvedValue({ BTC: '50000' }),
      portfolio: vi.fn().mockResolvedValue([]),
    };

    const impl = new ClaudeMcpHyperliquidImpl({
      _testDeps: {
        runSession: async (sessionId) => ({ stdout: `[test] session ${sessionId} complete` }),
        hlClient: hlClientMock as any,
      },
    });

    const ctx = makeContext(workingDir, implStateDir);
    const output = await impl.run(ctx);

    // Mirror engine.ts pack() envelope payload construction
    const envelopePayload: Record<string, unknown> = {
      preSnapshot: {
        capturedAt: output.preSnapshot!.capturedAt,
        hlTime: (output.preSnapshot as any).hlTime ?? 0,
        payload: (output.preSnapshot as any).payload ?? {},
      },
      postSnapshot: {
        capturedAt: output.postSnapshot!.capturedAt,
        hlTime: (output.postSnapshot as any).hlTime ?? 0,
        payload: (output.postSnapshot as any).payload ?? {},
      },
      fills: output.fills ?? [],
      gating: output.gating,
      ...(output.informational != null ? { informational: output.informational } : {}),
      ...(output.rationale != null ? { rationale: output.rationale } : {}),
    };

    const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as `0x${string}`;
    const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`;

    const result = await assembleAndSignEnvelope(
      {
        solverType: 'portfolio.v0',
        role: 'restoration',
        task: {
          cid: 'bafy-test-intent',
          onchainCreationTx: '0x' + 'ab'.repeat(32),
          onchainCreationBlock: 100,
          requestId: '0x' + 'cd'.repeat(32),
        },
        participant: { safeAddress: TEST_ADDRESS, agentEoa: TEST_ADDRESS },
        window: { startTs: START_TS, endTs: END_TS },
        executor: {
          implName: 'claude-mcp-hyperliquid',
          implVersion: '1.0.0',
          clientGitSha: 'dev',
          codeDigest: 'sha256:' + '0'.repeat(64),
          runtimeBundleDigest: 'sha256:' + '1'.repeat(64),
          plugins: [],
          signingKey: { kind: 'agent-eoa', pubkey: TEST_ADDRESS },
        },
        artifacts: [],
        payload: envelopePayload,
        generatedAt: NOW,
      },
      {
        ipfsRegistryUrl: 'http://mock',
        agentEoaPrivateKey: TEST_PK,
      },
    );

    // Envelope role + solverType must be correct
    expect(result.envelope.role).toBe('solution');
    expect(result.envelope.solverType).toBe('portfolio.v0');
    expect(result.envelope.schemaVersion).toBe('jinn.execution.v1');

    // Envelope must validate against SignedEnvelopeSchema
    expect(() => SignedEnvelopeSchema.parse(result.envelope)).not.toThrow();

    // Signature hash must be present and 32-byte hex
    expect(result.envelopeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.envelope.signature.hash).toBe(result.envelopeHash);
  });
});

// ── Finding #2: Private key NOT embedded in generated script body ─────────────

describe('_writeHlMcpServerScript', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'jinn-hl-script-test-'));
    const mcpDir = join(tmpDir, 'mcp');
    mkdirSync(mcpDir);
    return { mcpDir, outPath: join(mcpDir, 'hl-server.mjs') };
  }

  const SENTINEL_KEY = '0x' + 'deadbeefdeadbeefdeadbeef1234567890abcdef1234567890abcdef12345678';

  const dummyConfig = {
    hlBaseUrl: 'https://api.hyperliquid-testnet.xyz',
    apiWalletPrivateKey: SENTINEL_KEY,
    apiWalletAddress: '0x' + 'a'.repeat(40),
    masterAddress: '0x' + 'b'.repeat(40),
  };

  it('script body does NOT contain the private key', () => {
    const { outPath } = setup();
    _writeHlMcpServerScript(outPath, dummyConfig);
    const scriptContent = readFileSync(outPath, 'utf-8');
    expect(scriptContent).not.toContain(SENTINEL_KEY);
    // Also ensure no 32-byte hex string appears in the script
    expect(scriptContent).not.toContain('deadbeef');
  });

  it('companion hl-server-config.json exists at mode 0o600', () => {
    const { outPath, mcpDir } = setup();
    _writeHlMcpServerScript(outPath, dummyConfig);
    const configPath = join(mcpDir, 'hl-server-config.json');
    const stat = statSync(configPath);
    // Check unix permission bits
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('companion config file contains the private key (correctly isolated)', () => {
    const { outPath, mcpDir } = setup();
    _writeHlMcpServerScript(outPath, dummyConfig);
    const configPath = join(mcpDir, 'hl-server-config.json');
    const configContent = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(configContent);
    expect(parsed.apiWalletPrivateKey).toBe(SENTINEL_KEY);
  });

  it('script passes config path as process.argv[2]', () => {
    const { outPath } = setup();
    _writeHlMcpServerScript(outPath, dummyConfig);
    const scriptContent = readFileSync(outPath, 'utf-8');
    expect(scriptContent).toContain('process.argv[2]');
    expect(scriptContent).toContain('readFileSync');
  });
});
