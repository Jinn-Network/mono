// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title MarketplaceRequestData
/// @notice Frozen abi.encode requestData helpers for revised-generation Mech Deliver joins.
/// @dev Projector and settlement decode this blob unambiguously (no packed encoding).
///      v2 binds verdictCode into the digest preimage so claim cannot choose it freely.
library MarketplaceRequestData {
    /// @dev Domain marker bound into every revised requestData blob.
    bytes32 internal constant DOMAIN = keccak256("jinn.marketplace.revised");

    /// @dev Encoding version for DOMAIN (v2 adds verdictCode).
    uint8 internal constant VERSION = 2;

    uint8 internal constant LEG_SOLUTION = 1;
    uint8 internal constant LEG_VERDICT = 2;

    /// @dev Verdict-index sentinel for solution legs.
    uint32 internal constant SOLUTION_VERDICT_SENTINEL = 0;

    /// @dev Verdict-code sentinel for solution legs.
    uint8 internal constant SOLUTION_VERDICT_CODE_SENTINEL = 0;

    error MRDInvalidDomain(bytes32 domain);
    error MRDInvalidVersion(uint8 version);
    error MRDInvalidLegKind(uint8 legKind);
    error MRDZeroDigest();
    error MRDInvalidVerdictCode(uint8 verdictCode);

    struct Decoded {
        bytes32 domain;
        uint8 version;
        uint8 legKind;
        uint256 taskId;
        uint32 attemptIndex;
        uint32 verdictIndex;
        bytes32 deliveryDigest;
        uint8 verdictCode;
    }

    /// @notice Encode frozen requestData for a solution leg.
    function encodeSolution(uint256 taskId, uint32 attemptIndex, bytes32 deliveryDigest)
        internal
        pure
        returns (bytes memory)
    {
        if (deliveryDigest == bytes32(0)) revert MRDZeroDigest();
        return abi.encode(
            DOMAIN,
            VERSION,
            LEG_SOLUTION,
            taskId,
            attemptIndex,
            SOLUTION_VERDICT_SENTINEL,
            deliveryDigest,
            SOLUTION_VERDICT_CODE_SENTINEL
        );
    }

    /// @notice Encode frozen requestData for a verdict leg (verdictCode is part of the digest preimage).
    function encodeVerdict(
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        bytes32 deliveryDigest,
        uint8 verdictCode
    ) internal pure returns (bytes memory) {
        if (deliveryDigest == bytes32(0)) revert MRDZeroDigest();
        if (verdictCode == 0 || verdictCode > 4) revert MRDInvalidVerdictCode(verdictCode);
        return abi.encode(
            DOMAIN, VERSION, LEG_VERDICT, taskId, attemptIndex, verdictIndex, deliveryDigest, verdictCode
        );
    }

    /// @notice Decode and validate a frozen requestData blob.
    function decode(bytes memory data) internal pure returns (Decoded memory decoded) {
        (
            bytes32 domain,
            uint8 version,
            uint8 legKind,
            uint256 taskId,
            uint32 attemptIndex,
            uint32 verdictIndex,
            bytes32 deliveryDigest,
            uint8 verdictCode
        ) = abi.decode(data, (bytes32, uint8, uint8, uint256, uint32, uint32, bytes32, uint8));

        if (domain != DOMAIN) revert MRDInvalidDomain(domain);
        if (version != VERSION) revert MRDInvalidVersion(version);
        if (legKind != LEG_SOLUTION && legKind != LEG_VERDICT) revert MRDInvalidLegKind(legKind);
        if (deliveryDigest == bytes32(0)) revert MRDZeroDigest();
        if (legKind == LEG_SOLUTION) {
            if (verdictIndex != SOLUTION_VERDICT_SENTINEL) revert MRDInvalidLegKind(legKind);
            if (verdictCode != SOLUTION_VERDICT_CODE_SENTINEL) revert MRDInvalidVerdictCode(verdictCode);
        } else {
            if (verdictCode == 0 || verdictCode > 4) revert MRDInvalidVerdictCode(verdictCode);
        }

        decoded = Decoded({
            domain: domain,
            version: version,
            legKind: legKind,
            taskId: taskId,
            attemptIndex: attemptIndex,
            verdictIndex: verdictIndex,
            deliveryDigest: deliveryDigest,
            verdictCode: verdictCode
        });
    }
}

/// @title MarketplaceRequestDataView
/// @notice External helpers exposing encode/decode constants for off-chain consumers and tests.
contract MarketplaceRequestDataView {
    bytes32 public constant DOMAIN = MarketplaceRequestData.DOMAIN;
    uint8 public constant VERSION = MarketplaceRequestData.VERSION;
    uint8 public constant LEG_SOLUTION = MarketplaceRequestData.LEG_SOLUTION;
    uint8 public constant LEG_VERDICT = MarketplaceRequestData.LEG_VERDICT;
    uint32 public constant SOLUTION_VERDICT_SENTINEL = MarketplaceRequestData.SOLUTION_VERDICT_SENTINEL;
    uint8 public constant SOLUTION_VERDICT_CODE_SENTINEL = MarketplaceRequestData.SOLUTION_VERDICT_CODE_SENTINEL;

    function encodeSolution(uint256 taskId, uint32 attemptIndex, bytes32 deliveryDigest)
        external
        pure
        returns (bytes memory)
    {
        return MarketplaceRequestData.encodeSolution(taskId, attemptIndex, deliveryDigest);
    }

    function encodeVerdict(
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        bytes32 deliveryDigest,
        uint8 verdictCode
    ) external pure returns (bytes memory) {
        return MarketplaceRequestData.encodeVerdict(taskId, attemptIndex, verdictIndex, deliveryDigest, verdictCode);
    }

    function decode(bytes memory data) external pure returns (MarketplaceRequestData.Decoded memory) {
        return MarketplaceRequestData.decode(data);
    }
}
