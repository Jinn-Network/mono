import type { BenchmarkRuntimeHost } from "../runtime/host-port.js";
import type { AgentProfile, CredentialGrant } from "../agent/index.js";
import type { RunAnchorDeps } from "../operations/run-anchor.js";

/**
 * The CLI's return shape and its injected environment (spec §5.2).
 *
 * `runCli` returns a result rather than writing to `process.stdout` and
 * calling `process.exit`, so every verb is testable as a function of its
 * arguments and the directory it was pointed at. `bin.ts` is the only file
 * in this package that touches the process.
 */

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliContext {
  readonly cwd: string;
  /** Returns an RFC 3339 timestamp. Injected so a test's output is a function of its inputs. */
  readonly clock: () => string;
  /** Live diagnostic stream for a long-running verb (`launch`, `resume`, BP-13) — one short line
   * per drive event, written as the run progresses. Distinct from the buffered `CliResult` the
   * verb eventually returns; optional, and absent in every verb that isn't long-running. */
  readonly progress?: (line: string) => void;
  /**
   * Installs and returns a shutdown request for a verb that runs until interrupted
   * (`publication serve`). A factory rather than a signal because registering a `SIGINT` listener
   * suppresses Node's default termination for the whole process: a wrapper that armed one at
   * startup would make Ctrl-C do nothing during every other verb. Only the verb that reads it
   * calls this, so only that verb takes the signals over.
   */
  readonly createShutdownSignal?: () => AbortSignal;
  readonly runtimeHost?: BenchmarkRuntimeHost;
  /** OS user-data directory supplied only by the process-owning CLI wrapper. */
  readonly agentDataDir?: string;
  /** Process-owned interactive subscription capture; absent in tests and non-interactive embeddings. */
  readonly subscriptionLogin?: (dataDir: string, profile: AgentProfile) => Promise<CredentialGrant>;
  /**
   * The anchor acquisition transport (`anchor`, and `lock`'s §7.2 hook), injected like
   * `runtimeHost`. Absent in `bin.ts`, where the sources build their own `globalThis.fetch`-backed
   * default; supplied by a test so no CLI test can reach a network, and available to an embedder
   * that wants its own transport or timeout.
   */
  readonly anchorDeps?: RunAnchorDeps;
}
