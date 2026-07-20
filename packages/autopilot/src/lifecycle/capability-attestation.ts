import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import { isoTimestamp } from './types.js';

export const CAPABILITY_ATTESTATION_ENV =
  'JINN_AUTOPILOT_CAPABILITY_ATTESTATION';
export const CAPABILITY_ATTESTATION_VERSION = 1;
export const CAPABILITY_ATTESTATION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export interface CapabilityAttestation {
  readonly version: 1;
  readonly repositoryUrl: typeof CANONICAL_GITHUB_HTTPS_REMOTE;
  readonly remoteName: string;
  readonly probeId: string;
  readonly implementerLogin: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly refs: {
    readonly branch: string;
    readonly review: string;
  };
  readonly proofs: {
    readonly absentRefCreation: true;
    readonly expectedParentRejection: true;
    readonly atomicPairSuccess: true;
    readonly atomicPairRejection: true;
    readonly ambiguousReadback: true;
    readonly exactCleanup: true;
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Capability attestation ${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  label: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Capability attestation ${label} is malformed`);
  }
  return value;
}

function exactTrue(value: unknown, label: string): true {
  if (value !== true) {
    throw new Error(`Capability attestation proof ${label} is missing`);
  }
  return true;
}

function timestamp(value: unknown, label: string): string {
  const raw = string(value, label);
  try {
    isoTimestamp(raw);
  } catch {
    throw new Error(`Capability attestation ${label} is invalid`);
  }
  return raw;
}

export function decodeCapabilityAttestation(
  value: unknown,
  expected: {
    readonly remoteName: string;
    readonly configuredLogins: readonly string[];
    readonly now: Date;
  },
): CapabilityAttestation {
  const root = record(value, 'document');
  const refs = record(root.refs, 'refs');
  const proofs = record(root.proofs, 'proofs');
  if (root.version !== CAPABILITY_ATTESTATION_VERSION) {
    throw new Error('Capability attestation version is unsupported');
  }
  if (root.repositoryUrl !== CANONICAL_GITHUB_HTTPS_REMOTE) {
    throw new Error('Capability attestation repository is not canonical');
  }
  const remoteName = string(root.remoteName, 'remoteName');
  if (remoteName !== expected.remoteName) {
    throw new Error('Capability attestation remote does not match active mode');
  }
  const probeId = string(root.probeId, 'probeId');
  if (!/^[0-9a-f]{32}$/.test(probeId)) {
    throw new Error('Capability attestation probeId is invalid');
  }
  const implementerLogin = string(root.implementerLogin, 'implementerLogin');
  if (!expected.configuredLogins.some(
    (login) => login.toLowerCase() === implementerLogin.toLowerCase(),
  )) {
    throw new Error(
      'Capability attestation implementer identity is not configured',
    );
  }
  const verifiedAt = timestamp(root.verifiedAt, 'verifiedAt');
  const expiresAt = timestamp(root.expiresAt, 'expiresAt');
  const verifiedMs = Date.parse(verifiedAt);
  const expiresMs = Date.parse(expiresAt);
  const nowMs = expected.now.getTime();
  if (
    verifiedMs > nowMs
    || nowMs - verifiedMs > CAPABILITY_ATTESTATION_MAX_AGE_MS
    || expiresMs <= nowMs
    || expiresMs - verifiedMs > CAPABILITY_ATTESTATION_MAX_AGE_MS
  ) {
    throw new Error('Capability attestation is expired or outside its validity window');
  }
  const branch = string(refs.branch, 'branch ref');
  const review = string(refs.review, 'review ref');
  if (
    branch !== `refs/heads/autopilot/capability-${probeId}`
    || review
      !== `refs/jinn-autopilot/review-claims/v1/capability-${probeId}`
  ) {
    throw new Error('Capability attestation refs do not match its probeId');
  }
  return {
    version: 1,
    repositoryUrl: CANONICAL_GITHUB_HTTPS_REMOTE,
    remoteName,
    probeId,
    implementerLogin,
    verifiedAt,
    expiresAt,
    refs: { branch, review },
    proofs: {
      absentRefCreation: exactTrue(
        proofs.absentRefCreation,
        'absent-ref creation',
      ),
      expectedParentRejection: exactTrue(
        proofs.expectedParentRejection,
        'expected-parent rejection',
      ),
      atomicPairSuccess: exactTrue(
        proofs.atomicPairSuccess,
        'atomic pair success',
      ),
      atomicPairRejection: exactTrue(
        proofs.atomicPairRejection,
        'atomic pair rejection',
      ),
      ambiguousReadback: exactTrue(
        proofs.ambiguousReadback,
        'ambiguous readback',
      ),
      exactCleanup: exactTrue(proofs.exactCleanup, 'exact cleanup'),
    },
  };
}

export function readCapabilityAttestation(
  path: string,
  expected: Parameters<typeof decodeCapabilityAttestation>[1],
): CapabilityAttestation {
  if (!isAbsolute(path)) {
    throw new Error('Capability attestation path must be absolute');
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      'Capability attestation must be a regular non-symbolic file',
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Capability attestation must be owner-only');
  }
  const canonical = realpathSync(path);
  return decodeCapabilityAttestation(
    JSON.parse(readFileSync(canonical, 'utf8')) as unknown,
    expected,
  );
}
