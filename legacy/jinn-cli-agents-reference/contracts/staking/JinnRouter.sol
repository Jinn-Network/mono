// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @dev Multisig interface for getting nonce
interface IMultisig {
    function nonce() external view returns (uint256);
}

/// @dev Mech Marketplace interface — only the functions JinnRouter needs
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

/// @title JinnRouter - Activity checker and request router for the Jinn training loop
/// @author JIN Network
/// @notice Routes marketplace requests through a Jinn-specific contract that tags job types
///         (restoration vs evaluation), tracks per-role activity counters, and implements the
///         OLAS activity checker interface (getMultisigNonces + isRatioPass).
/// @dev Deployed behind an upgradeable proxy. Slots 0-1 are reserved for the proxy
///      (implementation address and owner). JinnRouter storage starts at slot 2.
contract JinnRouter {
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
    // Slot 3
    uint256 public livenessRatio;
    // Slot 4
    bool public initialized;

    // Activity counters (slots 5-8)
    mapping(address => uint256) public creationCount;
    mapping(address => uint256) public restorationDeliveryCount;
    mapping(address => uint256) public evaluationCreationCount;
    mapping(address => uint256) public evaluationDeliveryCount;

    // Request tracking (slots 9-11)
    mapping(bytes32 => JobType) public requestTypes;
    mapping(bytes32 => bool) public claimed;
    mapping(bytes32 => bool) public restorationDeliveryClaimed;

    // ============================================================
    // Initialization
    // ============================================================

    /// @dev Initialize the router. Can only be called once.
    /// @param _mechMarketplace Mech marketplace contract address.
    /// @param _livenessRatio Liveness ratio in 1e18 format.
    function initialize(address _mechMarketplace, uint256 _livenessRatio) external {
        if (initialized) {
            revert AlreadyInitialized();
        }
        if (_mechMarketplace == address(0)) {
            revert ZeroAddress();
        }
        if (_livenessRatio == 0) {
            revert ZeroValue();
        }

        mechMarketplace = _mechMarketplace;
        livenessRatio = _livenessRatio;
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
    ///      The router verifies the delivery status on-chain and increments
    ///      the appropriate counter based on the request's job type.
    /// @param requestId The request ID that was delivered.
    function claimDelivery(bytes32 requestId) external {
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
        } else {
            evaluationDeliveryCount[msg.sender]++;
        }

        emit DeliveryClaimed(msg.sender, requestId, uint8(jobType));
    }

    // ============================================================
    // Activity Checker Interface (OLAS)
    // ============================================================

    /// @dev Gets service multisig nonces for the activity checker.
    /// @param multisig Service multisig address.
    /// @return nonces Array of [safe nonce, creation, restoration delivery, eval creation, eval delivery].
    function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces) {
        nonces = new uint256[](5);
        nonces[0] = IMultisig(multisig).nonce();
        nonces[1] = creationCount[multisig];
        nonces[2] = restorationDeliveryCount[multisig];
        nonces[3] = evaluationCreationCount[multisig];
        nonces[4] = evaluationDeliveryCount[multisig];
    }

    /// @dev Checks if the service multisig liveness ratio passes the threshold.
    /// @notice Sums all four activity deltas. Any combination of activities can satisfy
    ///         the liveness requirement. The total <= nonceDelta bound ensures claimed
    ///         activities cannot exceed the number of Safe transactions executed.
    /// @param curNonces Current nonce array from getMultisigNonces.
    /// @param lastNonces Previous nonce array from last checkpoint.
    /// @param ts Time difference between current and last checkpoint.
    /// @return ratioPass True if the liveness ratio is met.
    function isRatioPass(
        uint256[] memory curNonces,
        uint256[] memory lastNonces,
        uint256 ts
    ) external view returns (bool ratioPass) {
        if (ts == 0 || curNonces[0] <= lastNonces[0]) return false;

        uint256 nonceDelta = curNonces[0] - lastNonces[0];
        uint256 total = 0;

        for (uint256 i = 1; i <= 4; i++) {
            if (curNonces[i] > lastNonces[i]) {
                total += curNonces[i] - lastNonces[i];
            }
        }

        // Sanity: total activities can't exceed multisig transactions
        if (total == 0 || total > nonceDelta) return false;

        uint256 ratio = (total * 1e18) / ts;
        ratioPass = (ratio >= livenessRatio);
    }
}
