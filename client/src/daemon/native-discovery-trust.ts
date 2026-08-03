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
import { parseWellKnownDocument } from '@jinn-network/record-discovery-serve';
import type { Store } from '../store/store.js';
import type { NativeDiscoverySource } from './native-discovery.js';
import type { NativeOperatorConfig } from './native-product-config.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';

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

/** Resolves public source endpoints and installs full policy-scoped signed-chain verification. */
export async function buildNativeDiscoverySources(input: {
  readonly configured: readonly NativeOperatorConfig['sources'][number][];
  readonly store: Store;
  readonly transport: Transport;
  readonly trust: NativeTrustAuthority;
  readonly now?: () => Date;
}): Promise<readonly NativeDiscoverySource[]> {
  const now = input.now ?? (() => new Date());
  const result: NativeDiscoverySource[] = [];
  for (const configured of input.configured) {
    const base = configured.baseUrl.replace(/\/+$/u, '');
    // eslint-disable-next-line no-await-in-loop -- every configured source owns a distinct signed introduction.
    const wellKnownResponse = await input.transport.fetch(`${base}${WELL_KNOWN_PATH}`);
    const wellKnown = parseWellKnownDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(wellKnownResponse.bytes)));
    const candidates = wellKnown.sources.filter(({ agent, name }) => agent === configured.agent && name === configured.name);
    if (candidates.length !== 1) throw new Error(`public source ${configured.agent}/${configured.name} is not uniquely introduced`);
    const advertised = candidates[0]!;
    const resolver = input.trust.resolverFor({ family: 'observations', purpose: rolePurpose(configured.role) });
    const trust = createTrustAdapter({
      bindingResolver: resolver,
      keyCatalog: {
        candidateKeys: async (agent) => [...input.trust.candidateKeys(agent)],
      },
      verifier: input.trust.rawSignatureVerifier,
    });
    const source: NativeDiscoverySource = {
      endpoint: {
        agent: configured.agent,
        name: configured.name,
        servingRoot: base,
        archiveRootUrl: absolute(base, advertised.archiveRoot),
      },
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
