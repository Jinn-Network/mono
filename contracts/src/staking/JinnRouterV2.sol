// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @dev Activity checker V2 interface — receives evidence hashes from the router.
interface IActivityCheckerV2 {
    function recordRestorationEvidence(address multisig, bytes32 evidenceHash) external;
}

/// @dev Mech Marketplace interface — only the functions JinnRouterV2 needs
interface IMechMarketplace {
    enum RequestStatus {
        DoesNotExist,
        RequestedPriority,
        RequestedExpired,
        Delivered
    }

    function request(
        bytes memory requestData,
        uint256 maxDeliveryRate,
        bytes32 paymentType,
        address priorityMech,
        uint256 responseTimeout,
        bytes calldata paymentData
    ) external payable returns (bytes32 requestId);

    function getRequestStatus(bytes32 requestId) external view returns (RequestStatus status);
}

/// @dev Zero address provided.
error ZeroAddress();

/// @dev Zero value provided.
error ZeroValue();

/// @dev Already initialized.
error AlreadyInitialized();

/// @dev Not initialized.
error NotInitialized();

/// @dev Request not found in router (not created through this contract).
error RequestNotFound(bytes32 requestId);

/// @dev Delivery already claimed for this request.
error AlreadyClaimed(bytes32 requestId);

/// @dev Request has not been delivered on the marketplace.
error NotDelivered(bytes32 requestId);

/// @dev Restoration delivery not yet claimed for the referenced request.
error RestorationNotClaimed(bytes32 restorationRequestId);

