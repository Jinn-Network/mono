/**
 * The native discovery decode — one decode, two callers (one-swap M3, umbrella #2461).
 *
 * This body was extracted verbatim from `native-solver-production.ts`'s inline
 * `createNativeDiscoveryConsumer({ decode })` closure. It is THE reason
 * `native-solver-production.ts` can pass `canonicalFinalized: true` to its claim admission: no
 * announcement becomes a card unless this decode has already proved the requester's association
 * names a canonical, finalized `TaskCreated` on the composed venue. M2 left the fleet path's
 * `canonicalFinalized` returning `false` precisely because it had no such decode; wiring this one
 * onto the fleet path is what makes `true` honest there (see `native-fleet-runtime.ts`).
 *
 * Extraction, not redesign: the checks, their order, and their refusal messages are unchanged.
 * The only shape change is that the four collaborators the body reads off
 * `NativeInfrastructurePrimitives` / `NativeTrustAuthority` are now named parameters, so the fleet
 * path — which owns a `PublicClient` and no `NativeInfrastructurePrimitives` — can supply the same
 * four without assembling a bundle whose write-custody and public-listener halves it never uses.
 */
import {
  NATIVE_REQUESTER_ASSOCIATION_FACT,
  decodeNativeRequesterAnnouncement,
  parseNativeAuthorityTimeAnchor,
  type CanonicalTaskCreated,
  type NativeAuthorityTimeAnchor,
} from '../native-requester/requester.js';
import { address, digest, hash, object, uint } from './native-assembly.js';
import type { NativeDiscoveryDecodeInput } from './native-discovery.js';
import type { AnnouncedSubmissionCard } from './native-submission-facts.js';

const ASSOCIATION = NATIVE_REQUESTER_ASSOCIATION_FACT;

export interface NativeRequesterDecodePorts {
  /** Refuses a stale trust catalog before any announcement content is read. */
  readonly assertTrustFresh: () => Promise<void>;
  /** Canonical, finalized Base authority-time anchor check. */
  readonly verifyAuthorityTime: (anchor: NativeAuthorityTimeAnchor) => Promise<boolean>;
  /** Exact bytes at the announcement's single advertised Submission location. */
  readonly recordByLocation: (locator: string) => Promise<Uint8Array>;
  /** Canonical + finalized `TaskCreated` reader for the composed venue. */
  readonly canonicalTaskCreated: (expected: {
    readonly chainId: number;
    readonly coordinator: `0x${string}`;
    readonly creator: `0x${string}`;
    readonly taskId: bigint;
    readonly taskDigest: `sha256:${string}`;
    readonly txHash: `0x${string}`;
    readonly terms: {
      readonly solutionMaxDeliveryRateWei: bigint;
      readonly verdictMaxDeliveryRateWei: bigint;
      readonly responseTimeoutSeconds: bigint;
      readonly allowSolverSelfEvaluation: false;
    };
    readonly maxClaims: 1;
  }) => Promise<CanonicalTaskCreated | null>;
}

/**
 * Builds the decode both native solver paths install on their discovery consumer.
 *
 * Every refusal here is a HARD refusal: `createNativeDiscoveryConsumer.sync()` does not catch,
 * so a non-canonical, non-finalized, self-evaluation-permitting or location-ambiguous
 * announcement aborts the whole source pass rather than being queued as a card. That is the
 * property `canonicalFinalized` leans on downstream — a queued card is, by construction, a card
 * whose `TaskCreated` this operator independently re-derived from chain.
 */
export function buildNativeRequesterAnnouncementDecode(
  ports: NativeRequesterDecodePorts,
): (input: NativeDiscoveryDecodeInput) => Promise<AnnouncedSubmissionCard> {
  return async (discoveryInput) => {
    await ports.assertTrustFresh();
    const facts = object(discoveryInput.announcement.facts, 'requester facts');
    const association = object(facts[ASSOCIATION], 'requester association');
    const authorityTime = parseNativeAuthorityTimeAnchor(association['authorityTime']);
    if (!await ports.verifyAuthorityTime(authorityTime)) {
      throw new Error('native requester authority time is not canonical and finalized');
    }
    const submissionLocation = discoveryInput.announcement.locations ?? [];
    if (submissionLocation.length !== 1) {
      throw new Error('native requester announcement must advertise one Submission location');
    }
    const submissionBytes = await ports.recordByLocation(submissionLocation[0]!.locator);
    const lookup = {
      chainId: Number(uint(association['chainId'], 'chainId')),
      coordinator: address(association['coordinator'], 'coordinator'),
      creator: address(association['creator'], 'creator'),
      taskId: uint(association['taskId'], 'taskId'),
      taskDigest: digest(association['taskDigest'], 'taskDigest'),
      txHash: hash(association['txHash'], 'txHash'),
      terms: (() => {
        const terms = object(association['postingTerms'], 'posting terms');
        if (terms['allowSolverSelfEvaluation'] !== false) {
          throw new Error('native requester permits solver self-evaluation');
        }
        return {
          solutionMaxDeliveryRateWei: uint(terms['solutionMaxDeliveryRateWei'], 'solution rate'),
          verdictMaxDeliveryRateWei: uint(terms['verdictMaxDeliveryRateWei'], 'verdict rate'),
          responseTimeoutSeconds: uint(terms['responseTimeoutSeconds'], 'response timeout'),
          allowSolverSelfEvaluation: false as const,
        };
      })(),
      maxClaims: 1 as const,
    };
    const canonical = await ports.canonicalTaskCreated(lookup);
    if (canonical === null) throw new Error('native TaskCreated is not canonical and finalized');
    return decodeNativeRequesterAnnouncement({
      discovery: discoveryInput,
      canonicalTaskCreated: canonical,
      submissionBytes,
    });
  };
}
