/**
 * Surgical write-back of the native IDENTITY keys onto an operator's `config.json`
 * (spec/2026-08-07-native-identity-ceremony.md §4.1 step 7).
 *
 * Five keys, and only these five: `agentIri`, `admissionAgent`, `identityStores`,
 * `trustRootsPath`, `trustPolicyGenesisDigest`. They are the values only the ceremony can know —
 * it minted the custody, minted the IRIs, and sealed the genesis policy whose digest pins the
 * chain.
 *
 * Everything else on the file is preserved byte-for-byte in value: this is a read-modify-write over
 * the parsed JSON, not a re-serialization of a validated config. A `config.json` carries harness
 * settings, joined SolverNets, task definitions and an operator's own hand-edits; a ceremony that
 * round-tripped it through the loader would silently normalize away anything the loader tolerates
 * but does not model.
 *
 * Three keys are deliberately NOT written:
 *   - `ipfs.apiUrl`, `publicBaseUrl`, `recordSources` — deploy-config the ceremony cannot know
 *     (an IPFS endpoint, this host's public URL, and who this operator's peers are). Native boot
 *     hard-requires the first two, so the ceremony REPORTS them as outstanding rather than
 *     guessing.
 *   - `compositionMode` — the flip stays the deploy PR's one switch.
 */

import { existsSync, readFileSync } from 'node:fs';
import { backupConfigFile, writeConfigFileAtomic } from './atomic-write.js';

/** The identity-store paths, keyed by the role family that owns each one. */
export interface NativeIdentityStorePaths {
  readonly requester?: string;
  readonly admission?: string;
  readonly solver?: string;
  readonly evaluator?: string;
}

export interface NativeIdentityWriteBack {
  readonly agentIri: string;
  /** Written ONLY when the ceremony provisioned admission custody. */
  readonly admissionAgent?: string;
  readonly identityStores: NativeIdentityStorePaths;
  readonly trustRootsPath: string;
  readonly trustPolicyGenesisDigest: `sha256:${string}`;
}

export interface NativeIdentityWriteResult {
  readonly configPath: string;
  /** Absent when the config file did not exist and was created by this call. */
  readonly backupPath?: string;
  /** The keys this call actually changed — an unchanged key is not reported as written. */
  readonly written: readonly string[];
  /** Keys already present with a DIFFERENT value, which this call overwrote. */
  readonly replaced: readonly string[];
  /** Native keys the ceremony cannot supply that native boot still needs. */
  readonly outstanding: readonly string[];
}

export class NativeIdentityWriteError extends Error {
  override readonly name = 'NativeIdentityWriteError';
}

function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (cause) {
    throw new NativeIdentityWriteError(`config file cannot be read at ${configPath}: ${String(cause)}`);
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Refusing beats merging into a file we cannot faithfully round-trip: an atomic write of a
    // partially-understood config would destroy whatever the operator actually had there.
    throw new NativeIdentityWriteError(`config file at ${configPath} is not valid JSON: ${String(cause)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NativeIdentityWriteError(`config file at ${configPath} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The native keys the ceremony does not own, reported so the operator sees what still stands
 * between this config and a native boot instead of discovering it at the next daemon start.
 */
function outstandingNativeKeys(config: Record<string, unknown>): readonly string[] {
  const missing: string[] = [];
  const ipfs = config.ipfs;
  if (ipfs === undefined || typeof ipfs !== 'object' || (ipfs as { apiUrl?: unknown }).apiUrl === undefined) {
    missing.push('ipfs.apiUrl');
  }
  if (config.publicBaseUrl === undefined) missing.push('publicBaseUrl');
  if (!Array.isArray(config.recordSources) || config.recordSources.length === 0) {
    missing.push('recordSources');
  }
  return missing;
}

/** The plan a `--dry-run` prints: what WOULD change, computed without touching the file. */
export function planNativeIdentityWriteBack(input: {
  readonly configPath: string;
  readonly values: NativeIdentityWriteBack;
}): { readonly written: readonly string[]; readonly replaced: readonly string[]; readonly outstanding: readonly string[] } {
  const config = readConfigObject(input.configPath);
  const merged = mergeNativeIdentity(config, input.values);
  return {
    written: merged.written,
    replaced: merged.replaced,
    outstanding: outstandingNativeKeys(merged.config),
  };
}

function mergeNativeIdentity(
  config: Record<string, unknown>,
  values: NativeIdentityWriteBack,
): { readonly config: Record<string, unknown>; readonly written: string[]; readonly replaced: string[] } {
  const next = { ...config };
  const written: string[] = [];
  const replaced: string[] = [];

  const assign = (key: string, value: unknown): void => {
    const before = next[key];
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    if (before !== undefined) replaced.push(key);
    written.push(key);
    next[key] = value;
  };

  assign('agentIri', values.agentIri);
  // `join --role-sets requester,solver` provisions no admission custody, so it must not claim an
  // admission authority: the runtime refuses an admissionAgent with no store behind it, and an
  // admissionAgent equal to the requester Agent.
  if (values.admissionAgent !== undefined) assign('admissionAgent', values.admissionAgent);

  // Per-family merge, not replacement: an operator who ran `init` for requester+solver and later
  // provisioned evaluator custody keeps the first two entries.
  const existingStores = next.identityStores;
  const baseStores = (existingStores !== null && typeof existingStores === 'object' && !Array.isArray(existingStores))
    ? (existingStores as Record<string, unknown>)
    : {};
  const stores: Record<string, unknown> = { ...baseStores };
  for (const family of ['requester', 'admission', 'solver', 'evaluator'] as const) {
    const path = values.identityStores[family];
    if (path !== undefined) stores[family] = path;
  }
  assign('identityStores', stores);

  assign('trustRootsPath', values.trustRootsPath);
  assign('trustPolicyGenesisDigest', values.trustPolicyGenesisDigest);

  return { config: next, written, replaced };
}

/**
 * Merges the five identity keys onto `configPath` and reads the file back to prove the merge
 * landed. Backed up first (`<path>.backup-<timestamp>`) and written temp+fsync+rename, so an
 * interrupted write leaves either the old config or the new one — never a half-written config the
 * daemon would then refuse to load.
 */
export function writeNativeIdentityConfig(input: {
  readonly configPath: string;
  readonly values: NativeIdentityWriteBack;
}): NativeIdentityWriteResult {
  const config = readConfigObject(input.configPath);
  const merged = mergeNativeIdentity(config, input.values);
  const backupPath = backupConfigFile(input.configPath);
  writeConfigFileAtomic(input.configPath, merged.config);

  // Read-back assertion (§9 PR3). The write is the one step of the ceremony whose failure is
  // otherwise silent: every earlier step refuses loudly, but a config that did not take just boots
  // legacy at the next start and looks like nothing happened.
  const readBack = readConfigObject(input.configPath);
  for (const key of ['agentIri', 'identityStores', 'trustRootsPath', 'trustPolicyGenesisDigest']) {
    if (JSON.stringify(readBack[key]) !== JSON.stringify(merged.config[key])) {
      throw new NativeIdentityWriteError(
        `config write-back did not take: ${key} read back as ${JSON.stringify(readBack[key])}`,
      );
    }
  }
  if (input.values.admissionAgent !== undefined && readBack.admissionAgent !== input.values.admissionAgent) {
    throw new NativeIdentityWriteError('config write-back did not take: admissionAgent read back mismatched');
  }

  return {
    configPath: input.configPath,
    ...(backupPath === undefined ? {} : { backupPath }),
    written: merged.written,
    replaced: merged.replaced,
    outstanding: outstandingNativeKeys(readBack),
  };
}
