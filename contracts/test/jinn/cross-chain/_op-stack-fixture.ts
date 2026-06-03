/**
 * Helpers for constructing OP-output-root + storage-proof-shaped fixtures for
 * `CanonicalOpStackMessenger`.
 *
 * Under Hardhat 3 there is no module-scope `ethers`; every helper that needs
 * the ethers utility surface receives the connection's `ethers` as its first
 * argument. Callers obtain it from `await network.connect()` and pass it in.
 */

import type { network } from 'hardhat';

type HardhatEthers = Awaited<ReturnType<typeof network.connect>>['ethers'];

export const claimTicketTopic = (ethers: HardhatEthers): string =>
  ethers.id('ClaimTicket(uint256,uint256,uint256,uint256,uint256,address,address)');

export const CLAIM_SNAPSHOT_HASHES_SLOT = 1n;

export interface ClaimSnapshotFields {
  claimId: bigint;
  serviceId: bigint;
  taskCreationWeight: bigint;
  solutionDeliveryWeight: bigint;
  verdictDeliveryWeight: bigint;
  multisig: string;
}

export interface OutputRootArtifacts {
  outputRoot: string;
  outputRootProofBytes: string;
  stateRoot: string;
  storageRoot: string;
  accountProof: string[];
  storageProof: string[];
}

export const OP_STACK_PROOF_TUPLE =
  '(bytes32 disputeGameId, bytes outputRootProof, bytes[] accountProof, bytes[] storageProof, uint256 claimId, uint256 serviceId, uint256 taskCreationWeight, uint256 solutionDeliveryWeight, uint256 verdictDeliveryWeight, address multisig)';

function leafPathForHashedKey(hashedKey: string): string {
  return `0x20${hashedKey.slice(2)}`;
}

function buildSingleLeafTrie(ethers: HardhatEthers, hashedKey: string, leafValue: string): {
  root: string;
  proof: string[];
} {
  const leaf = ethers.encodeRlp([leafPathForHashedKey(hashedKey), leafValue]);
  return {
    root: ethers.keccak256(leaf),
    proof: [leaf],
  };
}

export function snapshotHash(ethers: HardhatEthers, fields: ClaimSnapshotFields): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'address'],
      [
        fields.claimId,
        fields.serviceId,
        fields.taskCreationWeight,
        fields.solutionDeliveryWeight,
        fields.verdictDeliveryWeight,
        fields.multisig,
      ],
    ),
  );
}

export function claimSnapshotStorageSlot(ethers: HardhatEthers, claimId: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256'],
      [claimId, CLAIM_SNAPSHOT_HASHES_SLOT],
    ),
  );
}

/**
 * RLP-encode a 32-byte hash the way geth stores storage values: as a
 * scalar with leading zero bytes stripped. Mirrors the on-chain
 * `RLP.encode(uint256)` path used by `CanonicalOpStackMessenger`.
 *
 * - All-zero hash → `0x80` (the canonical empty-string encoding).
 * - Non-zero hash → strip leading zero bytes, then RLP-encode the
 *   trimmed bytes as a string (handled correctly by `ethers.encodeRlp`).
 */
export function rlpEncodeStorageValue(ethers: HardhatEthers, hash: string): string {
  const value = BigInt(hash);
  if (value === 0n) {
    return ethers.encodeRlp('0x');
  }
  // toBeHex with no length argument returns a minimal-length hex string,
  // i.e. with leading zero bytes already stripped.
  return ethers.encodeRlp(ethers.toBeHex(value));
}

/**
 * Build the output-root artifacts using an explicit storage value, even if
 * it does not match `snapshotHash(fields)`. Used to craft the leading-zero-
 * byte regression test where the messenger must accept a snapshot hash
 * with high zero bytes despite geth's `TrimLeftZeroes` storage encoding.
 *
 * In production callers should use {buildOutputRootArtifacts}; this
 * variant is a test escape hatch.
 */
