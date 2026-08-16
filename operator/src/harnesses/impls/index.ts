/**
 * Single construction site for all first-party {@link Harness} instances.
 * Used by the daemon entrypoint and `jinn solver-nets` CLI (stub mode).
 */

import type { Runner, RunnerContext } from '../../runner/runner.js';
import type { Harness } from '../types.js';
import { LegacyClaudeImpl } from './legacy-claude/index.js';
import { ClaudeMcpHyperliquidImpl } from './claude-mcp-hyperliquid/index.js';
import { PortfolioV0Evaluator } from './portfolio-v0-evaluator/index.js';
import { PredictionV1BaselineImpl } from './prediction-v1-baseline/index.js';
import { PredictionV1Evaluator } from './prediction-v1-evaluator/index.js';
import { ClaudeMcpPredictionImpl } from './claude-mcp-prediction/index.js';
import { PredictionApyV0BaselineImpl } from './prediction-apy-v0-baseline/index.js';
import { ClaudeMcpPredictionApyImpl } from './claude-mcp-prediction-apy/index.js';
import { PredictionApyV0Evaluator } from './prediction-apy-v0-evaluator/index.js';
import {
  LearnerHarness,
} from './learner/index.js';
import { ClaudeCodeHarnessAdapter, CodexCodeHarnessAdapter } from './learner/index.js';
import type { LearnerCandidateConfig } from './learner/candidate.js';
import type { LearnerRoutingConfig } from './learner/routing.js';
import { SweRebenchV2EvaluatorHarness } from './swe-rebench-v2-evaluator/harness.js';
import { JinnRepoEvaluatorHarness } from './jinn-repo-evaluator/harness.js';
import type {
  SemanticAgentRunnerResolver,
} from './jinn-repo-evaluator/autopilot-semantic.js';
import type {
  ImmutableMechanicalVerifier,
} from './jinn-repo-evaluator/autopilot-mechanical-runner.js';
import { HermesHarness, HermesHarnessAdapter } from './hermes-agent/index.js';
import { maybeCreateStubHarnessFromEnv } from './stub.js';
import {
  canonicalHarnessName,
  canonicalHarnessNameSet,
  CODEX_HARNESS,
} from '../names.js';

/**
 * Environment passed to {@link buildHarnesses} — same shape for daemon
 * (live creds) and CLI introspection (stub: true, optional runner).
 */
