// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface ITaskPolicyHook {
    function canClaim(address operator, uint256 taskId, bytes32 solverTypeDigest) external view returns (bool);
}

error TCZeroAddress();
error TCZeroValue();
error TCAlreadyInitialized();
error TCNotInitialized();
error TCOwnerOnly(address sender, address owner);
error TCRouterOnly(address sender, address router);
error TCTaskNotFound(uint256 taskId);
error TCInvalidWindow();
error TCInvalidPolicy();
error TCTaskNotOpen(uint256 taskId);
error TCClaimWindowClosed(uint256 taskId);
error TCSubmissionDeadlinePassed(uint256 taskId);
error TCEvaluationDeadlinePassed(uint256 taskId);
error TCMaxClaimsReached(uint256 taskId);
error TCOperatorClaimLimitReached(uint256 taskId, address operator);
error TCPolicyHookRejected(uint256 taskId, address operator);
error TCAttemptNotFound(uint256 taskId, uint32 attemptIndex);
error TCAttemptNotSubmitted(uint256 taskId, uint32 attemptIndex);
error TCAttemptNotClaimed(uint256 taskId, uint32 attemptIndex);
error TCAttemptNotRegistered(uint256 taskId, uint32 attemptIndex);
error TCAttemptAlreadyRegistered(uint256 taskId, uint32 attemptIndex);
error TCAttemptAlreadySubmitted(uint256 taskId, uint32 attemptIndex);
error TCAttemptAlreadyFinalized(uint256 taskId, uint32 attemptIndex);
error TCRequestAlreadyRegistered(bytes32 requestId);
error TCRequestNotFound(bytes32 requestId);
error TCNotAttemptOperator(uint256 taskId, uint32 attemptIndex, address operator);
error TCClaimNotExpired(uint256 taskId, uint32 attemptIndex);
error TCAttemptClaimExpired(uint256 taskId, uint32 attemptIndex);
error TCSolverSelfEvaluation(uint256 taskId, uint32 attemptIndex, address evaluator);
error TCEvaluatorClaimLimitReached(uint256 taskId, uint32 attemptIndex, address evaluator);
error TCMaxVerdictsReached(uint256 taskId, uint32 attemptIndex);
error TCVerdictNotFound(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCVerdictAlreadyRegistered(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCVerdictAlreadyDelivered(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCVerdictNotRegistered(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCNotVerdictEvaluator(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, address evaluator);
error TCInvalidVerdictCode(uint8 verdictCode);
error TCVerdictClaimExpired(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);

/// @title TaskCoordinator
/// @notice Canonical Task lifecycle, claim, attempt, submission, and evaluation state for new Jinn Tasks.
contract TaskCoordinator {
    enum TaskStatus {
        None,
        Open,
        Closed,
        Cancelled
    }

    enum AttemptStatus {
        None,
        Claimed,
        RequestRegistered,
        Submitted,
        Expired
    }

    enum AttemptFinalization {
        None,
        PendingEvaluation,
        Passed,
        Failed
    }

    enum VerdictStatus {
        None,
        Claimed,
        RequestRegistered,
        Delivered
    }

    enum VerdictCode {
        None,
        Pass,
        Fail,
        Invalid,
        Unresolved
    }

    struct EvaluationPolicy {
        uint16 requiredVerdicts;
        uint16 passThreshold;
        uint64 evaluationDeadline;
        uint16 maxVerdictsPerEvaluator;
        bool disallowSolverSelfEvaluation;
    }

    struct TaskPolicy {
        uint64 claimWindowStart;
        uint64 claimWindowEnd;
        uint64 submissionDeadline;
        uint32 claimLeaseTtlSeconds;
        uint16 maxClaims;
        uint16 maxClaimsPerOperator;
        address policyHook;
        EvaluationPolicy evaluationPolicy;
    }

    struct TaskRecord {
        address creator;
        bytes32 taskCidDigest;
        bytes32 solverTypeDigest;
        TaskStatus status;
        TaskPolicy policy;
        uint32 claimCount;
        uint32 submittedCount;
        uint32 finalizedAttemptCount;
        bool taskCreationCredited;
    }

    struct AttemptRecord {
        uint256 taskId;
        uint32 attemptIndex;
        address operator;
        bytes32 requestId;
        bytes32 solutionCidDigest;
        uint256 solutionWeight;
        uint64 claimedAt;
        uint64 claimExpiresAt;
        uint64 submittedAt;
        AttemptStatus status;
        AttemptFinalization finalization;
        uint16 verdictClaimCount;
        uint16 validVerdictCount;
        uint16 passVerdictCount;
    }

    struct VerdictRecord {
        uint256 taskId;
        uint32 attemptIndex;
        uint32 verdictIndex;
        address evaluator;
        bytes32 requestId;
        bytes32 verdictCidDigest;
        VerdictCode verdictCode;
        uint64 claimedAt;
        uint64 claimExpiresAt;
        uint64 deliveredAt;
        VerdictStatus status;
    }

    struct RequestRef {
        uint256 taskId;
        uint32 attemptIndex;
        bool exists;
    }

    struct VerdictRequestRef {
        uint256 taskId;
        uint32 attemptIndex;
        uint32 verdictIndex;
        bool exists;
    }

    address public owner;
    address public authorizedRouter;
    bool public initialized;
    uint256 public nextTaskId;

    mapping(uint256 => TaskRecord) private _tasks;
    mapping(uint256 => mapping(uint32 => AttemptRecord)) private _attempts;
    mapping(uint256 => mapping(uint32 => mapping(uint32 => VerdictRecord))) private _verdicts;
    mapping(uint256 => mapping(address => uint16)) public claimsByTaskByOperator;
    mapping(uint256 => mapping(uint32 => mapping(address => uint16))) public verdictClaimsByAttemptByEvaluator;
    mapping(bytes32 => RequestRef) private _requestRefs;
    mapping(bytes32 => VerdictRequestRef) private _verdictRequestRefs;

    event Initialized(address indexed owner, address indexed authorizedRouter);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizedRouterUpdated(address indexed previousRouter, address indexed newRouter);
    event TaskCreated(
        uint256 indexed taskId,
        address indexed creator,
        bytes32 indexed solverTypeDigest,
        bytes32 taskCidDigest,
        uint16 maxClaims,
        uint16 requiredVerdicts,
        uint64 claimWindowStart,
        uint64 claimWindowEnd,
        uint64 submissionDeadline,
        uint64 evaluationDeadline
    );
    event TaskClaimed(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        address indexed operator,
        uint64 claimExpiresAt
    );
    event TaskAttemptRequestRegistered(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        bytes32 indexed requestId
    );
    event TaskSubmitted(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        address indexed operator,
        bytes32 requestId,
        bytes32 solutionCidDigest,
        uint256 solutionWeight
    );
    event EvaluationClaimed(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        uint32 indexed verdictIndex,
        address evaluator,
        uint64 claimExpiresAt
    );
    event VerdictRequestRegistered(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        uint32 indexed verdictIndex,
        bytes32 requestId
    );
    event VerdictDelivered(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        uint32 indexed verdictIndex,
        address evaluator,
        bytes32 verdictCidDigest,
        uint8 verdictCode
    );
    event AttemptFinalized(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        bool passed,
        uint16 validVerdictCount,
        uint16 passVerdictCount
    );
    event TaskCreationCreditLocked(uint256 indexed taskId, address indexed creator, uint256 weight);
    event TaskAttemptExpired(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator);

    modifier onlyOwner() {
        if (msg.sender != owner) revert TCOwnerOnly(msg.sender, owner);
        _;
    }

    modifier onlyRouter() {
        if (msg.sender != authorizedRouter) revert TCRouterOnly(msg.sender, authorizedRouter);
        _;
    }

    function initialize(address _owner, address _authorizedRouter) external {
        if (initialized) revert TCAlreadyInitialized();
        if (_owner == address(0) || _authorizedRouter == address(0)) revert TCZeroAddress();
        owner = _owner;
        authorizedRouter = _authorizedRouter;
        nextTaskId = 1;
        initialized = true;
        emit Initialized(_owner, _authorizedRouter);
        emit OwnershipTransferred(address(0), _owner);
        emit AuthorizedRouterUpdated(address(0), _authorizedRouter);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert TCZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function setAuthorizedRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert TCZeroAddress();
        address old = authorizedRouter;
        authorizedRouter = newRouter;
        emit AuthorizedRouterUpdated(old, newRouter);
    }

    function createTask(
        address creator,
        bytes32 taskCidDigest,
        bytes32 solverTypeDigest,
        TaskPolicy calldata policy
    ) external onlyRouter returns (uint256 taskId) {
        if (!initialized) revert TCNotInitialized();
        if (creator == address(0)) revert TCZeroAddress();
        if (taskCidDigest == bytes32(0) || solverTypeDigest == bytes32(0)) revert TCZeroValue();

        TaskPolicy memory normalizedPolicy = _normalizePolicy(policy);
        _validatePolicy(normalizedPolicy);

        taskId = nextTaskId++;
        _tasks[taskId] = TaskRecord({
            creator: creator,
            taskCidDigest: taskCidDigest,
            solverTypeDigest: solverTypeDigest,
            status: TaskStatus.Open,
            policy: normalizedPolicy,
            claimCount: 0,
            submittedCount: 0,
            finalizedAttemptCount: 0,
            taskCreationCredited: false
        });

        emit TaskCreated(
            taskId,
            creator,
            solverTypeDigest,
            taskCidDigest,
            normalizedPolicy.maxClaims,
            normalizedPolicy.evaluationPolicy.requiredVerdicts,
            normalizedPolicy.claimWindowStart,
            normalizedPolicy.claimWindowEnd,
            normalizedPolicy.submissionDeadline,
            normalizedPolicy.evaluationPolicy.evaluationDeadline
        );
    }

    function claimTask(uint256 taskId, address operator)
        external
        onlyRouter
        returns (uint32 attemptIndex, uint64 claimExpiresAt)
    {
        if (operator == address(0)) revert TCZeroAddress();
        TaskRecord storage record = _tasks[taskId];
        if (record.status == TaskStatus.None) revert TCTaskNotFound(taskId);
        if (record.status != TaskStatus.Open) revert TCTaskNotOpen(taskId);

        TaskPolicy memory policy = record.policy;
        uint256 nowTs = block.timestamp;
        if (nowTs < policy.claimWindowStart || nowTs > policy.claimWindowEnd) revert TCClaimWindowClosed(taskId);
        if (nowTs > policy.submissionDeadline) revert TCSubmissionDeadlinePassed(taskId);
        if (record.claimCount >= policy.maxClaims) revert TCMaxClaimsReached(taskId);
        if (claimsByTaskByOperator[taskId][operator] >= policy.maxClaimsPerOperator) {
            revert TCOperatorClaimLimitReached(taskId, operator);
        }
        if (policy.policyHook != address(0)) {
            if (!ITaskPolicyHook(policy.policyHook).canClaim(operator, taskId, record.solverTypeDigest)) {
                revert TCPolicyHookRejected(taskId, operator);
            }
        }

        attemptIndex = record.claimCount;
        uint256 expires = nowTs + policy.claimLeaseTtlSeconds;
        if (expires > policy.submissionDeadline) expires = policy.submissionDeadline;
        claimExpiresAt = uint64(expires);

        record.claimCount++;
        claimsByTaskByOperator[taskId][operator]++;
        _attempts[taskId][attemptIndex] = AttemptRecord({
            taskId: taskId,
            attemptIndex: attemptIndex,
            operator: operator,
            requestId: bytes32(0),
            solutionCidDigest: bytes32(0),
            solutionWeight: 0,
            claimedAt: uint64(nowTs),
            claimExpiresAt: claimExpiresAt,
            submittedAt: 0,
            status: AttemptStatus.Claimed,
            finalization: AttemptFinalization.None,
            verdictClaimCount: 0,
            validVerdictCount: 0,
            passVerdictCount: 0
        });

        emit TaskClaimed(taskId, attemptIndex, operator, claimExpiresAt);
    }

    function registerAttemptRequest(uint256 taskId, uint32 attemptIndex, bytes32 requestId) external onlyRouter {
        if (requestId == bytes32(0)) revert TCZeroValue();
        AttemptRecord storage attempt = _attempts[taskId][attemptIndex];
        if (attempt.status == AttemptStatus.None) revert TCAttemptNotFound(taskId, attemptIndex);
        if (attempt.status != AttemptStatus.Claimed) revert TCAttemptAlreadyRegistered(taskId, attemptIndex);
        if (_requestRefs[requestId].exists || _verdictRequestRefs[requestId].exists) {
            revert TCRequestAlreadyRegistered(requestId);
        }

        attempt.requestId = requestId;
        attempt.status = AttemptStatus.RequestRegistered;
        _requestRefs[requestId] = RequestRef({taskId: taskId, attemptIndex: attemptIndex, exists: true});

        emit TaskAttemptRequestRegistered(taskId, attemptIndex, requestId);
    }

    function recordSubmission(
        bytes32 requestId,
        address operator,
        bytes32 solutionCidDigest,
        uint256 solutionWeight
    ) external onlyRouter {
        if (solutionCidDigest == bytes32(0)) revert TCZeroValue();
        RequestRef memory ref = _requestRefs[requestId];
        if (!ref.exists) revert TCRequestNotFound(requestId);
        AttemptRecord storage attempt = _attempts[ref.taskId][ref.attemptIndex];
        if (attempt.operator != operator) revert TCNotAttemptOperator(ref.taskId, ref.attemptIndex, operator);
        if (attempt.status != AttemptStatus.RequestRegistered) {
            if (attempt.status == AttemptStatus.Submitted) revert TCAttemptAlreadySubmitted(ref.taskId, ref.attemptIndex);
            revert TCAttemptNotRegistered(ref.taskId, ref.attemptIndex);
        }

        TaskRecord storage record = _tasks[ref.taskId];
        if (block.timestamp > record.policy.submissionDeadline) revert TCSubmissionDeadlinePassed(ref.taskId);
        if (block.timestamp > attempt.claimExpiresAt) {
            revert TCAttemptClaimExpired(ref.taskId, ref.attemptIndex);
        }

        attempt.solutionCidDigest = solutionCidDigest;
        attempt.solutionWeight = solutionWeight;
        attempt.submittedAt = uint64(block.timestamp);
        attempt.status = AttemptStatus.Submitted;
        attempt.finalization = AttemptFinalization.PendingEvaluation;
        record.submittedCount++;

        emit TaskSubmitted(ref.taskId, ref.attemptIndex, operator, requestId, solutionCidDigest, solutionWeight);
    }

    function claimEvaluation(uint256 taskId, uint32 attemptIndex, address evaluator)
        external
        onlyRouter
        returns (uint32 verdictIndex, uint64 claimExpiresAt)
    {
        if (evaluator == address(0)) revert TCZeroAddress();
        TaskRecord storage task = _tasks[taskId];
        if (task.status == TaskStatus.None) revert TCTaskNotFound(taskId);
        AttemptRecord storage attempt = _attempts[taskId][attemptIndex];
        if (attempt.status == AttemptStatus.None) revert TCAttemptNotFound(taskId, attemptIndex);
        if (attempt.status != AttemptStatus.Submitted) revert TCAttemptNotSubmitted(taskId, attemptIndex);
        if (attempt.finalization != AttemptFinalization.PendingEvaluation) {
            revert TCAttemptAlreadyFinalized(taskId, attemptIndex);
        }

        EvaluationPolicy memory evalPolicy = task.policy.evaluationPolicy;
        if (block.timestamp > evalPolicy.evaluationDeadline) revert TCEvaluationDeadlinePassed(taskId);
        if (evalPolicy.disallowSolverSelfEvaluation && evaluator == attempt.operator) {
            revert TCSolverSelfEvaluation(taskId, attemptIndex, evaluator);
        }
        if (attempt.verdictClaimCount >= evalPolicy.requiredVerdicts) revert TCMaxVerdictsReached(taskId, attemptIndex);
        if (verdictClaimsByAttemptByEvaluator[taskId][attemptIndex][evaluator] >= evalPolicy.maxVerdictsPerEvaluator) {
            revert TCEvaluatorClaimLimitReached(taskId, attemptIndex, evaluator);
        }

        verdictIndex = attempt.verdictClaimCount;
        uint256 expires = block.timestamp + task.policy.claimLeaseTtlSeconds;
        if (expires > evalPolicy.evaluationDeadline) expires = evalPolicy.evaluationDeadline;
        claimExpiresAt = uint64(expires);

        attempt.verdictClaimCount++;
        verdictClaimsByAttemptByEvaluator[taskId][attemptIndex][evaluator]++;
        _verdicts[taskId][attemptIndex][verdictIndex] = VerdictRecord({
            taskId: taskId,
            attemptIndex: attemptIndex,
            verdictIndex: verdictIndex,
            evaluator: evaluator,
            requestId: bytes32(0),
            verdictCidDigest: bytes32(0),
            verdictCode: VerdictCode.None,
            claimedAt: uint64(block.timestamp),
            claimExpiresAt: claimExpiresAt,
            deliveredAt: 0,
            status: VerdictStatus.Claimed
        });

        emit EvaluationClaimed(taskId, attemptIndex, verdictIndex, evaluator, claimExpiresAt);
    }

    function registerVerdictRequest(
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        bytes32 requestId
    ) external onlyRouter {
        if (requestId == bytes32(0)) revert TCZeroValue();
        VerdictRecord storage verdict = _verdicts[taskId][attemptIndex][verdictIndex];
        if (verdict.status == VerdictStatus.None) revert TCVerdictNotFound(taskId, attemptIndex, verdictIndex);
        if (verdict.status != VerdictStatus.Claimed) {
            revert TCVerdictAlreadyRegistered(taskId, attemptIndex, verdictIndex);
        }
        if (_requestRefs[requestId].exists || _verdictRequestRefs[requestId].exists) {
            revert TCRequestAlreadyRegistered(requestId);
        }

        verdict.requestId = requestId;
        verdict.status = VerdictStatus.RequestRegistered;
        _verdictRequestRefs[requestId] = VerdictRequestRef({
            taskId: taskId,
            attemptIndex: attemptIndex,
            verdictIndex: verdictIndex,
            exists: true
        });

        emit VerdictRequestRegistered(taskId, attemptIndex, verdictIndex, requestId);
    }

    function recordVerdict(
        bytes32 verdictRequestId,
        address evaluator,
        bytes32 verdictCidDigest,
        uint8 verdictCodeRaw
    )
        external
        onlyRouter
        returns (
            bool attemptFinalized,
            bool attemptPassed,
            bool creditCreator,
            address creator,
            uint256 creatorWeight
        )
    {
        if (verdictCidDigest == bytes32(0)) revert TCZeroValue();
        if (verdictCodeRaw == uint8(VerdictCode.None) || verdictCodeRaw > uint8(VerdictCode.Unresolved)) {
            revert TCInvalidVerdictCode(verdictCodeRaw);
        }
        VerdictRequestRef memory ref = _verdictRequestRefs[verdictRequestId];
        if (!ref.exists) revert TCRequestNotFound(verdictRequestId);
        VerdictRecord storage verdict = _verdicts[ref.taskId][ref.attemptIndex][ref.verdictIndex];
        if (verdict.evaluator != evaluator) {
            revert TCNotVerdictEvaluator(ref.taskId, ref.attemptIndex, ref.verdictIndex, evaluator);
        }
        if (verdict.status != VerdictStatus.RequestRegistered) {
            if (verdict.status == VerdictStatus.Delivered) {
                revert TCVerdictAlreadyDelivered(ref.taskId, ref.attemptIndex, ref.verdictIndex);
            }
            revert TCVerdictNotRegistered(ref.taskId, ref.attemptIndex, ref.verdictIndex);
        }

        TaskRecord storage task = _tasks[ref.taskId];
        if (block.timestamp > task.policy.evaluationPolicy.evaluationDeadline) {
            revert TCEvaluationDeadlinePassed(ref.taskId);
        }
        if (block.timestamp > verdict.claimExpiresAt) {
            revert TCVerdictClaimExpired(ref.taskId, ref.attemptIndex, ref.verdictIndex);
        }

        VerdictCode verdictCode = VerdictCode(verdictCodeRaw);
        verdict.verdictCidDigest = verdictCidDigest;
        verdict.verdictCode = verdictCode;
        verdict.deliveredAt = uint64(block.timestamp);
        verdict.status = VerdictStatus.Delivered;

        AttemptRecord storage attempt = _attempts[ref.taskId][ref.attemptIndex];
        attempt.validVerdictCount++;
        if (verdictCode == VerdictCode.Pass) {
            attempt.passVerdictCount++;
        }

        emit VerdictDelivered(
            ref.taskId,
            ref.attemptIndex,
            ref.verdictIndex,
            evaluator,
            verdictCidDigest,
            verdictCodeRaw
        );

        EvaluationPolicy memory evalPolicy = task.policy.evaluationPolicy;
        if (attempt.validVerdictCount == evalPolicy.requiredVerdicts) {
            attemptFinalized = true;
            attemptPassed = attempt.passVerdictCount >= evalPolicy.passThreshold;
            attempt.finalization = attemptPassed ? AttemptFinalization.Passed : AttemptFinalization.Failed;
            task.finalizedAttemptCount++;

            emit AttemptFinalized(
                ref.taskId,
                ref.attemptIndex,
                attemptPassed,
                attempt.validVerdictCount,
                attempt.passVerdictCount
            );

            if (!task.taskCreationCredited) {
                task.taskCreationCredited = true;
                creditCreator = true;
                creator = task.creator;
                creatorWeight = attempt.solutionWeight;
                emit TaskCreationCreditLocked(ref.taskId, creator, creatorWeight);
            }
        }
    }

    function expireAttempt(uint256 taskId, uint32 attemptIndex) external {
        AttemptRecord storage attempt = _attempts[taskId][attemptIndex];
        if (attempt.status == AttemptStatus.None) revert TCAttemptNotFound(taskId, attemptIndex);
        if (attempt.status == AttemptStatus.Submitted) revert TCAttemptAlreadySubmitted(taskId, attemptIndex);
        if (attempt.status == AttemptStatus.Expired) return;
        if (block.timestamp <= attempt.claimExpiresAt) revert TCClaimNotExpired(taskId, attemptIndex);
        attempt.status = AttemptStatus.Expired;
        emit TaskAttemptExpired(taskId, attemptIndex, attempt.operator);
    }

    function getTask(uint256 taskId) external view returns (TaskRecord memory record) {
        record = _tasks[taskId];
    }

    function getAttempt(uint256 taskId, uint32 attemptIndex) external view returns (AttemptRecord memory attempt) {
        attempt = _attempts[taskId][attemptIndex];
    }

    function getVerdict(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex)
        external
        view
        returns (VerdictRecord memory verdict)
    {
        verdict = _verdicts[taskId][attemptIndex][verdictIndex];
    }

    function getRequestRef(bytes32 requestId) external view returns (uint256 taskId, uint32 attemptIndex, bool exists) {
        RequestRef memory ref = _requestRefs[requestId];
        return (ref.taskId, ref.attemptIndex, ref.exists);
    }

    function getVerdictRequestRef(bytes32 requestId)
        external
        view
        returns (uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, bool exists)
    {
        VerdictRequestRef memory ref = _verdictRequestRefs[requestId];
        return (ref.taskId, ref.attemptIndex, ref.verdictIndex, ref.exists);
    }

    function taskIdByRequestId(bytes32 requestId) external view returns (uint256 taskId) {
        RequestRef memory ref = _requestRefs[requestId];
        return ref.taskId;
    }

    function allSubmittedAttemptsFinalized(uint256 taskId) external view returns (bool) {
        TaskRecord storage task = _tasks[taskId];
        if (task.status == TaskStatus.None) revert TCTaskNotFound(taskId);
        return task.submittedCount > 0 && task.finalizedAttemptCount == task.submittedCount;
    }

    function _normalizePolicy(TaskPolicy calldata policy) internal pure returns (TaskPolicy memory normalized) {
        normalized = policy;
        EvaluationPolicy memory evalPolicy = policy.evaluationPolicy;
        bool evalPolicyZero = evalPolicy.requiredVerdicts == 0
            && evalPolicy.passThreshold == 0
            && evalPolicy.evaluationDeadline == 0
            && evalPolicy.maxVerdictsPerEvaluator == 0
            && !evalPolicy.disallowSolverSelfEvaluation;

        if (normalized.evaluationPolicy.requiredVerdicts == 0) {
            normalized.evaluationPolicy.requiredVerdicts = 1;
        }
        if (normalized.evaluationPolicy.passThreshold == 0) {
            normalized.evaluationPolicy.passThreshold = 1;
        }
        if (normalized.evaluationPolicy.evaluationDeadline == 0) {
            normalized.evaluationPolicy.evaluationDeadline = normalized.submissionDeadline;
        }
        if (normalized.evaluationPolicy.maxVerdictsPerEvaluator == 0) {
            normalized.evaluationPolicy.maxVerdictsPerEvaluator = 1;
        }
        if (evalPolicyZero) {
            normalized.evaluationPolicy.disallowSolverSelfEvaluation = true;
        }
    }

    function _validatePolicy(TaskPolicy memory policy) internal pure {
        if (policy.maxClaims == 0 || policy.maxClaimsPerOperator == 0 || policy.claimLeaseTtlSeconds == 0) {
            revert TCInvalidPolicy();
        }
        if (policy.maxClaimsPerOperator > policy.maxClaims) revert TCInvalidPolicy();
        if (
            policy.claimWindowStart == 0 ||
            policy.claimWindowEnd < policy.claimWindowStart ||
            policy.submissionDeadline < policy.claimWindowEnd
        ) {
            revert TCInvalidWindow();
        }

        EvaluationPolicy memory evalPolicy = policy.evaluationPolicy;
        if (
            evalPolicy.requiredVerdicts == 0 ||
            evalPolicy.passThreshold == 0 ||
            evalPolicy.passThreshold > evalPolicy.requiredVerdicts ||
            evalPolicy.maxVerdictsPerEvaluator == 0
        ) {
            revert TCInvalidPolicy();
        }
        if (evalPolicy.evaluationDeadline < policy.submissionDeadline) revert TCInvalidWindow();
    }
}
