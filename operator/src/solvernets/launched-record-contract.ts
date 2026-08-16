/**
 * Contract-reference resolution for a launched SolverNet record.
 *
 * Carved out of the deleted `launched-record-dispatcher.ts` by Wave-4 D3
 * (Task 17 of `docs/superpowers/plans/2026-07-30-cutover-stage-3-posting-flow.md`,
 * DR-2026-08-05 decision 1). What retired there was the generator PRODUCER —
 * `wireLaunchedRecordGenerators`, the per-SolverType generator factories, and
 * the launcher generator-state projection — all of which existed to feed the
 * legacy creator loop.
 *
 * These two functions are pure record parsing: they answer "which SolverType
 * contract does this launched record name", from the pinned manifest when it is
 * on disk and from the `solverNetId` shape otherwise. That is part of the
 * launched-record wire vocabulary, which survives the producer's retirement —
 * the SolverNet generator-config endpoint still needs it to pick the right
 * config schema for a record.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LaunchedSolverNetRecord } from './store.js';

export interface LaunchedRecordContractRef {
  id: string;
  version: string;
  solverType: string;
  source: 'manifest' | 'solverNetId';
}

function solverTypeFor(id: string, version: string): string {
  return `${id}.${version}`;
}

export function resolveContractFromSolverNetId(
  solverNetId: string,
): LaunchedRecordContractRef | null {
  const match = /^[^_]+_(.+)_[^_]+$/u.exec(solverNetId);
  const contractAndVersion = match?.[1];
  if (!contractAndVersion) return null;
  const splitAt = contractAndVersion.lastIndexOf('-');
  if (splitAt <= 0 || splitAt === contractAndVersion.length - 1) return null;
  const id = contractAndVersion.slice(0, splitAt);
  const version = contractAndVersion.slice(splitAt + 1);
  return {
    id,
    version,
    solverType: solverTypeFor(id, version),
    source: 'solverNetId',
  };
}

function contractFromManifest(raw: unknown): LaunchedRecordContractRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const manifest = raw as { contract?: { id?: unknown; version?: unknown } };
  const id = manifest.contract?.id;
  const version = manifest.contract?.version;
  if (typeof id !== 'string' || typeof version !== 'string') return null;
  if (!id || !version) return null;
  return {
    id,
    version,
    solverType: solverTypeFor(id, version),
    source: 'manifest',
  };
}

async function tryReadManifestContract(path: string): Promise<LaunchedRecordContractRef | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return contractFromManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function resolveLaunchedRecordContract(
  record: LaunchedSolverNetRecord,
  opts: { launchedDir?: string } = {},
): Promise<LaunchedRecordContractRef | null> {
  const manifestPaths = [
    record.manifestPath,
    opts.launchedDir ? join(opts.launchedDir, `${record.solverNetId}.manifest.json`) : undefined,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const manifestPath of manifestPaths) {
    const fromManifest = await tryReadManifestContract(manifestPath);
    if (fromManifest) return fromManifest;
  }

  return resolveContractFromSolverNetId(record.solverNetId);
}
