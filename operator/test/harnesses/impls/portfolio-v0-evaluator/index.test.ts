/**
 * Integration test for PortfolioV0Evaluator.
 *
 * Uses synthetic manifests + injected test deps (_testDeps on config) to verify:
 * - supports() / canAttempt()
 * - Verdict derivation for PASS, FAIL, REJECTED, INDETERMINATE scenarios
 * - verdict.json is written to workingDir
 * - Output shape matches expectations
 *
 * Unified-payload model (Task 7/9):
 *   - solverType = 'portfolio.v0' (same as restoration)
 *   - task.role = 'evaluation'
 *   - manifest inlined at task.context.restorationResult (JSON string)
 *   - _testDeps injected via PortfolioV0Evaluator constructor config, not spec
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../../../src/util/canonical-json.js';
import { tmpdir } from 'node:os';
import { PortfolioV0Evaluator } from '../../../../src/harnesses/impls/portfolio-v0-evaluator/index.js';
import { SOLUTION_ENVELOPE_CID_CONTEXT_KEY } from '../../../../src/harnesses/impls/evaluation-context.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';
import type { HlFill, HlGridPoint } from '../../../../src/venues/hyperliquid/types.js';
import { TrajectoryCollector } from '../../../../src/trajectory/index.js';

// ── Shared test data ──────────────────────────────────────────────────────────

const NOW = 1_746_000_000_000;
const START_TS = NOW - 86_400_000;
const END_TS = NOW;

/** 25 fills; all closed trades (closedPnl != "0.0"), sz=0.04, px=50000 → notional=2000 each. */
const MOCK_FILLS: HlFill[] = Array.from({ length: 25 }, (_, i) => ({
  coin: 'BTC',
  px: '50000',
  sz: '0.04',   // 0.04 * 50000 = 2000 notional per fill
  side: 'B' as const,
  time: START_TS + i * (86_400_000 / 25),
  startPosition: '0',
  dir: 'Open Long',
  closedPnl: '100.0',
  hash: `0x${i.toString(16).padStart(4, '0')}`,
  oid: i,
  crossed: false,
  fee: '0.5',
  tid: i + 1,
  feeToken: 'USDC',
  twapId: null,
}));

// Total notional = 25 * 2000 = 50000; preValue = 10000 → notional multiple = 5.0x
// closedTrades = 25 (all have non-zero closedPnl)

const PRE_VALUE = 10_000;
const POST_VALUE = 10_600;  // 6% return

const PRE_SNAPSHOT = {
  capturedAt: START_TS + 1000,
  hlTime: START_TS + 1000,
  payload: { marginSummary: { accountValue: String(PRE_VALUE) } },
};

const POST_SNAPSHOT = {
  capturedAt: END_TS,
  hlTime: END_TS,
  payload: { marginSummary: { accountValue: String(POST_VALUE) } },
};

const MOCK_MANIFEST = {
  schemaVersion: 'jinn.execution.v1',
  solverType: 'portfolio.v0',
  role: 'solution',
  generatedAt: NOW,
  task: {
    cid: 'QmINTENT',
    onchainCreationTx: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
    onchainCreationBlock: 100,
    requestId: '0x0000000000000000000000000000000000000000000000000000000000000001',
  },
  participant: {
    safeAddress: '0x1111111111111111111111111111111111111111',
    agentEoa: '0x2222222222222222222222222222222222222222',
  },
  window: { startTs: START_TS, endTs: END_TS },
  executor: {
    implName: 'portfolio-v0',
    implVersion: '1.0.0',
    clientGitSha: 'dev',
    codeDigest: 'sha256:' + '0'.repeat(64),
    runtimeBundleDigest: 'sha256:' + '1'.repeat(64),
    plugins: [],
    signingKey: { kind: 'agent-eoa', pubkey: '0x2222222222222222222222222222222222222222' },
  },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: {
    preSnapshot: PRE_SNAPSHOT,
    postSnapshot: POST_SNAPSHOT,
    fills: MOCK_FILLS,
    gating: {
      equityReturnPct: '6.0',
      maxDrawdownPct: '0.0',
      closedTradesCount: 25,
      tradedNotionalMultiple: '5.0',
    },
  },
  signature: {
    algo: 'secp256k1',
    signer: '0x2222222222222222222222222222222222222222',
    hash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    sig: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef00',
  },
};

