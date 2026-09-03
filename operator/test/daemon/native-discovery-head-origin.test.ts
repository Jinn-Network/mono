/**
 * #3530 — the composed `verifyHead` must bind the head's origin to the source being followed.
 *
 * `sameHead` compared the whole signature envelope, so a head's `origin` was bound implicitly by
 * byte equality. `reSignedIdleHead` (`native-discovery.ts`) admits a NEW envelope at the same
 * `sequence`/`entry` and compares neither origin nor bytes, so the binding now rests entirely on
 * the `verifyHead` the host injects — stated as a requirement on the `NativeDiscoverySource` port,
 * which is the right place for it, but which nothing in the operator tree checked. Every
 * `verifyHead` in `native-discovery.test.ts` is a stub, so that suite would stay green against a
 * wiring that dropped the check; the only thing exercising the real procedure lived in another
 * package, testing the procedure rather than this package's wiring of it.
 *
 * This composes the one production construction site — `buildNativeDiscoverySources` — and asks
 * its `verifyHead` about a head that names another agent. The discriminator is exact: the fixture
 * trust catalog resolves no keys, so a head whose origin DOES match gets as far as signature
 * resolution and answers `unauthorized-signer`. Delete the origin comparison from
 * `verifySourceHead` and the foreign-origin cases answer `unauthorized-signer` too, reddening
 * every one of them.
 */
import { describe, expect, it } from 'vitest';
import {
  RECORD_DISCOVERY_VERSION,
  sealJson,
  type SourceHead,
} from '@jinn-network/record-discovery-protocol';
import type { Transport } from '@jinn-network/record-discovery-client';
import type { BindingResolver, DsseChainVerifier, PolicyCheckInput, WitnessVerifier } from '@jinn-network/trust-core';
import { Store } from '../../src/store/store.js';
import { buildNativeDiscoverySources } from '../../src/daemon/native-discovery-trust.js';
import type { NativeTrustAuthority } from '../../src/daemon/native-trust-catalog.js';

const AGENT = 'did:key:zNativeRequester';
const OTHER_AGENT = 'did:key:zSomeOtherAgent';
const SOURCE_NAME = 'requester';
const ROOT = 'https://requester.example';
const DIGEST = `sha256:${'a'.repeat(64)}` as const;

function fakeTrust(): NativeTrustAuthority {
  const bindingResolver: BindingResolver = { async resolveBinding() { return null; } };
  const witnessVerifier: WitnessVerifier = {
    async verify1271Witness() { return { verified: false, reason: 'fixture never verifies' }; },
  };
  const dsseVerifier: DsseChainVerifier = () => ({ validSignerKeyids: [] });
  return {
    bindingResolver,
    dsseVerifier,
    witnessVerifier,
    conflicts: [],
    newestPolicyVersion: 1,
    rawSignatureVerifier: { async verify() { return false; } },
    async assertFresh() { /* fixture */ },
    candidateKeys() { return []; },
    policy(purpose) { return { accepted: [`accepted-for-${purpose}`], requiredStrength: 'strong' } as PolicyCheckInput; },
    async verifyRoleBinding() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    async verifyOnchainAuthority() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    resolverFor() { return bindingResolver; },
  };
}

/** Head revalidation performs no fetch, so any request from this path is itself a failure. */
const noTransport: Transport = {
  async fetch(url: string) { throw new Error(`head revalidation must not fetch ${url}`); },
};

function headWithOrigin(origin: string): SourceHead {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    origin,
    sequence: '0000000000000001',
    entry: DIGEST,
    issuedAt: '2026-08-02T01:00:00.000Z',
    refreshBy: '2026-08-03T01:00:00.000Z',
  };
}

/** A well-formed head envelope over exactly the bytes the procedure will re-seal and compare. */
function envelopeFor(head: SourceHead) {
  return {
    payloadType: 'application/vnd.jinn.record-discovery.head.v1+json',
    payload: Buffer.from(sealJson(head).bytes).toString('base64'),
    signatures: [{ keyid: 'requester-key', sig: Buffer.from('signature').toString('base64') }],
  };
}

function productionSource() {
  const [source] = buildNativeDiscoverySources({
    configured: [{ role: 'requester', agent: AGENT, name: SOURCE_NAME, baseUrl: ROOT }],
    store: new Store(':memory:'),
    transport: noTransport,
    trust: fakeTrust(),
    now: () => new Date('2026-08-02T02:00:00.000Z'),
  });
  return source!;
}

async function revalidate(origin: string) {
  const source = productionSource();
  const head = headWithOrigin(origin);
  return source.verifyHead({
    source: { agent: AGENT, name: SOURCE_NAME },
    head,
    signature: envelopeFor(head),
  });
}

describe('#3530 — the wired verifyHead binds the head origin to the followed source', () => {
  it.each([
    ['another agent, same source name', `${OTHER_AGENT}/${SOURCE_NAME}`],
    ['this agent, another source name', `${AGENT}/solver`],
    ['another agent and another source name', `${OTHER_AGENT}/solver`],
    ['an origin that is not a source origin at all', 'not-an-origin'],
  ])('refuses a head whose origin names %s', async (_label, origin) => {
    await expect(revalidate(origin)).resolves.toEqual({ status: 'head-origin-mismatch' });
  });

  it('lets a head whose origin DOES name this source through to signature resolution', async () => {
    // Not an acceptance: the fixture catalog resolves no key, so the procedure gets as far as
    // `unauthorized-signer`. That is the point — it is how far the refusals above did NOT get,
    // so the verdict they assert can only have come from the origin comparison.
    await expect(revalidate(`${AGENT}/${SOURCE_NAME}`)).resolves.toEqual({ status: 'unauthorized-signer' });
  });
});
