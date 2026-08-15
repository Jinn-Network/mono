// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {TaskCoordinatorV4} from "../tasks/TaskCoordinatorV4.sol";
import {MarketplaceRequestData} from "../marketplace/MarketplaceRequestData.sol";
import {RouterV4Auth} from "../marketplace/RouterV4Auth.sol";
import {SafeTransferLib} from "../vendor/registries/SafeTransferLib.sol";

interface ITaskActivityCheckerV4 {
    function recordSolutionDelivery(address operator, bytes32 solutionDigest) external returns (uint256 weight);
    function recordVerdictDelivery(address evaluator, bytes32 verdictDigest) external returns (uint256 weight);
    function recordTaskCreationFinalized(address creator, uint256 taskId, uint256 weight) external;
}

interface IMechV4 {
    function maxDeliveryRate() external view returns (uint256);
    function paymentType() external view returns (bytes32);
    function isOperator(address multisig) external view returns (bool);
}

interface IMechMarketplaceV4 {
    enum RequestStatus {
        DoesNotExist,
        RequestedPriority,
        RequestedExpired,
        Delivered
    }

    function mapNonces(address requester) external view returns (uint256);

    function getRequestId(
        address mech,
        address requester,
        bytes memory data,
        uint256 deliveryRate,
        bytes32 paymentType,
        uint256 nonce
    ) external view returns (bytes32 requestId);

    function getRequestStatus(bytes32 requestId) external view returns (RequestStatus status);

    function mapRequestIdInfos(bytes32 requestId)
        external
        view
        returns (
            address priorityMech,
            address deliveryMech,
            address requester,
            uint256 responseTimeout,
            uint256 deliveryRate,
            bytes32 paymentType
        );
}

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

