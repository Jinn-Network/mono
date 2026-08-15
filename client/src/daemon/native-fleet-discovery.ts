/**
 * The ONE fleet daemon's native discovery consumer (one-swap M3, umbrella #2461, DR-2026-08-05).
 *
 * M2 assembled everything `buildOperatorComposition({ mode: 'native' })` demands and deliberately
 * stopped short of a source consumer, leaving `canonicalFinalized` refusing every claim. This is
 * the piece that closes it: the same verified, checkpointed consumer
 * (`createNativeDiscoveryConsumer`) over the same policy-scoped signed-chain source verification
 * (`buildNativeDiscoverySources`) and the same canonical-and-finalized decode
 * (`native-requester-decode.ts`) the native solver host runs — three shared modules, two callers,
 * no second implementation.
 *
 * Two differences from the solver host, both load-bearing and both inherited from M2:
 *
 * 1. **The shared `Store`.** `native-solver-production.ts` opens `stateDir/solver.sqlite`; this
 *    runs over `Store(config.dbPath)`, where the legacy readers, the projector cursor and
 *    `task_runs` already live, because the R1 read-plane repoint needs the native tables in the
 *    database the API layer already opens. The caller passes the Store in.
 * 2. **Config, not `NativeProductConfig`.** Sources come off the shape-v2 `config.json`
 *    (`recordSources`), not the role-scoped schema of the entry point retiring at stage 5.
 */
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import type { NativeRecordSource } from '../config/native-sections.js';
import type { Store } from '../store/store.js';
import { buildNativeDiscoverySources } from './native-discovery-trust.js';
import { createNativeDiscoveryConsumer, type NativeDiscoveryConsumer } from './native-discovery.js';
import {
  buildNativeRequesterAnnouncementDecode,
  type NativeRequesterDecodePorts,
} from './native-requester-decode.js';
import type { AnnouncedSubmissionCard } from './native-submission-facts.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';

export class NativeFleetDiscoveryError extends Error {
  override readonly name = 'NativeFleetDiscoveryError';
}

export interface FleetNativeDiscoveryInput {
  readonly store: Store;
  readonly trust: NativeTrustAuthority;
  /** Every `recordSources` entry as configured; only the `requester` ones are consumed here. */
  readonly recordSources: readonly NativeRecordSource[] | undefined;
  /**
   * This operator's own `publicBaseUrl` (#2547). For a co-located requester+solver operator the
   * solver loop consumes THIS operator's own requester source; passing it lets that self-hosted
   * source's idle-lapsed head degrade rather than deadlock `WorkLoop.initialize`'s boot `sync()`.
   */
  readonly selfBaseUrl?: string;
  readonly verifyAuthorityTime: NativeRequesterDecodePorts['verifyAuthorityTime'];
  readonly recordByLocation: NativeRequesterDecodePorts['recordByLocation'];
  readonly canonicalTaskCreated: NativeRequesterDecodePorts['canonicalTaskCreated'];
}

/**
 * The exactly-one requester source the solver loop consumes.
 *
 * `native-solver-production.ts` enforces the same cardinality ("native solver requires exactly one
 * requester source"), and for the same reason: the claim policy's `maxConcurrent: 1` and the
 * single-solver-of-record admission model have no defined behaviour across two independently
 * checkpointed requester histories. Solver- and evaluator-role entries are filtered out rather
 * than refused — an operator who has already configured an evaluator source ahead of M4 must not
 * be blocked from booting the solver loop.
 */
export function selectFleetRequesterSources(
  configured: readonly NativeRecordSource[] | undefined,
): readonly NativeRecordSource[] {
  if (configured === undefined) {
    throw new NativeFleetDiscoveryError(
      'compositionMode "native" requires config.recordSources; native boot refuses rather than '
      + 'polling no source and silently claiming nothing',
    );
  }
  const requester = configured.filter(({ role }) => role === 'requester');
  if (requester.length !== 1) {
    throw new NativeFleetDiscoveryError(
      `native fleet discovery requires exactly one requester record source, found ${requester.length}`,
    );
  }
  return requester;
}

export async function buildFleetNativeDiscovery(
  input: FleetNativeDiscoveryInput,
): Promise<NativeDiscoveryConsumer<AnnouncedSubmissionCard>> {
  const configured = selectFleetRequesterSources(input.recordSources);
  // `createHttpTransport('')` is the solver host's own construction: each source endpoint carries
  // its absolute serving root, so the transport needs no base of its own.
  const transport = createHttpTransport('');
  // Construction resolves NO source (#2521): the fleet daemon's own requester source lives behind
  // the archive listener `main.ts` binds ~250 statements after this call, and a peer's lives behind
  // an operator that may not be up yet. Introduction resolution happens at first `sync()`.
  const sources = buildNativeDiscoverySources({
    configured,
    store: input.store,
    transport,
    trust: input.trust,
    ...(input.selfBaseUrl === undefined ? {} : { selfBaseUrl: input.selfBaseUrl }),
  });
  return createNativeDiscoveryConsumer<AnnouncedSubmissionCard>({
    store: input.store,
    sources,
    transport,
    decode: buildNativeRequesterAnnouncementDecode({
      assertTrustFresh: () => input.trust.assertFresh(),
      verifyAuthorityTime: input.verifyAuthorityTime,
      recordByLocation: input.recordByLocation,
      canonicalTaskCreated: input.canonicalTaskCreated,
    }),
  });
}

/**
 * Did the native discovery decode admit this card?
 *
 * This is what makes the fleet path's `canonicalFinalized` honest, and it is a structural fact,
 * not a heuristic. `createNativeDiscoveryConsumer` stamps `discovery` (source identity, sequence,
 * entry digest and the exact signed high-water it was accepted under) onto every card it queues,
 * and it queues nothing the decode did not return — and the decode
 * (`buildNativeRequesterAnnouncementDecode`) throws, degrading that source for the poll, unless it
 * has independently re-derived a canonical, finalized `TaskCreated` from chain for that
 * announcement.
 * So a card carrying this provenance is by construction a card whose `TaskCreated` this operator
 * proved canonical and finalized; a card without it never went through that gate and must still be
 * refused.
 *
 * The alternative — a literal `true`, which `native-solver-production.ts` passes — is safe there
 * only because that host has exactly one card source. The fleet daemon's claim runtime is reachable
 * from a composition that also carries a legacy archive adapter, so "the decode ran" is checked
 * rather than assumed.
 */
export function nativeDiscoveryDecodeProvedCanonical(card: AnnouncedSubmissionCard): boolean {
  return card.discovery !== undefined;
}
