import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import {
  compareCalendarStrictRfc3339Instants,
  didPkh,
  dssePreAuthEncoding,
  parseExactDsseEnvelope,
  recordDigest,
  recoverEip191Address,
  resolveBindingForAgent,
  TRUST_REVOCATION_MEDIA_TYPE,
  validateKeyBinding,
  validateRevocation,
  verifyEnvelopeBinding,
  verifyPolicyChain,
  type AnchorObservation,
  type BindingResolver,
  type DsseChainVerifier,
  type EoaCeremonyEvidence,
  type KeyBinding,
  type PolicyCheckInput,
  type Sha256Digest,
  type WitnessVerifier,
} from '@jinn-network/trust-core';
import {
  createAnchorResolver,
  createBindingResolver,
  type BindingConflict,
  type BindingStore,
  type SealedKeyBindingRecord,
  type SealedRevocationRecord,
} from '@jinn-network/trust-resolve';
import { z } from 'zod/v3';
import type { NativeRoleIdentityRole } from './role-identities.js';
import type { RawSignatureVerifier } from '@jinn-network/record-discovery-client';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const bytes = base64.transform((value) => new Uint8Array(Buffer.from(value, 'base64')));
const message = z.object({
  domain: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  uri: z.string().min(1),
  version: z.literal('1'),
  chainId: z.number().int().positive(),
  nonce: z.string().min(1),
  issuedAt: z.string().datetime(),
  expirationTime: z.string().datetime().optional(),
  resources: z.array(z.string()),
}).strict();
const ceremony = z.object({
  type: z.literal('eoa'),
  message,
  messageBytes: bytes,
  signature: bytes,
}).strict();
const sealedBinding = z.object({
  digest: sha256,
  envelope: bytes,
  ceremony,
}).strict();
const sealedRevocation = z.object({ digest: sha256, envelope: bytes }).strict();
const anchor = z.object({
  digest: sha256,
  locator: z.object({
    profile: z.literal('https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1'),
    chainId: z.literal(84532),
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
    contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
    /** Zero-based byte offset into the canonical transaction input. */
    inputByteOffset: z.number().int().min(0).max(1_048_576),
  }).strict(),
}).strict();

export const NativeTrustCatalogSchema = z.object({
  schemaVersion: z.literal(2),
  format: z.literal('jinn.native-trust-catalog/2'),
  policyGenesisDigest: sha256,
  policies: z.array(z.object({ digest: sha256, envelope: bytes }).strict()).min(1),
  anchors: z.array(anchor).min(1),
  bindings: z.array(sealedBinding).min(1),
  revocations: z.array(sealedRevocation),
}).strict();

type ParsedCatalog = z.infer<typeof NativeTrustCatalogSchema>;

const ED25519_MULTICODEC = Uint8Array.of(0xed, 0x01);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class NativeTrustCatalogError extends Error {
  // `string`, not the literal, so `NativeTrustCatalogReadError` below can narrow it to its own name.
  override readonly name: string = 'NativeTrustCatalogError';
}

/**
 * A `verifyOnchainAuthority` failure that could NOT complete because a live chain read (the
 * `Safe.isOwner` step) failed — an RPC/network/transport error, distinct from a `false` ownership
 * verdict. Fail-closed for THIS attempt exactly like its parent (the caller never trusts a subject
 * whose authority could not be established), but a distinct type so the evaluator can classify it as
 * RETRYABLE — a transient read that never ran does not become truer by being retried to the 4h SLA,
 * and terminalizing it (as the settlement-authority checks did) buries a passing subject behind a
 * network blip. A genuine refusal (`!owns`, or any deterministic ceremony/scope/consent failure)
 * stays the plain `NativeTrustCatalogError` and remains terminal.
 */
export class NativeTrustCatalogReadError extends NativeTrustCatalogError {
  override readonly name = 'NativeTrustCatalogReadError';
}