/// @title JinnRouterV2 - Activity router for the Jinn training loop with evidence forwarding
/// @author JIN Network
/// @notice Routes marketplace requests through a Jinn-specific contract that tags job types
///         (restoration vs evaluation), tracks per-role activity counters, and forwards
///         evidence hashes to a separate RestorationActivityCheckerV2 for anti-farming checks.
/// @dev Deployed behind an upgradeable proxy. Slots 0-1 are reserved for the proxy
///      (implementation address and owner). JinnRouterV2 storage starts at slot 2.
///      The staking contract points at RestorationActivityCheckerV2, not this router.
///      getMultisigNonces and isRatioPass have been removed — those now live in the checker.
contract JinnRouterV2 {
    // ============================================================
    // Events
    // ============================================================

    event Initialized(address indexed mechMarketplace, uint256 livenessRatio);
    event RestorationJobCreated(address indexed creator, bytes32 indexed requestId);
    event EvaluationJobCreated(address indexed creator, bytes32 indexed requestId, bytes32 indexed restorationRequestId);
    event DeliveryClaimed(address indexed claimer, bytes32 indexed requestId, uint8 jobType);

    // ============================================================
    // Enums
    // ============================================================

    enum JobType { NONE, RESTORATION, EVALUATION }

    // ============================================================
    // Storage — slots 0-1 reserved for proxy
    // ============================================================

    // Slot 0: proxy implementation address — DO NOT USE
    address private _proxyReserved0;
    // Slot 1: proxy owner address — DO NOT USE
    address private _proxyReserved1;

    // Slot 2
    address public mechMarketplace;
    // Slot 3 — kept for proxy storage layout compatibility
    uint256 public livenessRatio;
    // Slot 4
    bool public initialized;
    // Slot 5
    address public activityChecker;

    // Activity counters (slots 6-9)
    mapping(address => uint256) public creationCount;
    mapping(address => uint256) public restorationDeliveryCount;
    mapping(address => uint256) public evaluationCreationCount;
    mapping(address => uint256) public evaluationDeliveryCount;

    // Request tracking (slots 10-12)
    mapping(bytes32 => JobType) public requestTypes;
    mapping(bytes32 => bool) public claimed;
    mapping(bytes32 => bool) public restorationDeliveryClaimed;

    // ============================================================
    // Initialization
    // ============================================================

    /// @dev Initialize the router. Can only be called once.
    /// @param _mechMarketplace Mech marketplace contract address.
    /// @param _livenessRatio Liveness ratio in 1e18 format (stored for layout; not used by router).
    /// @param _activityChecker RestorationActivityCheckerV2 address for evidence forwarding.
    function initialize(address _mechMarketplace, uint256 _livenessRatio, address _activityChecker) external {
        if (initialized) revert AlreadyInitialized();
        if (_mechMarketplace == address(0)) revert ZeroAddress();
        if (_livenessRatio == 0) revert ZeroValue();
        if (_activityChecker == address(0)) revert ZeroAddress();

        mechMarketplace = _mechMarketplace;
        livenessRatio = _livenessRatio;
        activityChecker = _activityChecker;
        initialized = true;

        emit Initialized(_mechMarketplace, _livenessRatio);
    }

    // ============================================================
    // Request Routing
    // ============================================================

    /// @dev Create a restoration job on the marketplace.
    /// @param requestData Request data (typically IPFS CID of desired state).
    /// @param priorityMech Priority mech address to handle the request.
    /// @param maxDeliveryRate Maximum delivery rate the creator is willing to pay.
    /// @param responseTimeout Response timeout window.
    /// @param paymentType Payment type identifier.
    /// @param paymentData Additional payment data.
    /// @return requestId The marketplace request ID.
    function createRestorationJob(
        bytes memory requestData,
        address priorityMech,
        uint256 maxDeliveryRate,
        uint256 responseTimeout,
        bytes32 paymentType,
        bytes calldata paymentData
    ) external payable returns (bytes32 requestId) {
        if (!initialized) revert NotInitialized();

        creationCount[msg.sender]++;

        requestId = IMechMarketplace(mechMarketplace).request{value: msg.value}(
            requestData,
            maxDeliveryRate,
            paymentType,
            priorityMech,
            responseTimeout,
            paymentData
        );

        requestTypes[requestId] = JobType.RESTORATION;

        emit RestorationJobCreated(msg.sender, requestId);
    }

    /// @dev Create an evaluation job on the marketplace. Requires a restoration delivery
    ///      to have been claimed for the referenced restoration request (loop enforcement).
    /// @param restorationRequestId The restoration request that must have been delivered.
    /// @param requestData Request data for the evaluation job.
    /// @param evaluationMech Priority mech to handle the evaluation.
    /// @param maxDeliveryRate Maximum delivery rate.
    /// @param responseTimeout Response timeout window.
    /// @param paymentType Payment type identifier.
    /// @param paymentData Additional payment data.
    /// @return requestId The marketplace request ID for the evaluation job.
    function createEvaluationJob(
        bytes32 restorationRequestId,
        bytes memory requestData,
        address evaluationMech,
        uint256 maxDeliveryRate,
        uint256 responseTimeout,
        bytes32 paymentType,
        bytes calldata paymentData
    ) external payable returns (bytes32 requestId) {
        if (!initialized) revert NotInitialized();

        // Loop enforcement: restoration must have been delivered and claimed
        if (!restorationDeliveryClaimed[restorationRequestId]) {
            revert RestorationNotClaimed(restorationRequestId);
        }

        evaluationCreationCount[msg.sender]++;

        requestId = IMechMarketplace(mechMarketplace).request{value: msg.value}(
            requestData,
            maxDeliveryRate,
            paymentType,
            evaluationMech,
            responseTimeout,
            paymentData
        );

        requestTypes[requestId] = JobType.EVALUATION;

        emit EvaluationJobCreated(msg.sender, requestId, restorationRequestId);
    }

    // ============================================================
    // Delivery Claims
    // ============================================================

    /// @dev Claim credit for a delivery that happened on the marketplace.
    ///      For restoration deliveries, optionally forwards an evidence hash to the
    ///      activity checker for anti-farming verification.
    ///      The router verifies the delivery status on-chain and increments
    ///      the appropriate counter based on the request's job type.
    /// @param requestId The request ID that was delivered.
    /// @param evidenceHash IPFS CID or other hash of restoration evidence. Pass bytes32(0)
    ///        to skip forwarding. Ignored for evaluation deliveries.
    function claimDelivery(bytes32 requestId, bytes32 evidenceHash) external {
        if (!initialized) revert NotInitialized();

        JobType jobType = requestTypes[requestId];
        if (jobType == JobType.NONE) {
            revert RequestNotFound(requestId);
        }

        if (claimed[requestId]) {
            revert AlreadyClaimed(requestId);
        }

        // Verify the delivery actually happened on the marketplace
        IMechMarketplace.RequestStatus status = IMechMarketplace(mechMarketplace).getRequestStatus(requestId);
        if (status != IMechMarketplace.RequestStatus.Delivered) {
            revert NotDelivered(requestId);
        }

        claimed[requestId] = true;

        if (jobType == JobType.RESTORATION) {
            restorationDeliveryCount[msg.sender]++;
            restorationDeliveryClaimed[requestId] = true;

            // Forward evidence to activity checker for anti-farming
            if (evidenceHash != bytes32(0) && activityChecker != address(0)) {
                IActivityCheckerV2(activityChecker).recordRestorationEvidence(msg.sender, evidenceHash);
            }
        } else {
            // Evaluation delivery — evidence forwarding is not applicable
            evaluationDeliveryCount[msg.sender]++;
        }

        emit DeliveryClaimed(msg.sender, requestId, uint8(jobType));
    }
}
