import type { Task, TaskResult, RequestId } from '../types/index.js';
import type { TrajectoryCollector } from '../trajectory/index.js';

export interface RunnerContext {
  requestId: RequestId;
  workingDirectory: string;
  timeoutMs: number;
  storePath?: string;
  daemonApiUrl?: string;
  /**
   * Bearer token required by the daemon's cost-mutating API routes
   * (`POST /artifacts`, `POST /v1/artifacts/acquire`). Forwarded into the
   * MCP subprocess via `DAEMON_API_TOKEN` and attached to fetch headers.
   * When omitted, MCP calls those routes without an Authorization header
   * and the daemon will respond 401.
   */
  daemonApiToken?: string;
  /**
   * Optional corpus configuration forwarded to the MCP subprocess so
   * `search_records` / `inspect_record` can hit the Ponder indexer + IPFS
   * gateway. `acquire_artifact` no longer needs anything from this block — it
   * proxies to the daemon at `daemonApiUrl` and the daemon owns the agent EOA
   * private key. When omitted, record lookup and artifact acquisition fall
   * back to local-only behavior. Spec: spec/2026-04-30-phase-a-umbrella.md §4.
   */
  corpusEnv?: {
    /** Discovery indexer URL (Ponder). Sets JINN_DISCOVERY_URL on the MCP subprocess. */
    discoveryUrl?: string;
    ipfsGatewayUrl?: string;
    rpcUrl?: string;
    chainId?: number;
    identityRegistryAddress?: string;
    fromBlock?: number;
  };
  /**
   * In-run trajectory collector. When provided, the runner emits a
   * jinn.state_transition span wrapping the Claude subprocess lifetime.
   * Scope §3.2 traced-I/O boundary.
   */
  trajectory?: TrajectoryCollector;
}

export interface Runner {
  run(task: Task, context: RunnerContext): Promise<TaskResult>;
}
