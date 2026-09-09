/**
 * Artifact retrieval primitive — fetch by content address, verify, return bytes.
 *
 * One function fetches an artifact from the network legs an envelope names and
 * hands back its bytes only after they hash to the recorded sha256, together
 * with the provenance of the leg that produced them. A digest mismatch fails
 * closed: the failure arm of the result union has no bytes on it at all.
 *
 * Keyless and filesystem-neutral by construction. There is no store, no signer,
 * no private key, no path, and no write of any kind — not because a caller is
 * trusted to omit them, but because no parameter through which they could
 * arrive exists. `test/architecture/keyless-primitive.test.ts` holds the module
 * graph to the same promise.
 *
 * Where the returned bytes land is the caller's decision. The daemon chain
 * (`acquire.ts`) composes this with its byte cache; the CLI hands them to the
 * operator; the MCP handler proxies to a daemon that runs it. None of that is
 * this function's business.
 *
 * Issue #4179 (umbrella #2448 / journey spec B0c).
 */

import { createHash } from 'node:crypto';
import {
  buildArtifactUrl,
  fetchArtifactContent,
  type AcquireResult,
  type FetchArtifactOptions,
} from './fetch-artifact.js';
import {
  classifyIpfsFetchFailure,
  fetchFromIpfs as defaultFetchFromIpfs,
  type FetchFromIpfsOptions,
} from './ipfs.js';
import type { ArtifactSource } from './types.js';

const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1';

/**
 * Content address of a corpus artifact: the sha256 of the bytes themselves, as
 * recorded in the envelope's `artifact.sha256` — never an IPFS CID (artifacts
 * stopped having CIDs post jinn-mono-vy37.1.2).
 */
export interface ArtifactAddress {
  /** 64-char lowercase hex. The one thing that is trusted. */
  sha256: string;
  /**
   * Declared type from the envelope. Carried into the result for the caller's
   * convenience and never consulted during verification — an attacker-supplied
   * label cannot influence whether bytes are admitted.
   */
  artifactType?: string;
}

/**
 * Where the bytes might be. Every field is manifest-supplied and therefore
 * attacker-controlled; the destination policy and the byte/redirect/deadline
 * caps in `fetch-artifact.ts` and `ipfs.ts` are what make that safe.
 */
export interface ArtifactLocators {
  /** Donated IPFS sources — the envelope's `artifact.sources` entries. */
  sources?: readonly ArtifactSource[];
  /** Gateway base for the IPFS leg. The leg is skipped when this is absent. */
  ipfsGatewayUrl?: string;
  /** HTTP origin — the envelope's `artifact.access.endpoint`. */
  endpoint?: string;
  /** Envelope CID this artifact was named by. Provenance only. */
  envelopeCid?: string;
  /** Publishing operator's Safe, when known. Provenance and attribution only. */
  ownerSafe?: string;
}

export interface FetchVerifiedArtifactOptions {
  /** Bounds/seams for the origin leg. Env defaults apply when omitted. */
  origin?: FetchArtifactOptions;
  /** Bounds for the IPFS leg. Omitted means the seam is called with two arguments. */
  ipfs?: FetchFromIpfsOptions;
  /** Injection seams, mirroring the `acquire.ts` precedent so tests need no module mock. */
  deps?: {
    fetchArtifact?: (
      endpoint: string,
      sha256: string,
      options?: FetchArtifactOptions,
    ) => Promise<AcquireResult>;
    fetchFromIpfs?: (
      gatewayUrl: string,
      cid: string,
      opts?: FetchFromIpfsOptions,
    ) => Promise<unknown>;
    /** Clock seam for `fetchedAt`. */
    now?: () => string;
  };
}

/** One leg's outcome, recorded whether it succeeded, was skipped, or failed. */
export interface ArtifactFetchAttempt {
  readonly leg: 'ipfs' | 'origin';
  /** `ipfs://<cid>` or the exact URL `buildArtifactUrl` produced; empty when skipped. */
  readonly sourceUri: string;
  readonly outcome: 'verified' | 'skipped' | 'failed' | 'digest_mismatch';
  /** Present on `failed`; the classified reason, never a raw string match. */
  readonly reason?: ArtifactFetchFailureReason;
  readonly message?: string;
}

export interface ArtifactProvenance {
  /** Which leg produced the admitted bytes. */
  readonly source: 'ipfs' | 'origin';
  readonly sourceUri: string;
  /** Always 'sha256'. Explicit so the record does not silently mean "some digest". */
  readonly digestAlgorithm: 'sha256';
  /** ISO-8601 instant the bytes were verified, not when they were requested. */
  readonly fetchedAt: string;
  readonly sourceOperator?: string;
  readonly envelopeCid?: string;
  /** Every leg tried, in order. Legible even on the happy path. */
  readonly attempts: readonly ArtifactFetchAttempt[];
}

export interface VerifiedArtifact {
  readonly sha256: string;
  /** Verified bytes, in memory. Never a path, never a handle. */
  readonly bytes: Buffer;
  readonly artifactType: string;
  readonly provenance: ArtifactProvenance;
}

