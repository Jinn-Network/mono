#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type NativeOperatorHealth,
  type NativeOperatorHost,
} from './daemon/native-operator-host.js';
import {
  NativeProductFileSchema,
  type NativeProductConfig,
} from './daemon/native-product-config.js';
import { resolveConfiguredOperatorVerticalMode } from './daemon/native-vertical-config.js';
import type { OperatorVerticalDecision } from './daemon/native-vertical-mode.js';

export interface NativeDeploymentFactoryInput {
  readonly config: NativeProductConfig;
  readonly decision: OperatorVerticalDecision;
}

export interface NativeMainDeps {
  readonly loadConfig: () => NativeProductConfig;
  readonly buildHost: (input: NativeDeploymentFactoryInput) => Promise<NativeOperatorHost>;
  readonly installSignalHandlers?: boolean;
}

function loadNativeProductConfig(): NativeProductConfig {
  const index = process.argv.indexOf('--config');
  const path = index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]!
    : join(homedir(), '.jinn-client', 'config.json');
  if (!existsSync(path)) throw new Error(`native-v1 structured config is missing: ${path}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (cause) {
    throw new Error(`native-v1 structured config is not JSON: ${String(cause)}`);
  }
  const parsed = NativeProductFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`native-v1 structured config is invalid: ${parsed.error.message}`);
  return parsed.data;
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
  const config = deps.loadConfig();
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
