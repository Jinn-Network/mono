// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IClaimMessenger} from "../interfaces/IClaimMessenger.sol";
import {RLP} from "@openzeppelin/contracts/utils/RLP.sol";
import {TrieProof} from "@openzeppelin/contracts/utils/cryptography/TrieProof.sol";
import {Memory} from "@openzeppelin/contracts/utils/Memory.sol";

/// @notice Minimal interface to OP-Stack `DisputeGameFactory`.
interface IDisputeGameFactory {
    function gameAtIndex(uint256 _index)
        external
        view
        returns (uint32 gameType_, uint64 timestamp_, address proxy_);
}

/// @notice Generic OP-Stack dispute-game interface shared by legacy
///         CANNON games and Base Sepolia's Azul AggregateVerifier games.
interface IDisputeGame {
    function status() external view returns (uint8);
    function gameType() external view returns (uint32);
    function resolvedAt() external view returns (uint64);
    function rootClaim() external view returns (bytes32);
    function wasRespectedGameTypeWhenCreated() external view returns (bool);
}

/// @notice Minimal interface to OP-Stack `OptimismPortal2`.
interface IOptimismPortal2 {
    function respectedGameType() external view returns (uint32);
    function proofMaturityDelaySeconds() external view returns (uint256);
    function disputeGameFinalityDelaySeconds() external view returns (uint256);
}

