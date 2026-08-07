import {
  createTrustAdapter,
  type Transport,
} from '@jinn-network/record-discovery-client';
import {
  MEDIA_HEAD,
  WELL_KNOWN_PATH,
  dssePreAuthEncoding,
  parseWireDsseEnvelope,
  sealJson,
  verifySourceChain,
  type HighWaterMark,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import type { SourceEndpoint } from '@jinn-network/record-discovery-client';
import { parseWellKnownDocument } from '@jinn-network/record-discovery-serve';
import type { Store } from '../store/store.js';
import type { NativeDiscoverySource } from './native-discovery.js';
import type { NativeOperatorConfig } from './native-product-config.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';

/**
 * A configured source whose `.well-known` introduction could not be resolved.
 *
 * Issue #2521 F4: the transport throws a bare `TypeError: fetch failed` for a connection refusal,
 * with no URL in it. That is the single most likely native-boot/poll failure and it cost the live
 * DR-2026-08-05 gate both of its rounds' first diagnosis. Naming agent/name/baseUrl is the whole
 * point of this class — the poll-time refusal has to be legible without `JINN_DEBUG=1`.
 */
export class NativeDiscoverySourceResolutionError extends Error {
  override readonly name = 'NativeDiscoverySourceResolutionError';

  constructor(
    readonly agent: string,
    readonly sourceName: string,
    readonly baseUrl: string,
    detail: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `native discovery source ${agent}/${sourceName} at ${baseUrl} could not be resolved: ${detail}`,
      options,
    );
  }
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function sourceCheckpoint(store: Store, source: SourceIdentity): HighWaterMark | undefined {
  const row = store.db.prepare(
    `SELECT sequence, entry_digest, issued_at FROM native_discovery_source_checkpoints
      WHERE source_agent = ? AND source_name = ?`,
  ).get(source.agent, source.name) as {
    sequence: string;
    entry_digest: `sha256:${string}`;
    issued_at: string;
  } | undefined;
  return row === undefined ? undefined : {
    sequence: row.sequence,
    entry: row.entry_digest,
    issuedAt: row.issued_at,
  };
}

function rolePurpose(role: NativeOperatorConfig['sources'][number]['role']): string {
  switch (role) {
    case 'requester': return 'native:requester-discovery';
    case 'solver': return 'native:solver-discovery';
    case 'evaluator': return 'native:evaluator-discovery';
  }
}

function absolute(base: string, path: string): string {
  return new URL(path, `${base.replace(/\/+$/u, '')}/`).toString();
}

/**
 * Installs full policy-scoped signed-chain verification over each configured source, and DEFERS
 * that source's introduction resolution to its first poll.
 *
 * ## Why resolution is lazy (issue #2521, umbrella #2461, DR-2026-08-05)
 *
 * This used to fetch every configured source's `.well-known` introduction here, at construction.
 * That made a native fleet operator unbootable at any configuration, because construction sits
 * inside a genuine dependency cycle rather than merely early in a statement list:
 *
 *  - `main.ts` builds the discovery consumer (`buildFleetNativeRuntime`) ~250 statements BEFORE it
 *    binds the archive listener (`startPublicArchiveServer`), and it cannot do otherwise: the
 *    listener serves `fleetRequesterDiscovery`, `composition.nativeSolutionPublisher` and
 *    `fleetEvaluator`, all of which are built FROM the runtime the consumer belongs to. An
 *    operator's own requester source lives behind that listener, so it was fetching itself before
 *    binding itself (#2521 F1);
 *  - and the evaluator leg demands exactly one requester AND one solver source
 *    (`native-evaluator-opportunity-source.ts`), which in the gate's two-operator topology are
 *    owned by different operators. Eager resolution therefore made A's boot wait on B's listener
 *    and B's boot wait on A's: no start order existed (#2521 F2).
 *
 * Binding the listener before composition and registering handlers as they are built would fix the
 * FIRST of those and not the second — a peer's archive is not this process's to bind. Deferring
 * resolution to first poll dissolves both, so that is what this does.
 *
 * ## The recorded trade-off
 *
 * Eager resolution failed the boot fast on a misconfigured source. Lazily, a misconfigured source
 * surfaces at its first poll instead: `jinn run` comes up, and the refusal arrives one poll
 * interval later. Given that two operators must be able to boot into each other with neither
 * already serving, that trade is forced. It is paid for by making the poll-time refusal loud —
 * `NativeDiscoverySourceResolutionError` names agent, source name and baseUrl (#2521 F4), where
 * the eager path threw a bare `fetch failed`.
 *
 * ## Verification strength is UNCHANGED
 *
 * Every check this function ever performed still runs, in the same order, over the same bytes;
 * only its clock position moved. Uniqueness of the introduction is still enforced before an
 * endpoint exists; `verifySourceChain` and the head/entry chain still gate every accepted card at
 * poll; the trust adapter is still constructed from the same policy-scoped resolver. Nothing here
 * is self- or peer-conditional, so there is no "tolerate my own source" hole: a source that is
 * down, serves an unsigned or wrongly-signed chain, or introduces a different identity is refused
 * exactly as before, and the consumer writes no checkpoint and queues no card for that poll.
 */
export function buildNativeDiscoverySources(input: {
  readonly configured: readonly NativeOperatorConfig['sources'][number][];
  readonly store: Store;
  readonly transport: Transport;
  readonly trust: NativeTrustAuthority;
  readonly now?: () => Date;
}): readonly NativeDiscoverySource[] {
  const now = input.now ?? (() => new Date());
  const result: NativeDiscoverySource[] = [];
  for (const configured of input.configured) {
    const base = configured.baseUrl.replace(/\/+$/u, '');
    // Resolved on first poll and memoized on SUCCESS only — a peer that is down now must be
    // reachable at the next poll rather than permanently written off. Memoizing the success keeps
    // the process's introduction-read count at exactly what the eager path had (one per source per
    // process), so the pre-existing staleness of a pinned `archiveRootUrl` is neither introduced
    // nor widened here.
    let resolved: SourceEndpoint | undefined;
    const resolveEndpoint = async (): Promise<SourceEndpoint> => {
      if (resolved !== undefined) return resolved;
      let wellKnownResponse;
      try {
        wellKnownResponse = await input.transport.fetch(`${base}${WELL_KNOWN_PATH}`);
      } catch (cause) {
        throw new NativeDiscoverySourceResolutionError(
          configured.agent,
          configured.name,
          base,
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        );
      }
      const wellKnown = parseWellKnownDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wellKnownResponse.bytes)));
      const candidates = wellKnown.sources.filter(({ agent, name }) => agent === configured.agent && name === configured.name);
      if (candidates.length !== 1) {
        throw new NativeDiscoverySourceResolutionError(
          configured.agent,
          configured.name,
          base,
          `public source ${configured.agent}/${configured.name} is not uniquely introduced`,
        );
      }
      resolved = {
        agent: configured.agent,
        name: configured.name,
        servingRoot: base,
        archiveRootUrl: absolute(base, candidates[0]!.archiveRoot),
      };
      return resolved;
    };
    const resolver = input.trust.resolverFor({ family: 'observations', purpose: rolePurpose(configured.role) });
    const trust = createTrustAdapter({
      bindingResolver: resolver,
      keyCatalog: {
        candidateKeys: async (agent) => [...input.trust.candidateKeys(agent)],
      },
      verifier: input.trust.rawSignatureVerifier,
    });
    const source: NativeDiscoverySource = {
      identity: { agent: configured.agent, name: configured.name },
      resolveEndpoint,
      async verify(candidate) {
        return verifySourceChain({
          head: candidate.head,
          headSignature: candidate.headSignature,
          entries: candidate.entries,
          ports: {
            keys: trust.keys,
            sigs: trust.sigs,
            fresh: trust.fresh,
            now: now(),
            firstAdoption: candidate.firstAdoption,
            hwm: {
              async get() { return sourceCheckpoint(input.store, candidate.source); },
              async put() { /* consumer commits the accepted HWM with its queued cards */ },
            },
          },
        });
      },
      async verifyHead(candidate) {
        try {
          const parsed = parseWireDsseEnvelope(candidate.signature);
          if (parsed.envelope.payloadType !== MEDIA_HEAD || !same(parsed.payloadBytes, sealJson(candidate.head).bytes)) {
            return { status: 'head-payload-mismatch' };
          }
          const keys = await trust.keys.resolve(candidate.source.agent, now());
          const pae = dssePreAuthEncoding(MEDIA_HEAD, parsed.payloadBytes);
          for (const signature of parsed.signatures) {
            const key = keys.find(({ keyid }) => keyid === signature.keyid);
            if (key !== undefined && await trust.sigs.verify(pae, signature.signatureBytes, key)) {
              return { status: trust.fresh.isFresh(candidate.head.refreshBy, now()) ? 'ok' : 'stale' };
            }
          }
          return { status: 'unauthorized-signer' };
        } catch {
          return { status: 'invalid-head-envelope' };
        }
      },
    };
    result.push(source);
  }
  return result;
}