export interface HarnessEnv {
  /** When true, CLI path — impls report `requires live daemon` from `isReady()`. */
  stub?: boolean;
  /** Agent EOA private key (daemon). */
  pk?: `0x${string}`;
  /** Service Safe address (daemon). */
  safe?: `0x${string}`;
  rpcUrl: string;
  archiveRpcUrl?: string;
  claudePath: string;
  claudeModel: string;
  /**
   * Required for production registry when `legacy-claude` is included.
   * Omitted in stub CLI registries.
   */
  runner?: Runner;
  /** e.g. `http://127.0.0.1:${apiPort}` for {@link LegacyClaudeImpl} */
  daemonApiUrl?: string;
  /**
   * Bearer token for daemon API cost-mutating routes (forwarded to the MCP
   * subprocess via env). Mirrors `daemonApiUrl` exactly.
   */
  daemonApiToken?: string;
  /** SQLite store path for MCP artifact handoff in {@link LegacyClaudeImpl}. */
  storePath?: string;
  /**
   * Legacy-claude runner working directory (defaults to /tmp if unset).
   */
  legacyClaudeWorkingDirectory?: string;
  /**
   * Corpus env for {@link LegacyClaudeImpl} / MCP `jinn-client` record lookup
   * and artifact acquisition tools.
   */
  corpusEnv?: RunnerContext['corpusEnv'];
  /** Path to the `codex` executable. Defaults to `codex`. */
  codexPath?: string;
  /** Default Codex model when a SolverNet does not specify one. */
  codexModel?: string;
  /**
   * Timeout (ms) for the `codex --version` probe in the Codex variant of
   * `LearnerHarness.isReady`.
   */
  codexDoctorTimeoutMs?: number;
  /** Optional Polymarket Gamma API override for acceptance or private mirrors. */
  polymarketGammaBaseUrl?: string;
  /** Optional Polymarket CLOB API override for acceptance or private mirrors. */
  polymarketClobBaseUrl?: string;
  /**
   * Root for impl-scoped state dirs (e.g. hyperliquid api-wallet). Defaults under
   * `~/.jinn-client/engine/impl-state` when unset — wired from `config.engine` in main.
   */
  implStateDirRoot?: string;
  /**
   * IPFS registry URL used by Harnesses that need to pin verdict-side
   * artifacts (e.g. swe-rebench-v2 test logs). Optional — Harnesses that
   * don't need IPFS leave this unused.
   */
  ipfsRegistryUrl?: string;
  /** From `config.sweRebenchV2StateDir` — swe-rebench-v2 evaluator substrate. */
  sweRebenchV2StateDir?: string;
  /**
   * Explicit `supports()` routing for the two `LearnerHarness` instances
   * (product design §10). When `solverTypes` is absent, `buildHarnesses`
   * derives the allowlist from the operator's joined SolverNets — the routing
   * they already declared — so an existing deployment keeps claiming exactly
   * what it joined, and neither more nor less.
   */
  learnerRouting?: LearnerRoutingConfig;
  /** Candidate-mode settings forwarded to the `LearnerHarness` instances. */
  learnerCandidate?: LearnerCandidateConfig;
  /**
   * Pre-loaded external (operator-supplied) Harnesses — produced by
   * `loadExternalImpl()` in `operator/src/harnesses/external-impls/`. Appended to
   * the in-repo construction list. See plan
   * `docs/superpowers/plans/2026-04-30-plug-in-surface-path-2-foundation.md`
   * step 5.7.
   */
  externalImpls?: readonly Harness[];
  /**
   * Impl names to filter out of the returned list entirely (different from
   * `HarnessRegistry.disabled`, which only suppresses dispatch). Useful
   * when a fleet wants to construct without paying the cost of an in-repo
   * impl that has external deps.
   */
  disabledNames?: readonly string[];
  /**
   * Test-only replacements keyed by harness identity: each entry displaces the
   * in-repo harness with the same canonical name (registration index preserved).
   * Fail-closed: if non-empty and `JINN_TEST_MODE !== '1'`, {@link buildHarnesses}
   * throws. Never wire from operator config / `main.ts`.
   */
  testHarnessReplacements?: readonly Harness[];
  /** Path to the `hermes` executable. Defaults to `hermes`. */
  hermesPath?: string;
  /** Default Hermes model when a SolverNet does not specify one. */
  hermesModel?: string;
  /** Hermes provider (e.g. 'anthropic'). */
  hermesProvider?: string;
  /** Local OpenAI-compatible Hermes base URL. */
  hermesBaseUrl?: string;
  /** Timeout (ms) for the `hermes doctor` probe in HermesHarness.isReady. */
  hermesDoctorTimeoutMs?: number;
  /**
   * Provider-and-model-configured semantic evaluator runtime. The registry
   * never guesses a provider from a SolverNet model identifier.
   */
  semanticEvaluatorRunnerResolver?: SemanticAgentRunnerResolver;
  /** Isolated immutable verifier for Autopilot exact-head evaluation. */
  immutableMechanicalVerifier?: ImmutableMechanicalVerifier;
}

/**
 * Build the canonical ordered list of first-party restoration/evaluation Harnesses.
 * Registration order is stable: it matches historical `main.ts` first-match
 * behavior for `HarnessRegistry`.
 *
 * The claude-code Harness is registered as the default peer Harness;
 * it no longer wraps specialists.
 */
