/**
 * The ONE fleet daemon's public record-discovery SERVING plane (issue #2519, umbrella #2461,
 * DR-2026-08-05).
 *
 * The one-swap collapse moved the SOLVER's serving plane into the fleet daemon and left the
 * REQUESTER's and the EVALUATOR's behind: `main.ts` mounted exactly one handler
 * (`composition.nativeSolutionPublisher.handler`), so a fleet operator served its solver archive
 * and nothing else. Every native boot then failed at `buildNativeDiscoverySources`, which resolves
 * each configured source's `.well-known` introduction — including the operator's OWN requester
 * source, which nothing served. Two operators could not boot; the DR-2026-08-05 G-loop gate could
 * not run.
 *
 * This module is the missing wiring, and it is deliberately ONE listener rather than one per role.
 *
 * ## Why one listener, not a port per role
 *
 * Every announcement this operator publishes stamps its record locations against the ONE
 * `config.publicBaseUrl` — the requester's `location()` (`native-requester/requester.ts`), the
 * signed source's `${baseUrl}${recordPath(...)}` (`native-signed-source.ts`), and the
 * `exactLocations` map. A consumer resolves those bytes by fetching that exact URL
 * (`NativePublicRecordTransport.byLocation` -> `fetch`). So an operator's requester, solver and
 * evaluator records must ALL be reachable under one origin. Serving each role on its own port
 * would publish announcements whose locations point at a listener that does not hold the record —
 * a broken archive, not a narrower one. Per-role base URLs would be the alternative, and that is a
 * config-surface and protocol-location change, not the wiring fix this issue asks for.
 *
 * So: no new config keys. `publicArchive.{enabled,host,port}` keeps its exact shape and meaning,
 * and `publicBaseUrl` keeps being the single origin peers resolve everything under; what changes
 * is that the listener now carries every source this operator owns instead of just the solver's.
 *
 * ## Exposure scoping is unchanged
 *
 * Each composed handler is still a `createArchiveHttpHandler` over its own blob store, whose path
 * grammar (`parseArchivePath`) admits only the five protocol shapes and 404s everything else. The
 * composite adds no route: it dispatches to the handlers and answers 404 when none of them owns
 * the path. Source names are distinct per role (`requester`, `solver-records`, `evaluator-records`)
 * and record paths are content-addressed, so "first non-404 wins" is unambiguous.
 *
 * ## The cold-start deadlock (#2519 F2)
 *
 * The well-known document is written only from a PUBLISH path — `requester.ts`'s
 * `writeDiscoveryIndex`, and `native-signed-source.ts`'s `syncWellKnown`, which returns early
 * while the source has no committed state. So a source that has never published serves no
 * introduction; a consumer's boot-time `buildNativeDiscoverySources` throws; and publishing needs
 * a booted daemon. That is unbreakable for an operator consuming its own source, and it makes a
 * peer's first boot depend on the other operator having already published.
 *
 * The fix lives here, on the SERVING side, because that is where the gap is and because it then
 * covers all three roles at once instead of patching two publish paths: when a source's own
 * handler has no well-known document yet, the composite synthesizes that source's introduction
 * entry from its identity — `headPath(name)` and the genesis archive page, exactly the values the
 * publish path writes for its first entry.
 *
 * This weakens NO verification, on either side of the wire:
 *
 *  - the well-known document is unsigned INTRODUCTION metadata by design ("introduction is never
 *    trust", `record-discovery-serve/well-known.ts`); acceptance is `verifySourceChain` over the
 *    signed head and entries, which this module never touches;
 *  - a consumer that reaches a synthesized introduction still finds the head and the archive page
 *    absent, so it refuses that source at poll — a peer that has published nothing stays refused,
 *    and a peer serving an unsigned or wrongly-signed chain stays refused. Nothing here is
 *    self/peer-conditional, so there is no "tolerate my own source" hole to widen.
 *
 * What it buys is exactly the boot property the gate needs: an operator's archive introduces every
 * source it owns from the moment it is mounted, so both operators boot before either has posted.
 */