function decodeEd25519DidKey(keyId: string): KeyObject {
  if (!keyId.startsWith('did:key:z')) throw new NativeTrustCatalogError(`unsupported DSSE key ${keyId}`);
  let decoded: Uint8Array;
  try { decoded = new Uint8Array(bs58.decode(keyId.slice('did:key:z'.length))); } catch {
    throw new NativeTrustCatalogError(`invalid did:key encoding ${keyId}`);
  }
  if (decoded.length !== 34
    || decoded[0] !== ED25519_MULTICODEC[0]
    || decoded[1] !== ED25519_MULTICODEC[1]) {
    throw new NativeTrustCatalogError(`native trust catalog supports only Ed25519 did:key signatures (${keyId})`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(decoded.subarray(2))]),
    format: 'der',
    type: 'spki',
  });
}

function decodeSignature(value: string): Uint8Array | undefined {
  try {
    const decoded = new Uint8Array(Buffer.from(value, 'base64'));
    return decoded.length === 64 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Key authority section 8, "An account's signature": an account signs a revocation with a DSSE
 * signature whose keyid is its `did:pkh`, a 65-byte EIP-191 `personal_sign` signature over the
 * pre-authentication encoding, recovering to that account. The text defines it for a revocation and
 * for no other record, so nothing else takes one. Without this, no voucher account's revocation
 * could take effect on the native path, and a role binding, which holds no `bindings` scope, could
 * then be revoked by no one.
 */
function accountSignatureValid(payloadType: string, pae: Uint8Array, keyid: string, sig: string): boolean {
  if (payloadType !== TRUST_REVOCATION_MEDIA_TYPE) return false;
  const chainId = /^did:pkh:eip155:([0-9]+):0x[0-9a-fA-F]{40}$/u.exec(keyid)?.[1];
  if (chainId === undefined) return false;
  try {
    return didPkh(chainId, recoverEip191Address(pae, new Uint8Array(Buffer.from(sig, 'base64')))) === keyid;
  } catch {
    return false;
  }
}

/**
 * Real DSSE verification; key IDs are never accepted by declaration alone. Ed25519 `did:key`
 * signatures on any record, and an account's `did:pkh` signature on a revocation.
 */
export const verifyNativeDsse: DsseChainVerifier = (envelopeBytes) => {
  try {
    const envelope = parseExactDsseEnvelope(envelopeBytes);
    const pae = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
    const valid = new Set<string>();
    for (const signature of envelope.signatures) {
      if (signature.keyid === undefined) continue;
      if (signature.keyid.startsWith('did:pkh:')) {
        if (accountSignatureValid(envelope.payloadType, pae, signature.keyid, signature.sig)) valid.add(signature.keyid);
        continue;
      }
      const bytes = decodeSignature(signature.sig);
      if (bytes === undefined) continue;
      try {
        if (cryptoVerify(null, pae, decodeEd25519DidKey(signature.keyid), bytes)) valid.add(signature.keyid);
      } catch {
        // An unsupported/invalid key is not a valid signer. Other signatures may still verify.
      }
    }
    return { validSignerKeyids: [...valid].sort() };
  } catch {
    return { validSignerKeyids: [] };
  }
};

function requireDigest(bytes: Uint8Array, expected: string, label: string): `sha256:${string}` {
  const actual = recordDigest(bytes);
  if (actual !== expected) throw new NativeTrustCatalogError(`${label} digest mismatch: expected ${expected}, got ${actual}`);
  return actual;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) throw new NativeTrustCatalogError(`duplicate ${label} ${identity}`);
    seen.add(identity);
  }
}

function parseBinding(entry: ParsedCatalog['bindings'][number]): SealedKeyBindingRecord {
  const digest = requireDigest(entry.envelope, entry.digest, 'binding');
  const validated = validateKeyBinding(entry.envelope);
  if (!validated.conforms || validated.value === undefined) {
    throw new NativeTrustCatalogError(`binding ${digest} is not a conforming sealed KeyBinding`);
  }
  if (validated.value.ceremony.type !== 'eoa') {
    throw new NativeTrustCatalogError(`binding ${digest} uses an unsupported non-EOA ceremony`);
  }
  return {
    binding: validated.value,
    envelopeBytes: entry.envelope,
    bindingDigest: digest,
    ceremonyEvidence: entry.ceremony as EoaCeremonyEvidence,
  };
}