export type ArtifactFetchFailureReason =
  /** Bytes arrived and did not hash to the address. */
  | 'digest_mismatch'
  /** Every attempted leg answered, and every answer was absence. */
  | 'not_found'
  /** Nothing was supplied to try. */
  | 'no_locator'
  /** Destination policy refused an origin or a redirect hop. */
  | 'blocked'
  | 'too_large'
  | 'timeout'
  /** Transport failure — nothing was learned about whether the content exists. */
  | 'unavailable';

export interface FetchVerifiedArtifactFailure {
  readonly ok: false;
  readonly sha256: string;
  readonly reason: ArtifactFetchFailureReason;
  /** Derived from `reason`, never caller-supplied. */
  readonly retryable: boolean;
  readonly message: string;
  readonly attempts: readonly ArtifactFetchAttempt[];
  /** Present only on `digest_mismatch`. Evidence, not content. */
  readonly mismatch?: {
    readonly expectedSha256: string;
    readonly actualSha256: string;
    readonly sourceUri: string;
    readonly sourceOperator?: string;
  };
}

export type FetchVerifiedArtifactResult =
  | { readonly ok: true; readonly artifact: VerifiedArtifact }
  | FetchVerifiedArtifactFailure;

/** Nothing that was learned tells us to stop; everything else does. */
const RETRYABLE_REASONS: ReadonlySet<ArtifactFetchFailureReason> = new Set([
  'timeout',
  'unavailable',
]);

/**
 * The one digest check in the system. Legs that already hold bytes — the byte
 * cache, the self-store, a route resolver, the MCP daemon proxy — call this
 * rather than writing `createHash('sha256')` out again.
 */
export function verifyArtifactDigest(
  expectedSha256: string,
  bytes: Buffer,
): { ok: true } | { ok: false; actualSha256: string } {
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  return actualSha256 === expectedSha256 ? { ok: true } : { ok: false, actualSha256 };
}

/**
 * Log an IPFS read the retrieval is about to fall through, unless the gateway
 * actually answered "not there" (#3441). A cap refusal is positive evidence the
 * content exists, so it must not read like an ordinary miss.
 */
function warnIpfsFallThrough(subject: string, error: unknown): void {
  const classification = classifyIpfsFetchFailure(error);
  if (classification === 'not-found') return;
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(
    `[corpus-read] IPFS source for ${subject} could not be used (${classification}), `
      + `falling through to the next source: ${detail}`,
  );
}

/**
 * Decode a `jinn.artifact.donation.v1` payload into its raw bytes.
 *
 * Moved verbatim from `acquire.ts`. The `schemaVersion` check compares against
 * the encoding constant — the published fixtures set both fields to that same
 * string, so the comparison is load-bearing as written and is not "corrected"
 * here.
 */
function decodeDonationArtifact(raw: unknown, expectedSha256: string): Buffer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('donation artifact payload is not an object');
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== DONATION_ARTIFACT_ENCODING || record['encoding'] !== DONATION_ARTIFACT_ENCODING) {
    throw new Error('donation artifact payload has unexpected encoding');
  }
  if (record['sha256'] !== expectedSha256) {
    throw new Error('donation artifact sha256 does not match requested artifact');
  }
  if (typeof record['data'] !== 'string') {
    throw new Error('donation artifact payload is missing base64 data');
  }
  return Buffer.from(record['data'], 'base64');
}

/** `fetchArtifactContent`'s vocabulary → the primitive's. */
function originReason(reason: Exclude<AcquireResult, { ok: true }>['reason']): ArtifactFetchFailureReason {
  return reason === 'network_error' ? 'unavailable' : reason;
}

