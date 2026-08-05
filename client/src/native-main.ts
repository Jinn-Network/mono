#!/usr/bin/env node
import {
  type NativeOperatorHealth,
  type NativeOperatorHost,
} from './daemon/native-operator-host.js';
import type { NativeProductConfig } from './daemon/native-product-config.js';
import {
  loadNativeProductConfigFile,
  resolveNativeConfigPath,
} from './daemon/native-config-path.js';
import { resolveConfiguredOperatorVerticalMode } from './daemon/native-vertical-config.js';
import type { OperatorVerticalDecision } from './daemon/native-vertical-mode.js';
import {
  recordNativeOperatorComposition,
  startNativeStatusSnapshotLoop,
  type NativeStatusSnapshotLoopHandle,
} from './daemon/native-phase-d-observability.js';

export interface NativeDeploymentFactoryInput {
  readonly config: NativeProductConfig;
  readonly decision: OperatorVerticalDecision;
}

export interface NativeMainDeps {
  readonly loadConfig: () => NativeProductConfig;
  readonly buildHost: (input: NativeDeploymentFactoryInput) => Promise<NativeOperatorHost>;
  readonly installSignalHandlers?: boolean;
  /**
   * Phase D observability (#2380): records the `native-operator-composition` durable counter as
   * positive native-presence evidence. Mirrors `daemon.ts`'s `legacy-operator-composition`,
   * recorded once the mode is validly selected. Optional and undefined ⇒ skipped, so existing ad
   * hoc test deps objects are unaffected; `PRODUCTION_DEPS` always wires the real function.
   */
  readonly recordNativeComposition?: (config: NativeProductConfig) => void;
  /**
   * Phase D observability (#2380): starts native's status surface — periodic durable snapshots
   * of `phaseDTransitionUsageDiagnostics()` plus instance identity into `stateDir`, since native
   * has no `/v1/status`. Started only after post-start health is decision-ready; its `stop()` is
   * folded into the existing shutdown path. Optional and undefined ⇒ skipped.
   */
  readonly startStatusSnapshotLoop?: (input: {
    readonly config: NativeProductConfig;
    readonly decision: OperatorVerticalDecision;
    readonly refreshHealth: () => Promise<NativeOperatorHealth>;
  }) => NativeStatusSnapshotLoopHandle;
}

/**
 * Resolves and loads via `daemon/native-config-path.js` — its own file,
 * its own `--native-config` flag, never `--config` / the legacy default
 * (see issue #2378). `jinn run` resolves the identical path before
 * deciding to invoke this entry, so the two can never disagree.
 */
function loadNativeProductConfig(): NativeProductConfig {
  return loadNativeProductConfigFile(resolveNativeConfigPath());
}

async function buildProductionHost(input: NativeDeploymentFactoryInput): Promise<NativeOperatorHost> {
  const { createNativeProductionOperatorHost } = await import('./daemon/native-production-deployment.js');
  return createNativeProductionOperatorHost(input);
}

const PRODUCTION_DEPS: NativeMainDeps = {
  loadConfig: loadNativeProductConfig,
  buildHost: buildProductionHost,
  installSignalHandlers: true,
  recordNativeComposition: recordNativeOperatorComposition,
  startStatusSnapshotLoop: (input) => startNativeStatusSnapshotLoop({
    stateDir: input.config.operator.native.stateDir,
    decision: input.decision,
    refreshHealth: input.refreshHealth,
  }),
};

function validateStartedHealth(health: NativeOperatorHealth): void {
  if (health.mode !== 'native-v1'
    || health.nativeFallbackCount !== 0
    || !health.leaseOwned
    || health.sourceLag !== 0
    || health.uncertainOperations !== 0
    || !health.venue.caughtUp
    || BigInt(health.venue.canonicalBlock) < BigInt(health.venue.finalizedBlock)
    || (health.backendRequired && !health.backendReady)
    || (health.evidenceRequired && !health.evidenceReady)
    || !health.publicSourceReady
    || Object.keys(health.roleKeyIds).length === 0) {
    throw new Error('native-v1 host health is not decision-ready');
  }
}

/** Native-only entry. It has no import path to Daemon, TaskEngine, bridge records, or watchers. */
export async function main(deps: NativeMainDeps = PRODUCTION_DEPS): Promise<{
  readonly schemaVersion: 1;
  readonly kind: 'native_daemon_started';
  readonly mode: 'native-v1';
  readonly readiness: OperatorVerticalDecision['readiness'];
  readonly health: NativeOperatorHealth;
}> {
  const config = deps.loadConfig();
  const decision = resolveConfiguredOperatorVerticalMode(config);
  if (decision.effectiveMode !== 'native-v1') {
    throw new Error(`native entry refused effective mode ${decision.effectiveMode} (${decision.readiness})`);
  }
  // #2380: record native presence as positive evidence as soon as the mode is validly selected —
  // mirrors daemon.ts's legacy-operator-composition recording point (post-validation, pre-start).
  deps.recordNativeComposition?.(config);
  const host = await deps.buildHost({ config, decision });
  let snapshotLoop: NativeStatusSnapshotLoopHandle | undefined;
  try {
    await host.start();
    const health = await host.health();
    validateStartedHealth(health);
    // #2380: native's status surface — only started once health is decision-ready, so snapshots
    // never represent a not-yet-running instance.
    snapshotLoop = deps.startStatusSnapshotLoop?.({ config, decision, refreshHealth: () => host.health() });
    const stop = async () => {
      snapshotLoop?.stop();
      await host.close();
    };
    if (deps.installSignalHandlers === true) {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
    return {
      schemaVersion: 1,
      kind: 'native_daemon_started',
      mode: 'native-v1',
      readiness: decision.readiness,
      health,
    };
  } catch (cause) {
    snapshotLoop?.stop();
    try {
      await host.close();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'native-v1 startup/health and cleanup failed');
    }
    throw cause;
  }
}
