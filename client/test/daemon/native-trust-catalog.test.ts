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
} from '../../src/daemon/native-trust-catalog.js';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const NOW = '2026-08-02T12:00:00.000Z';
const VALID_FROM = '2026-08-01T00:00:00.000Z';
const ANCHOR_TIME = '2026-08-01T00:01:00.000Z';
const AGENT = 'https://jinn.network/agents/native-solver';
const ROLE_PURPOSE = 'native:solver-delivery';
const FAMILY = 'deliveries';
const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);

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

async function eoaCeremony(agent: string, didKey: string, mode: 'valid' | 'bad-signature' | 'bad-content' = 'valid'):
Promise<EoaCeremonyEvidence> {
  const message = {
    domain: 'trust.jinn.network',
    address: ACCOUNT.address,
    uri: 'https://trust.jinn.network/ceremony/key-binding',
    version: '1' as const,
    chainId: 84532,
    nonce: 'phase-b-native-catalog',
    issuedAt: VALID_FROM,
    resources: [agent, didKey],
  };
  const signedMessage = mode === 'bad-content'
    ? { ...message, resources: ['https://jinn.network/agents/attacker', didKey] }
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
    profile: 'https://jinn.network/trust/anchor-locators/base-sepolia-calldata-v1' as const,
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

async function buildCatalog(options: {
  readonly purpose?: 'present' | 'missing';
  readonly validFrom?: string;
  readonly expiresAt?: string;
  readonly ceremonyMode?: 'valid' | 'bad-signature' | 'bad-content' | 'digest-mismatch';
  readonly revoked?: boolean;
  readonly conflict?: boolean;
  readonly forgeBindingEnvelope?: boolean;
} = {}): Promise<CatalogFixture> {
  const root = await mkdtemp(join(tmpdir(), 'jinn-native-trust-'));
  const path = join(root, 'trust.json');
  const pair = generateKeyPairSync('ed25519');
  const working = ed25519Signer(pair);
  const anchorDigest = recordDigest(new TextEncoder().encode('binding-anchor'));
  const ceremony = await eoaCeremony(AGENT, working.id,
    options.ceremonyMode === 'bad-signature' || options.ceremonyMode === 'bad-content'
      ? options.ceremonyMode
      : 'valid');
  const binding: KeyBinding = {
    protocol: 'https://jinn.network/trust/key-binding/v1',
    agent: AGENT,
    key: { publicKey: working.id, keyid: working.id, algorithm: 'Ed25519', didKey: working.id },
    voucher: { kind: 'account', did: didPkh(84532, ACCOUNT.address), contractAccount: false },
    relationship: 'controls',
    scope: ['bindings', FAMILY],
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
    protocol: 'https://jinn.network/trust/policy/v1',
    version: 1,
    purposes: options.purpose === 'missing' ? {} : {
      [ROLE_PURPOSE]: { accepted: [AGENT], requiredStrength: 'strong' },
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
      protocol: 'https://jinn.network/trust/revocation/v1',
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
    })).rejects.toThrow(/does not match structured deployment authority/u);
    expect(anchorReads).toBe(0);

    const link = join(fixture.root, 'trust-link.json');
    await symlink(fixture.path, link);
    await expect(openNativeTrustCatalog({
      path: link,
      expectedPolicyGenesisDigest: fixture.policyGenesisDigest,
      anchorClient: { async lookupFinalizedAnchor() { return null; } },
    })).rejects.toThrow(/regular non-symlink/u);
  });
});
