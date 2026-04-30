// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IClaimMessenger} from "../interfaces/IClaimMessenger.sol";

/// @notice Minimal JINN-token mint surface used by {JinnDistributor}.
/// @dev    Kept local to avoid importing the full ERC20 + Votes surface.
interface IJinn {
    function mint(address to, uint256 amount) external;
}

/// @title JinnDistributor
/// @notice Phase A3 sole-minter surface for the JINN token. Operators or
///         relayers submit cross-chain proofs of work performed on Base;
///         the distributor recovers the work counters via an
///         {IClaimMessenger}, applies Governor-mutable per-channel
///         weights, applies an operator/DAO split, and mints JINN to
///         the operator's service multisig and the DAO Timelock.
///
/// @dev    Replay protection is intentionally local: per-service
///         monotonic accumulators (`totalClaimedOperator[serviceId]`,
///         `totalClaimedDao[serviceId]`) record the last-claimed
///         entitlement on each side. Each {claim} mints only the
///         delta vs. the accumulator high-water mark, so resubmitting
///         the same proof — or a strictly older snapshot — is a no-op.
///
///         The messenger is stateless and trusted only to recover the
///         (serviceId, counters, multisig) tuple from an opaque
///         `bytes proof`; it MUST NOT keep its own seen-proof
///         registry.
///
///         Ownership is held by the deployer at first and is intended
///         to be transferred to the DAO Timelock via the standard OZ
///         {Ownable2Step} ceremony. Only the owner can swap the
///         messenger or update the operator/DAO ratios and the
///         per-channel weights.
contract JinnDistributor is Ownable2Step {
    // -------------------------------------------------------------------------
    // Immutable wiring
    // -------------------------------------------------------------------------

    /// @notice The JINN token. The distributor must be its `minter`.
    IJinn public immutable jinn;

    /// @notice Recipient of the DAO-share mint (typically the OZ
    ///         Timelock that owns the JINN token + this distributor).
    address public immutable daoTreasury;

    // -------------------------------------------------------------------------
    // Governor-mutable state
    // -------------------------------------------------------------------------

    /// @notice Cross-chain proof verifier. Stateless / idempotent;
    ///         see {IClaimMessenger}.
    IClaimMessenger public messenger;

    /// @notice Operator-share multiplier in 1e18 fixed point.
    ///         Default at deploy is typically 0.75e18.
    /// @dev    `operatorRatio` and {daoRatio} are independent —
    ///         their sum is intentionally NOT constrained. The §2 = B
    ///         lock in the Phase A spec keeps total emissions uncapped
    ///         so that channel weights and ratios can be tuned
    ///         independently without rewriting accumulators.
    uint256 public operatorRatio;

    /// @notice DAO-share multiplier in 1e18 fixed point.
    ///         Default at deploy is typically 0.25e18.
    /// @dev    See {operatorRatio} for the (intentional) lack of a
    ///         sum constraint.
    uint256 public daoRatio;

    /// @notice Per-channel weight applied to verified-creation counts.
    /// @dev    Independent of the other channel weights; updated
    ///         together via {setWeights}.
    uint256 public wCreation;

    /// @notice Per-channel weight applied to novelty-weighted
    ///         restoration deliveries.
    uint256 public wRestorationDelivery;

    /// @notice Per-channel weight applied to evaluation deliveries.
    /// @dev    Note there is no `wEvaluationCreation` — eval creations
    ///         are a protocol mechanical step and do not earn JINN.
    uint256 public wEvaluationDelivery;

    // -------------------------------------------------------------------------
    // Bounds on governance-mutable parameters
    // -------------------------------------------------------------------------

    /// @notice Hard ceiling on either side of the operator/DAO ratio split.
    ///         10x the 1e18 baseline — comfortably above any plausible
    ///         tuning, low enough to bound mint scaling so a bad
    ///         governance proposal cannot inflate per-claim mints by an
    ///         arbitrary factor.
    uint256 public constant MAX_RATIO = 10e18;

    /// @notice Hard ceiling on each per-channel weight. 1M JINN per
    ///         counter unit — generous headroom over the v0 default of 1
    ///         while still bounding the largest possible single-claim
    ///         mint from a runaway governance update.
    uint256 public constant MAX_WEIGHT = 1e24;

    // -------------------------------------------------------------------------
    // Per-service monotonic accumulators
    // -------------------------------------------------------------------------

    /// @notice High-water mark of operator-share entitlement minted
    ///         for `serviceId`. Monotonically non-decreasing.
    mapping(uint256 => uint256) public totalClaimedOperator;

    /// @notice High-water mark of DAO-share entitlement minted for
    ///         `serviceId`. Monotonically non-decreasing.
    mapping(uint256 => uint256) public totalClaimedDao;

    /// @notice First-observed multisig for `serviceId`. Bound on the
    ///         first {claim} for that serviceId; subsequent claims for
    ///         the same serviceId MUST recover the same multisig.
    ///         Prevents accumulator-replay across operator-multisig
    ///         rotations: the OLAS ServiceRegistry permits the multisig
    ///         field to change, and without this binding the new
    ///         multisig would inherit the entitlement high-water mark
    ///         already minted to the previous multisig.
    mapping(uint256 => address) public serviceMultisig;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted on every successful (non-zero-mint) claim.
    /// @param serviceId             Recovered OLAS service id.
    /// @param multisig              Recovered service multisig — the
    ///                              operator-share mint recipient.
    /// @param operatorMinted        Newly-minted JINN to `multisig`
    ///                              on this claim (may be 0 if only
    ///                              the DAO side advanced).
    /// @param daoMinted             Newly-minted JINN to {daoTreasury}
    ///                              on this claim (may be 0 if only
    ///                              the operator side advanced).
    /// @param totalEntitledOperator New high-water mark of operator
    ///                              entitlement after this claim.
    /// @param totalEntitledDao      New high-water mark of DAO
    ///                              entitlement after this claim.
    event Claimed(
        uint256 indexed serviceId,
        address indexed multisig,
        uint256 operatorMinted,
        uint256 daoMinted,
        uint256 totalEntitledOperator,
        uint256 totalEntitledDao
    );

    /// @notice Emitted when the owner swaps the cross-chain messenger.
    event MessengerUpdated(address indexed newMessenger);

    /// @notice Emitted when the owner updates the operator/DAO split.
    event RatiosUpdated(uint256 operatorRatio, uint256 daoRatio);

    /// @notice Emitted when the owner updates per-channel weights.
    event WeightsUpdated(
        uint256 wCreation,
        uint256 wRestorationDelivery,
        uint256 wEvaluationDelivery
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    /// @notice Constructor or {setMessenger} given a zero address.
    error ZeroAddress();

    /// @notice Messenger returned `multisig == address(0)`.
    error ZeroMultisig();

    /// @notice {claim} recovered a `multisig` for `serviceId` that
    ///         differs from the one bound on the first observation.
    /// @dev    Guards against accumulator-replay following an OLAS
    ///         ServiceRegistry multisig rotation.
    error ServiceMultisigChanged(uint256 serviceId, address expected, address actual);

    /// @notice {setRatios} given an operator or DAO ratio above
    ///         {MAX_RATIO}.
    error RatioOutOfBounds();

    /// @notice {setWeights} given any per-channel weight above
    ///         {MAX_WEIGHT}.
    error WeightOutOfBounds();

    /// @notice {setMessenger} target had no deployed bytecode at the
    ///         supplied address (post-zero-address check).
    error MessengerNotContract();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address initialOwner,
        address _jinn,
        address _daoTreasury,
        address _initialMessenger,
        uint256 _operatorRatio,
        uint256 _daoRatio,
        uint256 _wCreation,
        uint256 _wRestorationDelivery,
        uint256 _wEvaluationDelivery
    ) Ownable(initialOwner) {
        if (_jinn == address(0)) revert ZeroAddress();
        if (_daoTreasury == address(0)) revert ZeroAddress();
        if (_initialMessenger == address(0)) revert ZeroAddress();

        jinn = IJinn(_jinn);
        daoTreasury = _daoTreasury;
        messenger = IClaimMessenger(_initialMessenger);
        operatorRatio = _operatorRatio;
        daoRatio = _daoRatio;
        wCreation = _wCreation;
        wRestorationDelivery = _wRestorationDelivery;
        wEvaluationDelivery = _wEvaluationDelivery;
    }

    // -------------------------------------------------------------------------
    // Core claim flow
    // -------------------------------------------------------------------------

    /// @notice Validate a cross-chain proof and mint the delta in
    ///         operator/DAO entitlement vs. the per-service
    ///         accumulators.
    /// @dev    Permissionless. Anyone may submit a proof — the
    ///         recovered `multisig` and {daoTreasury} are the mint
    ///         recipients regardless of who pays the gas. CEI
    ///         ordering: accumulators are written before the
    ///         {IJinn.mint} external calls so any reentrant call
    ///         observes the post-update state and short-circuits.
    function claim(bytes calldata proof) external {
        (
            uint256 serviceId,
            uint256 vCreations,
            uint256 vRestoration,
            uint256 evalDelivery,
            address multisig
        ) = messenger.verifyClaim(proof);

        if (multisig == address(0)) revert ZeroMultisig();

        // Bind the operator multisig to the first observation for this
        // serviceId. If the OLAS ServiceRegistry later rotates the
        // multisig, the new address would otherwise inherit the
        // high-water mark already minted to the old address — the new
        // operator could claim accumulated entitlement that never
        // belonged to them. We pin the recipient here once and then
        // require all future claims for the same serviceId to recover
        // the same multisig.
        address bound = serviceMultisig[serviceId];
        if (bound == address(0)) {
            serviceMultisig[serviceId] = multisig;
        } else if (bound != multisig) {
            revert ServiceMultisigChanged(serviceId, bound, multisig);
        }

        // Snapshot weighted by current per-channel weights.
        uint256 weighted = wCreation * vCreations
            + wRestorationDelivery * vRestoration
            + wEvaluationDelivery * evalDelivery;

        uint256 entitledOperator = (weighted * operatorRatio) / 1e18;
        uint256 entitledDao      = (weighted * daoRatio)      / 1e18;

        uint256 alreadyOperator = totalClaimedOperator[serviceId];
        uint256 alreadyDao      = totalClaimedDao[serviceId];

        // Clamp to zero on decreasing snapshots (e.g. weight or ratio
        // changes that lower the entitlement below the high-water
        // mark). We never unmint, and the accumulator never moves
        // backwards.
        uint256 owedOperator = entitledOperator > alreadyOperator
            ? entitledOperator - alreadyOperator
            : 0;
        uint256 owedDao = entitledDao > alreadyDao
            ? entitledDao - alreadyDao
            : 0;

        if (owedOperator == 0 && owedDao == 0) {
            return;
        }

        // CEI: update accumulators BEFORE external mint calls. Any
        // reentrant claim() call sees the post-update state and
        // returns immediately.
        if (owedOperator > 0) {
            totalClaimedOperator[serviceId] = entitledOperator;
        }
        if (owedDao > 0) {
            totalClaimedDao[serviceId] = entitledDao;
        }

        if (owedOperator > 0) {
            jinn.mint(multisig, owedOperator);
        }
        if (owedDao > 0) {
            jinn.mint(daoTreasury, owedDao);
        }

        emit Claimed(
            serviceId,
            multisig,
            owedOperator,
            owedDao,
            // Read back from storage so we report the actual stored
            // high-water mark (which equals `entitled*` only on the
            // side that advanced).
            totalClaimedOperator[serviceId],
            totalClaimedDao[serviceId]
        );
    }

    // -------------------------------------------------------------------------
    // Governor-mutable setters (onlyOwner = Timelock post-handover)
    // -------------------------------------------------------------------------

    /// @notice Swap the cross-chain messenger. Future-proofs for
    ///         β2 (OP Succinct) and β3 (third-party bridge)
    ///         implementations.
    /// @dev    The new address must contain deployed bytecode. This
    ///         catches the most common governance footgun (typo'd EOA
    ///         address) without try/catch overhead on every {claim}.
    function setMessenger(IClaimMessenger newMessenger) external onlyOwner {
        if (address(newMessenger) == address(0)) revert ZeroAddress();
        if (address(newMessenger).code.length == 0) revert MessengerNotContract();
        messenger = newMessenger;
        emit MessengerUpdated(address(newMessenger));
    }

    /// @notice Update the operator/DAO split. Both ratios are
    ///         independent — `newOperatorRatio + newDaoRatio` is
    ///         intentionally unconstrained per the §2 = B (uncapped)
    ///         lock in the Phase A spec. Decreases never unmint;
    ///         the accumulator high-water marks are sticky.
    /// @dev    Each side is bounded by {MAX_RATIO} so a runaway
    ///         governance proposal cannot inflate per-claim mints by
    ///         an arbitrary factor.
    function setRatios(uint256 newOperatorRatio, uint256 newDaoRatio)
        external
        onlyOwner
    {
        if (newOperatorRatio > MAX_RATIO || newDaoRatio > MAX_RATIO) {
            revert RatioOutOfBounds();
        }
        operatorRatio = newOperatorRatio;
        daoRatio = newDaoRatio;
        emit RatiosUpdated(newOperatorRatio, newDaoRatio);
    }

    /// @notice Update per-channel weights. Each weight is
    ///         independent. As with ratios, decreases never unmint —
    ///         only future {claim} calls observe the new weights.
    /// @dev    Each weight is bounded by {MAX_WEIGHT} for the same
    ///         reason {setRatios} caps each side: bound the largest
    ///         possible per-claim mint.
    function setWeights(
        uint256 _wCreation,
        uint256 _wRestorationDelivery,
        uint256 _wEvaluationDelivery
    ) external onlyOwner {
        if (
            _wCreation > MAX_WEIGHT
                || _wRestorationDelivery > MAX_WEIGHT
                || _wEvaluationDelivery > MAX_WEIGHT
        ) {
            revert WeightOutOfBounds();
        }
        wCreation = _wCreation;
        wRestorationDelivery = _wRestorationDelivery;
        wEvaluationDelivery = _wEvaluationDelivery;
        emit WeightsUpdated(_wCreation, _wRestorationDelivery, _wEvaluationDelivery);
    }
}