export function buildHarnesses(env: HarnessEnv): Harness[] {
  const isStub = Boolean(env.stub);

  if (!isStub) {
    if (!env.pk) throw new Error('buildHarnesses: pk is required when stub is not set');
    if (!env.safe) throw new Error('buildHarnesses: safe is required when stub is not set');
  }

  const learnerRouting: LearnerRoutingConfig = env.learnerRouting ?? {};

  const out: Harness[] = [];

  if (env.runner) {
    out.push(
      new LegacyClaudeImpl({
        runner: env.runner,
        workingDirectory: env.legacyClaudeWorkingDirectory ?? '/tmp',
        timeoutMs: 300_000,
        storePath: env.storePath,
        daemonApiUrl: env.daemonApiUrl,
        daemonApiToken: env.daemonApiToken,
        corpusEnv: env.corpusEnv,
        stub: isStub,
      }),
    );
  }

  out.push(
    new ClaudeMcpHyperliquidImpl({
      claudePath: env.claudePath,
      claudeModel: env.claudeModel,
      implStateDir: env.implStateDirRoot
        ? `${env.implStateDirRoot}/claude-mcp-hyperliquid`
        : undefined,
      stub: isStub,
    }),
  );
  out.push(
    isStub
      ? new PortfolioV0Evaluator({ stub: true })
      : new PortfolioV0Evaluator(),
  );
  out.push(
    new PredictionV1BaselineImpl({
      stub: isStub,
    }),
  );
  out.push(
    new ClaudeMcpPredictionImpl({
      claudePath: env.claudePath,
      claudeModel: env.claudeModel,
      rpcUrl: env.rpcUrl,
      stub: isStub,
    }),
  );
  out.push(
    isStub
      ? new PredictionV1Evaluator({ stub: true })
      : new PredictionV1Evaluator({
          ...(env.polymarketGammaBaseUrl ? { gammaBaseUrl: env.polymarketGammaBaseUrl } : {}),
          ...(env.polymarketClobBaseUrl ? { clobBaseUrl: env.polymarketClobBaseUrl } : {}),
        }),
  );
  out.push(
    new PredictionApyV0BaselineImpl({
      rpcUrl: env.rpcUrl,
      archiveRpcUrl: env.archiveRpcUrl,
      stub: isStub,
    }),
  );
  out.push(
    new ClaudeMcpPredictionApyImpl({
      claudePath: env.claudePath,
      claudeModel: env.claudeModel,
      rpcUrl: env.rpcUrl,
      archiveRpcUrl: env.archiveRpcUrl,
      stub: isStub,
    }),
  );
  out.push(
    isStub
      ? new PredictionApyV0Evaluator({ stub: true, rpcUrl: env.rpcUrl, archiveRpcUrl: env.archiveRpcUrl })
      : new PredictionApyV0Evaluator({
          evaluatorPk: env.pk!,
          evaluatorSafeAddress: env.safe!,
          rpcUrl: env.rpcUrl,
          archiveRpcUrl: env.archiveRpcUrl,
        }),
  );
  out.push(
    new SweRebenchV2EvaluatorHarness({
      stub: isStub,
      implStateDir: env.implStateDirRoot
        ? `${env.implStateDirRoot}/swe-rebench-v2-evaluator`
        : undefined,
      ipfsRegistryUrl: env.ipfsRegistryUrl,
      ...(env.sweRebenchV2StateDir ? { stateDir: env.sweRebenchV2StateDir } : {}),
    }),
  );
  out.push(
    new JinnRepoEvaluatorHarness({
      stub: isStub,
      semanticAgentRunnerResolver: env.semanticEvaluatorRunnerResolver,
      immutableMechanicalVerifier: env.immutableMechanicalVerifier,
      implStateDir: env.implStateDirRoot
        ? `${env.implStateDirRoot}/jinn-repo-evaluator`
        : undefined,
    }),
  );

  // Env-gated stub harness for T2.4 release gate. Active only when
  // JINN_HARNESS_STUB_INSTANCE is set; no-op otherwise.
  const stub = maybeCreateStubHarnessFromEnv();
  if (stub) {
    out.push(stub);
  }

  // Operator-supplied external Harnesses are appended before the default learner
  // so explicit SolverNet harness settings can select them.
  if (env.externalImpls && env.externalImpls.length > 0) {
    out.push(...env.externalImpls);
  }

  // Default Harness: handles any non-evaluation Task not claimed by a
  // SolverNet specialist or evaluator.
  const learnerAdapter = new ClaudeCodeHarnessAdapter({
    claudePath: env.claudePath,
    claudeModel: env.claudeModel,
    storePath: env.storePath,
    daemonApiUrl: env.daemonApiUrl,
    daemonApiToken: env.daemonApiToken,
    corpusEnv: env.corpusEnv,
  });
  out.push(new LearnerHarness({
    adapter: learnerAdapter,
    claudePath: env.claudePath,
    routing: learnerRouting,
    ...(env.learnerCandidate ? { candidate: env.learnerCandidate } : {}),
  }));

  // Codex-backed peer Harness. It supports the same restoration surface as
  // claude-code, but is selected only by explicit SolverNet harness config so
  // historical first-match fallback stays unchanged.
  const codexLearnerAdapter = new CodexCodeHarnessAdapter({
    codexPath: env.codexPath,
    codexModel: env.codexModel,
    storePath: env.storePath,
    daemonApiUrl: env.daemonApiUrl,
    daemonApiToken: env.daemonApiToken,
    corpusEnv: env.corpusEnv,
  });
  out.push(new LearnerHarness({
    name: CODEX_HARNESS,
    adapter: codexLearnerAdapter,
    claudePath: env.claudePath,
    routing: learnerRouting,
    ...(env.learnerCandidate ? { candidate: env.learnerCandidate } : {}),
    ...(env.codexPath !== undefined ? { codexPath: env.codexPath } : {}),
    ...(env.codexDoctorTimeoutMs !== undefined
      ? { codexDoctorTimeoutMs: env.codexDoctorTimeoutMs }
      : {}),
  }));

  const hermesAdapter = new HermesHarnessAdapter({
    hermesPath: env.hermesPath,
    hermesModel: env.hermesModel,
    hermesProvider: env.hermesProvider,
    hermesBaseUrl: env.hermesBaseUrl,
    daemonApiUrl: env.daemonApiUrl ?? 'http://127.0.0.1:7331',
    daemonApiToken: env.daemonApiToken ?? '',
    storePath: env.storePath,
    corpusEnv: env.corpusEnv ?? {},
  });
  out.push(new HermesHarness({
    adapter: hermesAdapter,
    ...(env.hermesPath !== undefined ? { hermesPath: env.hermesPath } : {}),
    ...(env.hermesBaseUrl !== undefined ? { hermesBaseUrl: env.hermesBaseUrl } : {}),
    ...(env.hermesDoctorTimeoutMs !== undefined ? { hermesDoctorTimeoutMs: env.hermesDoctorTimeoutMs } : {}),
  }));

  applyTestHarnessReplacements(out, env.testHarnessReplacements);

  if (env.disabledNames && env.disabledNames.length > 0) {
    const disabled = canonicalHarnessNameSet(env.disabledNames);
    return out.filter((impl) => !disabled.has(canonicalHarnessName(impl.name)));
  }
  return out;
}

/**
 * Mutates `out` in place: each replacement removes the matching canonical name
 * and inserts at that index. Empty / omitted → no-op. Non-empty without
 * JINN_TEST_MODE=1 → throw. Unknown name → throw.
 */
function applyTestHarnessReplacements(
  out: Harness[],
  replacements: readonly Harness[] | undefined,
): void {
  if (!replacements || replacements.length === 0) return;

  if (process.env['JINN_TEST_MODE'] !== '1') {
    throw new Error(
      'testHarnessReplacements must never activate in a real operator run: ' +
        'replacements were supplied but JINN_TEST_MODE is not "1". ' +
        'Set JINN_TEST_MODE=1 for in-process tests / e2e; otherwise omit testHarnessReplacements.',
    );
  }

  for (const replacement of replacements) {
    const target = canonicalHarnessName(replacement.name);
    const idx = out.findIndex((h) => canonicalHarnessName(h.name) === target);
    if (idx < 0) {
      throw new Error(
        `testHarnessReplacements: no in-repo harness named "${replacement.name}" ` +
          `(canonical: "${target}"). Refusing to append — replacement must displace an existing name.`,
      );
    }
    out.splice(idx, 1, replacement);
  }
}
