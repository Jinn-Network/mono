/**
 * Single construction site for all first-party {@link RestorerImpl} instances.
 * Used by the daemon entrypoint and `jinn intents` CLI (stub mode).
 */

import type { Runner } from '../../runner/runner.js';
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
  DefaultLearningRestorerImpl,
  DefaultLearningWrapper,
} from './default-learner/index.js';
import { ClaudeCodeHarnessAdapter } from './default-learner/index.js';

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
   * Root for impl-scoped state dirs (e.g. hyperliquid api-wallet). Defaults under
   * `~/.jinn-client/engine/impl-state` when unset — wired from `config.engine` in main.
   */
  implStateDirRoot?: string;
}

/**
 * Build the canonical ordered list of first-party restorer / evaluator impls.
 * Registration order is stable: it matches historical `main.ts` first-match
 * behavior for `RestorerImplRegistry`.
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

  // Build the default-learner wrapper LAST (so it sees all other impls
  // as its specialists pool) but register it FIRST so it wins
  // first-match for every kind.
  const learnerAdapter = new ClaudeCodeHarnessAdapter({
    claudePath: env.claudePath,
    claudeModel: env.claudeModel,
  });
  const learnerShim = new DefaultLearningRestorerImpl({ adapter: learnerAdapter });
  const learnerWrapper = new DefaultLearningWrapper({
    shim: learnerShim,
    specialists: [...out], // snapshot of specialists; wrapper does not delegate to itself
  });
  return [learnerWrapper, ...out];
}