/// @title CanonicalOpStackMessenger
/// @notice Implements `IClaimMessenger` against canonical OP-Stack output
///         roots. The proof validates a `TaskClaimEmitter.claimSnapshotHashes`
///         storage slot against the finalized L2 state root, then returns
///         the tuple committed by that snapshot hash.
contract CanonicalOpStackMessenger is IClaimMessenger {
    using RLP for *;
    using Memory for *;

    /// @notice L1 OptimismPortal2 anchoring the L2 output roots.
    address public immutable optimismPortal;

    /// @notice DisputeGameFactory used to look up dispute games that
    ///         finalize the L2 output root being proven.
    address public immutable disputeGameFactory;

    /// @notice Address of the deployed `TaskClaimEmitter` on Base /
    ///         Base Sepolia. The account proof must be for this address.
    address public immutable expectedEmitter;

    /// @notice topic0 of the `ClaimTicket` event. Kept as locked
    ///         deploy metadata for canary tooling and artifact checks.
    bytes32 public immutable claimTicketTopic;

    /// @notice Solidity storage slot of `claimSnapshotHashes`.
    ///         TaskClaimEmitter has `nextClaimId` at slot 0 and this
    ///         mapping at slot 1; immutables do not occupy storage slots.
    uint256 public constant CLAIM_SNAPSHOT_HASHES_SLOT = 1;

    /// @notice Decoded shape of the canonical storage proof.
    struct OpStackProof {
        bytes32 disputeGameId;
        bytes outputRootProof;
        bytes[] accountProof;
        bytes[] storageProof;
        uint256 claimId;
        uint256 serviceId;
        uint256 taskCreationWeight;
        uint256 solutionDeliveryWeight;
        uint256 verdictDeliveryWeight;
        address multisig;
    }

    /// @notice OP-Stack output-root proof preimage. `stateRoot` is used
    ///         for the account proof; all four fields recompute the game's
    ///         output root.
    struct OutputRootProof {
        bytes32 version;
        bytes32 stateRoot;
        bytes32 messagePasserStorageRoot;
        bytes32 latestBlockHash;
    }

    error InvalidDisputeGame();
    error GameNotResolved();
    error AirgapNotElapsed();
    error WrongGameType();
    error OutputRootMismatch();
    error AccountMPTInvalid();
    error StorageRootMissing();
    error StorageMPTInvalid();
    error SnapshotHashMismatch();

    uint8 private constant GAME_STATUS_DEFENDER_WINS = 2;

    constructor(
        address _optimismPortal,
        address _disputeGameFactory,
        address _expectedEmitter,
        bytes32 _claimTicketTopic
    ) {
        require(_optimismPortal != address(0), "CanonicalMessenger: portal=0");
        require(_disputeGameFactory != address(0), "CanonicalMessenger: factory=0");
        require(_expectedEmitter != address(0), "CanonicalMessenger: emitter=0");
        require(_claimTicketTopic != bytes32(0), "CanonicalMessenger: topic=0");
        optimismPortal = _optimismPortal;
        disputeGameFactory = _disputeGameFactory;
        expectedEmitter = _expectedEmitter;
        claimTicketTopic = _claimTicketTopic;
    }

    /// @inheritdoc IClaimMessenger
    function verifyClaim(bytes calldata proof)
        external
        view
        override
        returns (
            uint256 serviceId,
            uint256 taskCreationWeight,
            uint256 solutionDeliveryWeight,
            uint256 verdictDeliveryWeight,
            address multisig
        )
    {
        require(proof.length > 0, "CanonicalMessenger: empty proof");
        OpStackProof memory p = abi.decode(proof, (OpStackProof));

        bytes32 l2OutputRoot = _verifyDisputeGame(p.disputeGameId);
        bytes32 stateRoot = _verifyOutputRoot(p.outputRootProof, l2OutputRoot);

        bytes32 expectedSnapshotHash = keccak256(
            abi.encode(
                p.claimId,
                p.serviceId,
                p.taskCreationWeight,
                p.solutionDeliveryWeight,
                p.verdictDeliveryWeight,
                p.multisig
            )
        );

        bytes32 storageRoot = _verifyEmitterAccount(stateRoot, p.accountProof);
        _verifySnapshotStorage(p.claimId, expectedSnapshotHash, storageRoot, p.storageProof);

        return (
            p.serviceId,
            p.taskCreationWeight,
            p.solutionDeliveryWeight,
            p.verdictDeliveryWeight,
            p.multisig
        );
    }

    function _verifyDisputeGame(bytes32 disputeGameId) internal view returns (bytes32) {
        if (disputeGameId == bytes32(0)) revert InvalidDisputeGame();
        uint256 index = uint256(disputeGameId);

        (uint32 factoryGameType, , address proxy) =
            IDisputeGameFactory(disputeGameFactory).gameAtIndex(index);
        if (proxy == address(0)) revert InvalidDisputeGame();

        IDisputeGame game = IDisputeGame(proxy);
        uint32 proxyGameType = game.gameType();
        if (proxyGameType != factoryGameType) revert WrongGameType();

        IOptimismPortal2 portal = IOptimismPortal2(optimismPortal);

        // Azul compatibility: accept the game type that was respected
        // when the game was created. If the portal has since moved to a
        // new type, old respected games remain valid.
        if (
            !game.wasRespectedGameTypeWhenCreated()
                && proxyGameType != portal.respectedGameType()
        ) {
            revert WrongGameType();
        }

        if (game.status() != GAME_STATUS_DEFENDER_WINS) revert GameNotResolved();

        uint256 resolvedAt = uint256(game.resolvedAt());
        uint256 proofMaturity = portal.proofMaturityDelaySeconds();
        uint256 gameFinality = portal.disputeGameFinalityDelaySeconds();
        if (
            resolvedAt == 0
                || block.timestamp < resolvedAt + proofMaturity
                || block.timestamp < resolvedAt + gameFinality
        ) {
            revert AirgapNotElapsed();
        }

        return game.rootClaim();
    }

    function _verifyOutputRoot(bytes memory outputRootProof, bytes32 l2OutputRoot)
        internal
        pure
        returns (bytes32 stateRoot)
    {
        OutputRootProof memory orp = abi.decode(outputRootProof, (OutputRootProof));
        bytes32 recomputed = keccak256(
            abi.encodePacked(
                orp.version,
                orp.stateRoot,
                orp.messagePasserStorageRoot,
                orp.latestBlockHash
            )
        );
        if (recomputed != l2OutputRoot) revert OutputRootMismatch();
        return orp.stateRoot;
    }

    function _verifyEmitterAccount(bytes32 stateRoot, bytes[] memory accountProof)
        internal
        view
        returns (bytes32 storageRoot)
    {
        if (stateRoot == bytes32(0) || accountProof.length == 0) revert AccountMPTInvalid();

        bytes memory accountKey = abi.encodePacked(keccak256(abi.encodePacked(expectedEmitter)));
        bytes memory accountRlp = TrieProof.traverse(stateRoot, accountKey, accountProof);
        Memory.Slice[] memory fields = accountRlp.decodeList();
        // Canonical Ethereum accounts are exactly 4 fields:
        // [nonce, balance, storageRoot, codeHash]. Reject anything
        // else as malformed up front — keeps the proof shape pinned.
        if (fields.length != 4) revert AccountMPTInvalid();

        storageRoot = fields[2].readBytes32();
        if (storageRoot == bytes32(0)) revert StorageRootMissing();
    }

    function _verifySnapshotStorage(
        uint256 claimId,
        bytes32 expectedSnapshotHash,
        bytes32 storageRoot,
        bytes[] memory storageProof
    ) internal pure {
        if (storageProof.length == 0) revert StorageMPTInvalid();

        bytes32 mappingSlot = keccak256(abi.encode(claimId, CLAIM_SNAPSHOT_HASHES_SLOT));
        bytes memory storageKey = abi.encodePacked(keccak256(abi.encode(mappingSlot)));
        // Geth stores storage values in the trie with leading zero
        // bytes stripped (see geth's `TrimLeftZeroes`). RLP.encode of
        // a `uint256` performs the same scalar encoding, while
        // RLP.encode of a `bytes32` keeps all 32 bytes verbatim. We
        // must encode as a scalar to match the on-chain leaf for any
        // snapshot hash whose high bytes happen to be zero.
        bytes memory expectedValue = RLP.encode(uint256(expectedSnapshotHash));
        if (!TrieProof.verify(expectedValue, storageRoot, storageKey, storageProof)) {
            revert SnapshotHashMismatch();
        }
    }
}
