/**
 * Stage-5 participation projection: claim, discovery, spend, and status
 * surfaces read `executionWiring[]` / `posting[]` under configShapeVersion 2.
 * The retired `joinedSolverNets` / `solverNets` keys are no longer on the
 * parsed config (Zod strips a stale on-disk copy).
 */
import { keccak256, toBytes } from 'viem';
import { SOLVER_NET_CONTRACTS } from '@jinn-network/sdk/solvernets';
import type { ExecutionWiringConfigEntry } from './shape-v2.js';

const HEX_DIGEST = /^0x[0-9a-fA-F]{64}$/u;

export function discoveryDigestsFromWiring(
  wiring: readonly ExecutionWiringConfigEntry[] | undefined,
): string[] {
  return (wiring ?? [])
    .map((entry) => entry.legacyManifestDigest)
    .filter((digest): digest is string => typeof digest === 'string' && digest.length > 0);
}

export function wiringParticipationKey(entry: ExecutionWiringConfigEntry): string {
  return entry.legacyManifestDigest ?? entry.workKind;
}

export function contractRefFromWorkKind(
  workKind: string,
): { id: string; version: string } | undefined {
  if (workKind in SOLVER_NET_CONTRACTS) {
    const lastDot = workKind.lastIndexOf('.');
    if (lastDot <= 0) return undefined;
    return { id: workKind.slice(0, lastDot), version: workKind.slice(lastDot + 1) };
  }
  return undefined;
}

export function digestMatchesCid(digest: string | undefined, cid: string): boolean {
  if (digest === undefined || digest.length === 0) return false;
  if (digest === cid) return true;
  return digest.toLowerCase() === keccak256(toBytes(cid)).toLowerCase();
}

export function isHexManifestDigest(value: string): boolean {
  return HEX_DIGEST.test(value);
}

export function findWiringByName(
  wiring: readonly ExecutionWiringConfigEntry[] | undefined,
  needle: string,
): ExecutionWiringConfigEntry | undefined {
  return (wiring ?? []).find(
    (entry) =>
      entry.workKind === needle
      || entry.legacyManifestDigest === needle
      || digestMatchesCid(entry.legacyManifestDigest, needle),
  );
}

/** Posting `legacyManifestDigest` is a CID; wiring's is a keccak digest. */
export function cidFromParticipationDigest(digest: string | undefined): string | undefined {
  if (digest === undefined || digest.length === 0) return undefined;
  if (isHexManifestDigest(digest)) return undefined;
  return digest;
}
