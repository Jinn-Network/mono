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

export interface NativeDeploymentFactoryInput {
  readonly config: NativeProductConfig;
  readonly decision: OperatorVerticalDecision;
}

export interface NativeMainDeps {
  readonly loadConfig: () => NativeProductConfig | Promise<NativeProductConfig>;
  readonly buildHost: (input: NativeDeploymentFactoryInput) => Promise<NativeOperatorHost>;
  readonly installSignalHandlers?: boolean;
}

/**
 * Resolves and loads via `daemon/native-config-path.js` — its own file,
 * its own `--native-config` flag, never `--config` / the legacy default
 * (see issue #2378). `jinn run` resolves the identical path before
 * deciding to invoke this entry, so the two can never disagree.
 */
function loadNativeProductConfig(): Promise<NativeProductConfig> {
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
  const config = await deps.loadConfig();
  const decision = resolveConfiguredOperatorVerticalMode(config);
  if (decision.effectiveMode !== 'native-v1') {
    throw new Error(`native entry refused effective mode ${decision.effectiveMode} (${decision.readiness})`);
  }
  const host = await deps.buildHost({ config, decision });
  try {
    await host.start();
    const health = await host.health();
    validateStartedHealth(health);
    const stop = async () => { await host.close(); };
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
    try {
      await host.close();
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], 'native-v1 startup/health and cleanup failed');
    }
    throw cause;
  }
}
