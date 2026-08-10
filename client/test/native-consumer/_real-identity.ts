import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import {
  DISCOVERY_SIGNING_SCOPE,
  type KeyResolver,
  type ResolvedKey,
  type SignatureVerifier,
} from '@jinn-network/record-discovery-protocol';
import {
  TRUST_KEY_BINDING_FORMAT,
  canonicalJsonBytes,
  deriveStrength,
  dssePreAuthEncoding,
  parseExactDsseEnvelope,
  sealDsseEnvelope,
  type AnchorResolver,
  type DsseChainVerifier,
  type KeyBinding,
  type PolicyCheckInput,
  type Sha256Digest,
} from '@jinn-network/trust-core';
import {
  createBindingResolver,
  type BindingStore,
  type SealedKeyBindingRecord,
} from '@jinn-network/trust-resolve';
import type { ConsumerTrustPorts } from '../../src/native-consumer/verification.js';

export interface RealIdentity {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  sign(payload: Uint8Array): Uint8Array;
  verify(payload: Uint8Array, signature: Uint8Array): boolean;
}

export function realIdentity(label: string): RealIdentity {
  const pair = generateKeyPairSync('ed25519');
  return {
    keyId: `did:key:z6Mk${label}111111111111111111111111111111`,
    ...pair,
    sign: (payload) => new Uint8Array(sign(null, payload, pair.privateKey)),
    verify: (payload, signature) => verify(null, payload, pair.publicKey, signature),
  };
}

export function signedEnvelope(payloadBytes: Uint8Array, payloadType: string, identity: RealIdentity): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes,
    payloadType,
    signatures: [{ keyid: identity.keyId, signature: identity.sign(dssePreAuthEncoding(payloadType, payloadBytes)) }],
  });
}

export interface RealBindingInput {
  readonly agent: string;
  readonly identity: RealIdentity;
  readonly scope: readonly string[];
  readonly relationship: 'controls' | 'signs-for';
  readonly voucher: string;
  readonly order: number;
}

export function createRealTrustFixture(input: {
  readonly bindings: readonly RealBindingInput[];
  readonly sourceKeys: readonly { readonly agent: string; readonly identity: RealIdentity }[];
  readonly policies: ConsumerTrustPorts['policies'];
}): { readonly trust: ConsumerTrustPorts; readonly keys: KeyResolver; readonly sigs: SignatureVerifier } {
  const anchors = new Map<Sha256Digest, string>();
  const records: SealedKeyBindingRecord[] = input.bindings.map((entry) => {
    const bindingDigest = `sha256:${entry.order.toString(16).padStart(64, '0')}` as Sha256Digest;
    const anchorDigest = `sha256:${(entry.order + 1000).toString(16).padStart(64, '0')}` as Sha256Digest;
    const time = `2026-01-${String(entry.order).padStart(2, '0')}T00:00:00Z`;
    anchors.set(anchorDigest, time);
    const binding: KeyBinding = {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: entry.agent,
      key: {
        publicKey: entry.identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        keyid: entry.identity.keyId,
        algorithm: 'ed25519',
        didKey: entry.identity.keyId,
      },
      voucher: { kind: 'oidc-machine', subject: entry.voucher },
      relationship: entry.relationship,
      scope: [...entry.scope],
      validFrom: time,
      ceremony: { type: 'oidc-machine', digest: `sha256:${'c'.repeat(64)}` },
      strength: deriveStrength('oidc-machine'),
      anchors: [{ digest: anchorDigest }],
    };
    return {
      binding,
      bindingDigest,
      envelopeBytes: signedEnvelope(
        canonicalJsonBytes(binding),
        'application/vnd.jinn.trust.key-binding.v1+json',
        entry.identity,
      ),
    };
  });
  const store: BindingStore = {
    async listBindingsForAgent(agent) { return records.filter(({ binding }) => binding.agent === agent); },
    async listRevocationsForTargets() { return []; },
  };
  const anchorResolver: AnchorResolver = {
    async lookupAnchor(digest) {
      const anchorTime = anchors.get(digest);
      return anchorTime === undefined ? null : { digest, anchorTime };
    },
  };
  const bindingResolver = createBindingResolver({ bindings: store, anchors: anchorResolver, requireAnchors: true });
  const identityByKey = new Map(input.bindings.map(({ identity }) => [identity.keyId, identity]));
  const dsseVerifier: DsseChainVerifier = (bytes) => {
    let parsed;
    try { parsed = parseExactDsseEnvelope(bytes); } catch { return { validSignerKeyids: [] }; }
    const pae = dssePreAuthEncoding(parsed.payloadType, parsed.payloadBytes);
    return {
      validSignerKeyids: parsed.signatures.flatMap(({ keyid, sig }) => {
        if (keyid === undefined) return [];
        const identity = identityByKey.get(keyid);
        return identity?.verify(pae, Buffer.from(sig, 'base64')) === true ? [keyid] : [];
      }),
    };
  };
  const sourceByAgent = new Map(input.sourceKeys.map(({ agent, identity }) => [agent, identity]));
  const keys: KeyResolver = {
    async resolve(agent, at) {
      const identity = sourceByAgent.get(agent);
      if (identity === undefined) return [];
      const resolved = await bindingResolver.resolveBinding({ key: identity.keyId, agent }, at.toISOString());
      if (resolved === null || !resolved.binding.scope.includes(DISCOVERY_SIGNING_SCOPE)) return [];
      return [{ keyid: identity.keyId, publicKey: 'resolved-ed25519', algorithm: 'ed25519' } satisfies ResolvedKey];
    },
    async everBound(agent, keyid) {
      const identity = sourceByAgent.get(agent);
      return identity?.keyId === keyid;
    },
  };
  const sigs: SignatureVerifier = {
    async verify(pae, signature, key) { return identityByKey.get(key.keyid)?.verify(pae, signature) ?? false; },
  };
  return {
    trust: {
      bindingResolver,
      dsseVerifier,
      witnessVerifier: { async verify1271Witness() { return { verified: false, reason: 'not a Safe ceremony' }; } },
      policies: input.policies,
    },
    keys,
    sigs,
  };
}
