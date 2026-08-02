#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { JinnConfig } from './config.js';
import type { NativeOperatorHost } from './daemon/native-operator-host.js';
import { resolveConfiguredOperatorVerticalMode } from './daemon/native-vertical-config.js';
import type { OperatorVerticalDecision } from './daemon/native-vertical-mode.js';

export interface NativeDeploymentFactoryInput {
  readonly config: NativeProductConfig;
  readonly decision: OperatorVerticalDecision;
}

export interface NativeDeploymentModule {
  createNativeOperatorHost(input: NativeDeploymentFactoryInput): NativeOperatorHost | Promise<NativeOperatorHost>;
}

export interface NativeMainDeps {
  readonly loadConfig: () => NativeProductConfig;
  readonly loadDeployment: (config: NativeProductConfig) => Promise<NativeDeploymentModule>;
  readonly installSignalHandlers?: boolean;
}

export type NativeProductConfig = Pick<JinnConfig, 'network' | 'operator'> & { readonly rpcUrl?: string };

function loadNativeProductConfig(): NativeProductConfig {
  const index = process.argv.indexOf('--config');
  const path = index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]!
    : join(homedir(), '.jinn-client', 'config.json');
  if (!existsSync(path)) throw new Error(`native-v1 structured config is missing: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as NativeProductConfig;
  const native = parsed.operator?.native;
  if (parsed.network !== 'testnet' || native === undefined) {
    throw new Error('native-v1 requires structured testnet operator.native configuration');
  }
  for (const [name, value] of Object.entries({
    stateDir: native.stateDir,
    identityStorePath: native.identityStorePath,
    trustRootsPath: native.trustRootsPath,
    publicBaseUrl: native.publicBaseUrl,
    runtimeModule: native.runtime.deploymentModule,
    runtimeDigest: native.runtime.moduleDigest,
  })) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`native-v1 config is missing ${name}`);
  }
  return parsed;
}

async function loadConfiguredDeployment(config: NativeProductConfig): Promise<NativeDeploymentModule> {
  const runtime = config.operator?.native?.runtime;
  if (runtime === undefined) throw new Error('native-v1 requires a digest-pinned runtime deployment module');
  if (!isAbsolute(runtime.deploymentModule)) throw new Error('native runtime deployment module path must be absolute');
  const bytes = await readFile(runtime.deploymentModule);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== runtime.moduleDigest) throw new Error('native runtime deployment module digest mismatch');
  const loaded = await import(pathToFileURL(runtime.deploymentModule).href) as Partial<NativeDeploymentModule>;
  if (typeof loaded.createNativeOperatorHost !== 'function') {
    throw new Error('native runtime deployment module must export createNativeOperatorHost');
  }
  return loaded as NativeDeploymentModule;
}

const PRODUCTION_DEPS: NativeMainDeps = {
  loadConfig: loadNativeProductConfig,
  loadDeployment: loadConfiguredDeployment,
  installSignalHandlers: true,
};

/** Native-only entry. It has no import path to Daemon, TaskEngine, bridge records, or watchers. */
export async function main(deps: NativeMainDeps = PRODUCTION_DEPS): Promise<{
  readonly schemaVersion: 1;
  readonly kind: 'native_daemon_started';
  readonly mode: 'native-v1';
  readonly readiness: OperatorVerticalDecision['readiness'];
  readonly health: unknown;
}> {
  const config = deps.loadConfig();
  const decision = resolveConfiguredOperatorVerticalMode(config);
  if (decision.effectiveMode !== 'native-v1') {
    throw new Error(`native entry refused effective mode ${decision.effectiveMode} (${decision.readiness})`);
  }
  const deployment = await deps.loadDeployment(config);
  const host = await deployment.createNativeOperatorHost({ config, decision });
  await host.start();
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
    health: await host.health(),
  };
}
