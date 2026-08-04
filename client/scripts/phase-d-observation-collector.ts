#!/usr/bin/env node
/**
 * Phase D observation-window collector (#2380).
 *
 * Scrapes the enumerated first-party fleet — the operators and Railway services named in
 * `docs/runbooks/cutover-stage-1-drain.md` — on a daily cadence, and writes/updates a durable
 * observation receipt binding each instance's identity to its Phase D diagnostics for the
 * approved window. This automates what the issue calls out as the current (undesirable) method:
 * "a human scraping each host".
 *
 * All decision logic (missing/corrupt/reset invalidation, the zero-use verdict) lives in the pure
 * library `src/monitoring/phase-d-observation-window.ts` — this script is a thin I/O wrapper,
 * mirroring `scripts/net-liveness-probe.ts` / `src/monitoring/net-liveness.ts`.
 *
 * Usage:
 *   yarn phase-d-observe -- --fleet ./phase-d-fleet.json --receipt ./phase-d-observation-receipt.json
 *
 * See docs/runbooks/phase-d-observation-window.md for the fleet manifest shape, the receipt
 * contract, and cron setup.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  appendDailyObservation,
  fetchHttpStatusSnapshot,
  parseExistingReceipt,
  readFileStatusSnapshot,
  type PhaseDObservationFetch,
  type PhaseDObservationFetchResult,
  type PhaseDObservationReceipt,
} from '../src/monitoring/phase-d-observation-window.js';

interface FleetInstanceConfig {
  readonly instanceId: string;
  readonly imageDigest?: string;
  readonly reportedSourceSha?: string;
  readonly source:
    | { readonly kind: 'http-status'; readonly url: string; readonly tokenEnv?: string }
    | { readonly kind: 'file-snapshot'; readonly path: string };
}

interface FleetManifest {
  readonly windowId: string;
  readonly approvedBy: string;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly instances: readonly FleetInstanceConfig[];
}

class CollectorSetupError extends Error {
  override readonly name = 'CollectorSetupError';
}

function parseArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new CollectorSetupError(`${label} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (cause) {
    throw new CollectorSetupError(`${label} is not valid JSON: ${path} (${String(cause)})`);
  }
}

function loadFleetManifest(path: string): FleetManifest {
  const manifest = readJson<Partial<FleetManifest>>(path, 'fleet manifest');
  if (typeof manifest.windowId !== 'string' || manifest.windowId.length === 0
    || typeof manifest.approvedBy !== 'string' || manifest.approvedBy.length === 0
    || typeof manifest.startedAt !== 'string'
    || !Array.isArray(manifest.instances) || manifest.instances.length === 0) {
    throw new CollectorSetupError(`fleet manifest is missing required fields: ${path}`);
  }
  return manifest as FleetManifest;
}

function loadExistingReceipt(path: string): PhaseDObservationReceipt | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    // A corrupt receipt is a collector-setup failure, not a per-instance fetch failure — silently
    // starting a fresh receipt would erase prior days' snapshot history without anyone noticing.
    throw new CollectorSetupError(`existing receipt is corrupt: ${path} (${String(cause)}). Move or repair it before re-running.`);
  }
  try {
    // parseExistingReceipt validates schemaVersion/kind/instances shape — a well-formed JSON file
    // with the right windowId but a truncated/missing instances array must never be silently
    // trusted as "the existing receipt": that would discard real history the same way the
    // fleet-shrinkage hazard would, just via the file instead of the fetch.
    return parseExistingReceipt(raw);
  } catch (cause) {
    throw new CollectorSetupError(`existing receipt has an unexpected shape: ${path} (${String(cause)}). Move or repair it before re-running.`);
  }
}

async function fetchInstance(instance: FleetInstanceConfig, collectedAt: string): Promise<PhaseDObservationFetchResult> {
  if (instance.source.kind === 'http-status') {
    const token = instance.source.tokenEnv ? process.env[instance.source.tokenEnv] : undefined;
    return fetchHttpStatusSnapshot({ url: instance.source.url, ...(token ? { token } : {}) });
  }
  return readFileStatusSnapshot({ path: instance.source.path, collectedAt });
}

function persistReceiptAtomic(path: string, receipt: PhaseDObservationReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

async function main(): Promise<void> {
  const fleetPath = parseArg('--fleet');
  const receiptPath = parseArg('--receipt');
  if (!fleetPath || !receiptPath) {
    throw new CollectorSetupError('usage: phase-d-observation-collector --fleet <path> --receipt <path>');
  }
  const nowArg = parseArg('--now');
  const collectedAt = nowArg ?? new Date().toISOString();

  const fleet = loadFleetManifest(fleetPath);
  const existing = loadExistingReceipt(receiptPath);

  const fetched: PhaseDObservationFetch[] = await Promise.all(
    fleet.instances.map(async (instance) => ({
      instanceId: instance.instanceId,
      imageDigest: instance.imageDigest ?? null,
      reportedSourceSha: instance.reportedSourceSha ?? null,
      result: await fetchInstance(instance, collectedAt),
    })),
  );

  const receipt = appendDailyObservation({
    existing,
    windowId: fleet.windowId,
    approvedBy: fleet.approvedBy,
    startedAt: fleet.startedAt,
    endedAt: fleet.endedAt ?? null,
    collectedAt,
    fetched,
  });

  persistReceiptAtomic(receiptPath, receipt);

  console.log(`[phase-d-observe] window=${receipt.windowId} zeroUse=${receipt.verdict.zeroUse} `
    + `signalsCovered=${receipt.verdict.signalsCovered.join(',') || '(none)'}`);
  for (const instance of receipt.instances) {
    const latest = instance.snapshots.at(-1);
    console.log(`[phase-d-observe]   ${instance.instanceId}: complete=${instance.complete} `
      + `resets=${instance.resets} regressions=${instance.regressions} durable=${latest?.durable ?? false} `
      + `observationWindowStartedAt=${latest?.observationWindowStartedAt ?? 'null'}`);
  }
  console.log(`[phase-d-observe] wrote ${receiptPath}`);
}

main().catch((err) => {
  console.error(`[phase-d-observe] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
