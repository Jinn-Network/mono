/**
 * The fleet requester WRITE path (one-swap M5e, umbrella #2461, DR-2026-08-05 decision 1).
 *
 * This closes the two gaps the M5d finding named as the reason `native-fleet-posting.ts`'s `post`
 * had to fail closed:
 *
 *  1. the config -> request task construction (the native requester's `request()` seals the sealed
 *     today-mode bundle — Task, Submission, admission receipt, requester envelope — from the pinned
 *     B1 prediction fixture; the `posting[]` entry supplies the run identity), and
 *  2. the venue -> requester posting bridge (a real `MarketplaceRequesterBackend` whose posting
 *     `safe` port is the fleet composition's ONE Safe broadcaster).
 *
 * ONE broadcaster / single-nonce authority (program contract 1, M4a review). The requester posting
 * command does NOT open a second wallet or venue: `input.safeBroadcast` is
 * `composition.venue.safe` — the SAME `BaseVenueSafeBroadcaster` the solver claim/delivery,
 * evaluator verdict and settlement legs serialize through — and `input.intents` /`input.observe`
 * are that same venue's posting WAL and scope store. Every requester `createTask` therefore
 * assigns its nonce through the one durable per-`(chainId, sender)` broadcast lock, never a second
 * nonce stack against the same Safe.
 *
 * Same-instance discipline (program contract 2): this module constructs no identity set, no chain
 * read client, and no store of its own. The caller injects the fleet's already-opened role
 * authority, the venue's ports, the shared authority-time / canonical reads, and the IPFS pin.
 *
 * Idempotency and cadence (M5e finding, stated where it bites). `postTarget` derives a DETERMINISTIC
 * `runId` from the posting entry, so a repeated tick — or a restart — returns the requester's
 * durable canonical association for that entry rather than broadcasting a second `createTask`. That
 * is deliberate: one configured posting entry mints exactly one escrowed task (the today-mode
 * escrow is real native wei), and re-driving it is a no-op read, not a spend. A production cadence
 * that mints FRESH tasks per entry needs a per-entry run cursor the `posting[]` config does not
 * carry yet; that generator semantics is a later milestone, not wired here.
 */
import {
  BASE_SEPOLIA_TODAY,
  DEFAULT_POSTING_TERMS,
  makeMarketplaceBackend,
  type IpfsPinPort,
  type MarketplaceObservePort,
  type PostingIntentStore,
  type PostingTerms,
  type SafeBroadcastPort,
} from '@jinn-network/marketplace-binding';
import {
  createNativeRequester,
  createNativeRequesterPostTask,
  NATIVE_REQUESTER_FIXTURE,
  type CanonicalTaskCreated,
  type NativeAuthorityTimeAnchor,
  type NativeRequesterRoles,
} from '../native-requester/requester.js';
import {
  adoptPostedTask,
  isRequesterError,
  type AdoptionDecision,
  type DeliveryObservePort,
} from '../native-requester/work-client/index.js';
import type { AdoptionReceiptStore } from './native-adoption-receipt-store.js';
import type { PostingLoopTarget } from './posting-loop.js';

/**
 * The fleet's today-mode posting terms. The reference on-ramp terms from the marketplace binding
 * (`DEFAULT_POSTING_TERMS`), minus its `maxClaims` companion — `maxClaims: 1` rides in the sealed
 * Submission's `attempts.maxTotal`, which the golden fixture already pins, and the marketplace
 * backend reads its escrow multiplier from that Submission, not from the terms. Kept as a named
 * export so the escrow a fleet post spends is one auditable value, not an inline literal.
 */
export const FLEET_REQUESTER_POSTING_TERMS: PostingTerms = {
  solutionMaxDeliveryRateWei: DEFAULT_POSTING_TERMS.solutionMaxDeliveryRateWei,
  verdictMaxDeliveryRateWei: DEFAULT_POSTING_TERMS.verdictMaxDeliveryRateWei,
  responseTimeoutSeconds: DEFAULT_POSTING_TERMS.responseTimeoutSeconds,
  allowSolverSelfEvaluation: DEFAULT_POSTING_TERMS.allowSolverSelfEvaluation,
};

/** The canonical `TaskCreated` reader the requester association re-checks its broadcast against. */
export type CanonicalTaskCreatedReader = (expected: {
  readonly chainId: number;
  readonly coordinator: `0x${string}`;
  readonly creator: `0x${string}`;
  readonly taskId: bigint;
  readonly taskDigest: `sha256:${string}`;
  readonly txHash: `0x${string}`;
  readonly terms: PostingTerms;
  readonly maxClaims: 1;
}) => Promise<CanonicalTaskCreated | null>;

