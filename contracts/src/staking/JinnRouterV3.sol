// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {TaskCoordinator} from "../tasks/TaskCoordinator.sol";

interface ITaskActivityCheckerV3 {
    function recordSolutionDelivery(address operator, bytes32 solutionDigest) external returns (uint256 weight);
    function recordVerdictDelivery(address evaluator, bytes32 verdictDigest) external returns (uint256 weight);
    function recordTaskCreationFinalized(address creator, uint256 taskId, uint256 weight) external;
}

interface IMechV3 {
    function maxDeliveryRate() external view returns (uint256);
    function paymentType() external view returns (bytes32);
    function isOperator(address multisig) external view returns (bool);
}

interface IMechMarketplaceV3 {
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

    function mapRequestIdInfos(bytes32 requestId) external view returns (
        address priorityMech,
        address deliveryMech,
        address requester,
        uint256 responseTimeout,
        uint256 deliveryRate,
        bytes32 paymentType
    );
}

error RouterZeroAddress();
error RouterZeroValue();
error RouterAlreadyInitialized();
error RouterNotInitialized();
error RouterOwnerOnly(address sender, address owner);
error RouterTaskNotFound(uint256 taskId);
error RouterTaskNotRefundable(uint256 taskId);
error RouterRefundFailed(address receiver, uint256 amount);
error RouterInvalidPaymentType(bytes32 paymentType);
error RouterInvalidOperatorMech(address operator, address mech);
error RouterInsufficientTaskBudget(uint256 taskId, uint256 available, uint256 required);
error RouterRequestNotFound(bytes32 requestId);
error RouterAlreadyClaimed(bytes32 requestId);
error RouterNotDelivered(bytes32 requestId);
error RouterWrongRequester(bytes32 requestId, address requester);
error RouterWrongDeliveryOperator(bytes32 requestId, address expectedOperator, address deliveryMech);
error RouterWrongRequestKind(bytes32 requestId, uint8 expected, uint8 actual);

