/**
 * External-impl loader. Reads a signed manifest from disk, verifies
 * it against the trusted-signer list, dynamically imports the
 * entry module, calls the factory with `ExternalHarnessEnv`, and
 * validates that the resulting impl matches the manifest's
 * (name, version, supportedSolverTypes) identity.
 *
 * Spec: `spec/2026-05-external-restorer-impls.md` §3, now expressed through
 * the Harness vocabulary in `spec/2026-05-01-harness-pack-architecture.md`.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadManifest,
  verifyManifestSignature,
  type JinnManifest,
} from '../manifest/index.js';
import type { ScopedSecrets } from '../capability/index.js';
import type { Harness } from '../types.js';
import type { ExternalImplEntry, SignerTrust } from './types.js';
import { verifyPackageHash } from './package-hash.js';
import { isInsidePackageDir } from '../../util/path-safety.js';

/**
 * Daemon-side mirror of the SDK's `ExternalHarnessEnv`. Kept local
 * (not imported from the SDK at runtime) so the client doesn't add a
 * runtime dependency on @jinn-network/sdk/harness; the shape is part
 * of the published Path 2 contract.
 */
export interface ExternalHarnessEnv {
  readonly implName: string;
  readonly implVersion: string;
  readonly network: string;
  readonly implStateDir: string;
  readonly secrets: ScopedSecrets;
  readonly log: (event: {
    level: 'info' | 'warn' | 'error';
    msg: string;
    data?: unknown;
  }) => void;
  readonly stub: boolean;
}

export type ExternalHarnessFactory = (
  env: ExternalHarnessEnv,
) => Harness;

export type LoadFailureReason =
  | 'impl-trust'
  | 'impl-load-failed'
  | 'impl-construction-failed'
  | 'impl-identity-mismatch'
  | 'impl-supports-mismatch'
  | 'impl-package-hash-mismatch'
  | 'impl-entry-escape'
  | 'impl-version-mismatch';

export type LoadResult =
  | { kind: 'ok'; impl: Harness; manifest: JinnManifest }
  | { kind: 'error'; reason: LoadFailureReason; detail?: string };

export interface LoadExternalImplArgs {
  entry: ExternalImplEntry;
  trustedSigners: readonly SignerTrust[];
  env: ExternalHarnessEnv;
}

const SOLVER_TYPE_PATTERN = /^([a-z][a-z0-9-]*\.v[0-9]+)/;

export async function loadExternalImpl({
  entry,
  trustedSigners,
  env,
}: LoadExternalImplArgs): Promise<LoadResult> {
  const manifestPath = join(entry.entry, 'jinn.manifest.json');

  let manifest: JinnManifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (err) {
    return {
      kind: 'error',
      reason: 'impl-load-failed',
      detail: (err as Error).message,
    };
  }

  const trusted = await verifyManifestSignature(manifest, trustedSigners);
  if (!trusted) {
    return { kind: 'error', reason: 'impl-trust' };
  }

  // Recompute the package-content hash and compare to the manifest's
  // claim. This binds the signed manifest to the bytes on disk —
  // without it a signed manifest could be paired with arbitrary code
  // so long as the manifest itself is unmodified. See Finding 2 in the
  // PR review.
  const hashOk = await verifyPackageHash(entry.entry, manifest);
  if (!hashOk) {
    return {
      kind: 'error',
      reason: 'impl-package-hash-mismatch',
      detail: `recomputed package hash does not match manifest.package.hash (${manifest.package.hash})`,
    };
  }

  if (manifest.name !== entry.name) {
    return {
      kind: 'error',
      reason: 'impl-identity-mismatch',
      detail: `entry.name=${entry.name} != manifest.name=${manifest.name}`,
    };
  }

  // Operator-pinned version: if the entry pins a specific version, the
  // manifest MUST match it exactly. Prevents silent upgrades of the
  // on-disk package without an explicit operator config change.
  // (Finding 10.)
  if (entry.version !== undefined && manifest.version !== entry.version) {
    return {
      kind: 'error',
      reason: 'impl-version-mismatch',
      detail: `entry.version=${entry.version} != manifest.version=${manifest.version}`,
    };
  }

  const entryAbs = join(entry.entry, manifest.entry);
  // Defence-in-depth against `..` traversal: the schema regex forbids
  // `..` segments, but we also enforce containment at runtime in case
  // the schema changes or the manifest is loaded from a non-validated
  // source. (Finding 4a.)
  if (!isInsidePackageDir(entry.entry, entryAbs)) {
    return {
      kind: 'error',
      reason: 'impl-entry-escape',
      detail: `manifest.entry=${manifest.entry} resolves outside the package root`,
    };
  }

  let mod: { default?: ExternalHarnessFactory };
  try {
    mod = (await import(pathToFileURL(entryAbs).href)) as {
      default?: ExternalHarnessFactory;
    };
  } catch (err) {
    return {
      kind: 'error',
      reason: 'impl-load-failed',
      detail: (err as Error).message,
    };
  }
  if (typeof mod.default !== 'function') {
    return {
      kind: 'error',
      reason: 'impl-load-failed',
      detail: 'default export is not a function',
    };
  }

  let impl: Harness;
  try {
    impl = mod.default(env);
  } catch (err) {
    return {
      kind: 'error',
      reason: 'impl-construction-failed',
      detail: (err as Error).message,
    };
  }

  if (impl.name !== manifest.name) {
    return {
      kind: 'error',
      reason: 'impl-identity-mismatch',
      detail: `impl.name=${impl.name} != manifest.name=${manifest.name}`,
    };
  }
  if (impl.version !== manifest.version) {
    return {
      kind: 'error',
      reason: 'impl-identity-mismatch',
      detail: `impl.version=${impl.version} != manifest.version=${manifest.version}`,
    };
  }

  // Every solverType the manifest claims must be `supports()`-positive
  // for at least one role.
  for (const supported of manifest.supportedSolverTypes) {
    const solverTypeMatch = SOLVER_TYPE_PATTERN.exec(supported);
    if (!solverTypeMatch) continue;
    const solverType = solverTypeMatch[1];
    const restorationOk = impl.supports({ solverType, role: 'restoration' });
    const evaluationOk = impl.supports({ solverType, role: 'evaluation' });
    if (!restorationOk && !evaluationOk) {
      return {
        kind: 'error',
        reason: 'impl-supports-mismatch',
        detail: `manifest claims ${solverType} but impl rejects both restoration and evaluation`,
      };
    }
  }

  return { kind: 'ok', impl, manifest };
}