export interface FleetRequesterWriteInput {
  /** This operator's requester Agent IRI (the `requester-submission` / `requester-discovery` owner). */
  readonly requesterAgent: string;
  /** The DISTINCT admission Agent IRI whose store holds the `admission` signing key. */
  readonly admissionAgent: string;
  /** The requester source's public base URL (announcement locations resolve under it). */
  readonly publicBaseUrl: string;
  /** The requester's durable association/draft directory (same one the projector resolver reads). */
  readonly requesterStateDir: string;
  /** This operator's service Safe — the creator Safe the today-mode escrow is sent from. */
  readonly creatorSafe: `0x${string}`;
  /** Role authority dispatch: `admission` -> the admission set, the rest -> the requester set. */
  readonly roles: NativeRequesterRoles;
  /** The composition's ONE Safe broadcaster (`composition.venue.safe`). NEVER a second wallet. */
  readonly safeBroadcast: SafeBroadcastPort;
  /** The composition venue's posting WAL (`composition.venue.intents`). */
  readonly intents: PostingIntentStore;
  /** The composition venue's requester-scope store (`composition.venue.observe`). */
  readonly observe: MarketplaceObservePort;
  /** The IPFS pin the sealed Task/Submission bytes are uploaded through before broadcast. */
  readonly ipfsPin: IpfsPinPort;
  /** Latest canonical finalized Base Sepolia block, sealed into the requester authority. */
  readonly authorityTime: () => Promise<NativeAuthorityTimeAnchor>;
  /** Reuses the runtime's ONE canonical read (`solverReads.canonicalTaskCreated`). */
  readonly canonicalTaskCreated: CanonicalTaskCreatedReader;
  /**
   * The durable adoption-receipt sink (one-swap M5f). The G-loop adopt leg reads this operator's own
   * posted associations, observes + verifies each delivery, and records an accepted decision here.
   * `has()` makes adoption adopt-once: an already-adopted task is skipped on later reconcile ticks.
   * `main.ts` builds a {@link AdoptionReceiptStore} under the requester state dir.
   */
  readonly adoptionReceipts: AdoptionReceiptStore;
  /** Optional info/warn sink for adoption outcomes — a new accepted adoption logs info, a refusal a loud warn. */
  readonly logger?: { info(message: string): void; warn(message: string): void };
  /** Overrides the fleet default terms (tests). Production uses {@link FLEET_REQUESTER_POSTING_TERMS}. */
  readonly postingTerms?: PostingTerms;
  readonly now?: () => Date;
}

export interface FleetRequesterWrite {
  /**
   * This requester's SERVING plane — the archive handler over its signed source, and the source
   * identity that handler answers for (#2519 F1).
   *
   * All three standalone hosts mount their role's discovery handler; the fleet daemon mounted only
   * the solver's, because this write port surfaced no handler for `main.ts` to mount. Without it a
   * fleet operator serves no requester archive, so no consumer can ever resolve that source's
   * introduction and BOTH operators refuse every poll — the operator's own consumer included.
   * (Since #2521 that resolution happens at poll rather than at boot; the archive is no less
   * required, the refusal just arrives one poll later.) It is the same `handleDiscoveryRequest`
   * the standalone requester host mounts
   * (`native-production-deployment.ts`), over the same durable `<requesterStateDir>/discovery`
   * store, so the fleet and standalone serving planes cannot drift.
   */
  readonly discovery: {
    readonly source: import('@jinn-network/record-discovery-protocol').SourceIdentity;
    readonly handler: (request: Request) => Promise<Response>;
  };
  /**
   * Posts one target as this operator's own today-mode task and returns the on-chain task id. The
   * posting loop calls this AFTER its funds/freshness preflight for the target, so a broadcast here
   * has already cleared preflight. Idempotent per entry (see the module doc): a repeat returns the
   * durable canonical association without re-broadcasting.
   */
  postTarget(target: PostingLoopTarget): Promise<{ readonly taskId?: string }>;
  /**
   * Reconciles any durable posting draft/WAL before the loop admits new posts, THEN runs the adopt
   * leg (M5f) over this operator's own posted tasks. This is the loop's first tick step, so a
   * delivery from a second operator is observed, verified and adopted before the next post.
   */
  reconcile(): Promise<void>;
  /**
   * The G-loop adopt leg (M5f): for each posted task not yet adopted, observe its delivery, verify it
   * fail-closed against the posted Submission, and record a durable accepted decision. READ + RECORD
   * — never a broadcast. Returns the decisions recorded THIS pass (empty when nothing new was
   * delivered). A per-task refusal (tamper / non-correspondence) is a loud skip, never fatal to the
   * pass. Exposed for direct test drive; production reaches it through {@link reconcile}.
   */
  adopt(): Promise<readonly AdoptionDecision[]>;
}

const RUN_ID_ALLOWED = /[^A-Za-z0-9._-]/gu;