// The original portfolio.v0 intent spec (used in MOCK_INTENT_BASE and as spec in eval intents)
const MOCK_INTENT_BASE = {
  id: 'portfolio-intent-1',
  description: 'Test portfolio.v0 intent',
  solverType: 'portfolio.v0',
  role: 'restoration',
  window: { startTs: START_TS, endTs: END_TS },
  spec: {
    kind: 'portfolio.v0',
    account: {
      venue: 'hyperliquid-mainnet',
      masterAddress: '0x3333333333333333333333333333333333333333',
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

// ── HL mock data ──────────────────────────────────────────────────────────────

/**
 * Grid that brackets START_TS + 1000 (the pre snapshot capturedAt).
 * Points chosen so linear interpolation at (START_TS+1000) yields ~10000.
 * We pick: before=[START_TS, 9900], after=[START_TS+2000, 10100]
 * frac = (1000-0)/(2000-0) = 0.5
 * value = 9900 + 0.5 * (10100-9900) = 10000 exactly.
 */
const MOCK_GRID: HlGridPoint[] = [
  [START_TS - 200_000_000, '9500'],
  [START_TS, '9900'],           // before: t=START_TS, v=9900
  [START_TS + 2000, '10100'],   // after: t=START_TS+2000, v=10100
  [END_TS + 1000, '11000'],
];

function makeMockHlDeps(overrides: {
  fills?: HlFill[];
  grid?: HlGridPoint[];
  startTimeClamped?: boolean;
} = {}) {
  const fills = overrides.fills ?? MOCK_FILLS;
  const grid = overrides.grid ?? MOCK_GRID;
  const clamped = overrides.startTimeClamped ?? false;
  return {
    hlPortfolioPeriod: async (_user: string) => ({
      accountValueHistory: grid,
    }),
    hlUserFillsByTime: async (_user: string, _startTime: number, _endTime?: number) => ({
      fills,
      startTimeClamped: clamped,
    }),
  };
}

// ── Context factory ───────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `eval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface CtxOverrides {
  /** Override the spec on the eval intent (e.g., to change minReturnPct). */
  intentSpecOverrides?: Record<string, unknown>;
  /** Override eligibility on the eval intent. */
  eligibilityOverrides?: Record<string, unknown>;
  /** The manifest to inline as context.restorationResult. */
  manifest?: typeof MOCK_MANIFEST;
  fills?: HlFill[];
  grid?: HlGridPoint[];
  startTimeClamped?: boolean;
  /** Thread a restoration envelope CID through context (tests CID back-ref). */
  solutionEnvelopeCid?: string;
  /** Simulate HL API failure. */
  hlError?: boolean;
}

/**
 * Build a HarnessContext for an evaluation Task using the unified-payload model.
 *
 * - solverType = 'portfolio.v0' (same as restoration)
 * - task.role = 'evaluation'
 * - manifest is inlined at context.restorationResult as a JSON string
 * - HL test deps are passed via evaluator constructor config (_testDeps)
 */
function makeCtx(
  workingDir: string,
  evaluator: PortfolioV0Evaluator,
  overrides: CtxOverrides = {},
): HarnessContext {
  const {
    intentSpecOverrides = {},
    eligibilityOverrides,
    manifest = MOCK_MANIFEST,
    solutionEnvelopeCid,
  } = overrides;

  const ds: Task = {
    id: 'eval-intent-1',
    description: 'Evaluate portfolio.v0 restoration result',
    solverType: 'portfolio.v0',
    role: 'evaluation',
    restorationRequestId: '0xrequest',
    window: { startTs: START_TS, endTs: END_TS },
    spec: {
      kind: 'portfolio.v0',
      account: {
        venue: 'hyperliquid-mainnet',
        masterAddress: '0x3333333333333333333333333333333333333333',
      },
      target: {
        metric: 'equity_return_pct',
        minReturnPct: 5.0,
      },
      constraint: {
        maxDrawdownPct: 10.0,
      },
      ...intentSpecOverrides,
    },
    eligibility: eligibilityOverrides ?? {
      minClosedTrades: 20,
      minTradedNotionalMultiple: 5.0,
    },
    context: {
      restorationResult: JSON.stringify(manifest),
      ...(solutionEnvelopeCid ? { [SOLUTION_ENVELOPE_CID_CONTEXT_KEY]: solutionEnvelopeCid } : {}),
    },
  };

  return {
task: ds,
    implStateDir: workingDir,
    workingDir,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: new TrajectoryCollector({ taskCid: 'test-intent-cid', runId: 'test-run-id' }),
  };
}

/**
 * Build a PortfolioV0Evaluator with injected HL test deps.
 * HL deps are now on the constructor config, not the spec.
 */
function makeEvaluator(overrides: {
  fills?: HlFill[];
  grid?: HlGridPoint[];
  startTimeClamped?: boolean;
  hlError?: boolean;
} = {}): PortfolioV0Evaluator {
  if (overrides.hlError) {
    return new PortfolioV0Evaluator({
      _testDeps: {
        hlPortfolioPeriod: async () => { throw new Error('HL unavailable'); },
        hlUserFillsByTime: async () => { throw new Error('HL unavailable'); },
      },
    });
  }
  return new PortfolioV0Evaluator({
    _testDeps: makeMockHlDeps({
      fills: overrides.fills,
      grid: overrides.grid,
      startTimeClamped: overrides.startTimeClamped,
    }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PortfolioV0Evaluator', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  // ── supports() ──────────────────────────────────────────────────────────────

  describe('supports()', () => {
    it('returns true for portfolio.v0 + type=evaluation', () => {
      const impl = makeEvaluator();
      expect(impl.supports({ solverType: 'portfolio.v0', role: 'evaluation' })).toBe(true);
    });

    it('returns false for portfolio.v0 without type=evaluation (restoration)', () => {
      const impl = makeEvaluator();
      expect(impl.supports({ solverType: 'portfolio.v0' })).toBe(false);
    });

    it('returns false for portfolio.v0 with type=restoration', () => {
      const impl = makeEvaluator();
      expect(impl.supports({ solverType: 'portfolio.v0', role: 'restoration' })).toBe(false);
    });

    it('returns false for unknown kinds', () => {
      const impl = makeEvaluator();
      expect(impl.supports({ solverType: 'other.kind', role: 'evaluation' })).toBe(false);
    });
  });

  // ── canAttempt() ────────────────────────────────────────────────────────────

  describe('canAttempt()', () => {
    it('returns ok=true for valid eval intent', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);
      const result = await impl.canAttempt!(ctx.task);
      expect(result.ok).toBe(true);
    });

    it('returns ok=false when solverType is wrong', async () => {
      const impl = makeEvaluator();
      const intent: Task = {
        id: 'x',
        description: 'x',
        solverType: 'portfolio.v0.other',
        role: 'evaluation',
        restorationRequestId: '0xrequest',
        spec: {},
        context: { restorationResult: JSON.stringify(MOCK_MANIFEST) },
      };
      const result = await impl.canAttempt!(intent);
      expect(result.ok).toBe(false);
    });

    it('returns ok=false when type is not evaluation', async () => {
      const impl = makeEvaluator();
      const intent: Task = {
        id: 'x',
        description: 'x',
        solverType: 'portfolio.v0',
        role: 'restoration',
        restorationRequestId: '0xrequest',
        spec: {},
        context: { restorationResult: JSON.stringify(MOCK_MANIFEST) },
      };
      const result = await impl.canAttempt!(intent);
      expect(result.ok).toBe(false);
    });

    it('returns ok=false when context.restorationResult is missing', async () => {
      const impl = makeEvaluator();
      const intent: Task = {
        id: 'x',
        description: 'x',
        solverType: 'portfolio.v0',
        role: 'evaluation',
        restorationRequestId: '0xrequest',
        spec: {},
        // no context
      };
      const result = await impl.canAttempt!(intent);
      expect(result.ok).toBe(false);
    });

    it('returns ok=false when restorationRequestId is missing', async () => {
      const impl = makeEvaluator();
      const intent: Task = {
        id: 'x',
        description: 'x',
        solverType: 'portfolio.v0',
        role: 'evaluation',
        // no restorationRequestId
        spec: {},
        context: { restorationResult: JSON.stringify(MOCK_MANIFEST) },
      };
      const result = await impl.canAttempt!(intent);
      expect(result.ok).toBe(false);
    });
  });

  // ── run() — happy path (PASS) ────────────────────────────────────────────────

  describe('run() — PASS scenario', () => {
    it('produces PASS verdict for well-formed manifest meeting all criteria', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      const output = await impl.run(ctx);

      expect(output.venueRef.name).toBe('hyperliquid');
      expect(output.gating.verdict).toBe('PASS');
      expect(typeof output.gating.score).toBe('string');
      expect(BigInt(output.gating.score as string)).toBeGreaterThan(0n);
      expect(output.gating.scoreBasis).toBe('calmar.v1');

    });

    it('produces PASS verdict when the manifest uses the unified snapshot shape', async () => {
      // Harness today writes unified-shape snapshots: top-level `accountValue`
      // + nested raw perps/spot payloads, with NO top-level `marginSummary`.
      // Evaluator must pull the unified value from the claimed payload for
      // post-snapshot metric extraction (no grid-based post rederivation exists).
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const unifiedPreSnapshot = {
        capturedAt: START_TS + 1000,
        hlTime: START_TS + 1000,
        payload: {
          accountValue: String(PRE_VALUE),
          perpsAccountValue: '0',
          spotUsdc: String(PRE_VALUE),
          clearinghouseState: {
            marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
            crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
            crossMaintenanceMarginUsed: '0',
            withdrawable: '0',
            assetPositions: [],
            time: START_TS + 1000,
          },
          spotClearinghouseState: {
            balances: [{ coin: 'USDC', token: 0, total: String(PRE_VALUE), hold: '0.0', entryNtl: '0.0' }],
          },
        },
      };
      const unifiedPostSnapshot = {
        capturedAt: END_TS,
        hlTime: END_TS,
        payload: {
          accountValue: String(POST_VALUE),
          perpsAccountValue: '0',
          spotUsdc: String(POST_VALUE),
          clearinghouseState: {
            marginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
            crossMarginSummary: { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' },
            crossMaintenanceMarginUsed: '0',
            withdrawable: '0',
            assetPositions: [],
            time: END_TS,
          },
          spotClearinghouseState: {
            balances: [{ coin: 'USDC', token: 0, total: String(POST_VALUE), hold: '0.0', entryNtl: '0.0' }],
          },
        },
      };
      const unifiedManifest = {
        ...MOCK_MANIFEST,
        payload: {
          ...MOCK_MANIFEST.payload,
          preSnapshot: unifiedPreSnapshot,
          postSnapshot: unifiedPostSnapshot,
        },
      };

      const ctx = makeCtx(wd, impl, { manifest: unifiedManifest });
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('PASS');
    });

    it('writes verdict.json to workingDir', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const verdictPath = join(wd, 'verdict.json');
      expect(existsSync(verdictPath)).toBe(true);

      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      expect(verdict.verdict).toBe('PASS');
      expect(verdict.checks).toBeDefined();
      expect(Array.isArray(verdict.checks)).toBe(true);
    });

    it('verdict.json contains all impl-declared checks', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      const checkNames = verdict.checks.map((c: { name: string }) => c.name);

      const expectedChecks = [
        'availability.hyperliquid_reachable',
        'availability.hl_pre_snapshot_rederivable',
        'availability.hl_fills_rederivable',
        'availability.hl_post_snapshot_rederivable',
        'integrity.window_bounds',
        'eligibility.min_closed_trades',
        'eligibility.min_traded_notional',
        'consistency.pre_snapshot',
        'consistency.post_snapshot',
        'consistency.fills',
        'consistency.gating.equity_return',
        'consistency.gating.max_drawdown',
        'consistency.gating.closed_trades',
        'consistency.gating.traded_notional',
        'spec.equity_return_target',
        'spec.max_drawdown_constraint',
      ];

      for (const name of expectedChecks) {
        expect(checkNames, `missing check: ${name}`).toContain(name);
      }
    });

    it('declares verdict.json artifact with role evaluation_verdict', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      const output = await impl.run(ctx);

      expect(output.artifacts).toBeDefined();
      const verdictArtifact = output.artifacts!.find((a) => a.artifactType === 'evaluation_verdict');
      expect(verdictArtifact).toBeDefined();
      expect(verdictArtifact!.path).toBe('verdict.json');
    });

    it('score is bounded [0, 1e18] for PASS verdict', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      const output = await impl.run(ctx);

      const score = BigInt(output.gating.score as string);
      expect(score).toBeGreaterThanOrEqual(0n);
      expect(score).toBeLessThanOrEqual(BigInt(1e18));
    });
  });

  // ── run() — FAIL scenario (spec not met) ─────────────────────────────────────

  describe('run() — FAIL scenario', () => {
    it('produces FAIL verdict when equity return target is not met', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);

      // Override the target on the eval intent spec: 50% target — won't be met with 6% return
      const ctx = makeCtx(wd, impl, {
        intentSpecOverrides: {
          target: { metric: 'equity_return_pct', minReturnPct: 50.0 },
        },
      });
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('FAIL');
      expect(output.gating.score).toBe('0');

      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      expect(verdict.verdict).toBe('FAIL');
      const specCheck = verdict.checks.find((c: { name: string }) => c.name === 'spec.equity_return_target');
      expect(specCheck?.status).toBe('FAIL');
    });

    it('produces FAIL verdict when claimed drawdown is inconsistent with rederived value', async () => {
      const wd = makeTmpDir(); dirs.push(wd);

      // Manifest claims 15% drawdown, but rederived from the linear 10000→10600 grid is ~0%.
      // consistency.gating.max_drawdown FAILS (|15.0 - 0| >> 0.05 tolerance).
      // spec.max_drawdown_constraint checks rederived (~0%), not claimed, so that check PASSes.
      // Net result: FAIL driven by consistency.gating.max_drawdown.
      const manifestWithDrawdown = {
        ...MOCK_MANIFEST,
        payload: {
          ...MOCK_MANIFEST.payload,
          gating: {
            ...MOCK_MANIFEST.payload.gating,
            maxDrawdownPct: '15.0',  // 15% drawdown claimed — inconsistent with rederived ~0%
          },
        },
      };

      const impl = makeEvaluator();
      const ctx = makeCtx(wd, impl, { manifest: manifestWithDrawdown });
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('FAIL');
      expect(output.gating.score).toBe('0');

      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      expect(verdict.verdict).toBe('FAIL');
      const drawdownCheck = verdict.checks.find(
        (c: { name: string }) => c.name === 'consistency.gating.max_drawdown',
      );
      expect(drawdownCheck).toBeDefined();
      expect(drawdownCheck.status).toBe('FAIL');
    });
  });

  // ── run() — REJECTED scenario (eligibility not met) ──────────────────────────

  describe('run() — REJECTED scenario', () => {
    it('produces REJECTED verdict when minClosedTrades not met', async () => {
      const wd = makeTmpDir(); dirs.push(wd);

      // Eval intent requires 100 closed trades; mock only provides 25
      const impl = makeEvaluator();
      const ctx = makeCtx(wd, impl, {
        eligibilityOverrides: {
          minClosedTrades: 100,
          minTradedNotionalMultiple: 5.0,
        },
      });
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('REJECTED');
      expect(output.gating.score).toBe('0');
    });

    it('produces REJECTED verdict when minTradedNotional not met', async () => {
      const wd = makeTmpDir(); dirs.push(wd);

      // Eval intent requires 50x notional multiple; mock only provides 5x
      const impl = makeEvaluator();
      const ctx = makeCtx(wd, impl, {
        eligibilityOverrides: {
          minClosedTrades: 20,
          minTradedNotionalMultiple: 50.0,
        },
      });
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('REJECTED');
      expect(output.gating.score).toBe('0');
    });
  });

  // ── run() — INDETERMINATE scenario ───────────────────────────────────────────

  describe('run() — INDETERMINATE scenario', () => {
    it('emits venue_io span with ERROR status when HL API fails', async () => {
      const wd = makeTmpDir(); dirs.push(wd);
      const impl = makeEvaluator({ hlError: true });
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const { spans } = ctx.trajectory.snapshot();
      const venueSpan = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.venue_io');
      expect(venueSpan).toBeDefined();
      expect(venueSpan!.status.code).toBe('ERROR');
      expect(venueSpan!.attributes['http.response.status_code']).toBe(0);
    });

    it('produces INDETERMINATE verdict when HL API fails', async () => {
      const wd = makeTmpDir(); dirs.push(wd);

      // HL deps throw — simulates HL unavailability (was previously IPFS failure)
      const impl = makeEvaluator({ hlError: true });
      const ctx = makeCtx(wd, impl);
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('INDETERMINATE');
      expect(output.gating.score).toBe('0');

      // Failure must be attributed to the HL layer
      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      const hlCheck = verdict.checks.find(
        (c: { name: string; status: string }) => c.name === 'availability.hyperliquid_reachable',
      );
      expect(hlCheck).toBeDefined();
      expect(hlCheck.status).toBe('FAIL');
    });

    it('produces INDETERMINATE verdict when fills are clamped', async () => {
      const wd = makeTmpDir(); dirs.push(wd);

      const impl = makeEvaluator({ startTimeClamped: true });
      const ctx = makeCtx(wd, impl);
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('INDETERMINATE');
      expect(output.gating.score).toBe('0');
    });

    it('produces INDETERMINATE verdict when no grid bracket for pre snapshot', async () => {
      const wd = makeTmpDir(); dirs.push(wd);

      // Grid that does not bracket the preSnapshot capturedAt (START_TS + 1000)
      const emptyGrid: HlGridPoint[] = [];

      const impl = makeEvaluator({ grid: emptyGrid });
      const ctx = makeCtx(wd, impl);
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('INDETERMINATE');
    });

    it('forces INDETERMINATE when post-snapshot rederivable check is SKIP (funding-accrual edge)', async () => {
      // Spec §7.5: if postSnapshot.capturedAt > endTs + 60s, the check is SKIP and
      // verdict MUST be INDETERMINATE — even when all other checks would PASS.
      const wd = makeTmpDir(); dirs.push(wd);

      // postSnapshot.capturedAt = END_TS + 90_000 ms, which is > END_TS + 60_000 ms
      const latePostSnapshot = {
        capturedAt: END_TS + 90_000,
        hlTime: END_TS + 90_000,
        payload: { marginSummary: { accountValue: String(POST_VALUE) } },
      };

      const manifestWithLatePost = {
        ...MOCK_MANIFEST,
        payload: {
          ...MOCK_MANIFEST.payload,
          postSnapshot: latePostSnapshot,
        },
      };

      const impl = makeEvaluator();
      const ctx = makeCtx(wd, impl, { manifest: manifestWithLatePost });
      const output = await impl.run(ctx);

      expect(output.gating.verdict).toBe('INDETERMINATE');
      expect(output.gating.score).toBe('0');

      // Confirm the SKIP check is present in the verdict manifest
      const verdict = JSON.parse(
        (await import('node:fs')).readFileSync(
          (await import('node:path')).join(wd, 'verdict.json'),
          'utf-8',
        ),
      );
      expect(verdict.verdict).toBe('INDETERMINATE');
      const skipCheck = verdict.checks.find(
        (c: { name: string; status: string }) =>
          c.name === 'availability.hl_post_snapshot_rederivable' && c.status === 'SKIP',
      );
      expect(skipCheck).toBeDefined();
    });
  });

  // ── Verdict manifest structure ────────────────────────────────────────────────

  describe('verdict manifest structure', () => {
    it('contains rederived + claimed sections', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      expect(verdict.rederived).toBeDefined();
      expect(verdict.claimed).toBeDefined();
      expect(verdict.rederived.gating).toBeDefined();
      expect(verdict.claimed.gating).toBeDefined();
    });

    it('has signature section', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      expect(verdict.signature).toBeDefined();
      expect(verdict.signature.algo).toBe('secp256k1');
    });

    it('score is "0" for INDETERMINATE verdict', async () => {
      const impl = makeEvaluator({ hlError: true });
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      const output = await impl.run(ctx);
      expect(output.gating.score).toBe('0');
    });

    it('verdict.json includes scoreBasis and scoreVersion', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      expect(verdict.scoreBasis).toBe('calmar.v1');
      expect(verdict.scoreVersion).toBe('v1');
    });

    it('verdict.json has no legacy schemaVersion field', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      expect(verdict.schemaVersion).toBeUndefined();
      expect(verdict.verdict).toBeDefined();
    });

    it('verdict.json carries onchainCreationBlock from manifest task provenance', async () => {
      // In the unified-payload model, onchainCreationBlock comes from the inlined manifest,
      // not from EvalSpec pointer fields. MOCK_MANIFEST.signedTask.onchainCreationBlock = 100.
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const verdict = JSON.parse(readFileSync(join(wd, 'verdict.json'), 'utf-8'));
      expect(verdict.task.onchainCreationBlock).toBe(100);
    });

    // ── Finding #12: generatedAt determinism ────────────────────────────────
    // Two evaluations of identical inputs at different wall-clock times must
    // produce the same signed hash but different generatedAt values.

    it('trajectory collector receives venue_io + state_transition + artifact.emit spans', async () => {
      const impl = makeEvaluator();
      const wd = makeTmpDir(); dirs.push(wd);
      const ctx = makeCtx(wd, impl);

      await impl.run(ctx);

      const { spans } = ctx.trajectory.snapshot();
      const kinds = spans.map((s) => s.attributes['jinn.span.kind']);

      expect(kinds).toContain('jinn.venue_io');
      expect(kinds).toContain('jinn.state_transition');
      expect(kinds).toContain('jinn.artifact.emit');

      const venueSpan = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.venue_io');
      expect(venueSpan).toBeDefined();
      expect(venueSpan!.attributes['net.peer.name']).toBe('api.hyperliquid.xyz');
      expect(venueSpan!.attributes['http.response.status_code']).toBe(200);

      const stateSpan = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.state_transition');
      expect(stateSpan).toBeDefined();
      expect(stateSpan!.attributes['jinn.state.from']).toBe('FETCHED');
      expect(stateSpan!.attributes['jinn.state.to']).toBe('SCORED');

      const artifactSpan = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit');
      expect(artifactSpan).toBeDefined();
      expect(artifactSpan!.attributes['jinn.artifact.artifactType']).toBe('evaluation_verdict');
      expect(typeof artifactSpan!.attributes['jinn.artifact.sha256']).toBe('string');
    });

    it('two evaluations at different times produce the same signed hash (finding #12)', async () => {
      const T1 = 1_750_000_000_000;
      const T2 = T1 + 3_600_000; // 1 hour later

      // Run at T1
      vi.useFakeTimers();
      vi.setSystemTime(T1);
      const impl1 = makeEvaluator();
      const wd1 = makeTmpDir(); dirs.push(wd1);
      const ctx1 = makeCtx(wd1, impl1);
      await impl1.run(ctx1);
      const verdict1 = JSON.parse(readFileSync(join(wd1, 'verdict.json'), 'utf-8'));

      // Run at T2
      vi.setSystemTime(T2);
      const impl2 = makeEvaluator();
      const wd2 = makeTmpDir(); dirs.push(wd2);
      const ctx2 = makeCtx(wd2, impl2);
      await impl2.run(ctx2);
      const verdict2 = JSON.parse(readFileSync(join(wd2, 'verdict.json'), 'utf-8'));

      vi.useRealTimers();

      // Signed hash must be identical
      expect(verdict1.signature.hash).toBe(verdict2.signature.hash);

      // generatedAt must differ (wall-clock differs)
      expect(verdict1.generatedAt).toBe(T1);
      expect(verdict2.generatedAt).toBe(T2);
      expect(verdict1.generatedAt).not.toBe(verdict2.generatedAt);

      // generatedAt must NOT appear inside the signed envelope (i.e., not in
      // the fields covered by signature.hash). We verify this structurally:
      // the signed content is everything except `signature` and `generatedAt`.
      expect(typeof verdict1.generatedAt).toBe('number');
      expect(typeof verdict2.generatedAt).toBe('number');
    });
  });

  // ── solutionEnvelope back-ref ─────────────────────────────────────────────

  describe('solutionEnvelope back-ref', () => {
    it('uses solutionEnvelopeCid from context when threaded by daemon', async () => {
      const workingDir = makeTmpDir();
      dirs.push(workingDir);
      const evaluator = makeEvaluator();
      const envelopeCid = 'f01551220deadbeefcafe';
      const ctx = makeCtx(workingDir, evaluator, { solutionEnvelopeCid: envelopeCid });
      const out = await evaluator.run(ctx);
      const vp = out.verdictPayload as { solutionEnvelope: { cid: string; sha256: string } };
      expect(vp.solutionEnvelope.cid).toBe(envelopeCid);
      // sha256 must be the sha256 of the JCS canonical bytes (aligns with JCS upload pipeline)
      const expectedSha256 = createHash('sha256').update(canonicalJson(MOCK_MANIFEST)).digest('hex');
      expect(vp.solutionEnvelope.sha256).toBe(expectedSha256);
    });

    it('falls back to restorationRequestId when no context key present', async () => {
      const workingDir = makeTmpDir();
      dirs.push(workingDir);
      const evaluator = makeEvaluator();
      const ctx = makeCtx(workingDir, evaluator);
      const out = await evaluator.run(ctx);
      const vp = out.verdictPayload as { solutionEnvelope: { cid: string; sha256: string } };
      // restorationRequestId is '0xrequest' in makeCtx
      expect(vp.solutionEnvelope.cid).toBe('0xrequest');
      // sha256 must be a valid hex string (not placeholder zeros)
      expect(vp.solutionEnvelope.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
