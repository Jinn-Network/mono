/**
 * #3470 — the production `verifyHead` from `buildNativeDiscoverySources`, driven with genuinely
 * ed25519-signed heads.
 *
 * The trust authority below resolves two did:key bindings for one agent: NEW (current) and OLD
 * (revoked before `now`), and verifies signatures with `crypto.verify`. The composed
 * `verifySourceHead` + `createTrustAdapter` must then tell apart: a current-signer head (`ok`),
 * the same signer past `refreshBy` (`stale`), a rotated-out signer (`unauthorized-signer`), and
 * OLD's signature presented under NEW's keyid (`unauthorized-signer`, which only a real signature
 * check produces).
 *
 * The second block plugs that `verifyHead` into `createNativeDiscoveryConsumer` and restarts it on
 * the same store, so the unchanged head reaches revalidation; a throwing key resolve must leave
 * `sync()` as the same error, not as an `invalid-head-envelope` refusal.
 */
import { generateKeyPairSync, sign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_HEAD,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  dssePreAuthEncoding,
  headPath,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
} from '@jinn-network/record-discovery-protocol';
import type { Transport } from '@jinn-network/record-discovery-client';
import {
  TRUST_KEY_BINDING_FORMAT,
  TRUST_REVOCATION_FORMAT,
  type BindingResolver,
  type DsseChainVerifier,
  type PolicyCheckInput,
  type ResolvedBinding,
  type ResolvedRevocation,
  type WitnessVerifier,
} from '@jinn-network/trust-core';
import { Store } from '../../src/store/store.js';
import { buildNativeDiscoverySources } from '../../src/daemon/native-discovery-trust.js';
import {
  createNativeDiscoveryConsumer,
  type NativeDiscoverySource,
} from '../../src/daemon/native-discovery.js';
import type { NativeTrustAuthority } from '../../src/daemon/native-trust-catalog.js';
import type { AnnouncedSubmissionCard } from '../../src/daemon/native-submission-facts.js';

const AGENT = 'did:key:zNativeRequester';
const SOURCE_NAME = 'requester';
const ROOT = 'https://requester.example';
const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const NOW = new Date('2026-08-02T02:00:00.000Z');
const BOUND_FROM = '2026-08-01T00:00:00.000Z';
const OLD_REVOKED_AT = '2026-08-02T00:30:00.000Z';
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

const OLD = generateKeyPairSync('ed25519');
const NEW = generateKeyPairSync('ed25519');

function didKeyOf(publicKey: KeyObject): string {
  const der = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  return `did:key:z${bs58.encode(Buffer.concat([Buffer.from([0xed, 0x01]), der.subarray(SPKI.length)]))}`;
}

const OLD_KEY = didKeyOf(OLD.publicKey);
const NEW_KEY = didKeyOf(NEW.publicKey);
const PUBLIC_KEYS = new Map([[OLD_KEY, OLD.publicKey], [NEW_KEY, NEW.publicKey]]);

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function signHead(head: SourceHead, signingKey: KeyObject, keyid: string) {
  const bytes = sealJson(head).bytes;
  return {
    payloadType: MEDIA_HEAD,
    payload: b64(bytes),
    signatures: [{ keyid, sig: b64(sign(null, dssePreAuthEncoding(MEDIA_HEAD, bytes), signingKey)) }],
  };
}

function headAt(issuedAt: string, refreshBy: string): SourceHead {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: `${AGENT}/${SOURCE_NAME}`,
    sequence: '0000000000000001',
    entry: DIGEST,
    issuedAt,
    refreshBy,
  };
}

function oldKeyRevocation(): ResolvedRevocation {
  return {
    revocation: {
      protocol: TRUST_REVOCATION_FORMAT,
      target: `sha256:${'c'.repeat(64)}`,
      revokedBy: OLD_KEY,
      anchors: [],
      effectiveFrom: OLD_REVOKED_AT,
    },
    envelopeBytes: new TextEncoder().encode('fixture revocation'),
    effectiveTime: OLD_REVOKED_AT,
  };
}

function bindingFor(didKey: string, revocations: readonly ResolvedRevocation[]): ResolvedBinding {
  return {
    binding: {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: AGENT,
      key: { keyid: didKey, didKey, publicKey: didKey, algorithm: 'ed25519' },
      voucher: { kind: 'account', did: 'did:pkh:eip155:1:0x5A5A5a5A5a5A5A5a5A5a5a5a5A5a5A5A5a5A5A5a', contractAccount: false },
      relationship: 'controls',
      scope: [DISCOVERY_SIGNING_SCOPE],
      validFrom: BOUND_FROM,
      ceremony: { type: 'oidc-machine', digest: `sha256:${'b'.repeat(64)}` },
      strength: 'strong',
      anchors: [],
    },
    envelopeBytes: new TextEncoder().encode('fixture binding'),
    bindingDigest: `sha256:${'d'.repeat(64)}`,
    effectiveStart: BOUND_FROM,
    isGenesis: true,
    revocations,
  };
}

const currentAndRevokedBindings: BindingResolver['resolveBinding'] = async (query) => {
  if (query.key === NEW_KEY) return bindingFor(NEW_KEY, []);
  if (query.key === OLD_KEY) return bindingFor(OLD_KEY, [oldKeyRevocation()]);
  return null;
};

