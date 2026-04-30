// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IClaimMessenger
/// @notice Interface every cross-chain ClaimTicket messenger must satisfy.
///         A messenger validates an opaque proof of a `ClaimTicket` event
///         emitted by `JinnClaimEmitter` on the measurement chain (Base /
///         Base Sepolia) and recovers the snapshot values for the
///         JinnDistributor on the JINN chain (Ethereum / Sepolia).
///
/// @dev Implementations MUST be stateless / idempotent — no nonce
///      tracking, no seen-proof registry, no storage writes during
///      `verifyClaim`. Replay protection lives in the JinnDistributor's
///      per-service monotonic accumulators, NOT in the messenger.
///
///      The opaque `bytes proof` parameter accommodates any concrete
///      proof format: canonical OP-Stack message proof (β1, default),
///      OP Succinct ZK validity proof (β2), third-party bridge
///      attestation (β3), or `MockMessenger` fixture pointer (testnet
///      / dev only).
interface IClaimMessenger {
    /// @notice Validates a cross-chain proof and recovers the
    ///         `ClaimTicket` parameters that were emitted on the
    ///         measurement chain.
    /// @param proof Opaque blob; format defined by the implementation.
    /// @return serviceId Recovered service id from the ClaimTicket.
    /// @return verifiedCreations Recovered counter value
    ///         (`checker.verifiedCreations(multisig)` at emit time).
    /// @return noveltyWeightedRestorationDeliveries Recovered counter
    ///         (`checker.noveltyWeightedCounts(multisig)` at emit time).
    /// @return evaluationDeliveryCount Recovered counter
    ///         (`router.evaluationDeliveryCount(multisig)` at emit time).
    /// @return multisig Recovered service multisig address (the
    ///         operator-share JINN mint recipient on the JINN chain).
    function verifyClaim(bytes calldata proof)
        external
        view
        returns (
            uint256 serviceId,
            uint256 verifiedCreations,
            uint256 noveltyWeightedRestorationDeliveries,
            uint256 evaluationDeliveryCount,
            address multisig
        );
}
