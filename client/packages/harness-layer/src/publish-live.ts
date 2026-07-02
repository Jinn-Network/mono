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
  encodeExecutionPayloadV2,
  IdentityPublisher,
  modeStringToFlag,
  type ExecutionPayloadV2,
} from '../../../src/erc8004/index.js';
import { sha256Hex } from '../../../src/captures/publish.js';
import { createFileLedger } from './ledger.js';
import type { HarnessPublishDeps } from './publish.js';

const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1' as const;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as const;

/** Base Sepolia defaults — mirror client/src/earning/contracts.ts. */
export const DEFAULT_TESTNET_RPC_URL = 'https://base-sepolia-rpc.publicnode.com';
export const DEFAULT_TESTNET_IDENTITY_REGISTRY =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
export const DEFAULT_IPFS_REGISTRY_URL = 'https://registry.autonolas.tech';

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
}

/** Build real publish deps: IPFS uploads + ERC-8004 anchor + file ledger. */
export function createLivePublishDeps(config: LivePublishConfig): HarnessPublishDeps {
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
    anchorEnvelope: async ({ envelopeCid, envelopeHash, envelope }) => {
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
      const { txHash, blockNumber } = await identityPublisher.publishContentV2({
        kind: 'capture',
        cid: envelopeCid,
        payload,
      });
      return { txHash, blockNumber };
    },
  };
}
