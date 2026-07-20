/**
 * Live publish wiring — real IPFS + real ERC-8004 anchor on Base Sepolia
 * (plan Task 4's human surface; issue #1311).
 *
 * Mirrors the daemon's `createLiveCapturePublisher` dep construction
 * (client/src/captures/live-publisher.ts) with explicit config instead of
 * daemon bootstrap state, so `jinn-layer publish` can run outside the
 * daemon. Testnet only in v0.
 */

import { Buffer } from 'node:buffer';
import type { Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { createClients } from '../../../src/adapters/mech/safe.js';
import { uploadToIpfs } from '../../../src/adapters/mech/ipfs.js';
import { canonicalJson } from '../../../src/harnesses/engine/canonical-json.js';
import {
  codeDigestSha256ToBytes32,
  contentKindForAnchor,
  encodeExecutionPayloadV2,
  IdentityPublisher,
  modeStringToFlag,
  type ExecutionPayloadV2,
} from '../../../src/erc8004/index.js';
import { sha256Hex } from '../../../src/captures/publish.js';
import { createFileLedger } from './ledger.js';
import type { ManifestBatchPublishDeps } from './publish.js';

const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1' as const;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as const;

/** Base Sepolia defaults — mirror client/src/earning/contracts.ts. */
export const DEFAULT_TESTNET_RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
export const DEFAULT_TESTNET_IDENTITY_REGISTRY =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
export const DEFAULT_IPFS_REGISTRY_URL = 'https://registry.autonolas.tech';

export interface ManifestAnchorStore {
  saveErc8004Anchor(input: {
    envelopeId: string;
    envelopeCid: string;
    contentKind: string;
    metadataKey: string;
    agentId: string;
    chainId: number;
    identityRegistryAddress: string;
    txHash: string;
    blockNumber: number | null;
    payloadHex: string;
    anchoredAt: number;
    gasUsed?: string | null;
    feeWei?: string | null;
  }): void;
  loadManifestBatchJournal(batchKey: string): string | null;
  saveManifestBatchJournal(batchKey: string, stateJson: string): void;
}

export interface LivePublishConfig {
  /** Operator agent EOA key — signs the envelope and the anchor tx. */
  privateKey: `0x${string}`;
  /** Operator Safe (participant identity). */
  safeAddress: `0x${string}`;
  /** ERC-8004 agent NFT id the anchor is published under. */
  agentId: bigint;
  rpcUrl?: string;
  identityRegistry?: `0x${string}`;
  ipfsRegistryUrl?: string;
  /** Access endpoint recorded on the published artifact. */
  endpoint?: string;
  ledgerPath?: string;
  clientGitSha?: string;
  /** Durable anchor telemetry sink. Required when manifest mode is exercised. */
  store?: ManifestAnchorStore;
}

/** Build real publish deps: IPFS uploads + ERC-8004 anchor + file ledger. */
export function createLivePublishDeps(config: LivePublishConfig): ManifestBatchPublishDeps {
  const rpcUrl = config.rpcUrl ?? DEFAULT_TESTNET_RPC_URL;
  const ipfsRegistryUrl = config.ipfsRegistryUrl ?? DEFAULT_IPFS_REGISTRY_URL;
  const endpoint = config.endpoint ?? 'http://127.0.0.1:7331';
  const { publicClient, walletClient, account } = createClients(
    rpcUrl,
    config.privateKey,
    baseSepolia,
  );
  const identityPublisher = new IdentityPublisher({
    identityRegistryAddress: config.identityRegistry ?? DEFAULT_TESTNET_IDENTITY_REGISTRY,
    agentId: config.agentId,
    walletClient,
    publicClient,
  });

  return {
    participant: { safeAddress: config.safeAddress, agentEoa: account.address },
    signer: { address: account.address, privateKey: config.privateKey },
    clientGitSha: config.clientGitSha ?? 'harness-layer-cli',
    defaultArtifactEndpoint: endpoint,
    ledger: createFileLedger(config.ledgerPath),
    publishArtifact: async ({ artifactType, payload }) => {
      const content = Buffer.from(canonicalJson(payload), 'utf8');
      const sha256 = sha256Hex(content);
      const cid = await uploadToIpfs(ipfsRegistryUrl, {
        schemaVersion: DONATION_ARTIFACT_ENCODING,
        artifactType,
        sha256,
        encoding: DONATION_ARTIFACT_ENCODING,
        data: content.toString('base64'),
      });
      return { cid, sha256, endpoint, priceUsdc: '0' };
    },
    publishEnvelope: async (envelope) => {
      const cid = await uploadToIpfs(ipfsRegistryUrl, envelope);
      return { cid, sha256: sha256Hex(canonicalJson(envelope)), endpoint, priceUsdc: '0' };
    },
    publishManifestBody: async (body) => {
      const cid = await uploadToIpfs(ipfsRegistryUrl, body, { rawLeaves: true });
      return { cid, sha256: sha256Hex(canonicalJson(body)), endpoint, priceUsdc: '0' };
    },
    anchorEnvelope: async ({
      metadataKey,
      envelopeCid,
      envelopeHash,
      envelope,
      requireSuccessfulReceipt,
      onBroadcast,
      onPrepared,
    }) => {
      const payload: ExecutionPayloadV2 = {
        version: 2,
        tier: 0,
        manifestHash: envelopeHash as Hex,
        attestationQuoteCid: '0x',
        sourceMeasurement: ZERO_BYTES32,
        codeDigest: codeDigestSha256ToBytes32(envelope.executor.codeDigest),
        implName: envelope.executor.implName,
        modeFlag: modeStringToFlag(envelope.executor.mode ?? 'train'),
      };
      const contentKind = contentKindForAnchor(metadataKey, envelopeCid);
      const payloadHex = encodeExecutionPayloadV2(payload);
      onPrepared?.(payloadHex);
      const { txHash, blockNumber, gasUsed, feeWei } =
        await identityPublisher.publishContentV2({
          kind: contentKind,
          cid: envelopeCid,
          payload,
          requireSuccessfulReceipt,
          onBroadcast,
        });
      return { txHash, blockNumber, gasUsed, feeWei, payloadHex };
    },
    anchorManifest: async ({ manifestCid, payload, onBroadcast }) => {
      const { txHash, blockNumber, gasUsed, feeWei } =
        await identityPublisher.publishManifest({
          manifestCid,
          payload,
          onBroadcast,
        });
      return { txHash, blockNumber, gasUsed, feeWei };
    },
    manifestJournal: config.store,
    manifestPublicationScope: {
      chainId: identityPublisher.chainId,
      identityRegistryAddress: identityPublisher.registry,
      agentId: identityPublisher.agent.toString(),
    },
    reconcileAnchor: (txHash) =>
      identityPublisher.reconcileTransaction(txHash),
    recordManifestAnchor: (anchor) => {
      if (!config.store) {
        throw new Error(
          'manifest anchor recording requires a Store (configure LivePublishConfig.store)',
        );
      }
      config.store.saveErc8004Anchor({
        envelopeId: anchor.manifestCid,
        envelopeCid: anchor.manifestCid,
        contentKind: anchor.contentKind,
        metadataKey: anchor.metadataKey,
        agentId: identityPublisher.agent.toString(),
        chainId: identityPublisher.chainId,
        identityRegistryAddress: identityPublisher.registry,
        txHash: anchor.txHash,
        blockNumber: anchor.blockNumber,
        payloadHex: anchor.payloadHex,
        anchoredAt: anchor.anchoredAt,
        gasUsed: anchor.gasUsed?.toString() ?? null,
        feeWei: anchor.feeWei?.toString() ?? null,
      });
    },
    recordControlAnchor: (anchor) => {
      if (!config.store) {
        throw new Error(
          'per-record control recording requires a Store (configure LivePublishConfig.store)',
        );
      }
      config.store.saveErc8004Anchor({
        envelopeId: anchor.envelopeRef,
        envelopeCid: anchor.envelopeRef,
        contentKind: anchor.contentKind,
        metadataKey: anchor.metadataKey,
        agentId: identityPublisher.agent.toString(),
        chainId: identityPublisher.chainId,
        identityRegistryAddress: identityPublisher.registry,
        txHash: anchor.txHash,
        blockNumber: anchor.blockNumber,
        payloadHex: anchor.payloadHex,
        anchoredAt: anchor.anchoredAt,
        gasUsed: anchor.gasUsed.toString(),
        feeWei: anchor.feeWei.toString(),
      });
    },
    log: (line) => console.log(line),
  };
}