/**
 * Deterministic today-mode run identity for a posting target. Prefixed so it always begins with an
 * identifier character (the requester's `runId` grammar requires `[A-Za-z0-9]` first), and every
 * disallowed character in the posting key is folded to `-` so an arbitrary manifest-derived work
 * kind still produces a legal, stable id. Deterministic BY DESIGN — see the module doc's
 * idempotency note.
 */
export function fleetRequesterRunId(target: Pick<PostingLoopTarget, 'postingKey'>): string {
  const sanitized = target.postingKey.replace(RUN_ID_ALLOWED, '-');
  return `fleet-${sanitized}`.slice(0, 128);
}

/**
 * Assembles the fleet requester write path. Pure over its injected ports — it opens no wallet,
 * venue, store, or chain client; the caller (main.ts, after the composition exists) owns those and
 * threads the composition's ONE broadcaster in.
 */
export function buildFleetRequesterWrite(input: FleetRequesterWriteInput): FleetRequesterWrite {
  const terms = input.postingTerms ?? FLEET_REQUESTER_POSTING_TERMS;
  const backend = makeMarketplaceBackend(BASE_SEPOLIA_TODAY, {
    creatorSafe: input.creatorSafe,
    terms,
    posting: {
      ipfs: input.ipfsPin,
      intents: input.intents,
      safe: input.safeBroadcast,
    },
    observe: input.observe,
  });
  const requester = createNativeRequester({
    stateDir: input.requesterStateDir,
    requesterAgent: input.requesterAgent,
    admissionAgent: input.admissionAgent,
    publicBaseUrl: input.publicBaseUrl,
    readChain: async () => BASE_SEPOLIA_TODAY,
    authorityTime: input.authorityTime,
    loadRoles: async () => input.roles,
    creatorSafe: input.creatorSafe,
    posting: {
      ...createNativeRequesterPostTask({ terms, backend }),
      // A today-mode v2 draft never re-enters draft-recover (only a v1 `broadcasting` draft does),
      // so this is never reached on the fleet path. It matches the standalone reads' honesty: a
      // `TaskCreated` anchors only creator + Task digest and cannot prove which Submission landed.
      recover: async () => null,
      canonicalTaskCreated: input.canonicalTaskCreated,
    },
    now: input.now ?? (() => new Date()),
  });
  // The adoption observe surface is the SAME venue observe port the write path already holds — no
  // second observe consumer is opened (program contract 2, the M4a/M5d shared-store discipline). The
  // delegating literal preserves each method's own closure `this`.
  const adoptionPort: DeliveryObservePort & { readonly receipts: AdoptionReceiptStore } = {
    observe: (ref) => input.observe.observe(ref),
    deliveries: (attempt) => input.observe.deliveries(attempt),
    fetchDelivery: (ref) => input.observe.fetchDelivery(ref),
    receipts: input.adoptionReceipts,
  };
  const now = input.now ?? (() => new Date());

  async function adopt(): Promise<readonly AdoptionDecision[]> {
    const associations = await requester.postedAssociations();
    const decisions: AdoptionDecision[] = [];
    for (const association of associations) {
      const taskId = association.taskId.toString(10);
      // Adopt-once: a task already on the durable receipt is skipped silently (no re-verify, no
      // re-log). This is what keeps a reconcile tick quiet for tasks already closed.
      // eslint-disable-next-line no-await-in-loop -- bounded by the operator's own posted-task count.
      if (await input.adoptionReceipts.has(taskId)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- deliberately sequential; small, bounded set.
        const decision = await adoptPostedTask(
          {
            facts: {
              taskId: association.taskId,
              taskDigest: association.taskDigest,
              submissionUri: association.submissionUri,
            },
            now,
          },
          adoptionPort,
        );
        if (decision !== null) {
          decisions.push(decision);
          input.logger?.info(`[adopt] adopted task ${taskId} delivery ${decision.deliveryDigest}`);
        }
      } catch (err) {
        // Fail-closed refusal (tampered / non-corresponding delivery) OR a transient observe error:
        // a loud skip that never strands the other posted tasks and never adopts garbage.
        const detail = isRequesterError(err)
          ? `${err.category}/${err.code}: ${err.message}`
          : err instanceof Error ? err.message : String(err);
        input.logger?.warn(`[adopt] skipped task ${taskId}: ${detail}`);
      }
    }
    return decisions;
  }

  return {
    discovery: { source: requester.source, handler: requester.handleDiscoveryRequest },
    adopt,
    async reconcile() {
      await requester.reconcile();
      await adopt();
    },
    async postTarget(target) {
      const result = await requester.request({
        network: 'base-sepolia',
        fixture: NATIVE_REQUESTER_FIXTURE,
        runId: fleetRequesterRunId(target),
      });
      return { taskId: result.association.taskId.toString(10) };
    },
  };
}
