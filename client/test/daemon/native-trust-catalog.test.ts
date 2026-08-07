import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  ceremonyEvidenceDigest,
  didPkh,
  dssePreAuthEncoding,
  recordDigest,
  sealDsseEnvelope,
  sealKeyBinding,
  sealRevocation,
  sealTrustPolicy,
  serializeCeremonyMessage,
  type DsseSigner,
  type EoaCeremonyEvidence,
  type KeyBinding,
  type Sha256Digest,
  type TrustPolicy,
} from '@jinn-network/trust-core';
import {
  openNativeTrustCatalog,
  verifyNativeDsse,
  type NativeFinalizedAnchorReadClient,
  type NativeSettlementOwnershipReadClient,
} from '../../src/daemon/native-trust-catalog.js';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const NOW = '2026-08-02T12:00:00.000Z';
const VALID_FROM = '2026-08-01T00:00:00.000Z';
const ANCHOR_TIME = '2026-08-01T00:01:00.000Z';
const AGENT = 'https://spec.jinn.network/agents/native-solver';
const ROLE_PURPOSE = 'native:solver-delivery';
const FAMILY = 'deliveries';
const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
/** A second EOA, used to forge a ceremony that lies about who signed it (§2.3c step 3). */
const OTHER_ACCOUNT = privateKeyToAccount(`0x${'22'.repeat(32)}`);
/** The settlement authority: a CONTRACT account, never the ceremony EOA (§2.3b). */
const SAFE = '0x5A5A5a5A5a5A5A5a5A5a5a5a5A5a5A5A5a5A5A5a' as const;
const SETTLEMENT_PURPOSE = 'native:solver-settlement';
const SETTLEMENT_FAMILY = 'settlements';

/** The default step-5 read: this Safe owns the ceremony EOA. Overridden per refusal test. */
const OWNS: NativeSettlementOwnershipReadClient = { async isOwner() { return true; } };

function keyId(publicKey: KeyObject): string {
  const der = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  return `did:key:z${bs58.encode(Buffer.concat([Buffer.from([0xed, 0x01]), der.subarray(SPKI.length)]))}`;
}