error RouterV4ZeroAddress();
error RouterV4ZeroValue();
error RouterV4AlreadyInitialized();
error RouterV4NotInitialized();
error RouterV4OwnerOnly(address sender, address owner);
error RouterV4TaskNotFound(uint256 taskId);
error RouterV4InsufficientTaskBudget(uint256 taskId, uint256 available, uint256 required);
error RouterV4InvalidPaymentType(bytes32 paymentType);
error RouterV4InvalidOperatorMech(address operator, address mech);
error RouterV4MarketplaceOnly(address sender, address marketplace);
error RouterV4SignatureInvalid();
error RouterV4ReservationNotLive(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error RouterV4WrongRequester(bytes32 requestId, address requester);
error RouterV4NotDelivered(bytes32 requestId);
error RouterV4WrongDeliveryOperator(bytes32 requestId, address expected, address deliveryMech);
error RouterV4AlreadyClaimed(bytes32 requestId);
error RouterV4CrossBinding();
error RouterV4NonceMismatch(uint256 expected, uint256 actual);
error RouterV4RateMismatch(uint256 expected, uint256 actual);
error RouterV4MechMismatch(address expected, address actual);
error RouterV4TaskNotRefundable(uint256 taskId);
error RouterV4Overflow();
error RouterV4TokenApproveFailed();
error RouterV4NotPrepared(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error RouterV4AlreadyPrepared(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error RouterV4PreparationDelivered(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, bytes32 requestId);
error RouterV4MarketplaceStatusUnavailable(bytes32 requestId);
error RouterV4VerdictCodeMismatch(uint8 expected, uint8 actual);
error RouterV4NotReservationParty(address expected, address actual);
error RouterV4RequestIdMismatch(bytes32 expected, bytes32 actual);

/// @title JinnRouterV4
/// @notice Revised-generation OLAS escrow router with prepare→Mech-deliver→claim settlement.
/// @dev Per-task exact conservation:
///      escrowed = remaining + reserved + spentOut
///      claim: remaining → reserved
///      Mech deliver (after prepare): tokens leave router; reserved stays until claim/forfeit
///      settle claim: reserved → spentOut; protocol credit granted
///      release/reap undelivered: reserved → remaining
///      Delivered prep: must NOT restore; forfeitDeliveredReservation clears reserved → spentOut without credit
contract JinnRouterV4 {
    bytes4 private constant EIP1271_MAGIC = 0x1626ba7e;

    enum ReservationKind {
        None,
        Solution,
        Verdict
    }

    struct TaskPayment {
        address creator;
        bytes32 taskCidDigest;
        bytes32 submissionDigest;
        uint256 solutionMaxDeliveryRate;
        uint256 verdictMaxDeliveryRate;
        uint256 responseTimeout;
        uint256 solutionBudgetRemaining;
        uint256 verdictBudgetRemaining;
        uint256 solutionReserved;
        uint256 verdictReserved;
        uint256 solutionSpentOut;
        uint256 verdictSpentOut;
    }

    struct Reservation {
        ReservationKind kind;
        uint256 taskId;
        uint32 attemptIndex;
        uint32 verdictIndex;
        address party;
        address priorityMech;
        uint256 rate;
        uint64 deadline;
        bool settled;
        bool released;
    }

    /// @dev Stored by prepare* before any token can move via Mech delivery.
    struct Preparation {
        bool prepared;
        bytes32 expectedRequestId;
        uint256 preparedNonce;
        bytes32 requestDataHash;
        bytes32 deliveryDigest;
        uint8 verdictCode;
    }

    address public owner;
    address public mechMarketplace;
    address public activityChecker;
    TaskCoordinatorV4 public taskCoordinator;
    address public olasToken;
    bytes32 public tokenPaymentType;
    address public tokenBalanceTracker;
    bool public initialized;

    mapping(uint256 => TaskPayment) public taskPayments;
    mapping(uint256 => mapping(uint32 => Reservation)) public solutionReservations;
    mapping(uint256 => mapping(uint32 => mapping(uint32 => Reservation))) public verdictReservations;
    mapping(uint256 => mapping(uint32 => Preparation)) public solutionPreparations;
    mapping(uint256 => mapping(uint32 => mapping(uint32 => Preparation))) public verdictPreparations;
    mapping(bytes32 => bool) public claimed;

    event Initialized(
        address indexed owner,
        address indexed mechMarketplace,
        address indexed taskCoordinator,
        address activityChecker,
        address olasToken,
        bytes32 tokenPaymentType,
        address tokenBalanceTracker
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    event TaskCreated(
        address indexed creator,
        bytes32 indexed taskCidDigest,
        bytes32 indexed submissionDigest,
        uint256 taskId,
        uint32 maxTotal,
        uint32 maxConcurrent,
        uint64 submissionDeadline,
        uint64 closeAt,
        uint64 responseTimeout,
        uint32 minVerdicts,
        bool requireDistinctEvaluator,
        uint256 solutionMaxDeliveryRate,
        uint256 verdictMaxDeliveryRate,
        uint256 solutionBudget,
        uint256 verdictBudget
    );

    event TaskAttemptCreated(
        address indexed operator,
        address indexed priorityMech,
        uint256 indexed taskId,
        uint32 attemptIndex,
        uint64 attemptDeadline,
        uint256 deliveryRate
    );

    event EvaluationAttemptCreated(
        address indexed evaluator,
        address indexed priorityMech,
        uint256 indexed taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        uint64 attemptDeadline,
        uint256 deliveryRate
    );

    event SolutionDeliveryPrepared(
        address indexed operator,
        bytes32 indexed expectedRequestId,
        uint256 indexed taskId,
        uint32 attemptIndex,
        uint256 nonce,
        bytes32 deliveryDigest
    );

    event VerdictDeliveryPrepared(
        address indexed evaluator,
        bytes32 indexed expectedRequestId,
        uint256 indexed taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        uint256 nonce,
        bytes32 deliveryDigest,
        uint8 verdictCode
    );

    event SolutionDeliveryClaimed(
        address indexed operator,
        bytes32 indexed requestId,
        bytes32 indexed deliveryDigest,
        uint256 taskId,
        uint32 attemptIndex
    );

    event VerdictDeliveryClaimed(
        address indexed evaluator,
        bytes32 indexed requestId,
        bytes32 indexed evaluationDeliveryDigest,
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        uint8 verdictCode
    );

    event TaskBudgetRefunded(
        uint256 indexed taskId,
        address indexed creator,
        uint256 solutionAmount,
        uint256 verdictAmount
    );

    event AttemptsAdded(uint256 indexed taskId, address indexed creator, uint32 added, uint32 newMaxTotal);
    event AttemptExpired(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator);
    event AttemptReleased(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator);
    event TaskClosed(uint256 indexed taskId, address indexed creator);
    event ReservationForfeited(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        uint32 indexed verdictIndex,
        bytes32 requestId,
        uint256 rate,
        uint8 legKind
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert RouterV4OwnerOnly(msg.sender, owner);
        _;
    }

    function initialize(
        address _owner,
        address _mechMarketplace,
        address _taskCoordinator,
        address _activityChecker,
        address _olasToken,
        bytes32 _tokenPaymentType,
        address _tokenBalanceTracker
    ) external {
        if (initialized) revert RouterV4AlreadyInitialized();
        if (
            _owner == address(0) || _mechMarketplace == address(0) || _taskCoordinator == address(0)
                || _olasToken == address(0) || _tokenBalanceTracker == address(0)
        ) {
            revert RouterV4ZeroAddress();
        }
        if (_tokenPaymentType == bytes32(0)) revert RouterV4ZeroValue();

        owner = _owner;
        mechMarketplace = _mechMarketplace;
        taskCoordinator = TaskCoordinatorV4(_taskCoordinator);
        activityChecker = _activityChecker;
        olasToken = _olasToken;
        tokenPaymentType = _tokenPaymentType;
        tokenBalanceTracker = _tokenBalanceTracker;
        initialized = true;

        bool ok = IERC20Approve(_olasToken).approve(_tokenBalanceTracker, type(uint256).max);
        if (!ok) revert RouterV4TokenApproveFailed();

        emit Initialized(
            _owner,
            _mechMarketplace,
            _taskCoordinator,
            _activityChecker,
            _olasToken,
            _tokenPaymentType,
            _tokenBalanceTracker
        );
        emit OwnershipTransferred(address(0), _owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert RouterV4ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function setActivityChecker(address newActivityChecker) external onlyOwner {
        activityChecker = newActivityChecker;
    }

    function createTask(
        bytes32 taskCidDigest,
        bytes32 submissionDigest,
        TaskCoordinatorV4.TaskPolicy calldata policy,
        uint256 solutionMaxDeliveryRate,
        uint256 verdictMaxDeliveryRate
    ) external returns (uint256 taskId) {
        if (!initialized) revert RouterV4NotInitialized();
        if (taskCidDigest == bytes32(0) || submissionDigest == bytes32(0)) revert RouterV4ZeroValue();
        if (solutionMaxDeliveryRate == 0 || verdictMaxDeliveryRate == 0) revert RouterV4ZeroValue();

        uint256 solutionBudget = _mul(solutionMaxDeliveryRate, policy.maxTotal);
        uint256 verdictBudget = _mul(_mul(verdictMaxDeliveryRate, policy.maxTotal), policy.minVerdicts);
        uint256 required = solutionBudget + verdictBudget;

        SafeTransferLib.safeTransferFrom(olasToken, msg.sender, address(this), required);

        taskId = taskCoordinator.createTask(msg.sender, taskCidDigest, submissionDigest, policy);

        TaskPayment storage payment = taskPayments[taskId];
        payment.creator = msg.sender;
        payment.taskCidDigest = taskCidDigest;
        payment.submissionDigest = submissionDigest;
        payment.solutionMaxDeliveryRate = solutionMaxDeliveryRate;
        payment.verdictMaxDeliveryRate = verdictMaxDeliveryRate;
        payment.responseTimeout = policy.responseTimeout;
        payment.solutionBudgetRemaining = solutionBudget;
        payment.verdictBudgetRemaining = verdictBudget;
        payment.solutionReserved = 0;
        payment.verdictReserved = 0;
        payment.solutionSpentOut = 0;
        payment.verdictSpentOut = 0;

        emit TaskCreated(
            msg.sender,
            taskCidDigest,
            submissionDigest,
            taskId,
            policy.maxTotal,
            policy.maxConcurrent,
            policy.submissionDeadline,
            policy.closeAt,
            policy.responseTimeout,
            policy.minVerdicts,
            policy.requireDistinctEvaluator,
            solutionMaxDeliveryRate,
            verdictMaxDeliveryRate,
            solutionBudget,
            verdictBudget
        );
    }

    function addAttempts(uint256 taskId, uint32 added) external {
        TaskPayment storage payment = _requirePayment(taskId);
        if (msg.sender != payment.creator) revert RouterV4OwnerOnly(msg.sender, payment.creator);
        _reap(taskId);

        TaskCoordinatorV4.TaskRecord memory beforeTask = taskCoordinator.getTask(taskId);
        uint32 newMaxTotal = taskCoordinator.addAttempts(taskId, added);
        uint32 oldMax = beforeTask.policy.maxTotal;
        uint32 delta = newMaxTotal - oldMax;

        uint256 solutionTopUp = _mul(payment.solutionMaxDeliveryRate, delta);
        uint256 verdictTopUp = _mul(_mul(payment.verdictMaxDeliveryRate, delta), beforeTask.policy.minVerdicts);
        SafeTransferLib.safeTransferFrom(olasToken, msg.sender, address(this), solutionTopUp + verdictTopUp);
        payment.solutionBudgetRemaining += solutionTopUp;
        payment.verdictBudgetRemaining += verdictTopUp;

        emit AttemptsAdded(taskId, msg.sender, added, newMaxTotal);
    }

    function claimTask(uint256 taskId, address priorityMech) external returns (uint32 attemptIndex) {
        if (!initialized) revert RouterV4NotInitialized();
        TaskPayment storage payment = _requirePayment(taskId);
        _reap(taskId);
        _validateMechOperator(priorityMech, msg.sender);

        uint256 deliveryRate = IMechV4(priorityMech).maxDeliveryRate();
        if (deliveryRate == 0) revert RouterV4ZeroValue();
        if (deliveryRate > payment.solutionMaxDeliveryRate) {
            revert RouterV4InsufficientTaskBudget(taskId, payment.solutionMaxDeliveryRate, deliveryRate);
        }
        if (payment.solutionBudgetRemaining < deliveryRate) {
            revert RouterV4InsufficientTaskBudget(taskId, payment.solutionBudgetRemaining, deliveryRate);
        }

        uint64 deadline = uint64(block.timestamp + payment.responseTimeout);
        attemptIndex = taskCoordinator.claimTask(taskId, msg.sender, deadline);

        payment.solutionBudgetRemaining -= deliveryRate;
        payment.solutionReserved += deliveryRate;

        Reservation storage reservation = solutionReservations[taskId][attemptIndex];
        reservation.kind = ReservationKind.Solution;
        reservation.taskId = taskId;
        reservation.attemptIndex = attemptIndex;
        reservation.verdictIndex = 0;
        reservation.party = msg.sender;
        reservation.priorityMech = priorityMech;
        reservation.rate = deliveryRate;
        reservation.deadline = deadline;
        reservation.settled = false;
        reservation.released = false;
        _clearPreparation(solutionPreparations[taskId][attemptIndex]);

        emit TaskAttemptCreated(msg.sender, priorityMech, taskId, attemptIndex, deadline, deliveryRate);
    }

    function claimEvaluation(uint256 taskId, uint32 attemptIndex, address evaluatorMech)
        external
        returns (uint32 verdictIndex)
    {
        if (!initialized) revert RouterV4NotInitialized();
        TaskPayment storage payment = _requirePayment(taskId);
        _reap(taskId);
        _validateMechOperator(evaluatorMech, msg.sender);

        uint256 deliveryRate = IMechV4(evaluatorMech).maxDeliveryRate();
        if (deliveryRate == 0) revert RouterV4ZeroValue();
        if (deliveryRate > payment.verdictMaxDeliveryRate) {
            revert RouterV4InsufficientTaskBudget(taskId, payment.verdictMaxDeliveryRate, deliveryRate);
        }
        if (payment.verdictBudgetRemaining < deliveryRate) {
            revert RouterV4InsufficientTaskBudget(taskId, payment.verdictBudgetRemaining, deliveryRate);
        }

        uint64 deadline = uint64(block.timestamp + payment.responseTimeout);
        verdictIndex = taskCoordinator.claimEvaluation(taskId, attemptIndex, msg.sender, deadline);

        payment.verdictBudgetRemaining -= deliveryRate;
        payment.verdictReserved += deliveryRate;

        Reservation storage reservation = verdictReservations[taskId][attemptIndex][verdictIndex];
        reservation.kind = ReservationKind.Verdict;
        reservation.taskId = taskId;
        reservation.attemptIndex = attemptIndex;
        reservation.verdictIndex = verdictIndex;
        reservation.party = msg.sender;
        reservation.priorityMech = evaluatorMech;
        reservation.rate = deliveryRate;
        reservation.deadline = deadline;
        reservation.settled = false;
        reservation.released = false;
        _clearPreparation(verdictPreparations[taskId][attemptIndex][verdictIndex]);

        emit EvaluationAttemptCreated(
            msg.sender, evaluatorMech, taskId, attemptIndex, verdictIndex, deadline, deliveryRate
        );
    }

    /// @notice First Safe MultiSend leg: bind exact requestId/nonce/requestData before tokens can move.
    function prepareSolutionDelivery(uint256 taskId, uint32 attemptIndex, bytes32 deliveryDigest)
        external
        returns (bytes32 expectedRequestId, uint256 nonce, bytes memory requestData)
    {
        if (!initialized) revert RouterV4NotInitialized();
        Reservation storage reservation = solutionReservations[taskId][attemptIndex];
        if (!_isLive(reservation)) revert RouterV4ReservationNotLive(taskId, attemptIndex, 0);
        if (reservation.party != msg.sender) revert RouterV4NotReservationParty(reservation.party, msg.sender);

        Preparation storage prep = solutionPreparations[taskId][attemptIndex];
        _clearStalePreparation(prep, taskId, attemptIndex, 0);

        requestData = MarketplaceRequestData.encodeSolution(taskId, attemptIndex, deliveryDigest);
        nonce = IMechMarketplaceV4(mechMarketplace).mapNonces(address(this));
        expectedRequestId = IMechMarketplaceV4(mechMarketplace).getRequestId(
            reservation.priorityMech, address(this), requestData, reservation.rate, tokenPaymentType, nonce
        );

        prep.prepared = true;
        prep.expectedRequestId = expectedRequestId;
        prep.preparedNonce = nonce;
        prep.requestDataHash = keccak256(requestData);
        prep.deliveryDigest = deliveryDigest;
        prep.verdictCode = 0;

        emit SolutionDeliveryPrepared(msg.sender, expectedRequestId, taskId, attemptIndex, nonce, deliveryDigest);
    }

    /// @notice First Safe MultiSend leg for verdicts; verdictCode is frozen into requestData.
    function prepareVerdictDelivery(
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        bytes32 deliveryDigest,
        uint8 verdictCode
    ) external returns (bytes32 expectedRequestId, uint256 nonce, bytes memory requestData) {
        if (!initialized) revert RouterV4NotInitialized();
        Reservation storage reservation = verdictReservations[taskId][attemptIndex][verdictIndex];
        if (!_isLive(reservation)) revert RouterV4ReservationNotLive(taskId, attemptIndex, verdictIndex);
        if (reservation.party != msg.sender) revert RouterV4NotReservationParty(reservation.party, msg.sender);

        Preparation storage prep = verdictPreparations[taskId][attemptIndex][verdictIndex];
        _clearStalePreparation(prep, taskId, attemptIndex, verdictIndex);

        requestData =
            MarketplaceRequestData.encodeVerdict(taskId, attemptIndex, verdictIndex, deliveryDigest, verdictCode);
        nonce = IMechMarketplaceV4(mechMarketplace).mapNonces(address(this));
        expectedRequestId = IMechMarketplaceV4(mechMarketplace).getRequestId(
            reservation.priorityMech, address(this), requestData, reservation.rate, tokenPaymentType, nonce
        );

        prep.prepared = true;
        prep.expectedRequestId = expectedRequestId;
        prep.preparedNonce = nonce;
        prep.requestDataHash = keccak256(requestData);
        prep.deliveryDigest = deliveryDigest;
        prep.verdictCode = verdictCode;

        emit VerdictDeliveryPrepared(
            msg.sender, expectedRequestId, taskId, attemptIndex, verdictIndex, nonce, deliveryDigest, verdictCode
        );
    }

    function releaseAttempt(uint256 taskId, uint32 attemptIndex) external {
        TaskPayment storage payment = _requirePayment(taskId);
        _reap(taskId);
        Reservation storage reservation = solutionReservations[taskId][attemptIndex];
        if (!_isLive(reservation) || reservation.party != msg.sender) {
            revert RouterV4ReservationNotLive(taskId, attemptIndex, 0);
        }
        Preparation storage prep = solutionPreparations[taskId][attemptIndex];
        _requireUndeliveredForBudgetRestore(prep, taskId, attemptIndex, 0);
        taskCoordinator.releaseAttempt(taskId, attemptIndex, msg.sender);
        _clearPreparation(prep);
        reservation.released = true;
        payment.solutionReserved -= reservation.rate;
        payment.solutionBudgetRemaining += reservation.rate;
        emit AttemptReleased(taskId, attemptIndex, msg.sender);
    }

    function releaseVerdict(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex) external {
        TaskPayment storage payment = _requirePayment(taskId);
        _reap(taskId);
        Reservation storage reservation = verdictReservations[taskId][attemptIndex][verdictIndex];
        if (!_isLive(reservation) || reservation.party != msg.sender) {
            revert RouterV4ReservationNotLive(taskId, attemptIndex, verdictIndex);
        }
        Preparation storage prep = verdictPreparations[taskId][attemptIndex][verdictIndex];
        _requireUndeliveredForBudgetRestore(prep, taskId, attemptIndex, verdictIndex);
        taskCoordinator.releaseVerdict(taskId, attemptIndex, verdictIndex, msg.sender);
        _clearPreparation(prep);
        reservation.released = true;
        payment.verdictReserved -= reservation.rate;
        payment.verdictBudgetRemaining += reservation.rate;
        emit AttemptReleased(taskId, attemptIndex, msg.sender);
    }

    /// @notice Clear a Delivered-but-unclaimed reservation without protocol activity credit.
    function forfeitDeliveredReservation(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, uint8 legKind)
        external
    {
        if (legKind == MarketplaceRequestData.LEG_SOLUTION) {
            _forfeitSolution(taskId, attemptIndex);
        } else if (legKind == MarketplaceRequestData.LEG_VERDICT) {
            _forfeitVerdict(taskId, attemptIndex, verdictIndex);
        } else {
            revert RouterV4CrossBinding();
        }
    }

    function closeTask(uint256 taskId) external {
        TaskPayment storage payment = _requirePayment(taskId);
        if (msg.sender != payment.creator) revert RouterV4OwnerOnly(msg.sender, payment.creator);
        _reap(taskId);
        taskCoordinator.closeTask(taskId, msg.sender);
        emit TaskClosed(taskId, msg.sender);
        _refundUnreserved(taskId, false);
    }

    function refundUnusedTaskBudget(uint256 taskId) external {
        TaskPayment storage payment = _requirePayment(taskId);
        if (msg.sender != payment.creator) revert RouterV4OwnerOnly(msg.sender, payment.creator);
        _reap(taskId);
        _refundUnreserved(taskId, true);
    }

    /// @notice View-only EIP-1271: magic only for the stored prepared authorization and exact requestId.
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (msg.sender != mechMarketplace) revert RouterV4MarketplaceOnly(msg.sender, mechMarketplace);
        RouterV4Auth.AuthSig memory auth = RouterV4Auth.decode(signature);
        _assertPreparedAuth(auth, hash);
        return EIP1271_MAGIC;
    }

    function claimSolutionDelivery(
        address mech,
        bytes calldata requestData,
        uint256 deliveryRate,
        bytes32 paymentType,
        uint256 nonce
    ) external {
        if (!initialized) revert RouterV4NotInitialized();
        if (paymentType != tokenPaymentType) revert RouterV4InvalidPaymentType(paymentType);

        MarketplaceRequestData.Decoded memory decoded = MarketplaceRequestData.decode(requestData);
        if (decoded.legKind != MarketplaceRequestData.LEG_SOLUTION) revert RouterV4CrossBinding();

        bytes32 requestId = IMechMarketplaceV4(mechMarketplace).getRequestId(
            mech, address(this), requestData, deliveryRate, paymentType, nonce
        );
        if (claimed[requestId]) revert RouterV4AlreadyClaimed(requestId);

        Reservation storage reservation = solutionReservations[decoded.taskId][decoded.attemptIndex];
        Preparation storage prep = solutionPreparations[decoded.taskId][decoded.attemptIndex];
        _assertClaimBinding(reservation, prep, mech, requestData, deliveryRate, nonce, requestId, decoded, 0);

        if (msg.sender != reservation.party) {
            revert RouterV4WrongDeliveryOperator(bytes32(0), reservation.party, mech);
        }

        _requireDeliveredExact(requestId, mech, deliveryRate, paymentType);

        reservation.settled = true;
        claimed[requestId] = true;
        TaskPayment storage payment = taskPayments[decoded.taskId];
        payment.solutionReserved -= reservation.rate;
        payment.solutionSpentOut += reservation.rate;
        _clearPreparation(prep);

        taskCoordinator.recordSolutionDelivery(
            decoded.taskId, decoded.attemptIndex, msg.sender, decoded.deliveryDigest
        );

        emit SolutionDeliveryClaimed(
            msg.sender, requestId, decoded.deliveryDigest, decoded.taskId, decoded.attemptIndex
        );
    }

    function claimVerdictDelivery(
        address mech,
        bytes calldata requestData,
        uint256 deliveryRate,
        bytes32 paymentType,
        uint256 nonce
    ) external {
        if (!initialized) revert RouterV4NotInitialized();
        if (paymentType != tokenPaymentType) revert RouterV4InvalidPaymentType(paymentType);

        MarketplaceRequestData.Decoded memory decoded = MarketplaceRequestData.decode(requestData);
        if (decoded.legKind != MarketplaceRequestData.LEG_VERDICT) revert RouterV4CrossBinding();

        bytes32 requestId = IMechMarketplaceV4(mechMarketplace).getRequestId(
            mech, address(this), requestData, deliveryRate, paymentType, nonce
        );
        if (claimed[requestId]) revert RouterV4AlreadyClaimed(requestId);

        Reservation storage reservation =
            verdictReservations[decoded.taskId][decoded.attemptIndex][decoded.verdictIndex];
        Preparation storage prep =
            verdictPreparations[decoded.taskId][decoded.attemptIndex][decoded.verdictIndex];
        _assertClaimBinding(
            reservation, prep, mech, requestData, deliveryRate, nonce, requestId, decoded, decoded.verdictCode
        );

        if (msg.sender != reservation.party) {
            revert RouterV4WrongDeliveryOperator(bytes32(0), reservation.party, mech);
        }

        _requireDeliveredExact(requestId, mech, deliveryRate, paymentType);

        uint8 verdictCode = prep.verdictCode;
        reservation.settled = true;
        claimed[requestId] = true;
        TaskPayment storage payment = taskPayments[decoded.taskId];
        payment.verdictReserved -= reservation.rate;
        payment.verdictSpentOut += reservation.rate;
        _clearPreparation(prep);

        _finalizeVerdictCredit(
            decoded.taskId, decoded.attemptIndex, decoded.verdictIndex, decoded.deliveryDigest, verdictCode, requestId
        );
    }

    function encodeAuthSignature(
        uint8 legKind,
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        address mech,
        bytes memory requestData,
        uint256 rate,
        uint256 nonce
    ) external view returns (bytes memory) {
        return RouterV4Auth.encode(
            legKind, taskId, attemptIndex, verdictIndex, mech, requestData, rate, tokenPaymentType, nonce
        );
    }

    function _finalizeVerdictCredit(
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        bytes32 deliveryDigest,
        uint8 verdictCode,
        bytes32 requestId
    ) internal {
        (bool attemptFinalized, bool creditCreator, address creator, uint256 creatorWeight) = taskCoordinator
            .recordVerdict(taskId, attemptIndex, verdictIndex, msg.sender, deliveryDigest, verdictCode);

        if (activityChecker != address(0)) {
            ITaskActivityCheckerV4(activityChecker).recordVerdictDelivery(msg.sender, deliveryDigest);
            if (attemptFinalized) {
                TaskCoordinatorV4.AttemptRecord memory finalizedAttempt = taskCoordinator.getAttempt(taskId, attemptIndex);
                ITaskActivityCheckerV4(activityChecker).recordSolutionDelivery(
                    finalizedAttempt.operator, finalizedAttempt.solutionDigest
                );
                if (creditCreator) {
                    ITaskActivityCheckerV4(activityChecker).recordTaskCreationFinalized(
                        creator, taskId, creatorWeight
                    );
                }
            }
        }

        emit VerdictDeliveryClaimed(
            msg.sender, requestId, deliveryDigest, taskId, attemptIndex, verdictIndex, verdictCode
        );
    }

    function _forfeitSolution(uint256 taskId, uint32 attemptIndex) internal {
        Reservation storage reservation = solutionReservations[taskId][attemptIndex];
        Preparation storage prep = solutionPreparations[taskId][attemptIndex];
        if (reservation.kind == ReservationKind.None || reservation.settled || reservation.released) {
            revert RouterV4ReservationNotLive(taskId, attemptIndex, 0);
        }
        if (msg.sender != reservation.party && msg.sender != taskPayments[taskId].creator) {
            revert RouterV4OwnerOnly(msg.sender, reservation.party);
        }
        if (!prep.prepared) revert RouterV4NotPrepared(taskId, attemptIndex, 0);
        if (_marketplaceStatus(prep.expectedRequestId) != IMechMarketplaceV4.RequestStatus.Delivered) {
            revert RouterV4NotDelivered(prep.expectedRequestId);
        }

        // Coordinator terminal first: revert rolls back; never credit or restore budget.
        taskCoordinator.forfeitAttempt(taskId, attemptIndex);

        TaskPayment storage payment = taskPayments[taskId];
        payment.solutionReserved -= reservation.rate;
        payment.solutionSpentOut += reservation.rate;
        claimed[prep.expectedRequestId] = true;
        reservation.settled = true;
        bytes32 requestId = prep.expectedRequestId;
        uint256 rate = reservation.rate;
        _clearPreparation(prep);
        emit ReservationForfeited(taskId, attemptIndex, 0, requestId, rate, MarketplaceRequestData.LEG_SOLUTION);
    }

    function _forfeitVerdict(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex) internal {
        Reservation storage reservation = verdictReservations[taskId][attemptIndex][verdictIndex];
        Preparation storage prep = verdictPreparations[taskId][attemptIndex][verdictIndex];
        if (reservation.kind == ReservationKind.None || reservation.settled || reservation.released) {
            revert RouterV4ReservationNotLive(taskId, attemptIndex, verdictIndex);
        }
        if (msg.sender != reservation.party && msg.sender != taskPayments[taskId].creator) {
            revert RouterV4OwnerOnly(msg.sender, reservation.party);
        }
        if (!prep.prepared) revert RouterV4NotPrepared(taskId, attemptIndex, verdictIndex);
        if (_marketplaceStatus(prep.expectedRequestId) != IMechMarketplaceV4.RequestStatus.Delivered) {
            revert RouterV4NotDelivered(prep.expectedRequestId);
        }

        taskCoordinator.forfeitVerdict(taskId, attemptIndex, verdictIndex);

        TaskPayment storage payment = taskPayments[taskId];
        payment.verdictReserved -= reservation.rate;
        payment.verdictSpentOut += reservation.rate;
        claimed[prep.expectedRequestId] = true;
        reservation.settled = true;
        bytes32 requestId = prep.expectedRequestId;
        uint256 rate = reservation.rate;
        _clearPreparation(prep);
        emit ReservationForfeited(
            taskId, attemptIndex, verdictIndex, requestId, rate, MarketplaceRequestData.LEG_VERDICT
        );
    }

    function _assertPreparedAuth(RouterV4Auth.AuthSig memory auth, bytes32 hash) internal view {
        if (auth.paymentType != tokenPaymentType) revert RouterV4InvalidPaymentType(auth.paymentType);

        MarketplaceRequestData.Decoded memory decoded = MarketplaceRequestData.decode(auth.requestData);
        if (decoded.legKind != auth.legKind) revert RouterV4CrossBinding();
        if (
            decoded.taskId != auth.taskId || decoded.attemptIndex != auth.attemptIndex
                || decoded.verdictIndex != auth.verdictIndex
        ) {
            revert RouterV4CrossBinding();
        }

        Reservation memory reservation =
            _loadReservation(auth.legKind, auth.taskId, auth.attemptIndex, auth.verdictIndex);
        if (!_isLive(reservation)) {
            revert RouterV4ReservationNotLive(auth.taskId, auth.attemptIndex, auth.verdictIndex);
        }

        Preparation memory prep = _loadPreparation(auth.legKind, auth.taskId, auth.attemptIndex, auth.verdictIndex);
        if (!prep.prepared) {
            revert RouterV4NotPrepared(auth.taskId, auth.attemptIndex, auth.verdictIndex);
        }
        if (reservation.priorityMech != auth.mech) revert RouterV4MechMismatch(reservation.priorityMech, auth.mech);
        if (reservation.rate != auth.rate) revert RouterV4RateMismatch(reservation.rate, auth.rate);
        if (prep.preparedNonce != auth.nonce) revert RouterV4NonceMismatch(prep.preparedNonce, auth.nonce);
        if (prep.requestDataHash != keccak256(auth.requestData)) revert RouterV4CrossBinding();
        if (prep.deliveryDigest != decoded.deliveryDigest) revert RouterV4CrossBinding();
        if (auth.legKind == MarketplaceRequestData.LEG_VERDICT && prep.verdictCode != decoded.verdictCode) {
            revert RouterV4VerdictCodeMismatch(prep.verdictCode, decoded.verdictCode);
        }

        uint256 currentNonce = IMechMarketplaceV4(mechMarketplace).mapNonces(address(this));
        if (auth.nonce != currentNonce) revert RouterV4NonceMismatch(currentNonce, auth.nonce);

        bytes32 requestId = IMechMarketplaceV4(mechMarketplace).getRequestId(
            auth.mech, address(this), auth.requestData, auth.rate, auth.paymentType, auth.nonce
        );
        if (requestId != hash) revert RouterV4SignatureInvalid();
        if (requestId != prep.expectedRequestId) {
            revert RouterV4RequestIdMismatch(prep.expectedRequestId, requestId);
        }
    }

    function _assertClaimBinding(
        Reservation storage reservation,
        Preparation storage prep,
        address mech,
        bytes calldata requestData,
        uint256 deliveryRate,
        uint256 nonce,
        bytes32 requestId,
        MarketplaceRequestData.Decoded memory decoded,
        uint8 expectedVerdictCode
    ) internal view {
        if (!_isLive(reservation)) {
            revert RouterV4ReservationNotLive(decoded.taskId, decoded.attemptIndex, decoded.verdictIndex);
        }
        if (!prep.prepared) {
            revert RouterV4NotPrepared(decoded.taskId, decoded.attemptIndex, decoded.verdictIndex);
        }
        if (prep.expectedRequestId != requestId) {
            revert RouterV4RequestIdMismatch(prep.expectedRequestId, requestId);
        }
        if (prep.preparedNonce != nonce) revert RouterV4NonceMismatch(prep.preparedNonce, nonce);
        if (prep.requestDataHash != keccak256(requestData)) revert RouterV4CrossBinding();
        if (prep.deliveryDigest != decoded.deliveryDigest) revert RouterV4CrossBinding();
        if (prep.verdictCode != expectedVerdictCode) {
            revert RouterV4VerdictCodeMismatch(prep.verdictCode, expectedVerdictCode);
        }
        if (reservation.priorityMech != mech) revert RouterV4MechMismatch(reservation.priorityMech, mech);
        if (reservation.rate != deliveryRate) revert RouterV4RateMismatch(reservation.rate, deliveryRate);
    }

    function _requirePayment(uint256 taskId) internal view returns (TaskPayment storage payment) {
        payment = taskPayments[taskId];
        if (payment.creator == address(0)) revert RouterV4TaskNotFound(taskId);
    }

    function _validateMechOperator(address mech, address operator) internal view {
        if (mech == address(0)) revert RouterV4ZeroAddress();
        if (!IMechV4(mech).isOperator(operator)) revert RouterV4InvalidOperatorMech(operator, mech);
        if (IMechV4(mech).paymentType() != tokenPaymentType) {
            revert RouterV4InvalidPaymentType(IMechV4(mech).paymentType());
        }
    }

    function _isLive(Reservation memory reservation) internal view returns (bool) {
        return reservation.kind != ReservationKind.None && !reservation.settled && !reservation.released
            && block.timestamp <= reservation.deadline;
    }

    function _loadReservation(uint8 legKind, uint256 taskId, uint32 attemptIndex, uint32 verdictIndex)
        internal
        view
        returns (Reservation memory)
    {
        if (legKind == MarketplaceRequestData.LEG_SOLUTION) {
            return solutionReservations[taskId][attemptIndex];
        }
        if (legKind == MarketplaceRequestData.LEG_VERDICT) {
            return verdictReservations[taskId][attemptIndex][verdictIndex];
        }
        revert RouterV4CrossBinding();
    }

    function _loadPreparation(uint8 legKind, uint256 taskId, uint32 attemptIndex, uint32 verdictIndex)
        internal
        view
        returns (Preparation memory)
    {
        if (legKind == MarketplaceRequestData.LEG_SOLUTION) {
            return solutionPreparations[taskId][attemptIndex];
        }
        if (legKind == MarketplaceRequestData.LEG_VERDICT) {
            return verdictPreparations[taskId][attemptIndex][verdictIndex];
        }
        revert RouterV4CrossBinding();
    }

    function _marketplaceStatus(bytes32 requestId) internal view returns (IMechMarketplaceV4.RequestStatus) {
        try IMechMarketplaceV4(mechMarketplace).getRequestStatus(requestId) returns (
            IMechMarketplaceV4.RequestStatus status
        ) {
            return status;
        } catch {
            revert RouterV4MarketplaceStatusUnavailable(requestId);
        }
    }

    function _requireUndeliveredForBudgetRestore(
        Preparation storage prep,
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex
    ) internal view {
        if (!prep.prepared) return;
        IMechMarketplaceV4.RequestStatus status = _marketplaceStatus(prep.expectedRequestId);
        if (status == IMechMarketplaceV4.RequestStatus.Delivered) {
            revert RouterV4PreparationDelivered(taskId, attemptIndex, verdictIndex, prep.expectedRequestId);
        }
    }

    function _clearStalePreparation(
        Preparation storage prep,
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex
    ) internal {
        if (!prep.prepared) return;
        IMechMarketplaceV4.RequestStatus status = _marketplaceStatus(prep.expectedRequestId);
        if (status == IMechMarketplaceV4.RequestStatus.Delivered) {
            revert RouterV4AlreadyPrepared(taskId, attemptIndex, verdictIndex);
        }
        _clearPreparation(prep);
    }

    function _clearPreparation(Preparation storage prep) internal {
        prep.prepared = false;
        prep.expectedRequestId = bytes32(0);
        prep.preparedNonce = 0;
        prep.requestDataHash = bytes32(0);
        prep.deliveryDigest = bytes32(0);
        prep.verdictCode = 0;
    }

    function _requireDeliveredExact(
        bytes32 requestId,
        address expectedMech,
        uint256 expectedRate,
        bytes32 expectedPaymentType
    ) internal view {
        IMechMarketplaceV4.RequestStatus status = _marketplaceStatus(requestId);
        if (status != IMechMarketplaceV4.RequestStatus.Delivered) revert RouterV4NotDelivered(requestId);

        (
            address priorityMech,
            address deliveryMech,
            address requester,
            ,
            uint256 deliveryRate,
            bytes32 paymentType
        ) = IMechMarketplaceV4(mechMarketplace).mapRequestIdInfos(requestId);

        if (requester != address(this)) revert RouterV4WrongRequester(requestId, requester);
        if (deliveryMech != expectedMech && priorityMech != expectedMech) {
            revert RouterV4MechMismatch(expectedMech, deliveryMech);
        }
        if (!IMechV4(deliveryMech).isOperator(msg.sender)) {
            revert RouterV4WrongDeliveryOperator(requestId, msg.sender, deliveryMech);
        }
        if (deliveryRate != expectedRate) revert RouterV4RateMismatch(expectedRate, deliveryRate);
        if (paymentType != expectedPaymentType) revert RouterV4InvalidPaymentType(paymentType);
    }

    function _reap(uint256 taskId) internal {
        TaskPayment storage payment = taskPayments[taskId];
        TaskCoordinatorV4.TaskRecord memory task = taskCoordinator.getTask(taskId);
        uint32 n = task.nextAttemptIndex;
        for (uint32 i = 0; i < n; i++) {
            Reservation storage sRes = solutionReservations[taskId][i];
            if (
                sRes.kind == ReservationKind.Solution && !sRes.settled && !sRes.released
                    && block.timestamp > sRes.deadline
            ) {
                Preparation storage sPrep = solutionPreparations[taskId][i];
                if (sPrep.prepared) {
                    if (_marketplaceStatus(sPrep.expectedRequestId) == IMechMarketplaceV4.RequestStatus.Delivered) {
                        continue;
                    }
                }
                sRes.released = true;
                _clearPreparation(sPrep);
                payment.solutionReserved -= sRes.rate;
                payment.solutionBudgetRemaining += sRes.rate;
                emit AttemptExpired(taskId, i, sRes.party);
            }
            TaskCoordinatorV4.AttemptRecord memory attempt = taskCoordinator.getAttempt(taskId, i);
            uint32 vCount = attempt.nextVerdictIndex;
            for (uint32 v = 0; v < vCount; v++) {
                Reservation storage vRes = verdictReservations[taskId][i][v];
                if (
                    vRes.kind == ReservationKind.Verdict && !vRes.settled && !vRes.released
                        && block.timestamp > vRes.deadline
                ) {
                    Preparation storage vPrep = verdictPreparations[taskId][i][v];
                    if (vPrep.prepared) {
                        if (_marketplaceStatus(vPrep.expectedRequestId) == IMechMarketplaceV4.RequestStatus.Delivered)
                        {
                            continue;
                        }
                    }
                    vRes.released = true;
                    _clearPreparation(vPrep);
                    payment.verdictReserved -= vRes.rate;
                    payment.verdictBudgetRemaining += vRes.rate;
                    emit AttemptExpired(taskId, i, vRes.party);
                }
            }
        }
        taskCoordinator.reapExpired(taskId);
    }

    function _refundUnreserved(uint256 taskId, bool requireNonZero) internal {
        TaskPayment storage payment = taskPayments[taskId];
        uint256 solutionAmount = payment.solutionBudgetRemaining;
        uint256 verdictAmount = payment.verdictBudgetRemaining;
        uint256 amount = solutionAmount + verdictAmount;
        if (amount == 0) {
            if (requireNonZero) revert RouterV4TaskNotRefundable(taskId);
            return;
        }
        payment.solutionBudgetRemaining = 0;
        payment.verdictBudgetRemaining = 0;
        SafeTransferLib.safeTransfer(olasToken, payment.creator, amount);
        emit TaskBudgetRefunded(taskId, payment.creator, solutionAmount, verdictAmount);
    }

    function _mul(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0 || b == 0) return 0;
        uint256 c = a * b;
        if (c / a != b) revert RouterV4Overflow();
        return c;
    }
}