export function buildOutputRootArtifactsWithStoredHash(
  ethers: HardhatEthers,
  emitter: string,
  claimId: bigint,
  storedSnapshotHash: string,
): OutputRootArtifacts {
  const slot = claimSnapshotStorageSlot(ethers, claimId);
  const storageTrieKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [slot]),
  );
  const storedValue = rlpEncodeStorageValue(ethers, storedSnapshotHash);
  const storageTrie = buildSingleLeafTrie(ethers, storageTrieKey, storedValue);

  const accountTrieKey = ethers.keccak256(emitter);
  const accountRlp = ethers.encodeRlp([
    '0x', // nonce
    '0x', // balance
    storageTrie.root,
    ethers.id('mock-emitter-code-hash'),
  ]);
  const accountTrie = buildSingleLeafTrie(ethers, accountTrieKey, accountRlp);

  const version = ethers.id('output-root-version-v1');
  const messagePasserStorageRoot = ethers.id('mock-msg-passer-root');
  const latestBlockHash = ethers.id('mock-latest-block-hash');
  const outputRoot = ethers.keccak256(
    ethers.concat([version, accountTrie.root, messagePasserStorageRoot, latestBlockHash]),
  );
  const outputRootProofBytes = ethers.AbiCoder.defaultAbiCoder().encode(
    ['(bytes32,bytes32,bytes32,bytes32)'],
    [[version, accountTrie.root, messagePasserStorageRoot, latestBlockHash]],
  );

  return {
    outputRoot,
    outputRootProofBytes,
    stateRoot: accountTrie.root,
    storageRoot: storageTrie.root,
    accountProof: accountTrie.proof,
    storageProof: storageTrie.proof,
  };
}

export function buildOutputRootArtifacts(
  ethers: HardhatEthers,
  emitter: string,
  fields: ClaimSnapshotFields,
): OutputRootArtifacts {
  const slot = claimSnapshotStorageSlot(ethers, fields.claimId);
  const storageTrieKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['bytes32'], [slot]),
  );
  const storedValue = rlpEncodeStorageValue(ethers, snapshotHash(ethers, fields));
  const storageTrie = buildSingleLeafTrie(ethers, storageTrieKey, storedValue);

  const accountTrieKey = ethers.keccak256(emitter);
  const accountRlp = ethers.encodeRlp([
    '0x', // nonce
    '0x', // balance
    storageTrie.root,
    ethers.id('mock-emitter-code-hash'),
  ]);
  const accountTrie = buildSingleLeafTrie(ethers, accountTrieKey, accountRlp);

  const version = ethers.id('output-root-version-v1');
  const messagePasserStorageRoot = ethers.id('mock-msg-passer-root');
  const latestBlockHash = ethers.id('mock-latest-block-hash');
  const outputRoot = ethers.keccak256(
    ethers.concat([version, accountTrie.root, messagePasserStorageRoot, latestBlockHash]),
  );
  const outputRootProofBytes = ethers.AbiCoder.defaultAbiCoder().encode(
    ['(bytes32,bytes32,bytes32,bytes32)'],
    [[version, accountTrie.root, messagePasserStorageRoot, latestBlockHash]],
  );

  return {
    outputRoot,
    outputRootProofBytes,
    stateRoot: accountTrie.root,
    storageRoot: storageTrie.root,
    accountProof: accountTrie.proof,
    storageProof: storageTrie.proof,
  };
}

export function encodeProof(ethers: HardhatEthers, args: {
  disputeGameId: string;
  outputRootProofBytes: string;
  accountProof: string[];
  storageProof: string[];
  fields: ClaimSnapshotFields;
}): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [OP_STACK_PROOF_TUPLE],
    [
      {
        disputeGameId: args.disputeGameId,
        outputRootProof: args.outputRootProofBytes,
        accountProof: args.accountProof,
        storageProof: args.storageProof,
        claimId: args.fields.claimId,
        serviceId: args.fields.serviceId,
        taskCreationWeight: args.fields.taskCreationWeight,
        solutionDeliveryWeight: args.fields.solutionDeliveryWeight,
        verdictDeliveryWeight: args.fields.verdictDeliveryWeight,
        multisig: args.fields.multisig,
      },
    ],
  );
}