/** A trust authority that resolves real bindings for OLD and NEW and checks real signatures. */
function signingTrustAuthority(
  resolveBinding: BindingResolver['resolveBinding'] = currentAndRevokedBindings,
): NativeTrustAuthority {
  const bindingResolver: BindingResolver = { resolveBinding };
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
    rawSignatureVerifier: {
      async verify(pae, sig, key) {
        const publicKey = PUBLIC_KEYS.get(key.keyid);
        return publicKey !== undefined && cryptoVerify(null, pae, publicKey, sig);
      },
    },
    async assertFresh() { /* fixture */ },
    candidateKeys(agent) {
      return agent === AGENT
        ? [{ keyid: OLD_KEY, probeAt: BOUND_FROM }, { keyid: NEW_KEY, probeAt: BOUND_FROM }]
        : [];
    },
    policy(purpose) { return { accepted: [`accepted-for-${purpose}`], requiredStrength: 'strong' } as PolicyCheckInput; },
    async verifyRoleBinding() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    async verifyOnchainAuthority() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    resolverFor() { return bindingResolver; },
  };
}

/** Head revalidation performs no fetch, so any request from the production source is a failure. */
const noTransport: Transport = {
  async fetch(url: string) { throw new Error(`head revalidation must not fetch ${url}`); },
};

function productionSource(trust: NativeTrustAuthority): NativeDiscoverySource {
  const [source] = buildNativeDiscoverySources({
    configured: [{ role: 'requester', agent: AGENT, name: SOURCE_NAME, baseUrl: ROOT }],
    store: new Store(':memory:'),
    transport: noTransport,
    trust,
    now: () => NOW,
  });
  return source!;
}

describe('#3470 — production verifyHead over genuinely signed heads', () => {
  const current = headAt('2026-08-02T01:00:00.000Z', '2026-08-03T01:00:00.000Z');
  const lapsed = headAt('2026-08-01T01:00:00.000Z', '2026-08-02T00:00:00.000Z');

  it.each([
    ['a current signer revalidates', current, signHead(current, NEW.privateKey, NEW_KEY), 'ok'],
    ['a current signer past refreshBy is stale', lapsed, signHead(lapsed, NEW.privateKey, NEW_KEY), 'stale'],
    ['a rotated-out signer is refused', current, signHead(current, OLD.privateKey, OLD_KEY), 'unauthorized-signer'],
    ['a signature that does not verify under the named key is refused', current, signHead(current, OLD.privateKey, NEW_KEY), 'unauthorized-signer'],
  ] as const)('%s', async (_label, head, signature, status) => {
    const source = productionSource(signingTrustAuthority());
    await expect(source.verifyHead({ source: { agent: AGENT, name: SOURCE_NAME }, head, signature }))
      .resolves.toEqual({ status });
  });
});

describe('#3470 — a throwing key resolve leaves pollSource untranslated', () => {
  const genesis: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: SOURCE_NAME },
    sequence: '0000000000000001',
    previous: null,
    timestamp: '2026-08-02T00:00:01.000Z',
    announcements: [{
      announcementId: 'announcement-1',
      action: 'available',
      record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: DIGEST },
      facts: { taskDigest: DIGEST, taskProfileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0' },
    }],
  };
  const head: SourceHead = {
    ...headAt('2026-08-02T01:00:00.000Z', '2026-08-03T01:00:00.000Z'),
    entry: sealJson(genesis).digest,
  };
  const pageUrl = `${ROOT}${archivePagePath(SOURCE_NAME, '0000000000000001')}`;
  const routes = new Map<string, unknown>([
    [pageUrl, {
      protocol: RECORD_DISCOVERY_VERSION,
      source: SOURCE_NAME,
      page: '0000000000000001',
      prevArchive: null,
      // Entry signatures are never checked here: the chain `verify` below is a drain-and-accept stub.
      entries: [{
        entry: genesis,
        signature: {
          payloadType: 'application/vnd.jinn.record-discovery.entry.v1+json',
          payload: b64(new TextEncoder().encode('signed-entry')),
          signatures: [{ keyid: NEW_KEY, sig: b64(new TextEncoder().encode('signature')) }],
        },
      }],
    }],
    [`${ROOT}${headPath(SOURCE_NAME)}`, signHead(head, NEW.privateKey, NEW_KEY)],
  ]);
  const transport: Transport = {
    async fetch(url: string) {
      const value = routes.get(url);
      if (value === undefined) throw new Error(`missing route ${url}`);
      return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)) };
    },
  };
  const card: AnnouncedSubmissionCard = {
    record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: DIGEST },
    facts: { taskDigest: DIGEST, taskProfileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0' },
    chain: {
      taskId: 1n,
      submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      nonce: 'nonce-1',
      intendedSpendWei: 0n,
    },
  };

  it('propagates the resolve fault out of sync() rather than an invalid-head-envelope refusal', async () => {
    const fault = new Error('trust catalog read failed');
    const prod = productionSource(signingTrustAuthority(async () => { throw fault; }));
    const verifyHead = vi.fn(prod.verifyHead);
    const source: NativeDiscoverySource = {
      identity: { agent: AGENT, name: SOURCE_NAME },
      selfServed: false,
      resolveEndpoint: async () => ({ agent: AGENT, name: SOURCE_NAME, servingRoot: ROOT, archiveRootUrl: pageUrl }),
      async verify(input) {
        for await (const item of input.entries) void item;
        return { status: 'ok' };
      },
      verifyHead,
    };
    const store = new Store(':memory:');
    const open = () => createNativeDiscoveryConsumer({
      store,
      sources: [source],
      transport,
      decode: async () => card,
      now: () => NOW,
    });

    // Cold sync: no checkpoint yet, so the head goes through the chain procedure, not verifyHead.
    await expect(open().sync()).resolves.toMatchObject({ accepted: 1, degraded: [] });
    expect(verifyHead).not.toHaveBeenCalled();

    const restarted = open();
    await expect(restarted.sync()).rejects.toBe(fault);
    expect(verifyHead).toHaveBeenCalledOnce();
  });
});
