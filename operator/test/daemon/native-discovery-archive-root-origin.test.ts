/**
 * #3411 — a peer's `.well-known` `archiveRoot` is peer-controlled input, and `new URL(candidate,
 * base)` DISCARDS the base whenever the candidate is absolute. Before this guard a peer could
 * introduce `archiveRoot: "http://127.0.0.1:8545/"` and the daemon fetched it: the HTTP transport
 * passes any absolute `http(s)://` target through verbatim, and the fleet daemon builds that
 * transport with an empty base, so nothing downstream ever compared the destination to the
 * serving root the operator actually configured.
 *
 * The property under test is containment, not an address deny-list: the resolved archive root must
 * live under the configured serving root. That is already what every LATER page fetch assumes —
 * `discovery/client`'s `pageUrl` rebuilds each subsequent page as `servingRoot + archivePagePath`
 * — so only page one could ever escape, and a loopback serving root stays perfectly usable for
 * local deployments.
 */
import { describe, expect, it } from 'vitest';
import {
  RECORD_DISCOVERY_VERSION,
  WELL_KNOWN_PATH,
  archivePagePath,
  sealJson,
} from '@jinn-network/record-discovery-protocol';
import type { Transport, TransportResponse } from '@jinn-network/record-discovery-client';
import type { BindingResolver, DsseChainVerifier, PolicyCheckInput, WitnessVerifier } from '@jinn-network/trust-core';
import { Store } from '../../src/store/store.js';
import {
  NativeDiscoverySourceResolutionError,
  buildNativeDiscoverySources,
} from '../../src/daemon/native-discovery-trust.js';
import type { NativeTrustAuthority } from '../../src/daemon/native-trust-catalog.js';

const AGENT = 'did:key:zNativeRequester';
const SOURCE_NAME = 'requester';
const ROOT = 'https://peer.example';

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

/** A transport that serves one `.well-known` document and records every URL it is asked for. */
function introducing(archiveRoot: string): { transport: Transport; fetched: string[] } {
  const fetched: string[] = [];
  const { bytes } = sealJson({
    protocol: RECORD_DISCOVERY_VERSION,
    sources: [{
      agent: AGENT,
      name: SOURCE_NAME,
      headPath: `/sources/${SOURCE_NAME}/head.json`,
      archiveRoot,
    }],
  });
  const transport: Transport = {
    async fetch(url: string): Promise<TransportResponse> {
      fetched.push(url);
      if (url === `${ROOT}${WELL_KNOWN_PATH}`) {
        return { status: 200, contentType: 'application/json', declaredLength: bytes.length, bytes };
      }
      throw new Error(`the guard must refuse before any fetch of ${url}`);
    },
  };
  return { transport, fetched };
}

function sourcesFor(archiveRoot: string) {
  const { transport, fetched } = introducing(archiveRoot);
  const sources = buildNativeDiscoverySources({
    configured: [{ role: 'requester', agent: AGENT, name: SOURCE_NAME, baseUrl: ROOT }],
    store: new Store(':memory:'),
    transport,
    trust: fakeTrust(),
  });
  return { source: sources[0]!, fetched };
}

describe('#3411 — a peer-introduced archiveRoot may not leave the configured serving root', () => {
  it('resolves an ordinary relative archive root under the serving root', async () => {
    const page = archivePagePath(SOURCE_NAME, '0001');
    const { source } = sourcesFor(page);
    await expect(source.resolveEndpoint()).resolves.toMatchObject({
      servingRoot: ROOT,
      archiveRootUrl: `${ROOT}${page}`,
    });
  });

  const hostile = [
    ['an absolute loopback URL', 'http://127.0.0.1:8545/'],
    ['a cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['a private-space host', 'http://10.0.0.5:8080/archive/0001.json'],
    ['another public origin', 'https://evil.example/collect'],
    ['a protocol-relative locator', '//evil.example/collect'],
    ['a scheme downgrade on the same host', 'http://peer.example/entries/0001.json'],
    ['a port change on the same host', 'https://peer.example:8443/entries/0001.json'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['embedded credentials', 'https://user:pass@peer.example/entries/0001.json'],
  ] as const;

  for (const [label, archiveRoot] of hostile) {
    it(`refuses ${label} without fetching it`, async () => {
      const { source, fetched } = sourcesFor(archiveRoot);
      await expect(source.resolveEndpoint()).rejects.toThrow(NativeDiscoverySourceResolutionError);
      // Only the introduction itself may have been fetched; the hostile destination never is.
      expect(fetched).toEqual([`${ROOT}${WELL_KNOWN_PATH}`]);
    });
  }

  it('classifies the refusal as a statement about identity, not as an unreachable source', async () => {
    const { source } = sourcesFor('http://127.0.0.1:8545/');
    await expect(source.resolveEndpoint()).rejects.toMatchObject({ kind: 'unintroduced' });
  });

  it('keeps a loopback serving root usable, so local deployments are unaffected', async () => {
    const page = archivePagePath(SOURCE_NAME, '0001');
    const { bytes } = sealJson({
      protocol: RECORD_DISCOVERY_VERSION,
      sources: [{ agent: AGENT, name: SOURCE_NAME, headPath: `/sources/${SOURCE_NAME}/head.json`, archiveRoot: page }],
    });
    const local = 'http://127.0.0.1:7331';
    const transport: Transport = {
      async fetch(url: string): Promise<TransportResponse> {
        if (url === `${local}${WELL_KNOWN_PATH}`) {
          return { status: 200, contentType: 'application/json', declaredLength: bytes.length, bytes };
        }
        throw new Error(`unexpected fetch of ${url}`);
      },
    };
    const [source] = buildNativeDiscoverySources({
      configured: [{ role: 'requester', agent: AGENT, name: SOURCE_NAME, baseUrl: local }],
      store: new Store(':memory:'),
      transport,
      trust: fakeTrust(),
    });
    await expect(source!.resolveEndpoint()).resolves.toMatchObject({ archiveRootUrl: `${local}${page}` });
  });
});