function parseRevocation(entry: ParsedCatalog['revocations'][number]): SealedRevocationRecord {
  const digest = requireDigest(entry.envelope, entry.digest, 'revocation');
  const validated = validateRevocation(entry.envelope);
  if (!validated.conforms || validated.value === undefined) {
    throw new NativeTrustCatalogError(`revocation ${digest} is not a conforming sealed Revocation`);
  }
  return { revocation: validated.value, envelopeBytes: entry.envelope };
}

const CLOSED_WITNESS_VERIFIER: WitnessVerifier = {
  async verify1271Witness() {
    return { verified: false, reason: 'Phase B file trust catalog admits only offline-verifiable EOA ceremonies' };
  },
};

export interface NativeTrustAuthority {
  readonly bindingResolver: BindingResolver;
  readonly dsseVerifier: DsseChainVerifier;
  readonly witnessVerifier: WitnessVerifier;
  readonly conflicts: readonly BindingConflict[];
  readonly newestPolicyVersion: number;
  readonly rawSignatureVerifier: RawSignatureVerifier;
  /** Fails closed when the deployment catalog changed after this authority snapshot opened. */
  assertFresh(): Promise<void>;
  candidateKeys(agent: string): readonly { readonly keyid: string; readonly probeAt: string }[];
  policy(purpose: string): PolicyCheckInput;
  verifyRoleBinding(input: {
    readonly role: NativeRoleIdentityRole;
    readonly key: string;
    readonly agent: string;
    readonly family: string;
    readonly atTime: string;
  }): Promise<{ readonly bindingDigest: `sha256:${string}` }>;
  verifyOnchainAuthority(input: {
    readonly key: string;
    readonly agent: string;
    readonly address: `0x${string}`;
    readonly atTime: string;
    readonly purpose: 'native:solver-settlement' | 'native:evaluator-settlement';
  }): Promise<{ readonly bindingDigest: `sha256:${string}` }>;
  resolverFor(input: { readonly family: string; readonly purpose: string }): BindingResolver;
}

export interface NativeFinalizedAnchorReadClient {
  lookupFinalizedAnchor(input: {
    readonly digest: `sha256:${string}`;
    readonly locator: z.infer<typeof anchor>['locator'];
  }): Promise<{
    readonly digest: `sha256:${string}`;
    readonly anchorTime: string;
    readonly chainId: 84532;
    readonly transactionHash: `0x${string}`;
    readonly blockHash: `0x${string}`;
    readonly blockNumber: bigint;
    readonly finalized: true;
  } | null>;
}

/**
 * The one on-chain read the settlement-authority association needs (spec/2026-08-07 §2.3c step 5):
 * does the service Safe list the ceremony's EIP-191 signer as an owner. A REQUIRED input on
 * `openNativeTrustCatalog`, deliberately — a Safe cannot sign, so without this read the association
 * has no honest second link, and an optional input would let a construction site leave a silent
 * runtime hole instead of failing to compile.
 */
export interface NativeSettlementOwnershipReadClient {
  isOwner(safe: `0x${string}`, candidate: `0x${string}`): Promise<boolean>;
}

/** §2.3b's third ceremony resource: `did:pkh:eip155:84532:0x<EIP-55 Safe>`, authored by `didPkh`. */
const SETTLEMENT_RESOURCE_PATTERN = /^did:pkh:eip155:84532:(0x[0-9a-fA-F]{40})$/u;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function nativeRolePurpose(role: NativeRoleIdentityRole): string {
  return `native:${role}`;
}