import {
  MEDIA_WELL_KNOWN,
  RECORD_DISCOVERY_VERSION,
  WELL_KNOWN_PATH,
  archivePagePath,
  formatSequence,
  headPath,
  splitOrigin,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  parseWellKnownDocument,
  type WellKnownSourceEntry,
} from '@jinn-network/record-discovery-serve';
import type { ArchiveHttpHandler } from '@jinn-network/record-discovery-transport-http';

export class NativeFleetServingPlaneError extends Error {
  override readonly name = 'NativeFleetServingPlaneError';
}

/** One archive this operator owns: its source identity, and the handler that serves its store. */
export interface FleetServedSource {
  readonly source: SourceIdentity;
  readonly handler: ArchiveHttpHandler;
}

/**
 * Adapts a signed publisher (solver / evaluator) to a served source.
 *
 * `sourceId` is the publisher's own `formatOrigin(agent, name)`, so splitting it is how the mount
 * site names the served identity WITHOUT restating `solver-records` / `evaluator-records` as a
 * literal it could get wrong.
 */
export function fleetServedSource(publisher: {
  readonly sourceId: string;
  readonly handler: ArchiveHttpHandler;
}): FleetServedSource {
  return { source: splitOrigin(publisher.sourceId), handler: publisher.handler };
}

/** The genesis archive page every source's first publish writes. */
const GENESIS_PAGE = formatSequence(1n);

/** The introduction a source that has published nothing yet still owes a consumer. */
function coldStartEntry(source: SourceIdentity): WellKnownSourceEntry {
  return {
    agent: source.agent,
    name: source.name,
    headPath: headPath(source.name),
    archiveRoot: archivePagePath(source.name, GENESIS_PAGE),
  };
}

async function introduce(served: FleetServedSource, requestUrl: string): Promise<readonly WellKnownSourceEntry[]> {
  const response = await served.handler(
    new Request(new URL(WELL_KNOWN_PATH, requestUrl), { method: 'GET' }),
  );
  if (!response.ok) return [coldStartEntry(served.source)];
  const document = parseWellKnownDocument(JSON.parse(await response.text()));
  // A handler serves exactly one store, so its document names exactly its own source(s). Keeping
  // the served entry verbatim (rather than re-deriving it) preserves the CURRENT archive page and
  // any additive fields the writer advertised.
  return document.sources.length === 0 ? [coldStartEntry(served.source)] : document.sources;
}

/**
 * Composes this operator's archives into the one handler `startPublicArchiveServer` mounts.
 *
 * `/.well-known/jinn-record-discovery` is merged across every served source (with a cold-start
 * introduction for any source that has not published yet); every other admitted path is offered to
 * each handler in turn and the first non-404 answer wins.
 */
export function buildFleetArchiveHandler(
  served: readonly FleetServedSource[],
): ArchiveHttpHandler {
  if (served.length === 0) {
    throw new NativeFleetServingPlaneError(
      'the fleet archive listener requires at least one served source; refusing to bind a listener that serves nothing',
    );
  }
  const seen = new Set<string>();
  for (const { source } of served) {
    const key = `${source.agent}\0${source.name}`;
    if (seen.has(key)) {
      throw new NativeFleetServingPlaneError(
        `duplicate served source identity ${source.agent}/${source.name}; two archives cannot own one source`,
      );
    }
    seen.add(key);
  }
  return async (request) => {
    if (new URL(request.url).pathname === WELL_KNOWN_PATH) {
      const sources: WellKnownSourceEntry[] = [];
      for (const entry of served) {
        // eslint-disable-next-line no-await-in-loop -- at most three local archives per operator.
        sources.push(...await introduce(entry, request.url));
      }
      return new Response(`${JSON.stringify({ protocol: RECORD_DISCOVERY_VERSION, sources })}\n`, {
        status: 200,
        headers: { 'content-type': MEDIA_WELL_KNOWN },
      });
    }
    for (const entry of served) {
      // eslint-disable-next-line no-await-in-loop -- disjoint source names; the owner answers first.
      const response = await entry.handler(request);
      if (response.status !== 404) return response;
    }
    return new Response(null, { status: 404 });
  };
}
