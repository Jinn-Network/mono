/**
 * Daemon-faithful harness run for `jinn eval` (issue #818) and the #822 e2e.
 *
 * Live testing proved the eval's earlier hand-rolled harness invocation did NOT
 * reproduce the daemon's agent runtime: it ran the agent with NO SolverNet
 * runtime plugins, so the claude-code adapter passed no `--plugin-dir`, the
 * bundled MCP server never loaded, and the agent had no `submit_typed_payload`
 * tool — producing no gradeable patch and rendering every task unscorable. The
 * daemon scores the same tasks because it builds the full HarnessContext with
 * `solverPluginRoots` from the SolverNet's runtime plugins (engine.ts §runImpl).
 *
 * This module is the single source of truth for that daemon-equivalent context.
 * It rebuilds the engine's HarnessContext MINUS persistence/on-chain wiring and
 * runs the harness through the SAME freeze-fence the daemon uses. The CLI uses
 * it now; the #822 e2e delegates to it next.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Harness, HarnessContext, RuntimePlugin } from '../harnesses/types.js';
import type { Task } from '../types/task.js';
import { provisionWorkingDir } from '../harnesses/engine/packaging.js';
import { runHarnessWithFreezeFence } from '../daemon/freeze-fence.js';
import { TrajectoryCollector } from '../trajectory/index.js';
import {
  loadSolverNets,
  type SolverNetTaskRole,
} from '../solver-nets/registry.js';
import type { ExecutionWiringConfigEntry } from '../config/shape-v2.js';

/** Wall-clock budget for a single eval harness run (1h) when the task carries no window. */
const EVAL_RUN_BUDGET_MS = 3_600_000;

/**
 * Resolve the SolverNet runtime plugins for `solverType`, exactly as the daemon
 * does (`loadSolverNets(...).forSolverType(...)`). These plugins carry the
 * bundled MCP server that provides `submit_typed_payload`; without them the
 * agent cannot emit a gradeable patch.
 *
 * Fails LOUD with an operator-actionable message when there is no joined
 * SolverNet for the solverType, or the matched net has no runtime plugins —
 * mirroring the evaluator's `jinn harnesses enable` precondition.
 */
export async function resolveRuntimePluginsForSolverType(
  solverType: string,
  executionWiring: readonly ExecutionWiringConfigEntry[] | undefined,
  role: SolverNetTaskRole = 'restoration',
): Promise<RuntimePlugin[]> {
  const registry = await loadSolverNets({ executionWiring });
  const net = registry.forSolverType(solverType, role);
  if (!net) {
    throw new Error(
      `no SolverNet for solverType ${solverType} (role ${role}): the eval runs the agent with the ` +
        `SAME runtime plugins the daemon would, but this operator has no executionWiring entry for it. ` +
        `Add an executionWiring row for this work kind and run \`jinn harnesses enable\`, then re-run eval.`,
    );
  }
  if (net.runtimePlugins.length === 0) {
    throw new Error(
      `SolverNet ${net.name} for solverType ${solverType} has no runtime plugins: the agent would run ` +
        `without the bundled MCP server (no submit_typed_payload) and produce no gradeable patch. ` +
        `Install the SolverNet's plugins (\`jinn harnesses enable\`) before running eval.`,
    );
  }
  return net.runtimePlugins;
}

/**
 * Run a harness once for eval, building the FULL daemon-equivalent
 * HarnessContext (plugins + solverPluginRoots) but with no persistence /
 * on-chain wiring. Mirrors `HarnessEngine`'s `runImpl` context assembly
 * (engine.ts §runImpl) and routes through the same freeze-fence.
 *
 * Owns the ephemeral working-dir lifecycle: the returned result references only
 * the patch string + codeDigest (nothing under workingDir), so the dir is safe
 * to reclaim in `finally` — preventing leaked repo clones across a full slate.
 */
export async function runHarnessForEval(args: {
  harness: Harness;
  task: Task;
  solverType: string;
  runtimePlugins: RuntimePlugin[];
  implStateDir: string;
  mode: 'frozen' | 'train';
  solverNetName?: string;
  model?: string;
}): Promise<{
  violation?: { taskId: string };
  envelope?: { executor: { mode: 'train' | 'frozen'; codeDigest: string } };
  solution?: { patch: string };
}> {
  const { harness, task, solverType, runtimePlugins, implStateDir, mode } = args;
  const defaultEndTs = Date.now() + EVAL_RUN_BUDGET_MS;
  const windowEndTs = task.window?.endTs ?? defaultEndTs;

  // Fresh ephemeral scratch dir — SEPARATE from implStateDir so the harness's
  // repo clone + diff harvest never trips the freeze-fence (which hashes
  // implStateDir only). Provisioned the same way the engine does.
  const workingDir = mkdtempSync(join(tmpdir(), 'jinn-eval-work-'));

  const abort = new AbortController();
  const msUntilEndTs = () => Math.max(0, windowEndTs - Date.now());
  const endTimer = setTimeout(() => abort.abort(), msUntilEndTs());
  // Don't keep the event loop alive on this timer (it's cleared in finally).
  endTimer.unref?.();

  try {
    provisionWorkingDir(workingDir, task);

    // Full daemon-equivalent HarnessContext — mirrors engine.ts §runImpl MINUS
    // persistence/on-chain. The load-bearing fields are runtimePlugins +
    // solverPluginRoots: they carry the bundled MCP server (submit_typed_payload).
    const ctx: HarnessContext = {
      task,
      requestId: task.id ?? `eval-${solverType}`,
      taskCid: '',
      solverNet: {
        name: args.solverNetName ?? solverType,
        solverType,
        ...(args.model ? { model: args.model } : {}),
      },
      runtimePlugins,
      solverPluginRoots: runtimePlugins.map((plugin) => plugin.root),
      implStateDir,
      workingDir,
      log: () => {
        /* eval run: quiet harness logs */
      },
      abort: abort.signal,
      msUntilEndTs,
      trajectory: new TrajectoryCollector({ taskCid: '', runId: `eval-${task.id ?? solverType}` }),
      mode,
    };

    const fence = await runHarnessWithFreezeFence(harness, ctx);
    if (!fence.ok) {
      return { violation: { taskId: task.id ?? `eval-${solverType}` } };
    }

    const patch = (fence.output.solutionPayload as { patch?: unknown } | undefined)?.patch;
    if (typeof patch !== 'string') {
      throw new Error(
        `eval harness produced no swe-rebench-v2 patch for task ${task.id ?? solverType} ` +
          `(solutionPayload.patch missing) — the agent ran but emitted no gradeable diff`,
      );
    }
    return {
      envelope: { executor: { mode, codeDigest: `sha256:${fence.codeDigest}` } },
      solution: { patch },
    };
  } finally {
    clearTimeout(endTimer);
    // Always reclaim the per-task scratch dir — swe-rebench-v2 clones a real
    // upstream repo here; leaking it across a full slate piles onto the
    // disk-pressure this stack already guards (JINN_EVAL_DISK_FLOOR_GB).
    rmSync(workingDir, { recursive: true, force: true });
  }
}
