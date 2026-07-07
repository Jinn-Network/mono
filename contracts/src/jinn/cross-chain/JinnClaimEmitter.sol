// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal interface for the V2 restoration activity checker.
///         Reads the two restoration-side counters that drive JINN
///         minting on the JINN chain.
///         - `verifiedCreations(multisig)` is added by the `pwg`
///           extension to V2 (creator credit, ε-gated by Hamming).
///         - `noveltyWeightedCounts(multisig)` is the existing public
///           state on V2 (delivery credit, novelty-weighted).
interface IRestorationActivityCheckerV2 {
    function verifiedCreations(address multisig) external view returns (uint256);
    function noveltyWeightedCounts(address multisig) external view returns (uint256);
}

/// @notice Minimal interface for the V2 JinnRouter. Reads the
///         evaluation-delivery counter, ungated per Q1.5
///         (deterministic-eval reasoning).
interface IJinnRouterV2 {
    function evaluationDeliveryCount(address multisig) external view returns (uint256);
}

/// @notice Minimal interface for the OLAS ServiceRegistry on Base.
///         `mapServices` returns the canonical 7-field tuple used by
///         existing OLAS contracts (MechMarketplace, RecoveryModule,
///         StakingManager). The function selector matches the
///         deployed registry; we only need the second field
///         (multisig).
interface IServiceRegistry {
    function mapServices(uint256 serviceId)
        external
        view
        returns (
            uint96 securityDeposit,
            address multisig,
            bytes32 configHash,
            uint32 threshold,
            uint32 maxNumAgentInstances,
            uint32 numAgentInstances,
            uint8 state
        );
}

/// @title JinnClaimEmitter
/// @notice Snapshot emitter on Base / Base Sepolia. Reads three
///         monotonic counters across two source contracts (V2 checker
///         and V2 router) plus the service multisig from the OLAS
///         ServiceRegistry, and emits a `ClaimTicket` carrying the
///         snapshot. The companion `IClaimMessenger` on the JINN
///         chain (Ethereum / Sepolia) validates the stored snapshot
///         hash via a canonical OP-Stack storage proof and feeds the
///         recovered values to the JinnDistributor.
///
/// @dev    No admin, no upgrade path. Permissionless: anyone can call
///         `emitClaim` for any serviceId. Spamming the event costs the
///         caller gas; each call writes a new immutable snapshot hash.
///         Replay protection lives in JinnDistributor accumulators on
///         the JINN chain.
contract JinnClaimEmitter {
    IRestorationActivityCheckerV2 public immutable checker;
    IJinnRouterV2 public immutable router;
    IServiceRegistry public immutable serviceRegistry;

    /// @notice Last assigned claim id. Starts at 0; the first emitted
    ///         claim uses id 1.
    uint256 public nextClaimId;

    /// @notice Stored snapshot commitment proven by the canonical L1
    ///         messenger. The mapping slot is intentionally stable for
    ///         storage-proof construction:
    ///         `keccak256(abi.encode(claimId, uint256(1)))`.
    mapping(uint256 => bytes32) public claimSnapshotHashes;

    /// @notice Snapshot of the three counter values for `serviceId`
    ///         at emit time. Carries `multisig` so the JINN-chain
    ///         distributor can route the operator-share mint, and
    ///         `claimer` for analytics (does not gate anything).
    event ClaimTicket(
        uint256 indexed claimId,
        uint256 indexed serviceId,
        uint256 verifiedCreations,
        uint256 noveltyWeightedRestorationDeliveries,
        uint256 evaluationDeliveryCount,
        address indexed multisig,
        address claimer
    );

    constructor(address _checker, address _router, address _registry) {
        require(_checker != address(0), "JinnClaimEmitter: checker=0");
        require(_router != address(0), "JinnClaimEmitter: router=0");
        require(_registry != address(0), "JinnClaimEmitter: registry=0");
        checker = IRestorationActivityCheckerV2(_checker);
        router = IJinnRouterV2(_router);
        serviceRegistry = IServiceRegistry(_registry);

        // Storage-layout invariant: CanonicalOpStackMessenger derives the
        // mapping slot as keccak256(abi.encode(claimId, 1)). If a future
        // edit reorders state and shifts claimSnapshotHashes off slot 1,
        // every canonical proof would silently fail. Pin it at deploy.
        uint256 actualSlot;
        assembly {
            actualSlot := claimSnapshotHashes.slot
        }
        require(actualSlot == 1, "JinnClaimEmitter: snapshot slot drift");
    }

    /// @notice Emit a snapshot ClaimTicket for the given service. All
    ///         three counter reads happen in one transaction; the
    ///         event captures their values at one block.
    /// @param serviceId OLAS service id whose multisig owns the
    ///                  counters being snapshotted.
    function emitClaim(uint256 serviceId) external returns (uint256 claimId) {
        (, address multisig, , , , , ) = serviceRegistry.mapServices(serviceId);
        require(multisig != address(0), "JinnClaimEmitter: unknown service");

        claimId = nextClaimId + 1;
        nextClaimId = claimId;

        uint256 verifiedCreations = checker.verifiedCreations(multisig);
        uint256 noveltyWeightedRestorationDeliveries = checker.noveltyWeightedCounts(multisig);
        uint256 evaluationDeliveryCount = router.evaluationDeliveryCount(multisig);

        claimSnapshotHashes[claimId] = keccak256(
            abi.encode(
                claimId,
                serviceId,
                verifiedCreations,
                noveltyWeightedRestorationDeliveries,
                evaluationDeliveryCount,
                multisig
            )
        );

        emit ClaimTicket(
            claimId,
            serviceId,
            verifiedCreations,
            noveltyWeightedRestorationDeliveries,
            evaluationDeliveryCount,
            multisig,
            msg.sender
        );
    }
}