/// @title JinnRouterV3
/// @notice Clean-break Task-first router. Bridges TaskCoordinator attempts and verdicts to OLAS Mech requests.
contract JinnRouterV3 {
    bytes32 public constant NATIVE_PAYMENT_TYPE =
        0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1;
    uint256 private constant FULL_WEIGHT = 1e18;

    enum RequestKind {
        None,
        Solution,
        Verdict
    }

    struct TaskPayment {
        address creator;
        bytes32 taskCidDigest;
        bytes32 solverTypeDigest;
        uint256 solutionMaxDeliveryRate;
        uint256 verdictMaxDeliveryRate;
        uint256 responseTimeout;
        uint256 solutionBudgetRemaining;
        uint256 verdictBudgetRemaining;
        bool solutionBudgetRefunded;
        bool verdictBudgetRefunded;
    }

    address public owner;
    address public mechMarketplace;
    address public activityChecker;
    TaskCoordinator public taskCoordinator;
    bool public initialized;

    mapping(bytes32 => RequestKind) public requestKinds;
    mapping(bytes32 => bool) public claimed;
    mapping(bytes32 => bool) public solutionDeliveryClaimed;
    mapping(bytes32 => bool) public verdictDeliveryClaimed;
    mapping(uint256 => TaskPayment) public taskPayments;

    event Initialized(
        address indexed owner,
        address indexed mechMarketplace,
        address indexed taskCoordinator,
        address activityChecker
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TaskCreated(
        address indexed creator,
        uint256 indexed taskId,
        bytes32 indexed solverTypeDigest,
        bytes32 taskCidDigest,
        uint16 maxClaims,
        uint16 requiredVerdicts,
        uint256 solutionBudget,
        uint256 verdictBudget
    );
    event TaskAttemptCreated(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        bytes32 indexed requestId,
        address operator,
        address priorityMech,
        uint256 deliveryRate
    );
    event EvaluationAttemptCreated(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        uint32 indexed verdictIndex,
        bytes32 requestId,
        address evaluator,
        address priorityMech,
        uint256 deliveryRate
    );
    event SolutionDeliveryClaimed(address indexed operator, bytes32 indexed requestId, uint256 indexed taskId, uint32 attemptIndex);
    event VerdictDeliveryClaimed(address indexed evaluator, bytes32 indexed requestId, uint256 indexed taskId, uint32 attemptIndex, uint32 verdictIndex, uint8 verdictCode);
    event TaskBudgetRefunded(uint256 indexed taskId, address indexed creator, uint256 solutionAmount, uint256 verdictAmount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert RouterOwnerOnly(msg.sender, owner);
        _;
    }

    function initialize(
        address _owner,
        address _mechMarketplace,
        address _taskCoordinator,
        address _activityChecker
    ) external {
        if (initialized) revert RouterAlreadyInitialized();
        if (_owner == address(0) || _mechMarketplace == address(0) || _taskCoordinator == address(0)) {
            revert RouterZeroAddress();
        }
        owner = _owner;
        mechMarketplace = _mechMarketplace;
        taskCoordinator = TaskCoordinator(_taskCoordinator);
        activityChecker = _activityChecker;
        initialized = true;
        emit Initialized(_owner, _mechMarketplace, _taskCoordinator, _activityChecker);
        emit OwnershipTransferred(address(0), _owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert RouterZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function setActivityChecker(address newActivityChecker) external onlyOwner {
        activityChecker = newActivityChecker;
    }

    function createTask(
        bytes32 taskCidDigest,
        bytes32 solverTypeDigest,
        TaskCoordinator.TaskPolicy calldata policy,
        uint256 solutionMaxDeliveryRate,
        uint256 verdictMaxDeliveryRate,
        uint256 responseTimeout
    ) external payable returns (uint256 taskId) {
        if (!initialized) revert RouterNotInitialized();
        if (
            taskCidDigest == bytes32(0) ||
            solverTypeDigest == bytes32(0) ||
            solutionMaxDeliveryRate == 0 ||
            verdictMaxDeliveryRate == 0
        ) {
            revert RouterZeroValue();
        }

        uint16 requiredVerdicts = _requiredVerdicts(policy);
        uint256 solutionBudget = solutionMaxDeliveryRate * uint256(policy.maxClaims);
        uint256 verdictBudget = verdictMaxDeliveryRate * uint256(policy.maxClaims) * uint256(requiredVerdicts);
        uint256 requiredBudget = solutionBudget + verdictBudget;
        if (msg.value != requiredBudget) revert RouterInsufficientTaskBudget(0, msg.value, requiredBudget);

        taskId = taskCoordinator.createTask(msg.sender, taskCidDigest, solverTypeDigest, policy);
        taskPayments[taskId] = TaskPayment({
            creator: msg.sender,
            taskCidDigest: taskCidDigest,
            solverTypeDigest: solverTypeDigest,
            solutionMaxDeliveryRate: solutionMaxDeliveryRate,
            verdictMaxDeliveryRate: verdictMaxDeliveryRate,
            responseTimeout: responseTimeout,
            solutionBudgetRemaining: solutionBudget,
            verdictBudgetRemaining: verdictBudget,
            solutionBudgetRefunded: false,
            verdictBudgetRefunded: false
        });

        emit TaskCreated(
            msg.sender,
            taskId,
            solverTypeDigest,
            taskCidDigest,
            policy.maxClaims,
            requiredVerdicts,
            solutionBudget,
            verdictBudget
        );
    }

    function claimTask(uint256 taskId, address priorityMech)
        external
        returns (uint32 attemptIndex, bytes32 requestId)
    {
        if (!initialized) revert RouterNotInitialized();
        TaskPayment storage payment = taskPayments[taskId];
        if (payment.creator == address(0)) revert RouterTaskNotFound(taskId);
        _validateMechOperator(priorityMech, msg.sender);

        uint256 deliveryRate = IMechV3(priorityMech).maxDeliveryRate();
        if (deliveryRate == 0) revert RouterZeroValue();
        if (deliveryRate > payment.solutionMaxDeliveryRate) {
            revert RouterInsufficientTaskBudget(taskId, payment.solutionMaxDeliveryRate, deliveryRate);
        }
        if (payment.solutionBudgetRemaining < deliveryRate) {
            revert RouterInsufficientTaskBudget(taskId, payment.solutionBudgetRemaining, deliveryRate);
        }

        uint64 claimExpiresAt;
        (attemptIndex, claimExpiresAt) = taskCoordinator.claimTask(taskId, msg.sender);
        claimExpiresAt;

        payment.solutionBudgetRemaining -= deliveryRate;
        requestId = IMechMarketplaceV3(mechMarketplace).request{value: deliveryRate}(
            abi.encodePacked(payment.taskCidDigest),
            payment.solutionMaxDeliveryRate,
            NATIVE_PAYMENT_TYPE,
            priorityMech,
            payment.responseTimeout,
            ""
        );

        requestKinds[requestId] = RequestKind.Solution;
        taskCoordinator.registerAttemptRequest(taskId, attemptIndex, requestId);

        emit TaskAttemptCreated(taskId, attemptIndex, requestId, msg.sender, priorityMech, deliveryRate);
    }

    function claimEvaluation(
        uint256 taskId,
        uint32 attemptIndex,
        address evaluatorMech,
        bytes32 evaluationTaskCidDigest
    ) external returns (uint32 verdictIndex, bytes32 verdictRequestId) {
        if (!initialized) revert RouterNotInitialized();
        if (evaluationTaskCidDigest == bytes32(0)) revert RouterZeroValue();
        TaskPayment storage payment = taskPayments[taskId];
        if (payment.creator == address(0)) revert RouterTaskNotFound(taskId);
        _validateMechOperator(evaluatorMech, msg.sender);

        uint64 claimExpiresAt;
        (verdictIndex, claimExpiresAt) = taskCoordinator.claimEvaluation(taskId, attemptIndex, msg.sender);
        claimExpiresAt;

        uint256 deliveryRate = IMechV3(evaluatorMech).maxDeliveryRate();
        if (deliveryRate == 0) revert RouterZeroValue();
        if (deliveryRate > payment.verdictMaxDeliveryRate) {
            revert RouterInsufficientTaskBudget(taskId, payment.verdictMaxDeliveryRate, deliveryRate);
        }
        if (payment.verdictBudgetRemaining < deliveryRate) {
            revert RouterInsufficientTaskBudget(taskId, payment.verdictBudgetRemaining, deliveryRate);
        }

        payment.verdictBudgetRemaining -= deliveryRate;
        verdictRequestId = IMechMarketplaceV3(mechMarketplace).request{value: deliveryRate}(
            abi.encodePacked(evaluationTaskCidDigest),
            payment.verdictMaxDeliveryRate,
            NATIVE_PAYMENT_TYPE,
            evaluatorMech,
            payment.responseTimeout,
            ""
        );

        requestKinds[verdictRequestId] = RequestKind.Verdict;
        taskCoordinator.registerVerdictRequest(taskId, attemptIndex, verdictIndex, verdictRequestId);

        emit EvaluationAttemptCreated(
            taskId,
            attemptIndex,
            verdictIndex,
            verdictRequestId,
            msg.sender,
            evaluatorMech,
            deliveryRate
        );
    }

    function refundUnusedTaskBudget(uint256 taskId) external {
        TaskPayment storage payment = taskPayments[taskId];
        if (payment.creator == address(0)) revert RouterTaskNotFound(taskId);
        if (msg.sender != payment.creator) revert RouterOwnerOnly(msg.sender, payment.creator);

        TaskCoordinator.TaskRecord memory record = taskCoordinator.getTask(taskId);
        uint256 solutionAmount;
        uint256 verdictAmount;

        if (
            !payment.solutionBudgetRefunded &&
            payment.solutionBudgetRemaining > 0 &&
            block.timestamp > record.policy.claimWindowEnd
        ) {
            solutionAmount = payment.solutionBudgetRemaining;
            payment.solutionBudgetRemaining = 0;
            payment.solutionBudgetRefunded = true;
        }

        bool verdictRefundable = block.timestamp > record.policy.evaluationPolicy.evaluationDeadline;
        if (!verdictRefundable && record.submittedCount > 0) {
            verdictRefundable = taskCoordinator.allSubmittedAttemptsFinalized(taskId);
        }
        if (!payment.verdictBudgetRefunded && payment.verdictBudgetRemaining > 0 && verdictRefundable) {
            verdictAmount = payment.verdictBudgetRemaining;
            payment.verdictBudgetRemaining = 0;
            payment.verdictBudgetRefunded = true;
        }

        uint256 amount = solutionAmount + verdictAmount;
        if (amount == 0) revert RouterTaskNotRefundable(taskId);

        (bool ok,) = payment.creator.call{value: amount}("");
        if (!ok) revert RouterRefundFailed(payment.creator, amount);
        emit TaskBudgetRefunded(taskId, payment.creator, solutionAmount, verdictAmount);
    }

    function claimSolutionDelivery(bytes32 requestId, bytes32 solutionDigest) external {
        if (!initialized) revert RouterNotInitialized();
        if (solutionDigest == bytes32(0)) revert RouterZeroValue();
        if (requestKinds[requestId] != RequestKind.Solution) {
            revert RouterWrongRequestKind(requestId, uint8(RequestKind.Solution), uint8(requestKinds[requestId]));
        }
        if (claimed[requestId]) revert RouterAlreadyClaimed(requestId);
        _requireDelivered(requestId);

        (, address deliveryMech, address requester,,,) = IMechMarketplaceV3(mechMarketplace).mapRequestIdInfos(requestId);
        if (requester != address(this)) revert RouterWrongRequester(requestId, requester);

        (uint256 taskId, uint32 attemptIndex, bool exists) = taskCoordinator.getRequestRef(requestId);
        if (!exists) revert RouterRequestNotFound(requestId);
        TaskCoordinator.AttemptRecord memory attempt = taskCoordinator.getAttempt(taskId, attemptIndex);
        if (!IMechV3(deliveryMech).isOperator(attempt.operator)) {
            revert RouterWrongDeliveryOperator(requestId, attempt.operator, deliveryMech);
        }
        if (msg.sender != attempt.operator) {
            revert RouterWrongDeliveryOperator(requestId, attempt.operator, deliveryMech);
        }

        uint256 solutionWeight = FULL_WEIGHT;
        if (activityChecker != address(0)) {
            solutionWeight = ITaskActivityCheckerV3(activityChecker).recordSolutionDelivery(msg.sender, solutionDigest);
        }

        claimed[requestId] = true;
        solutionDeliveryClaimed[requestId] = true;
        taskCoordinator.recordSubmission(requestId, msg.sender, solutionDigest, solutionWeight);

        emit SolutionDeliveryClaimed(msg.sender, requestId, taskId, attemptIndex);
    }

    function claimVerdictDelivery(bytes32 verdictRequestId, bytes32 verdictDigest, uint8 verdictCode) external {
        if (!initialized) revert RouterNotInitialized();
        if (verdictDigest == bytes32(0)) revert RouterZeroValue();
        if (requestKinds[verdictRequestId] != RequestKind.Verdict) {
            revert RouterWrongRequestKind(verdictRequestId, uint8(RequestKind.Verdict), uint8(requestKinds[verdictRequestId]));
        }
        if (claimed[verdictRequestId]) revert RouterAlreadyClaimed(verdictRequestId);
        _requireDelivered(verdictRequestId);

        (, address deliveryMech, address requester,,,) =
            IMechMarketplaceV3(mechMarketplace).mapRequestIdInfos(verdictRequestId);
        if (requester != address(this)) revert RouterWrongRequester(verdictRequestId, requester);

        (uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, bool exists) =
            taskCoordinator.getVerdictRequestRef(verdictRequestId);
        if (!exists) revert RouterRequestNotFound(verdictRequestId);
        TaskCoordinator.VerdictRecord memory verdict = taskCoordinator.getVerdict(taskId, attemptIndex, verdictIndex);
        if (!IMechV3(deliveryMech).isOperator(verdict.evaluator)) {
            revert RouterWrongDeliveryOperator(verdictRequestId, verdict.evaluator, deliveryMech);
        }
        if (msg.sender != verdict.evaluator) {
            revert RouterWrongDeliveryOperator(verdictRequestId, verdict.evaluator, deliveryMech);
        }

        claimed[verdictRequestId] = true;
        verdictDeliveryClaimed[verdictRequestId] = true;
        (
            bool attemptFinalized,
            ,
            bool creditCreator,
            address creator,
            uint256 creatorWeight
        ) = taskCoordinator.recordVerdict(verdictRequestId, msg.sender, verdictDigest, verdictCode);

        if (activityChecker != address(0)) {
            ITaskActivityCheckerV3(activityChecker).recordVerdictDelivery(msg.sender, verdictDigest);
            if (attemptFinalized && creditCreator) {
                ITaskActivityCheckerV3(activityChecker).recordTaskCreationFinalized(creator, taskId, creatorWeight);
            }
        }

        emit VerdictDeliveryClaimed(msg.sender, verdictRequestId, taskId, attemptIndex, verdictIndex, verdictCode);
    }

    function _validateMechOperator(address mech, address operator) internal view {
        if (mech == address(0)) revert RouterZeroAddress();
        if (!IMechV3(mech).isOperator(operator)) revert RouterInvalidOperatorMech(operator, mech);
        bytes32 paymentType = IMechV3(mech).paymentType();
        if (paymentType != NATIVE_PAYMENT_TYPE) revert RouterInvalidPaymentType(paymentType);
    }

    function _requireDelivered(bytes32 requestId) internal view {
        IMechMarketplaceV3.RequestStatus status = IMechMarketplaceV3(mechMarketplace).getRequestStatus(requestId);
        if (status != IMechMarketplaceV3.RequestStatus.Delivered) revert RouterNotDelivered(requestId);
    }

    function _requiredVerdicts(TaskCoordinator.TaskPolicy calldata policy) internal pure returns (uint16) {
        return policy.evaluationPolicy.requiredVerdicts == 0 ? 1 : policy.evaluationPolicy.requiredVerdicts;
    }
}