export async function openNativeTrustCatalog(input: {
  readonly path: string;
  /** Deployment authority pinned outside the mutable catalog file. */
  readonly expectedPolicyGenesisDigest: `sha256:${string}`;
  /** Canonical/finalized chain reader supplied by the bounded infrastructure layer. */
  readonly anchorClient: NativeFinalizedAnchorReadClient;
  /** Safe-ownership reader for §2.3c step 5. Required: every construction site supplies it. */
  readonly settlementOwnershipClient: NativeSettlementOwnershipReadClient;
  readonly now?: Date;
}): Promise<NativeTrustAuthority> {
  const metadata = await lstat(input.path).catch((cause) => {
    throw new NativeTrustCatalogError(`native trust catalog cannot be inspected: ${String(cause)}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new NativeTrustCatalogError('native trust catalog must be a regular non-symlink file');
  }
  let raw: unknown;
  let catalogBytes: Uint8Array;
  try {
    catalogBytes = await readFile(input.path);
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes));
  } catch (cause) {
    throw new NativeTrustCatalogError(`native trust catalog cannot be read: ${String(cause)}`);
  }
  const parsed = NativeTrustCatalogSchema.safeParse(raw);
  if (!parsed.success) throw new NativeTrustCatalogError(`native trust catalog is invalid: ${parsed.error.message}`);
  const catalog = parsed.data;
  const openedCatalogDigest = recordDigest(catalogBytes!);
  const assertFresh = async (): Promise<void> => {
    const currentMetadata = await lstat(input.path).catch(() => undefined);
    if (currentMetadata === undefined || !currentMetadata.isFile() || currentMetadata.isSymbolicLink()) {
      throw new NativeTrustCatalogError('native trust catalog changed type or disappeared after authority load');
    }
    const current = await readFile(input.path);
    if (recordDigest(current) !== openedCatalogDigest) {
      throw new NativeTrustCatalogError('native trust catalog changed after authority load; restart is required before authorizing work');
    }
  };
  if (catalog.policyGenesisDigest !== input.expectedPolicyGenesisDigest) {
    throw new NativeTrustCatalogError('native trust catalog policy genesis does not match structured deployment authority');
  }
  uniqueBy(catalog.policies, ({ digest }) => digest, 'policy digest');
  uniqueBy(catalog.anchors, ({ digest }) => digest, 'anchor digest');
  uniqueBy(catalog.bindings, ({ digest }) => digest, 'binding digest');
  uniqueBy(catalog.revocations, ({ digest }) => digest, 'revocation digest');

  for (const policy of catalog.policies) requireDigest(policy.envelope, policy.digest, 'policy');
  const policyResult = verifyPolicyChain(catalog.policies.map(({ envelope }) => envelope), {
    genesisAnchor: { digest: catalog.policyGenesisDigest as Sha256Digest },
    now: (input.now ?? new Date()).toISOString(),
    dsseVerifier: verifyNativeDsse,
  });
  if (!policyResult.ok || policyResult.newest === undefined) {
    throw new NativeTrustCatalogError(`native trust policy chain refused: ${policyResult.reason ?? 'unknown'}`);
  }

  const bindings = catalog.bindings.map(parseBinding);
  const revocations = catalog.revocations.map(parseRevocation);
  const requiredAnchorDigests = new Set<string>();
  for (const binding of bindings) {
    if (binding.binding.anchors.length === 0) throw new NativeTrustCatalogError(`binding ${binding.bindingDigest} has no anchor`);
    for (const reference of binding.binding.anchors) {
      if (!catalog.anchors.some(({ digest }) => digest === reference.digest)) {
        throw new NativeTrustCatalogError(`binding ${binding.bindingDigest} has an undeclared anchor ${reference.digest}`);
      }
      requiredAnchorDigests.add(reference.digest);
    }
  }
  for (const record of revocations) {
    if (record.revocation.anchors.length === 0) throw new NativeTrustCatalogError(`revocation ${record.revocation.target} has no anchor`);
    for (const reference of record.revocation.anchors) {
      if (!catalog.anchors.some(({ digest }) => digest === reference.digest)) {
        throw new NativeTrustCatalogError(`revocation has an undeclared anchor ${reference.digest}`);
      }
      requiredAnchorDigests.add(reference.digest);
    }
  }
  const anchors = new Map<string, AnchorObservation>();
  for (const digest of requiredAnchorDigests) {
    const declaration = catalog.anchors.find((candidate) => candidate.digest === digest)!;
    // Catalog timestamps are never authority: every observation comes from the canonical reader.
    // eslint-disable-next-line no-await-in-loop -- bounded startup catalog, fail before work.
    const observation = await input.anchorClient.lookupFinalizedAnchor({
      digest: digest as `sha256:${string}`,
      locator: declaration.locator,
    });
    if (observation === null
      || observation.digest !== digest
      || observation.chainId !== 84532
      || observation.finalized !== true
      || !/^0x[0-9a-fA-F]{64}$/u.test(observation.transactionHash)
      || !/^0x[0-9a-fA-F]{64}$/u.test(observation.blockHash)
      || observation.blockNumber < 0n
      || !Number.isFinite(Date.parse(observation.anchorTime))) {
      throw new NativeTrustCatalogError(`anchor ${digest} is missing, non-finalized, or mismatched`);
    }
    anchors.set(digest, { digest: observation.digest as Sha256Digest, anchorTime: observation.anchorTime });
  }

  const store: BindingStore = {
    async listBindingsForAgent(agent) { return bindings.filter(({ binding }) => binding.agent === agent); },
    async listRevocationsForTargets(targets) {
      const wanted = new Set(targets);
      return revocations.filter(({ revocation }) => wanted.has(revocation.target as Sha256Digest));
    },
  };
  const conflicts: BindingConflict[] = [];
  const anchorResolver = createAnchorResolver({
    client: { async lookupAnchor(digest) { return anchors.get(digest) ?? null; } },
  });
  const bindingResolver = createBindingResolver({
    bindings: store,
    anchors: anchorResolver,
    requireAnchors: true,
    recordSignedByItsKey: ({ binding, envelopeBytes }) =>
      verifyNativeDsse(envelopeBytes).validSignerKeyids.includes(binding.key.didKey),
    onConflict: (conflict) => conflicts.push(conflict),
  });
  const policyFor = (purpose: string): PolicyCheckInput => {
    const entry = policyResult.newest!.purposes[purpose];
    if (entry === undefined) throw new NativeTrustCatalogError(`native trust policy has no ${purpose} purpose`);
    return entry;
  };

  /**
   * `authorize`'s outcomes. A candidate binding can fail to authorize a family for categorically
   * different reasons, and the two consumers of this authority want OPPOSITE behavior on some of
   * them (issues #2525, #5212):
   *
   *  - **not trustworthy**: bad signature, wrong agent, failed ceremony, broken consent chain,
   *    policy-rejected, or conflicting bindings. Nobody may ever proceed past one of these, so
   *    `authorize` THROWS: there is no "return a value the caller might ignore" for an
   *    untrustworthy binding.
   *  - **not this key, here and now**: the binding is authentic, but the key does not sign
   *    `family` at `atTime`. That is trust-core's `scope-violation` (the binding does not carry
   *    `family`; the native ceremony mints one narrowly scoped key per role, so most of an Agent's
   *    keys do not cover any given family), trust-core's `revoked` (an authorized revocation took
   *    effect at or before `atTime`), or no binding of the pair in effect at `atTime`.
   *
   * `authorize` therefore RETURNS the second kind, with the refusal a caller that needs this key
   * throws, and each caller decides: `verified` (a call site that names one specific key and
   * demands that key cover the family) throws it verbatim; `resolverFor` (whose consumer
   * ENUMERATES an Agent's keys and keeps the ones that apply) skips the candidate and keeps going,
   * once it has shown a pair that resolves nothing at `atTime` is out of window rather than absent.
   *
   * The discriminator is trust-core's own typed `VerificationFailureReason` and the resolver's
   * `null`, never a string match on a message. `verifyEnvelopeBinding` reaches `scope-violation`
   * only after the DSSE signature, the resolution for this exact key and Agent, the ceremony and
   * the validity window have PASSED, and `revoked` only after the scope and the consent chain have
   * too.
   */
  type BindingAuthorization =
    | { readonly authorized: true; readonly bindingDigest: `sha256:${string}` }
    | {
      readonly authorized: false;
      readonly reason: 'scope-violation' | 'revoked' | 'binding-not-resolved';
      readonly refusal: string;
    };

  async function authorize(inputValue: {
    readonly key: string;
    readonly agent: string;
    readonly family: string;
    readonly purpose: string;
    readonly atTime: string;
  }): Promise<BindingAuthorization> {
    await assertFresh();
    const conflictCount = conflicts.length;
    const resolved = await bindingResolver.resolveBinding(
      { key: inputValue.key, agent: inputValue.agent },
      inputValue.atTime,
    );
    if (conflicts.length !== conflictCount) {
      throw new NativeTrustCatalogError(`conflicting bindings for ${inputValue.key} and ${inputValue.agent}`);
    }
    if (resolved === null) {
      return { authorized: false, reason: 'binding-not-resolved', refusal: `binding did not resolve for ${inputValue.key}` };
    }
    const outcome = await verifyEnvelopeBinding({
      envelopeBytes: resolved.envelopeBytes,
      key: inputValue.key,
      agent: inputValue.agent,
      family: inputValue.family,
      atTime: inputValue.atTime,
    }, {
      bindingResolver,
      witnessVerifier: CLOSED_WITNESS_VERIFIER,
      dsseVerifier: verifyNativeDsse,
      policy: policyFor(inputValue.purpose),
    });
    if (!outcome.ok || outcome.resolvedBinding === undefined) {
      const detail = `${outcome.reason ?? 'unknown'}${outcome.detail === undefined ? '' : ` (${outcome.detail})`}`;
      const refusal = `binding authority refused for ${inputValue.key}: ${detail}`;
      if (outcome.reason === 'scope-violation' || outcome.reason === 'revoked') {
        return { authorized: false, reason: outcome.reason, refusal };
      }
      throw new NativeTrustCatalogError(refusal);
    }
    return { authorized: true, bindingDigest: outcome.resolvedBinding.bindingDigest };
  }

  async function verified(inputValue: {
    readonly key: string;
    readonly agent: string;
    readonly family: string;
    readonly purpose: string;
    readonly atTime: string;
  }): Promise<{ readonly bindingDigest: `sha256:${string}` }> {
    const outcome = await authorize(inputValue);
    if (!outcome.authorized) throw new NativeTrustCatalogError(outcome.refusal);
    return { bindingDigest: outcome.bindingDigest };
  }

  /** §7.3's `max(validFrom, earliest anchor time)`, over the finalized anchors read above. */
  function effectiveStartOf(binding: KeyBinding): string | undefined {
    let earliest: string | undefined;
    for (const { digest } of binding.anchors) {
      const anchorTime = anchors.get(digest)?.anchorTime;
      if (anchorTime === undefined) continue;
      if (earliest === undefined || compareCalendarStrictRfc3339Instants(anchorTime, earliest) === -1) earliest = anchorTime;
    }
    if (earliest === undefined) return undefined;
    return compareCalendarStrictRfc3339Instants(binding.validFrom, earliest) === 1 ? binding.validFrom : earliest;
  }

  /**
   * Whether a pair that resolves nothing at the instant asked is authentic at an instant one of
   * its bindings is in effect, which makes it out of window then (expired, or not yet in effect)
   * rather than absent. `authorize` runs in full at each such instant and its throws propagate, so
   * an out-of-window binding with a failing ceremony, a broken consent chain, a conflict or a
   * policy refusal still stops the consumer, and a key with no record it signed is still refused.
   * A start computed wrongly here resolves nothing and so cannot skip a key.
   */
  async function inEffectAtAnotherInstant(inputValue: {
    readonly key: string;
    readonly agent: string;
    readonly family: string;
    readonly purpose: string;
  }): Promise<boolean> {
    let inEffect = false;
    for (const { binding } of bindings) {
      if (binding.key.didKey !== inputValue.key || binding.agent !== inputValue.agent) continue;
      const start = effectiveStartOf(binding);
      if (start === undefined) continue;
      // eslint-disable-next-line no-await-in-loop -- a pair has few bindings; each check reads the catalog.
      const outcome = await authorize({ ...inputValue, atTime: start });
      if (outcome.authorized || outcome.reason !== 'binding-not-resolved') inEffect = true;
    }
    return inEffect;
  }

  return {
    bindingResolver,
    dsseVerifier: verifyNativeDsse,
    witnessVerifier: CLOSED_WITNESS_VERIFIER,
    conflicts,
    newestPolicyVersion: policyResult.newest.version,
    rawSignatureVerifier: {
      async verify(pae, signature, key) {
        try {
          return cryptoVerify(null, pae, decodeEd25519DidKey(key.keyid), signature);
        } catch {
          return false;
        }
      },
    },
    assertFresh,
    candidateKeys(agent) {
      return bindings.filter(({ binding }) => binding.agent === agent).map(({ binding }) => ({
        keyid: binding.key.didKey,
        probeAt: binding.validFrom,
      }));
    },
    policy: policyFor,
    verifyRoleBinding: ({ role, ...rest }) => verified({ ...rest, purpose: nativeRolePurpose(role) }),
    /**
     * The settlement-authority association (spec/2026-08-07 §2.3c). The pre-amendment check
     * compared the ceremony's `message.address` to the settlement address itself — unsatisfiable
     * for a real operator, because a Safe is a contract and cannot produce the EIP-191 signature
     * the ceremony leg requires (`parseBinding` refuses non-EOA ceremonies; the witness verifier is
     * closed). It only ever passed because the e2e rig made the ceremony EOA and the "Safe" the
     * same account. The honest chain of custody is two links, each independently verifiable:
     * role key ← DSSE + EOA SIWE ceremony over [agent, key, safe] ← agent EOA ← Safe.isOwner ← Safe.
     */
    async verifyOnchainAuthority(value) {
      // 1. The unchanged pipeline: policy purpose, `settlements` family, DSSE + ceremony + §7.4a
      //    consent chain, freshness.
      const result = await verified({
        key: value.key,
        agent: value.agent,
        family: 'settlements',
        purpose: value.purpose,
        atTime: value.atTime,
      });
      // 2. Resolve at `atTime`; ceremony evidence is mandatory for a settlement-scoped binding.
      const resolved = await resolveBindingForAgent(
        bindingResolver,
        { key: value.key, agent: value.agent },
        value.atTime,
      );
      // Named before the ceremony guard: a binding that resolved for another agent
      // has not "carried no ceremony evidence". Defense in depth -- the resolver this
      // catalog builds draws candidates from `listBindingsForAgent(query.agent)` and so
      // is conforming by construction, which is also why there is no injection seam to
      // drive a key-only resolver through here from a test (issue #3629).
      if (resolved === null) {
        throw new NativeTrustCatalogError(
          `settlement authority ${value.key} did not resolve for ${value.agent}`,
        );
      }
      const ceremonyEvidence = resolved.ceremonyEvidence;
      if (ceremonyEvidence === undefined) {
        throw new NativeTrustCatalogError(
          `settlement authority ${value.key} carries no ceremony evidence`,
        );
      }
      // 3. The ceremony must not lie about who signed it. `verified()` has already required the
      //    recovered signer to equal the binding's VOUCHER; this requires it to equal the ceremony's
      //    own declared `message.address`, which is what the third resource is signed alongside.
      let signer: `0x${string}`;
      try {
        signer = recoverEip191Address(ceremonyEvidence.messageBytes, ceremonyEvidence.signature);
      } catch (cause) {
        throw new NativeTrustCatalogError(
          `settlement authority ${value.key} ceremony signature is not recoverable: ${String(cause)}`,
        );
      }
      if (!sameAddress(signer, ceremonyEvidence.message.address)) {
        throw new NativeTrustCatalogError(
          `settlement authority ${value.key} ceremony declares signer ${ceremonyEvidence.message.address} `
          + `but was signed by ${signer}`,
        );
      }
      // 4. The third declared resource names the settlement authority, inside the signed bytes.
      const declared = ceremonyEvidence.message.resources[2];
      if (declared === undefined) {
        throw new NativeTrustCatalogError(
          `settlement authority ${value.key} ceremony declares no settlement resource; a `
          + `settlements-scoped binding must name its Safe as the third ceremony resource`,
        );
      }
      const declaredSafe = SETTLEMENT_RESOURCE_PATTERN.exec(declared)?.[1];
      if (declaredSafe === undefined || !sameAddress(declaredSafe, value.address)) {
        throw new NativeTrustCatalogError(
          `settlement authority ${value.key} ceremony declares settlement resource ${declared}, `
          + `not did:pkh:eip155:84532:${value.address}`,
        );
      }
      // 5. The one honestly chain-state-dependent link, read at verification time (matching the
      //    recorded `ChainFactResolver.ownerOf` precedent, §10 open question c). A `false` and a
      //    read failure both refuse — fail-closed, with distinct errors.
      let owns: boolean;
      try {
        owns = await input.settlementOwnershipClient.isOwner(value.address, signer);
      } catch (cause) {
        // The read could not COMPLETE (RPC/network/transport). Fail closed, but as the RETRYABLE
        // read-error subtype so the evaluator does not terminalize a transient blip to the SLA.
        throw new NativeTrustCatalogReadError(
          `settlement authority ${value.key} Safe-ownership read for ${value.address} failed: ${String(cause)}`,
        );
      }
      if (!owns) {
        throw new NativeTrustCatalogError(
          `settlement authority ${value.key}: Safe ${value.address} does not own ceremony signer ${signer}`,
        );
      }
      // 6.
      return result;
    },
    /**
     * A family-scoped resolver for the ENUMERATE-AND-FILTER consumer (`@jinn-network/
     * record-discovery-client`'s `KeyResolver.resolve`, which walks every key ever bound to an
     * agent and keeps the ones that resolve). Its contract requires `resolveBinding` to RETURN for
     * a candidate that does not apply, so an out-of-scope key is `null` — "not this key", the same
     * answer `BindingResolver` already gives for an unknown pair — and enumeration continues to the
     * key that does cover `family`. Throwing there aborted the whole enumeration on candidate #1
     * and made every multi-scope agent unconsumable (issue #2525, live DR-2026-08-05 round 4).
     * A key revoked at the instant asked, or out of window at it, is `null` for the same reason:
     * throwing on one revoked or expired discovery key refused every read of the Agent, including
     * what its other, valid discovery keys signed (issue #5212). `null` is never the binding, so
     * nothing such a key signs verifies at an instant it is not in effect.
     *
     * `null` here is a SKIP and nothing else. Every other refusal (invalid signature, wrong agent,
     * failed ceremony, broken consent chain, policy-rejected, conflicting bindings, or a key with
     * no binding of the pair in effect at any instant) still throws, so it propagates through this
     * resolver and stops the consumer loud rather than degrading it into a silent filter. That holds
     * for an out-of-window key too: see `inEffectAtAnotherInstant`. See `authorize`'s doc for why
     * the discriminator is sound.
     */
    resolverFor({ family, purpose }) {
      return {
        async resolveBinding(query, atTime) {
          const outcome = await authorize({ ...query, family, purpose, atTime });
          if (outcome.authorized) return bindingResolver.resolveBinding(query, atTime);
          if (outcome.reason !== 'binding-not-resolved') return null;
          if (await inEffectAtAnotherInstant({ ...query, family, purpose })) return null;
          throw new NativeTrustCatalogError(outcome.refusal);
        },
      };
    },
  };
}
