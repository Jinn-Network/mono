/**
 * Single construction site for all first-party {@link RestorerImpl} instances.
 * Used by the daemon entrypoint and `jinn intents` CLI (stub mode).
 */

import type { Runner, RunnerContext } from '../../runner/runner.js';
import type { RestorerImpl } from '../types.js';
import { LegacyClaudeImpl } from './legacy-claude/index.js';
import { ClaudeMcpHyperliquidImpl } from './claude-mcp-hyperliquid/index.js';
import { PortfolioV0Evaluator } from './portfolio-v0-evaluator/index.js';
import { PredictionV0BaselineImpl } from './prediction-v0-baseline/index.js';
import { PredictionV0Evaluator } from './prediction-v0-evaluator/index.js';
import { ClaudeMcpPredictionImpl } from './claude-mcp-prediction/index.js';
import { PredictionApyV0BaselineImpl } from './prediction-apy-v0-baseline/index.js';
import { ClaudeMcpPredictionApyImpl } from './claude-mcp-prediction-apy/index.js';
import { PredictionApyV0Evaluator } from './prediction-apy-v0-evaluator/index.js';
import {
  ClaudeCodeLearnerImpl,
  ClaudeCodeLearnerWrapper,
} from './claude-code-learner/index.js';
import { ClaudeCodeHarnessAdapter } from './claude-code-learner/index.js';

/**
 * Environment passed to {@link buildRestorerImpls} — same shape for daemon
 * (live creds) and CLI introspection (stub: true, optional runner).
 */
export interface RestorerEnv {
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
  /** SQLite store path for MCP artifact handoff in {@link LegacyClaudeImpl}. */
  storePath?: string;
  /**
   * Legacy-claude runner working directory (defaults to /tmp if unset).
   */
  legacyClaudeWorkingDirectory?: string;
  /**
   * Corpus env for {@link LegacyClaudeImpl} / MCP `jinn-client` tools
   * (`search_artifacts`, `acquire_artifact`).
   */
  corpusEnv?: RunnerContext['corpusEnv'];
  /**
   * Root for impl-scoped state dirs (e.g. hyperliquid api-wallet). Defaults under
   * `~/.jinn-client/engine/impl-state` when unset — wired from `config.engine` in main.
   */
  implStateDirRoot?: string;
  /**
   * Pre-loaded external (operator-supplied) restorer impls — produced by
   * `loadExternalImpl()` in `client/src/restorer/external-impls/`. Appended to
   * the in-repo construction list before the claude-code-learner wrapper so
   * the wrapper sees them as specialists. See plan
   * `docs/superpowers/plans/2026-04-30-plug-in-surface-path-2-foundation.md`
   * step 5.7.
   */
  externalImpls?: readonly RestorerImpl[];
  /**
   * Pre-built serialised slot registry for Path 1 plug-ins (the bundled
   * claude-code-learner impl's plug-in surface). Built once in main.ts
   * by calling `loadPlugIns` + `serialiseRegistry` against
   * `config.learnerPlugIns[]`. Threaded into the learner shim so it can
   * forward the registry into the harness via `JINN_SLOT_REGISTRY_JSON`.
   *
   * See spec/2026-04-30-plug-in-surface.md §4 and plan
   * docs/superpowers/plans/2026-04-30-plug-in-surface-path-1-mechanism.md
   * Tasks 4–5.
   */
  slotRegistryJson?: string;
  /**
   * Impl names to filter out of the returned list entirely (different from
   * `RestorerImplRegistry.disabled`, which only suppresses dispatch). Useful
   * when a fleet wants to construct without paying the cost of an in-repo
   * impl that has external deps.
   */
  disabledNames?: readonly string[];
}

/**
 * Build the canonical ordered list of first-party restorer / evaluator impls.
 * Registration order is stable: it matches historical `main.ts` first-match
 * behavior for `RestorerImplRegistry`.
 *
 * The claude-code-learner wrapper is registered alongside specialists; it does
 * NOT win first-match by registration order. Universal-wrap behaviour is now
 * a registry policy (`RestorerDispatchConfig.wrapWith`) — see jinn-mono-0k2.
 * Default operator config sets `wrapWith: 'claude-code-learner'` so the
 * learning envelope wraps every restoration kind by default; operators flip
 * the policy off to dispatch directly to specialists.
 */
export function buildRestorerImpls(env: RestorerEnv): RestorerImpl[] {
  const isStub = Boolean(env.stub);

  if (!isStub) {
    if (!env.pk) throw new Error('buildRestorerImpls: pk is required when stub is not set');
    if (!env.safe) throw new Error('buildRestorerImpls: safe is required when stub is not set');
  }

  const out: RestorerImpl[] = [];

  if (env.runner) {
    out.push(
      new LegacyClaudeImpl({
        runner: env.runner,
        workingDirectory: env.legacyClaudeWorkingDirectory ?? '/tmp',
        timeoutMs: 300_000,
        storePath: env.storePath,
        daemonApiUrl: env.daemonApiUrl,
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
    new PredictionV0BaselineImpl({
      rpcUrl: env.rpcUrl,
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
      ? new PredictionV0Evaluator({ stub: true, rpcUrl: env.rpcUrl })
      : new PredictionV0Evaluator({
          evaluatorPk: env.pk!,
          evaluatorSafeAddress: env.safe!,
          rpcUrl: env.rpcUrl,
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

  // Operator-supplied external impls are appended *before* the learner
  // wrapper so the wrapper sees them as specialists too.
  if (env.externalImpls && env.externalImpls.length > 0) {
    out.push(...env.externalImpls);
  }

  // Build the claude-code-learner wrapper LAST (so it sees all other impls
  // as its specialists pool). It is registered alongside specialists, NOT
  // prepended — universal-wrap is now a registry policy
  // (RestorerDispatchConfig.wrapWith) rather than an ordering trick. See
  // jinn-mono-0k2.
  const learnerAdapter = new ClaudeCodeHarnessAdapter({
    claudePath: env.claudePath,
    claudeModel: env.claudeModel,
  });
  const learnerShim = new ClaudeCodeLearnerImpl({
    adapter: learnerAdapter,
    slotRegistryJson: env.slotRegistryJson,
  });
  const learnerWrapper = new ClaudeCodeLearnerWrapper({
    shim: learnerShim,
    specialists: [...out], // snapshot of specialists; wrapper does not delegate to itself
  });
  out.push(learnerWrapper);

  if (env.disabledNames && env.disabledNames.length > 0) {
    const disabled = new Set(env.disabledNames);
    return out.filter((impl) => !disabled.has(impl.name));
  }
  return out;
}
