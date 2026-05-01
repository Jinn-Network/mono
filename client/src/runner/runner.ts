import type { RestorationJob, RestorationResult, RequestId } from '../types/index.js';
import type { TrajectoryCollector } from '../trajectory/index.js';

export interface RunnerContext {
  requestId: RequestId;
  workingDirectory: string;
  timeoutMs: number;
  storePath?: string;
  daemonApiUrl?: string;
  /**
   * Optional corpus configuration forwarded to the MCP subprocess so its
   * `search_artifacts` / `acquire_artifact` tools can hit the network.
   * When omitted the tools fall back to local-only behavior.
   * Spec: spec/2026-04-30-phase-a-umbrella.md §4.
   */
  corpusEnv?: {
    subgraphUrl?: string;
    ipfsGatewayUrl?: string;
    agentPrivateKey?: string;
    selfSafeAddress?: string;
  };
  /**
   * In-run trajectory collector. When provided, the runner emits a
   * jinn.state_transition span wrapping the Claude subprocess lifetime.
   * Scope §3.2 traced-I/O boundary.
   */
  trajectory?: TrajectoryCollector;
}

export interface Runner {
  run(restorationJob: RestorationJob, context: RunnerContext): Promise<RestorationResult>;
}
