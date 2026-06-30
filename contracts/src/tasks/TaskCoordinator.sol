// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

error TCZeroAddress();
error TCZeroValue();
error TCAlreadyInitialized();
error TCNotInitialized();
error TCOwnerOnly(address sender, address owner);
error TCRouterOnly(address sender, address router);
error TCTaskNotFound(uint256 taskId);
error TCInvalidPolicy();
error TCTaskNotOpen(uint256 taskId);
error TCMaxClaimsReached(uint256 taskId);
error TCAttemptNotFound(uint256 taskId, uint32 attemptIndex);
error TCAttemptNotSubmitted(uint256 taskId, uint32 attemptIndex);
error TCAttemptAlreadyRegistered(uint256 taskId, uint32 attemptIndex);
error TCAttemptAlreadySubmitted(uint256 taskId, uint32 attemptIndex);
error TCAttemptNotRegistered(uint256 taskId, uint32 attemptIndex);
error TCRequestAlreadyRegistered(bytes32 requestId);
error TCRequestNotFound(bytes32 requestId);
error TCNotAttemptOperator(uint256 taskId, uint32 attemptIndex, address operator);
error TCSolverSelfEvaluation(uint256 taskId, uint32 attemptIndex, address evaluator);
error TCVerdictNotFound(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCVerdictAlreadyRegistered(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCVerdictAlreadyDelivered(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCVerdictNotRegistered(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCNotVerdictEvaluator(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, address evaluator);
error TCInvalidVerdictCode(uint8 verdictCode);

/// @title TaskCoordinator
/// @notice Canonical Task lifecycle, claim, attempt, submission, and evaluation state for new Jinn Tasks.
/// @dev Tokenless-OLAS pivot: the quality/quorum/finalization/window/lease apparatus is removed.
/// A Task escrows a launcher-funded attempt count (`maxClaims`); the first delivered verdict of an
/// attempt finalizes it and the creator is credited once. Self-evaluation is always rejected.
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
        Finalized
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

    struct TaskPolicy {
        uint32 maxClaims;
        // Default false → self-evaluation blocked (the independent-evaluation
        // invariant). A testnet SolverNet may set this true so a single operator
        // can close the loop solo for dogfooding; mainnet leaves it false.
        bool allowSolverSelfEvaluation;
    }

    struct TaskRecord {
        address creator;
        bytes32 taskCidDigest;
        bytes32 manifestDigest;
        TaskStatus status;
        TaskPolicy policy;
        uint32 claimCount;
        uint32 submittedCount;
        uint32 finalizedAttemptCount;
        bool creatorCredited;
    }

    struct AttemptRecord {
        uint256 taskId;
        uint32 attemptIndex;
        address operator;
        bytes32 requestId;
        bytes32 solutionCidDigest;
        uint256 solutionWeight;
        uint32 verdictCount;
        AttemptStatus status;
    }

    struct VerdictRecord {
        uint256 taskId;
        uint32 attemptIndex;
        uint32 verdictIndex;
        address evaluator;
        bytes32 requestId;
        bytes32 verdictCidDigest;
        VerdictCode verdictCode;
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
    mapping(bytes32 => RequestRef) private _requestRefs;
    mapping(bytes32 => VerdictRequestRef) private _verdictRequestRefs;

    event Initialized(address indexed owner, address indexed authorizedRouter);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizedRouterUpdated(address indexed previousRouter, address indexed newRouter);
    event TaskCreated(
        uint256 indexed taskId,
        address indexed creator,
        bytes32 indexed manifestDigest,
        bytes32 taskCidDigest,
        uint32 maxClaims
    );
    event TaskClaimed(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator);
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
        address evaluator
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
        bytes32 manifestDigest,
        TaskPolicy calldata policy
    ) external onlyRouter returns (uint256 taskId) {
        if (!initialized) revert TCNotInitialized();
        if (creator == address(0)) revert TCZeroAddress();
        if (taskCidDigest == bytes32(0) || manifestDigest == bytes32(0)) revert TCZeroValue();
        if (policy.maxClaims == 0) revert TCInvalidPolicy();

        taskId = nextTaskId++;
        _tasks[taskId] = TaskRecord({
            creator: creator,
            taskCidDigest: taskCidDigest,
            manifestDigest: manifestDigest,
            status: TaskStatus.Open,
            policy: policy,
            claimCount: 0,
            submittedCount: 0,
            finalizedAttemptCount: 0,
            creatorCredited: false
        });

        emit TaskCreated(taskId, creator, manifestDigest, taskCidDigest, policy.maxClaims);
    }

    function claimTask(uint256 taskId, address operator)
        external
        onlyRouter
        returns (uint32 attemptIndex)
    {
        if (operator == address(0)) revert TCZeroAddress();
        TaskRecord storage record = _tasks[taskId];
        if (record.status == TaskStatus.None) revert TCTaskNotFound(taskId);
        if (record.status != TaskStatus.Open) revert TCTaskNotOpen(taskId);
        if (record.claimCount >= record.policy.maxClaims) revert TCMaxClaimsReached(taskId);

        attemptIndex = record.claimCount;
        record.claimCount++;
        _attempts[taskId][attemptIndex] = AttemptRecord({
            taskId: taskId,
            attemptIndex: attemptIndex,
            operator: operator,
            requestId: bytes32(0),
            solutionCidDigest: bytes32(0),
            solutionWeight: 0,
            verdictCount: 0,
            status: AttemptStatus.Claimed
        });

        emit TaskClaimed(taskId, attemptIndex, operator);
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
        attempt.solutionCidDigest = solutionCidDigest;
        attempt.solutionWeight = solutionWeight;
        attempt.status = AttemptStatus.Submitted;
        record.submittedCount++;

        emit TaskSubmitted(ref.taskId, ref.attemptIndex, operator, requestId, solutionCidDigest, solutionWeight);
    }

    function claimEvaluation(uint256 taskId, uint32 attemptIndex, address evaluator)
        external
        onlyRouter
        returns (uint32 verdictIndex)
    {
        if (evaluator == address(0)) revert TCZeroAddress();
        TaskRecord storage task = _tasks[taskId];
        if (task.status == TaskStatus.None) revert TCTaskNotFound(taskId);
        AttemptRecord storage attempt = _attempts[taskId][attemptIndex];
        if (attempt.status == AttemptStatus.None) revert TCAttemptNotFound(taskId, attemptIndex);
        if (attempt.status != AttemptStatus.Submitted) revert TCAttemptNotSubmitted(taskId, attemptIndex);
        // Self-evaluation is blocked by default (independent-evaluation invariant);
        // a SolverNet opts in via policy.allowSolverSelfEvaluation (testnet dogfooding).
        if (!task.policy.allowSolverSelfEvaluation && evaluator == attempt.operator) {
            revert TCSolverSelfEvaluation(taskId, attemptIndex, evaluator);
        }

        verdictIndex = attempt.verdictCount;
        attempt.verdictCount++;
        _verdicts[taskId][attemptIndex][verdictIndex] = VerdictRecord({
            taskId: taskId,
            attemptIndex: attemptIndex,
            verdictIndex: verdictIndex,
            evaluator: evaluator,
            requestId: bytes32(0),
            verdictCidDigest: bytes32(0),
            verdictCode: VerdictCode.None,
            status: VerdictStatus.Claimed
        });

        emit EvaluationClaimed(taskId, attemptIndex, verdictIndex, evaluator);
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

        VerdictCode verdictCode = VerdictCode(verdictCodeRaw);
        verdict.verdictCidDigest = verdictCidDigest;
        verdict.verdictCode = verdictCode;
        verdict.status = VerdictStatus.Delivered;

        emit VerdictDelivered(
            ref.taskId,
            ref.attemptIndex,
            ref.verdictIndex,
            evaluator,
            verdictCidDigest,
            verdictCodeRaw
        );

        // Tokenless-OLAS pivot: the FIRST delivered verdict of an attempt finalizes it (any
        // verdict code — there is no quality gate now). The attempt is reported as passed; the
        // creator is credited exactly once per task with the finalized attempt's solution weight.
        // Later verdicts on an already-finalized attempt deliver but do not re-finalize.
        TaskRecord storage task = _tasks[ref.taskId];
        AttemptRecord storage attempt = _attempts[ref.taskId][ref.attemptIndex];
        if (attempt.status == AttemptStatus.Submitted) {
            attemptFinalized = true;
            attemptPassed = true;
            attempt.status = AttemptStatus.Finalized;
            task.finalizedAttemptCount++;

            if (!task.creatorCredited) {
                task.creatorCredited = true;
                creditCreator = true;
                creator = task.creator;
                creatorWeight = attempt.solutionWeight;
            }
        }
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
}
