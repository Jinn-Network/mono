/**
 * Launched-SolverNet + posting-entry fixtures for the native e2e rig (one-swap M7, umbrella #2461).
 *
 * The native posting loop (`src/daemon/native-fleet-posting.ts`) resolves each `config.posting[]`
 * entry's `launchedRecordPath` off disk with `LaunchedSolverNetRecordSchema` and annotates the
 * target `live` iff the record's `status === 'launched'`. M5e/M5f flagged this pair as needed:
 * a `status: 'launched'` record and the `posting[]` entry that points at it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  LaunchedSolverNetRecordSchema,
  type LaunchedSolverNetRecord,
} from '../../../../src/solvernets/store.js';
import type { PostingConfigEntry } from '../../../../src/config/shape-v2.js';

export interface LaunchedRecordFixture {
  readonly path: string;
  readonly record: LaunchedSolverNetRecord;
  readonly postingEntry: PostingConfigEntry;
}

/**
 * Writes a valid `status: 'launched'` record and returns it with the matching `posting[]` entry.
 * The record is schema-validated before write, so a drift in `LaunchedSolverNetRecordSchema`
 * reddens the fixture rather than producing a file the posting loop silently ignores.
 */
export async function writeLaunchedRecordFixture(input: {
  readonly path: string;
  readonly workKind: string;
  readonly launcherSafeAddress: `0x${string}`;
  readonly launcherAgentId: string;
  readonly solverNetId?: string;
  readonly manifestCid?: string;
  readonly generatorEnabled?: boolean;
}): Promise<LaunchedRecordFixture> {
  const solverNetId = input.solverNetId ?? 'native-e2e-solvernet';
  const now = '2026-08-02T00:00:00.000Z';
  const record: LaunchedSolverNetRecord = LaunchedSolverNetRecordSchema.parse({
    schemaVersion: 'solvernet.launched.v1',
    solverNetId,
    manifestCid: input.manifestCid ?? 'bafy-native-e2e-manifest',
    manifestHash: `0x${'ab'.repeat(32)}`,
    launcherAgentId: input.launcherAgentId,
    launcherSafeAddress: input.launcherSafeAddress,
    launchedAt: now,
    status: 'launched',
    statusUpdatedAt: now,
    generatorEnabled: input.generatorEnabled ?? false,
    registry: {},
  });
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, JSON.stringify(record, null, 2));
  return {
    path: input.path,
    record,
    postingEntry: {
      workKind: input.workKind,
      launchedRecordPath: input.path,
      generatorEnabled: input.generatorEnabled ?? false,
    },
  };
}