/** `classifyIpfsFetchFailure`'s hyphenated vocabulary → the primitive's. */
function ipfsReason(classification: 'too-large' | 'not-found' | 'unavailable'): ArtifactFetchFailureReason {
  if (classification === 'too-large') return 'too_large';
  if (classification === 'not-found') return 'not_found';
  return 'unavailable';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch an artifact by content address and return its bytes only after they
 * hash to that address.
 *
 * Legs run in the order the daemon chain has always used: the free donated IPFS
 * mirror first, the operator's HTTP origin second. A leg with no locator is
 * *skipped*, not failed. A digest mismatch on any leg fails the whole call and
 * does not fall through — the bytes are wrong or hostile, and the next locator
 * cannot make them right.
 */
export async function fetchVerifiedArtifact(
  address: ArtifactAddress,
  locators: ArtifactLocators,
  options?: FetchVerifiedArtifactOptions,
): Promise<FetchVerifiedArtifactResult> {
  const { sha256, artifactType } = address;
  const { sources = [], ipfsGatewayUrl, endpoint, envelopeCid, ownerSafe } = locators;
  const fetchIpfs = options?.deps?.fetchFromIpfs ?? defaultFetchFromIpfs;
  const fetchOrigin = options?.deps?.fetchArtifact
    ?? ((target: string, digest: string, opts?: FetchArtifactOptions) =>
      fetchArtifactContent(target, digest, opts));
  const now = options?.deps?.now ?? (() => new Date().toISOString());
  const ipfsOpts = options?.ipfs;

  const attempts: ArtifactFetchAttempt[] = [];

  const admit = (
    source: 'ipfs' | 'origin',
    sourceUri: string,
    bytes: Buffer,
  ): FetchVerifiedArtifactResult => {
    attempts.push({ leg: source, sourceUri, outcome: 'verified' });
    return {
      ok: true,
      artifact: {
        sha256,
        bytes,
        artifactType: artifactType ?? 'unknown',
        provenance: {
          source,
          sourceUri,
          digestAlgorithm: 'sha256',
          fetchedAt: now(),
          ...(ownerSafe ? { sourceOperator: ownerSafe } : {}),
          ...(envelopeCid ? { envelopeCid } : {}),
          attempts,
        },
      },
    };
  };

  const refuse = (
    leg: 'ipfs' | 'origin',
    sourceUri: string,
    actualSha256: string,
  ): FetchVerifiedArtifactFailure => {
    attempts.push({ leg, sourceUri, outcome: 'digest_mismatch' });
    return {
      ok: false,
      sha256,
      reason: 'digest_mismatch',
      retryable: false,
      message:
        `artifact ${sha256} from ${sourceUri} hashed to ${actualSha256}; `
        + 'the bytes were discarded',
      attempts,
      mismatch: {
        expectedSha256: sha256,
        actualSha256,
        sourceUri,
        ...(ownerSafe ? { sourceOperator: ownerSafe } : {}),
      },
    };
  };

  // 1. Donated IPFS mirror — free and public, so it goes first.
  const ipfsSource = sources.find((source) => source.kind === 'ipfs');
  if (ipfsSource && ipfsGatewayUrl) {
    const sourceUri = `ipfs://${ipfsSource.cid}`;
    try {
      // Two arguments unless bounds were supplied: existing fakes assert on the
      // recorded argument array, where a trailing `undefined` is a third entry.
      const raw = ipfsOpts === undefined
        ? await fetchIpfs(ipfsGatewayUrl, ipfsSource.cid)
        : await fetchIpfs(ipfsGatewayUrl, ipfsSource.cid, ipfsOpts);
      const bytes = decodeDonationArtifact(raw, sha256);
      const verified = verifyArtifactDigest(sha256, bytes);
      if (!verified.ok) return refuse('ipfs', sourceUri, verified.actualSha256);
      return admit('ipfs', sourceUri, bytes);
    } catch (err) {
      // A gateway failure or a malformed donation payload is opportunistic
      // noise, not a verdict on the artifact: classify, warn unless it was
      // proven absence, and let the next locator answer.
      warnIpfsFallThrough(`donation artifact ${sha256}`, err);
      attempts.push({
        leg: 'ipfs',
        sourceUri,
        outcome: 'failed',
        reason: ipfsReason(classifyIpfsFetchFailure(err)),
        message: errorMessage(err),
      });
    }
  } else {
    attempts.push({ leg: 'ipfs', sourceUri: '', outcome: 'skipped' });
  }

  // 2. Operator HTTP origin.
  if (endpoint) {
    const sourceUri = buildArtifactUrl(endpoint, sha256);
    let outcome: AcquireResult;
    try {
      outcome = await fetchOrigin(endpoint, sha256, options?.origin);
    } catch (err) {
      outcome = { ok: false, reason: 'network_error', message: errorMessage(err) };
    }
    if (outcome.ok) {
      const verified = verifyArtifactDigest(sha256, outcome.content);
      if (!verified.ok) return refuse('origin', sourceUri, verified.actualSha256);
      return admit('origin', sourceUri, outcome.content);
    }
    attempts.push({
      leg: 'origin',
      sourceUri,
      outcome: 'failed',
      reason: originReason(outcome.reason),
      ...(outcome.message ? { message: outcome.message } : {}),
    });
  } else {
    attempts.push({ leg: 'origin', sourceUri: '', outcome: 'skipped' });
  }

  // Nothing verified. Absence is only claimed when every attempted leg said so:
  // one inconclusive leg means we learned nothing about existence (#3441).
  const failures = attempts.filter((attempt) => attempt.outcome === 'failed');
  if (failures.length === 0) {
    return {
      ok: false,
      sha256,
      reason: 'no_locator',
      retryable: false,
      message: `artifact ${sha256} has no donated IPFS source and no origin endpoint to try`,
      attempts,
    };
  }
  const inconclusive = failures.filter((attempt) => attempt.reason !== 'not_found');
  const reason = inconclusive.length > 0
    ? inconclusive[inconclusive.length - 1]!.reason!
    : 'not_found';
  return {
    ok: false,
    sha256,
    reason,
    retryable: RETRYABLE_REASONS.has(reason),
    message:
      `artifact ${sha256} could not be retrieved (${reason}) from `
      + failures.map((attempt) => `${attempt.sourceUri}: ${attempt.reason}`).join('; '),
    attempts,
  };
}
