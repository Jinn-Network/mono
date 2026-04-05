// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IEligibilityChecker} from "./IEligibilityChecker.sol";

/// @dev Provided zero address.
error ZeroAddress();

/// @dev Zero value when it has to be different from zero.
error ZeroValue();

/// @dev Only owner can call this function.
error OwnerOnly(address sender, address owner);

/// @dev Request already has an active (non-expired) claim.
error JobAlreadyClaimed(bytes32 requestId, address claimer);

/// @dev Provider does not meet eligibility requirements.
error IneligibleToClaim(address provider, bytes32 requestId);

/// @dev Claim has not expired yet.
error ClaimNotExpired(bytes32 requestId);

/// @dev Caller is not the claim owner.
error NotClaimOwner(address sender, bytes32 requestId);

/// @dev No claim exists for this request.
error NoClaimExists(bytes32 requestId);

/// @title ClaimRegistry - On-chain claim coordination for marketplace requests
/// @author JIN Network
/// @notice Operators call claimJob() before starting work on a marketplace request.
///         Other operators see the claim on-chain and skip. Claims expire after claimTTL
///         seconds — expired claims can be reclaimed by anyone. Eligibility is delegated
///         to a swappable IEligibilityChecker (same pattern as OLAS activity checkers).
contract ClaimRegistry {
    struct Claim {
        address claimer;
        uint256 expiresAt;
    }

    /// @dev Eligibility checker (swappable by owner). Zero address = no check.
    IEligibilityChecker public eligibilityChecker;

    /// @dev Contract owner
    address public owner;

    /// @dev Time-to-live for claims in seconds
    uint256 public claimTTL;

    /// @dev Active claims: requestId → Claim
    mapping(bytes32 => Claim) public claims;

    /// @dev Count of expired claims per address (punishment/reputation data)
    mapping(address => uint256) public expiredClaimCount;

    event JobClaimed(bytes32 indexed requestId, address indexed claimer, uint256 expiresAt);
    event ClaimExpired(bytes32 indexed requestId, address indexed previousClaimer);
    event ClaimReleased(bytes32 indexed requestId, address indexed claimer);
    event EligibilityCheckerUpdated(address indexed oldChecker, address indexed newChecker);
    event ClaimTTLUpdated(uint256 oldTTL, uint256 newTTL);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(uint256 _claimTTL, address _owner) {
        if (_claimTTL == 0) revert ZeroValue();
        if (_owner == address(0)) revert ZeroAddress();
        claimTTL = _claimTTL;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ============ Claiming ============

    /// @notice Claim a marketplace request before starting work.
    /// @dev Expired claims are automatically cleared and counted as punishment.
    ///      Reverts if an active claim exists or eligibility check fails.
    /// @param requestId The marketplace request ID to claim
    function claimJob(bytes32 requestId) external {
        Claim memory existing = claims[requestId];

        if (existing.claimer != address(0)) {
            if (block.timestamp < existing.expiresAt) {
                // Active claim exists — revert
                revert JobAlreadyClaimed(requestId, existing.claimer);
            }
            // Expired claim — clear and count as punishment
            expiredClaimCount[existing.claimer] += 1;
            emit ClaimExpired(requestId, existing.claimer);
        }

        // Check eligibility if checker is set
        if (address(eligibilityChecker) != address(0)) {
            if (!eligibilityChecker.canClaim(msg.sender, requestId)) {
                revert IneligibleToClaim(msg.sender, requestId);
            }
        }

        // Record claim
        uint256 expiresAt = block.timestamp + claimTTL;
        claims[requestId] = Claim(msg.sender, expiresAt);
        emit JobClaimed(requestId, msg.sender, expiresAt);
    }

    /// @notice Release a claim voluntarily (no punishment).
    /// @dev Only the claimer can release. Useful when an operator realizes
    ///      they can't deliver and wants to free the request for others.
    /// @param requestId The marketplace request ID to release
    function releaseClaim(bytes32 requestId) external {
        Claim memory existing = claims[requestId];
        if (existing.claimer == address(0)) revert NoClaimExists(requestId);
        if (existing.claimer != msg.sender) revert NotClaimOwner(msg.sender, requestId);

        delete claims[requestId];
        emit ClaimReleased(requestId, msg.sender);
    }

    /// @notice Expire a stale claim (anyone can call for garbage collection).
    /// @dev Increments expiredClaimCount for the previous claimer as punishment.
    /// @param requestId The marketplace request ID with an expired claim
    function expireClaim(bytes32 requestId) external {
        Claim memory existing = claims[requestId];
        if (existing.claimer == address(0)) revert NoClaimExists(requestId);
        if (block.timestamp < existing.expiresAt) revert ClaimNotExpired(requestId);

        expiredClaimCount[existing.claimer] += 1;
        delete claims[requestId];
        emit ClaimExpired(requestId, existing.claimer);
    }

    /// @notice Get the active claim for a request.
    /// @dev Returns (address(0), 0) if no active claim or claim is expired.
    /// @param requestId The marketplace request ID
    /// @return claimer The address that claimed the request
    /// @return expiresAt When the claim expires (unix timestamp)
    function getJobClaim(bytes32 requestId) external view returns (address claimer, uint256 expiresAt) {
        Claim memory c = claims[requestId];
        if (c.claimer == address(0) || block.timestamp >= c.expiresAt) {
            return (address(0), 0);
        }
        return (c.claimer, c.expiresAt);
    }

    // ============ Admin ============

    /// @notice Set the eligibility checker contract. Zero address = no check.
    function setEligibilityChecker(address checker) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        address old = address(eligibilityChecker);
        eligibilityChecker = IEligibilityChecker(checker);
        emit EligibilityCheckerUpdated(old, checker);
    }

    /// @notice Set the claim time-to-live in seconds.
    function setClaimTTL(uint256 _claimTTL) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (_claimTTL == 0) revert ZeroValue();
        uint256 old = claimTTL;
        claimTTL = _claimTTL;
        emit ClaimTTLUpdated(old, _claimTTL);
    }

    /// @notice Transfer ownership.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (newOwner == address(0)) revert ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }
}