function ed25519Signer(pair: ReturnType<typeof generateKeyPairSync>): { readonly id: string; readonly signer: DsseSigner } {
  const id = keyId(pair.publicKey);
  return {
    id,
    signer: async ({ preAuthEncoding }) => [{
      keyid: id,
      signature: new Uint8Array(sign(null, preAuthEncoding, pair.privateKey)),
    }],
  };
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

interface CeremonyShape {
  readonly mode?: 'valid' | 'bad-signature' | 'bad-content';
  /**
   * Resources beyond `[agent, didKey]`. `undefined` keeps the two-resource (non-settlement) shape;
   * a settlement ceremony declares its Safe here as the §2.3b third entry.
   */
  readonly extraResources?: readonly string[];
  /** Overrides `message.address` while ACCOUNT still produces the signature — the step-3 forgery. */
  readonly declaredAddress?: `0x${string}`;
}

async function eoaCeremony(agent: string, didKey: string, shape: CeremonyShape = {}):
Promise<EoaCeremonyEvidence> {
  const mode = shape.mode ?? 'valid';
  const message = {
    domain: 'trust.jinn.network',
    address: shape.declaredAddress ?? ACCOUNT.address,
    uri: 'https://trust.jinn.network/ceremony/key-binding',
    version: '1' as const,
    chainId: 84532,
    nonce: 'phase-b-native-catalog',
    issuedAt: VALID_FROM,
    resources: [agent, didKey, ...(shape.extraResources ?? [])],
  };
  const signedMessage = mode === 'bad-content'
    ? { ...message, resources: ['https://spec.jinn.network/agents/attacker', didKey] }
    : message;
  const messageBytes = serializeCeremonyMessage('eoa', signedMessage);
  const signature = mode === 'bad-signature'
    ? new Uint8Array(65).fill(7)
    : hexToBytes(await ACCOUNT.signMessage({ message: { raw: messageBytes } }));
  return { type: 'eoa', message, messageBytes, signature };
}

type AnchorObservation = Awaited<ReturnType<NativeFinalizedAnchorReadClient['lookupFinalizedAnchor']>>;

function anchorLocator(_digest: string, index: number) {
  return {
    profile: 'https://spec.jinn.network/trust/anchor-locators/base-sepolia-calldata-v1' as const,
    chainId: 84532 as const,
    transactionHash: `0x${(index + 1).toString(16).padStart(64, '0')}` as const,
    contractAddress: `0x${'ab'.repeat(20)}` as const,
    inputByteOffset: 4 + index * 32,
  };
}

function observation(digest: Sha256Digest, overrides: Partial<NonNullable<AnchorObservation>> = {}):
NonNullable<AnchorObservation> {
  return {
    digest,
    anchorTime: ANCHOR_TIME,
    chainId: 84532,
    transactionHash: `0x${'ab'.repeat(32)}`,
    blockHash: `0x${'cd'.repeat(32)}`,
    blockNumber: 12_345n,
    finalized: true,
    ...overrides,
  };
}

interface CatalogFixture {
  readonly root: string;
  readonly path: string;
  readonly policyGenesisDigest: Sha256Digest;
  readonly key: string;
  readonly bindingDigest: Sha256Digest;
  readonly anchors: ReadonlyMap<string, NonNullable<AnchorObservation>>;
  readonly catalog: Record<string, unknown>;
  write(value?: Record<string, unknown>): Promise<void>;
}

/**
 * `undefined` → a plain two-resource delivery binding. A value → a settlements-scoped binding whose
 * ceremony declares `thirdResource` (or none, when `thirdResource` is `null`) as its third entry.
 */
interface SettlementShape {
  readonly thirdResource?: string | null;
  readonly declaredAddress?: `0x${string}`;
}

async function buildCatalog(options: {
  readonly purpose?: 'present' | 'missing';
  readonly validFrom?: string;
  readonly expiresAt?: string;
  readonly ceremonyMode?: 'valid' | 'bad-signature' | 'bad-content' | 'digest-mismatch';
  readonly revoked?: boolean;
  readonly conflict?: boolean;
  readonly forgeBindingEnvelope?: boolean;
  readonly settlement?: SettlementShape;
} = {}): Promise<CatalogFixture> {
  const root = await mkdtemp(join(tmpdir(), 'jinn-native-trust-'));
  const path = join(root, 'trust.json');
  const pair = generateKeyPairSync('ed25519');
  const working = ed25519Signer(pair);
  const anchorDigest = recordDigest(new TextEncoder().encode('binding-anchor'));
  const settlement = options.settlement;
  const family = settlement === undefined ? FAMILY : SETTLEMENT_FAMILY;
  const purpose = settlement === undefined ? ROLE_PURPOSE : SETTLEMENT_PURPOSE;
  const thirdResource = settlement === undefined
    ? undefined
    : (settlement.thirdResource === undefined ? didPkh(84532, SAFE) : settlement.thirdResource);
  const ceremony = await eoaCeremony(AGENT, working.id, {
    ...(options.ceremonyMode === 'bad-signature' || options.ceremonyMode === 'bad-content'
      ? { mode: options.ceremonyMode }
      : {}),
    ...(thirdResource === null || thirdResource === undefined ? {} : { extraResources: [thirdResource] }),
    ...(settlement?.declaredAddress === undefined ? {} : { declaredAddress: settlement.declaredAddress }),
  });
  const binding: KeyBinding = {
    protocol: 'https://spec.jinn.network/trust/key-binding/v1',
    agent: AGENT,
    key: { publicKey: working.id, keyid: working.id, algorithm: 'Ed25519', didKey: working.id },
    voucher: { kind: 'account', did: didPkh(84532, ACCOUNT.address), contractAccount: false },
    relationship: 'controls',
    scope: ['bindings', family],
    validFrom: options.validFrom ?? VALID_FROM,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ceremony: {
      type: 'eoa',
      digest: options.ceremonyMode === 'digest-mismatch'
        ? recordDigest(new TextEncoder().encode('wrong-ceremony'))
        : ceremonyEvidenceDigest(ceremony),
    },
    strength: 'strong',
    anchors: [{ digest: anchorDigest }],
  };
  const sealedBinding = await sealKeyBinding(binding, working.signer);
  let bindingEnvelope = sealedBinding.envelopeBytes;
  if (options.forgeBindingEnvelope === true) {
    const parsed = JSON.parse(new TextDecoder().decode(bindingEnvelope)) as { signatures: { sig: string }[] };
    parsed.signatures[0]!.sig = b64(new Uint8Array(64).fill(9));
    bindingEnvelope = new TextEncoder().encode(JSON.stringify(parsed));
  }

  const policy: TrustPolicy = {
    protocol: 'https://spec.jinn.network/trust/policy/v1',
    version: 1,
    purposes: options.purpose === 'missing' ? {} : {
      [purpose]: { accepted: [AGENT], requiredStrength: 'strong' },
    },
    signerSet: { keys: [working.id], threshold: 1 },
    refreshBy: '2027-01-01T00:00:00.000Z',
  };
  const sealedPolicy = await sealTrustPolicy(policy, working.signer);
  const anchors = new Map<string, NonNullable<AnchorObservation>>([
    [anchorDigest, observation(anchorDigest)],
  ]);
  const catalogBindings: Record<string, unknown>[] = [{
    digest: recordDigest(bindingEnvelope),
    envelope: b64(bindingEnvelope),
    ceremony: {
      type: 'eoa',
      message: ceremony.message,
      messageBytes: b64(ceremony.messageBytes),
      signature: b64(ceremony.signature),
    },
  }];
  if (options.conflict === true) {
    const secondAnchor = recordDigest(new TextEncoder().encode('second-binding-anchor'));
    const secondBinding = await sealKeyBinding({ ...binding, anchors: [{ digest: secondAnchor }] }, working.signer);
    anchors.set(secondAnchor, observation(secondAnchor, { anchorTime: '2026-08-01T00:02:00.000Z' }));
    catalogBindings.push({
      digest: secondBinding.recordDigest,
      envelope: b64(secondBinding.envelopeBytes),
      ceremony: catalogBindings[0]!.ceremony,
    });
  }
  const catalogAnchors = [...anchors.keys()].map((digest, index) => ({
    digest,
    locator: anchorLocator(digest, index),
  }));
  const revocations: Record<string, unknown>[] = [];
  if (options.revoked === true) {
    const revocationAnchor = recordDigest(new TextEncoder().encode('revocation-anchor'));
    const revocation = await sealRevocation({
      protocol: 'https://spec.jinn.network/trust/revocation/v1',
      target: recordDigest(bindingEnvelope),
      revokedBy: working.id,
      anchors: [{ digest: revocationAnchor }],
      effectiveFrom: '2026-08-02T00:00:00.000Z',
    }, working.signer);
    anchors.set(revocationAnchor, observation(revocationAnchor, { anchorTime: '2026-08-02T00:01:00.000Z' }));
    catalogAnchors.push({ digest: revocationAnchor, locator: anchorLocator(revocationAnchor, catalogAnchors.length) });
    revocations.push({ digest: revocation.recordDigest, envelope: b64(revocation.envelopeBytes) });
  }
  const catalog: Record<string, unknown> = {
    schemaVersion: 2,
    format: 'jinn.native-trust-catalog/2',
    policyGenesisDigest: sealedPolicy.recordDigest,
    policies: [{ digest: sealedPolicy.recordDigest, envelope: b64(sealedPolicy.envelopeBytes) }],
    anchors: catalogAnchors,
    bindings: catalogBindings,
    revocations,
  };
  const write = async (value: Record<string, unknown> = catalog): Promise<void> => {
    await writeFile(path, JSON.stringify(value));
  };
  await write();
  return {
    root,
    path,
    policyGenesisDigest: sealedPolicy.recordDigest,
    key: working.id,
    bindingDigest: recordDigest(bindingEnvelope),
    anchors,
    catalog,
    write,
  };
}

function anchorClient(fixture: CatalogFixture, reads: string[]): NativeFinalizedAnchorReadClient {
  return {
    async lookupFinalizedAnchor(input) {
      reads.push(input.digest);
      return fixture.anchors.get(input.digest) ?? null;
    },
  };
}

async function openAndVerifyRole(
  fixture: CatalogFixture,
  client: NativeFinalizedAnchorReadClient,
  opened: { count: number },
): Promise<void> {
  const authority = await openNativeTrustCatalog({
    path: fixture.path,
    expectedPolicyGenesisDigest: fixture.policyGenesisDigest,
    anchorClient: client,
    settlementOwnershipClient: OWNS,
    now: new Date(NOW),
  });
  await authority.verifyRoleBinding({
    role: 'solver-delivery',
    key: fixture.key,
    agent: AGENT,
    family: FAMILY,
    atTime: NOW,
  });
  opened.count += 1;
}

describe('native trust catalog authority', () => {
  it('cryptographically verifies Ed25519 DSSE and refuses key-id-only forgery', () => {
    const pair = generateKeyPairSync('ed25519');
    const id = keyId(pair.publicKey);
    const payload = new TextEncoder().encode('{"ok":true}');
    const payloadType = 'application/test+json';
    const envelope = sealDsseEnvelope({
      payloadType,
      payloadBytes: payload,
      signatures: [{ keyid: id, signature: new Uint8Array(sign(null, dssePreAuthEncoding(payloadType, payload), pair.privateKey)) }],
    });
    expect(verifyNativeDsse(envelope).validSignerKeyids).toEqual([id]);

    const forged = sealDsseEnvelope({
      payloadType,
      payloadBytes: payload,
      signatures: [{ keyid: id, signature: new Uint8Array(64).fill(7) }],
    });
    expect(verifyNativeDsse(forged).validSignerKeyids).toEqual([]);
  });

  it('opens a role only through real policy, DSSE, EOA ceremony, and finalized anchor authority', async () => {
    const fixture = await buildCatalog();
    const reads: string[] = [];
    const opened = { count: 0 };
    await openAndVerifyRole(fixture, anchorClient(fixture, reads), opened);
    expect(opened.count).toBe(1);
    expect(reads).toEqual([...fixture.anchors.keys()]);
  });

  it.each([
    ['missing', () => null],
    ['unfinalized', (expected: Sha256Digest) => ({ ...observation(expected), finalized: false })],
    ['digest-mismatched', (expected: Sha256Digest) => observation(recordDigest(new TextEncoder().encode(`${expected}:other`)))],
  ])('refuses a %s canonical anchor before any role opens', async (_label, result) => {
    const fixture = await buildCatalog();
    const reads: string[] = [];
    const opened = { count: 0 };
    await expect(openAndVerifyRole(fixture, {
      async lookupFinalizedAnchor(input) {
        reads.push(input.digest);
        return result(input.digest) as never;
      },
    }, opened)).rejects.toThrow(/anchor .* missing, non-finalized, or mismatched/u);
    expect(reads).toHaveLength(1);
    expect(opened.count).toBe(0);
  });

  it.each([
    ['ceremony commitment digest mismatch', { ceremonyMode: 'digest-mismatch' as const }, /ceremony evidence digest/u],
    ['ceremony signature mismatch', { ceremonyMode: 'bad-signature' as const }, /ceremony-verification-failed/u],
    ['ceremony signed-content mismatch', { ceremonyMode: 'bad-content' as const }, /ceremony-verification-failed/u],
    ['missing role purpose', { purpose: 'missing' as const }, /has no native:solver-delivery purpose/u],
    ['not-yet-effective binding', { validFrom: '2026-08-03T00:00:00.000Z' }, /binding did not resolve/u],
    ['expired binding', { expiresAt: '2026-08-02T00:00:00.000Z' }, /binding did not resolve/u],
    ['revoked binding', { revoked: true }, /revoked/u],
    ['conflicting bindings', { conflict: true }, /conflicting bindings/u],
    ['forged binding envelope', { forgeBindingEnvelope: true }, /envelope-signature-invalid/u],
  ])('refuses %s and never opens the role', async (_label, options, expected) => {
    const fixture = await buildCatalog(options);
    const opened = { count: 0 };
    await expect(openAndVerifyRole(fixture, anchorClient(fixture, []), opened)).rejects.toThrow(expected);
    expect(opened.count).toBe(0);
  });

  it('refuses catalog mutation and catalog-controlled policy pins before any role opens', async () => {
    const fixture = await buildCatalog();
    const opened = { count: 0 };
    const mutated = structuredClone(fixture.catalog);
    const policies = mutated.policies as { digest: string; envelope: string }[];
    policies[0]!.envelope = b64(new TextEncoder().encode('{}'));
    await fixture.write(mutated);
    await expect(openAndVerifyRole(fixture, anchorClient(fixture, []), opened)).rejects.toThrow(/policy digest mismatch/u);
    expect(opened.count).toBe(0);

    await fixture.write(fixture.catalog);
    let anchorReads = 0;
    await expect(openNativeTrustCatalog({
      path: fixture.path,
      expectedPolicyGenesisDigest: recordDigest(new TextEncoder().encode('deployment-selected-policy')),
      anchorClient: { async lookupFinalizedAnchor() { anchorReads += 1; return null; } },
      settlementOwnershipClient: OWNS,
    })).rejects.toThrow(/does not match structured deployment authority/u);
    expect(anchorReads).toBe(0);

    const link = join(fixture.root, 'trust-link.json');
    await symlink(fixture.path, link);
    await expect(openNativeTrustCatalog({
      path: link,
      expectedPolicyGenesisDigest: fixture.policyGenesisDigest,
      anchorClient: { async lookupFinalizedAnchor() { return null; } },
      settlementOwnershipClient: OWNS,
    })).rejects.toThrow(/regular non-symlink/u);
  });

  it('fails closed when the catalog bytes change after the authority snapshot opens', async () => {
    const fixture = await buildCatalog();
    const authority = await openNativeTrustCatalog({
      path: fixture.path,
      expectedPolicyGenesisDigest: fixture.policyGenesisDigest,
      anchorClient: anchorClient(fixture, []),
      settlementOwnershipClient: OWNS,
      now: new Date(NOW),
    });
    await expect(authority.assertFresh()).resolves.toBeUndefined();

    await writeFile(fixture.path, `${JSON.stringify(fixture.catalog)}\n`);
    await expect(authority.assertFresh()).rejects.toThrow(/changed after authority load; restart is required/u);
  });
});

/**
 * The settlement-authority association (spec/2026-08-07 §2.3c).
 *
 * The pre-amendment check compared the ceremony's `message.address` to the settlement address —
 * unsatisfiable for a real operator, because a Safe is a contract and cannot produce the EIP-191
 * signature the ceremony leg requires. Every refusal path below is a mutation that the old check
 * either could not express or did not catch; PR1's reviewer flagged M7 (dropping the third
 * settlement resource) as caught by nothing in-tree.
 */
describe('settlement-authority association (§2.3c)', () => {
  async function openSettlement(
    fixture: CatalogFixture,
    ownership: NativeSettlementOwnershipReadClient = OWNS,
  ) {
    return openNativeTrustCatalog({
      path: fixture.path,
      expectedPolicyGenesisDigest: fixture.policyGenesisDigest,
      anchorClient: anchorClient(fixture, []),
      settlementOwnershipClient: ownership,
      now: new Date(NOW),
    });
  }

  const probe = (fixture: CatalogFixture) => ({
    key: fixture.key,
    agent: AGENT,
    address: SAFE,
    atTime: NOW,
    purpose: 'native:solver-settlement' as const,
  });

  it('admits a Safe-scoped binding whose ceremony declares that Safe and whose signer the Safe owns', async () => {
    const fixture = await buildCatalog({ settlement: {} });
    const seen: [string, string][] = [];
    const authority = await openSettlement(fixture, {
      async isOwner(safe, candidate) { seen.push([safe, candidate]); return true; },
    });

    const result = await authority.verifyOnchainAuthority(probe(fixture));

    expect(result.bindingDigest).toBe(fixture.bindingDigest);
    // Step 5 reads `Safe.isOwner(recoveredSigner)` — the Safe under verification, the EOA that
    // actually signed. Not the other way round, and not the declared `message.address`.
    expect(seen).toEqual([[SAFE, ACCOUNT.address]]);
  });

  it('refuses a settlement ceremony with NO third resource (mutation M7)', async () => {
    const fixture = await buildCatalog({ settlement: { thirdResource: null } });
    const authority = await openSettlement(fixture);

    await expect(authority.verifyOnchainAuthority(probe(fixture)))
      .rejects.toThrow(/declares no settlement resource/u);
  });

  it('refuses a third resource naming a DIFFERENT Safe', async () => {
    const fixture = await buildCatalog({
      settlement: { thirdResource: didPkh(84532, `0x${'be'.repeat(20)}`) },
    });
    const authority = await openSettlement(fixture);

    await expect(authority.verifyOnchainAuthority(probe(fixture)))
      .rejects.toThrow(/declares settlement resource did:pkh:eip155:84532:0x[bB][eE]/u);
  });

  it('refuses a third resource that is not a Base Sepolia did:pkh account', async () => {
    const fixture = await buildCatalog({ settlement: { thirdResource: `https://example.test/${SAFE}` } });
    const authority = await openSettlement(fixture);

    await expect(authority.verifyOnchainAuthority(probe(fixture)))
      .rejects.toThrow(/declares settlement resource https:\/\/example\.test/u);
  });

  it('refuses a ceremony that lies about its signer (message.address !== recovered)', async () => {
    // The forgery `verified()` cannot see: the ceremony is genuinely signed by ACCOUNT (which IS the
    // binding's voucher, so `verifyEoaCeremony` passes), but `message.address` names a different
    // EOA — so the Safe-ownership read would be pointed at an address that never signed.
    const fixture = await buildCatalog({
      settlement: { declaredAddress: OTHER_ACCOUNT.address },
    });
    const authority = await openSettlement(fixture);

    await expect(authority.verifyOnchainAuthority(probe(fixture)))
      .rejects.toThrow(/ceremony declares signer .* but was signed by /u);
  });

  it('refuses when the Safe does not own the ceremony signer (isOwner false)', async () => {
    const fixture = await buildCatalog({ settlement: {} });
    const authority = await openSettlement(fixture, { async isOwner() { return false; } });

    await expect(authority.verifyOnchainAuthority(probe(fixture)))
      .rejects.toThrow(/does not own ceremony signer/u);
  });

  it('refuses fail-closed, with a DISTINCT error, when the ownership read itself fails', async () => {
    const fixture = await buildCatalog({ settlement: {} });
    const authority = await openSettlement(fixture, {
      async isOwner() { throw new Error('rpc unavailable'); },
    });

    // Distinct from the `false` refusal: an unreachable chain must never read as "not an owner",
    // and must never read as authorized either.
    await expect(authority.verifyOnchainAuthority(probe(fixture)))
      .rejects.toThrow(/Safe-ownership read for .* failed: .*rpc unavailable/u);
  });

  it('never reaches the chain read when the unchanged verified() pipeline already refuses', async () => {
    const fixture = await buildCatalog({ settlement: {}, ceremonyMode: 'bad-signature' });
    let reads = 0;
    const authority = await openSettlement(fixture, {
      async isOwner() { reads += 1; return true; },
    });

    await expect(authority.verifyOnchainAuthority(probe(fixture))).rejects.toThrow(/ceremony-verification-failed/u);
    expect(reads).toBe(0);
  });
});
