// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

error TCV4ZeroAddress();
error TCV4ZeroValue();
error TCV4AlreadyInitialized();
error TCV4NotInitialized();
error TCV4OwnerOnly(address sender, address owner);
error TCV4RouterOnly(address sender, address router);
error TCV4TaskNotFound(uint256 taskId);
error TCV4InvalidPolicy();
error TCV4TaskNotOpen(uint256 taskId);
error TCV4MaxConcurrentReached(uint256 taskId);
error TCV4MaxTotalReached(uint256 taskId);
error TCV4AttemptNotFound(uint256 taskId, uint32 attemptIndex);
error TCV4AttemptNotLive(uint256 taskId, uint32 attemptIndex);
error TCV4AttemptNotSubmitted(uint256 taskId, uint32 attemptIndex);
error TCV4AttemptAlreadySettled(uint256 taskId, uint32 attemptIndex);
error TCV4NotAttemptOperator(uint256 taskId, uint32 attemptIndex, address operator);
error TCV4SolverSelfEvaluation(uint256 taskId, uint32 attemptIndex, address evaluator);
error TCV4VerdictNotFound(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCV4VerdictAlreadySettled(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex);
error TCV4NotVerdictEvaluator(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, address evaluator);
error TCV4InvalidVerdictCode(uint8 verdictCode);
error TCV4ReleaseHoldActive(uint256 taskId, uint32 attemptIndex, uint64 unlockAt);
error TCV4OperatorClaimCap(address operator, uint32 liveCount, uint32 cap);
error TCV4SubmissionDeadlinePassed(uint256 taskId, uint64 deadline);
error TCV4ClosedForClaims(uint256 taskId);

/// @title TaskCoordinatorV4
/// @notice Thin revised-generation Task recorder: monotonic attempt identity, live occupancy,
///         deadlines, release/expiry, multi-verdict finalization. Escrow and Mech settlement live
///         on JinnRouterV4. Fresh generation — no V3 storage/ABI inheritance.
contract TaskCoordinatorV4 {
    enum TaskStatus {
        None,
        Open,
        Closed
    }

    enum AttemptStatus {
        None,
        Live,
        Submitted,
        Released,
        Expired,
        Finalized,
        /// @dev Delivered-on-Mech but unclaimed at router; no budget restore, no delivery credit.
        Forfeited
    }

    enum VerdictStatus {
        None,
        Live,
        Delivered,
        Released,
        Expired,
        /// @dev Delivered-on-Mech but unclaimed at router; no budget restore, no delivery credit.
        Forfeited
    }

    enum VerdictCode {
        None,
        Pass,
        Fail,
        Invalid,
        Unresolved
    }

    enum TerminalCause {
        None,
        CreatorClose,
        CapacityExhausted
    }

    struct TaskPolicy {
        uint32 maxTotal;
        uint32 maxConcurrent;
        uint64 submissionDeadline;
        uint64 closeAt;
        uint64 responseTimeout;
        uint32 minVerdicts;
        bool requireDistinctEvaluator;
    }

    struct TaskRecord {
        address creator;
        bytes32 taskCidDigest;
        bytes32 submissionDigest;
        TaskStatus status;
        TaskPolicy policy;
        uint32 nextAttemptIndex;
        uint32 liveOccupancy;
        uint32 settledAttemptCount;
        uint32 finalizedAttemptCount;
        bool creatorCredited;
        TerminalCause terminalCause;
    }

    struct AttemptRecord {
        uint256 taskId;
        uint32 attemptIndex;
        address operator;
        bytes32 solutionDigest;
        uint64 deadline;
        uint64 claimedAt;
        uint32 nextVerdictIndex;
        uint32 deliveredVerdictCount;
        AttemptStatus status;
    }

    struct VerdictRecord {
        uint256 taskId;
        uint32 attemptIndex;
        uint32 verdictIndex;
        address evaluator;
        bytes32 evaluationDeliveryDigest;
        VerdictCode verdictCode;
        uint64 deadline;
        uint64 claimedAt;
        VerdictStatus status;
    }

    address public owner;
    address public authorizedRouter;
    bool public initialized;
    uint256 public nextTaskId;

    /// @dev Deployment-fixed nonzero minimum hold before operator release (seconds).
    uint64 public releaseMinHoldSeconds;
    /// @dev Per-operator simultaneous live-claim cap; 0 = off.
    uint32 public maxSimultaneousClaimsPerOperator;

    mapping(uint256 => TaskRecord) private _tasks;
    mapping(uint256 => mapping(uint32 => AttemptRecord)) private _attempts;
    mapping(uint256 => mapping(uint32 => mapping(uint32 => VerdictRecord))) private _verdicts;
    mapping(address => uint32) public operatorLiveClaims;

    event Initialized(
        address indexed owner,
        address indexed authorizedRouter,
        uint64 releaseMinHoldSeconds,
        uint32 maxSimultaneousClaimsPerOperator
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorizedRouterUpdated(address indexed previousRouter, address indexed newRouter);

    event TaskCreated(
        uint256 indexed taskId,
        address indexed creator,
        bytes32 indexed taskCidDigest,
        bytes32 submissionDigest,
        uint32 maxTotal,
        uint32 maxConcurrent,
        uint64 submissionDeadline,
        uint64 closeAt,
        uint64 responseTimeout,
        uint32 minVerdicts,
        bool requireDistinctEvaluator
    );
    event AttemptsAdded(uint256 indexed taskId, address indexed creator, uint32 added, uint32 newMaxTotal);
    event TaskClosed(uint256 indexed taskId, address indexed creator);
    event TaskTerminalCause(uint256 indexed taskId, uint8 indexed cause);

    event AttemptExpired(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator);
    event AttemptReleased(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator);
    event AttemptForfeited(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator);
    event VerdictForfeited(
        uint256 indexed taskId, uint32 indexed attemptIndex, uint32 indexed verdictIndex, address evaluator
    );

    event TaskClaimed(uint256 indexed taskId, uint32 indexed attemptIndex, address indexed operator, uint64 deadline);
    event EvaluationClaimed(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        uint32 indexed verdictIndex,
        address evaluator,
        uint64 deadline
    );
    event TaskSubmitted(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        address indexed operator,
        bytes32 solutionDigest
    );
    event VerdictDelivered(
        uint256 indexed taskId,
        uint32 indexed attemptIndex,
        uint32 indexed verdictIndex,
        address evaluator,
        bytes32 evaluationDeliveryDigest,
        uint8 verdictCode
    );
    event AttemptFinalized(uint256 indexed taskId, uint32 indexed attemptIndex);

    modifier onlyOwner() {
        if (msg.sender != owner) revert TCV4OwnerOnly(msg.sender, owner);
        _;
    }

    modifier onlyRouter() {
        if (msg.sender != authorizedRouter) revert TCV4RouterOnly(msg.sender, authorizedRouter);
        _;
    }

    function initialize(
        address _owner,
        address _authorizedRouter,
        uint64 _releaseMinHoldSeconds,
        uint32 _maxSimultaneousClaimsPerOperator
    ) external {
        if (initialized) revert TCV4AlreadyInitialized();
        if (_owner == address(0) || _authorizedRouter == address(0)) revert TCV4ZeroAddress();
        if (_releaseMinHoldSeconds == 0) revert TCV4ZeroValue();
        owner = _owner;
        authorizedRouter = _authorizedRouter;
        releaseMinHoldSeconds = _releaseMinHoldSeconds;
        maxSimultaneousClaimsPerOperator = _maxSimultaneousClaimsPerOperator;
        nextTaskId = 1;
        initialized = true;
        emit Initialized(_owner, _authorizedRouter, _releaseMinHoldSeconds, _maxSimultaneousClaimsPerOperator);
        emit OwnershipTransferred(address(0), _owner);
        emit AuthorizedRouterUpdated(address(0), _authorizedRouter);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert TCV4ZeroAddress();
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function setAuthorizedRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert TCV4ZeroAddress();
        address old = authorizedRouter;
        authorizedRouter = newRouter;
        emit AuthorizedRouterUpdated(old, newRouter);
    }

    function createTask(
        address creator,
        bytes32 taskCidDigest,
        bytes32 submissionDigest,
        TaskPolicy calldata policy
    ) external onlyRouter returns (uint256 taskId) {
        if (!initialized) revert TCV4NotInitialized();
        if (creator == address(0)) revert TCV4ZeroAddress();
        if (taskCidDigest == bytes32(0) || submissionDigest == bytes32(0)) revert TCV4ZeroValue();
        _validatePolicy(policy);

        taskId = nextTaskId++;
        _tasks[taskId] = TaskRecord({
            creator: creator,
            taskCidDigest: taskCidDigest,
            submissionDigest: submissionDigest,
            status: TaskStatus.Open,
            policy: policy,
            nextAttemptIndex: 0,
            liveOccupancy: 0,
            settledAttemptCount: 0,
            finalizedAttemptCount: 0,
            creatorCredited: false,
            terminalCause: TerminalCause.None
        });

        emit TaskCreated(
            taskId,
            creator,
            taskCidDigest,
            submissionDigest,
            policy.maxTotal,
            policy.maxConcurrent,
            policy.submissionDeadline,
            policy.closeAt,
            policy.responseTimeout,
            policy.minVerdicts,
            policy.requireDistinctEvaluator
        );
    }

    function addAttempts(uint256 taskId, uint32 added) external onlyRouter returns (uint32 newMaxTotal) {
        if (added == 0) revert TCV4ZeroValue();
        TaskRecord storage record = _requireTask(taskId);
        if (record.status != TaskStatus.Open) revert TCV4ClosedForClaims(taskId);
        uint32 next = record.policy.maxTotal + added;
        if (next < record.policy.maxTotal) revert TCV4InvalidPolicy();
        if (record.policy.maxConcurrent > next) revert TCV4InvalidPolicy();
        record.policy.maxTotal = next;
        newMaxTotal = next;
        emit AttemptsAdded(taskId, record.creator, added, newMaxTotal);
    }

    /// @notice Reap expired solution + verdict reservations for a task. Called by router on touches.
    function reapExpired(uint256 taskId)
        external
        onlyRouter
        returns (uint32 solutionReaped, uint32 verdictReaped)
    {
        TaskRecord storage record = _requireTask(taskId);
        uint32 n = record.nextAttemptIndex;
        for (uint32 i = 0; i < n; i++) {
            AttemptRecord storage attempt = _attempts[taskId][i];
            if (attempt.status == AttemptStatus.Live && block.timestamp > attempt.deadline) {
                attempt.status = AttemptStatus.Expired;
                record.liveOccupancy -= 1;
                operatorLiveClaims[attempt.operator] -= 1;
                solutionReaped += 1;
                emit AttemptExpired(taskId, i, attempt.operator);
            }
            uint32 vCount = attempt.nextVerdictIndex;
            for (uint32 v = 0; v < vCount; v++) {
                VerdictRecord storage verdict = _verdicts[taskId][i][v];
                if (verdict.status == VerdictStatus.Live && block.timestamp > verdict.deadline) {
                    verdict.status = VerdictStatus.Expired;
                    verdictReaped += 1;
                    emit AttemptExpired(taskId, i, verdict.evaluator);
                }
            }
        }
    }

    function claimTask(uint256 taskId, address operator, uint64 deadline)
        external
        onlyRouter
        returns (uint32 attemptIndex)
    {
        if (operator == address(0)) revert TCV4ZeroAddress();
        if (deadline <= block.timestamp) revert TCV4ZeroValue();

        TaskRecord storage record = _requireTask(taskId);
        if (record.status != TaskStatus.Open) revert TCV4ClosedForClaims(taskId);
        if (block.timestamp > record.policy.submissionDeadline) {
            revert TCV4SubmissionDeadlinePassed(taskId, record.policy.submissionDeadline);
        }
        if (record.policy.closeAt != 0 && block.timestamp >= record.policy.closeAt) {
            revert TCV4ClosedForClaims(taskId);
        }
        if (record.nextAttemptIndex >= record.policy.maxTotal) revert TCV4MaxTotalReached(taskId);
        if (record.liveOccupancy >= record.policy.maxConcurrent) revert TCV4MaxConcurrentReached(taskId);

        if (maxSimultaneousClaimsPerOperator != 0) {
            uint32 live = operatorLiveClaims[operator];
            if (live >= maxSimultaneousClaimsPerOperator) {
                revert TCV4OperatorClaimCap(operator, live, maxSimultaneousClaimsPerOperator);
            }
        }

        attemptIndex = record.nextAttemptIndex;
        record.nextAttemptIndex += 1;
        record.liveOccupancy += 1;
        operatorLiveClaims[operator] += 1;

        _attempts[taskId][attemptIndex] = AttemptRecord({
            taskId: taskId,
            attemptIndex: attemptIndex,
            operator: operator,
            solutionDigest: bytes32(0),
            deadline: deadline,
            claimedAt: uint64(block.timestamp),
            nextVerdictIndex: 0,
            deliveredVerdictCount: 0,
            status: AttemptStatus.Live
        });

        emit TaskClaimed(taskId, attemptIndex, operator, deadline);
    }

    function releaseAttempt(uint256 taskId, uint32 attemptIndex, address operator) external onlyRouter {
        AttemptRecord storage attempt = _requireAttempt(taskId, attemptIndex);
        if (attempt.operator != operator) revert TCV4NotAttemptOperator(taskId, attemptIndex, operator);
        if (attempt.status != AttemptStatus.Live) revert TCV4AttemptNotLive(taskId, attemptIndex);
        uint64 unlockAt = attempt.claimedAt + releaseMinHoldSeconds;
        if (block.timestamp < unlockAt) revert TCV4ReleaseHoldActive(taskId, attemptIndex, unlockAt);

        attempt.status = AttemptStatus.Released;
        TaskRecord storage record = _tasks[taskId];
        record.liveOccupancy -= 1;
        operatorLiveClaims[operator] -= 1;
        emit AttemptReleased(taskId, attemptIndex, operator);
    }

    /// @notice Router-only terminal for delivered-but-unclaimed solution reservations.
    /// @dev Clears Live occupancy exactly once. If lazy reap already moved Live→Expired (and
    ///      decremented counters), transition Expired→Forfeited without a second decrement.
    ///      Does not restore budget, award delivery credit, or settle.
    function forfeitAttempt(uint256 taskId, uint32 attemptIndex) external onlyRouter {
        AttemptRecord storage attempt = _requireAttempt(taskId, attemptIndex);
        address operator = attempt.operator;

        if (attempt.status == AttemptStatus.Live) {
            attempt.status = AttemptStatus.Forfeited;
            TaskRecord storage record = _tasks[taskId];
            record.liveOccupancy -= 1;
            operatorLiveClaims[operator] -= 1;
            emit AttemptForfeited(taskId, attemptIndex, operator);
            return;
        }

        if (attempt.status == AttemptStatus.Expired) {
            // Occupancy already released by reapExpired; do not decrement again.
            attempt.status = AttemptStatus.Forfeited;
            emit AttemptForfeited(taskId, attemptIndex, operator);
            return;
        }

        if (
            attempt.status == AttemptStatus.Submitted || attempt.status == AttemptStatus.Finalized
                || attempt.status == AttemptStatus.Forfeited
        ) {
            revert TCV4AttemptAlreadySettled(taskId, attemptIndex);
        }
        revert TCV4AttemptNotLive(taskId, attemptIndex);
    }

    /// @notice Router-only terminal for delivered-but-unclaimed verdict reservations.
    /// @dev Marks verdict Forfeited once (Live or already-reaped Expired). No budget restore or credit.
    function forfeitVerdict(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex) external onlyRouter {
        VerdictRecord storage verdict = _requireVerdict(taskId, attemptIndex, verdictIndex);
        if (verdict.status == VerdictStatus.Live || verdict.status == VerdictStatus.Expired) {
            address evaluator = verdict.evaluator;
            verdict.status = VerdictStatus.Forfeited;
            emit VerdictForfeited(taskId, attemptIndex, verdictIndex, evaluator);
            return;
        }

        if (verdict.status == VerdictStatus.Delivered || verdict.status == VerdictStatus.Forfeited) {
            revert TCV4VerdictAlreadySettled(taskId, attemptIndex, verdictIndex);
        }
        revert TCV4VerdictNotFound(taskId, attemptIndex, verdictIndex);
    }

    function closeTask(uint256 taskId, address creator) external onlyRouter {
        TaskRecord storage record = _requireTask(taskId);
        if (record.creator != creator) revert TCV4OwnerOnly(creator, record.creator);
        if (record.status != TaskStatus.Open) revert TCV4TaskNotOpen(taskId);
        record.status = TaskStatus.Closed;
        record.terminalCause = TerminalCause.CreatorClose;
        emit TaskClosed(taskId, creator);
        emit TaskTerminalCause(taskId, uint8(TerminalCause.CreatorClose));
    }

    function recordSolutionDelivery(uint256 taskId, uint32 attemptIndex, address operator, bytes32 solutionDigest)
        external
        onlyRouter
    {
        if (solutionDigest == bytes32(0)) revert TCV4ZeroValue();
        AttemptRecord storage attempt = _requireAttempt(taskId, attemptIndex);
        if (attempt.operator != operator) revert TCV4NotAttemptOperator(taskId, attemptIndex, operator);
        if (attempt.status != AttemptStatus.Live) {
            if (attempt.status == AttemptStatus.Submitted || attempt.status == AttemptStatus.Finalized) {
                revert TCV4AttemptAlreadySettled(taskId, attemptIndex);
            }
            revert TCV4AttemptNotLive(taskId, attemptIndex);
        }
        // Delivery authorized through deadline even if task Closed.
        if (block.timestamp > attempt.deadline) revert TCV4AttemptNotLive(taskId, attemptIndex);

        attempt.solutionDigest = solutionDigest;
        attempt.status = AttemptStatus.Submitted;
        TaskRecord storage record = _tasks[taskId];
        record.liveOccupancy -= 1;
        record.settledAttemptCount += 1;
        operatorLiveClaims[operator] -= 1;

        emit TaskSubmitted(taskId, attemptIndex, operator, solutionDigest);
        _maybeMarkCapacityExhausted(record, taskId);
    }

    function claimEvaluation(uint256 taskId, uint32 attemptIndex, address evaluator, uint64 deadline)
        external
        onlyRouter
        returns (uint32 verdictIndex)
    {
        if (evaluator == address(0)) revert TCV4ZeroAddress();
        if (deadline <= block.timestamp) revert TCV4ZeroValue();

        TaskRecord storage task = _requireTask(taskId);
        if (task.status != TaskStatus.Open) revert TCV4ClosedForClaims(taskId);

        AttemptRecord storage attempt = _requireAttempt(taskId, attemptIndex);
        if (attempt.status != AttemptStatus.Submitted && attempt.status != AttemptStatus.Finalized) {
            revert TCV4AttemptNotSubmitted(taskId, attemptIndex);
        }
        if (task.policy.requireDistinctEvaluator && evaluator == attempt.operator) {
            revert TCV4SolverSelfEvaluation(taskId, attemptIndex, evaluator);
        }
        // Always enforce address distinctness per §7.134 (mandatory).
        if (evaluator == attempt.operator) {
            revert TCV4SolverSelfEvaluation(taskId, attemptIndex, evaluator);
        }

        verdictIndex = attempt.nextVerdictIndex;
        attempt.nextVerdictIndex += 1;
        _verdicts[taskId][attemptIndex][verdictIndex] = VerdictRecord({
            taskId: taskId,
            attemptIndex: attemptIndex,
            verdictIndex: verdictIndex,
            evaluator: evaluator,
            evaluationDeliveryDigest: bytes32(0),
            verdictCode: VerdictCode.None,
            deadline: deadline,
            claimedAt: uint64(block.timestamp),
            status: VerdictStatus.Live
        });

        emit EvaluationClaimed(taskId, attemptIndex, verdictIndex, evaluator, deadline);
    }

    function releaseVerdict(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, address evaluator)
        external
        onlyRouter
    {
        VerdictRecord storage verdict = _requireVerdict(taskId, attemptIndex, verdictIndex);
        if (verdict.evaluator != evaluator) {
            revert TCV4NotVerdictEvaluator(taskId, attemptIndex, verdictIndex, evaluator);
        }
        if (verdict.status != VerdictStatus.Live) revert TCV4VerdictNotFound(taskId, attemptIndex, verdictIndex);
        uint64 unlockAt = verdict.claimedAt + releaseMinHoldSeconds;
        if (block.timestamp < unlockAt) revert TCV4ReleaseHoldActive(taskId, attemptIndex, unlockAt);
        verdict.status = VerdictStatus.Released;
        emit AttemptReleased(taskId, attemptIndex, evaluator);
    }

    function recordVerdict(
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        address evaluator,
        bytes32 evaluationDeliveryDigest,
        uint8 verdictCode
    )
        external
        onlyRouter
        returns (bool attemptFinalized, bool creditCreator, address creator, uint256 creatorWeight)
    {
        if (evaluationDeliveryDigest == bytes32(0)) revert TCV4ZeroValue();
        if (verdictCode == uint8(VerdictCode.None) || verdictCode > uint8(VerdictCode.Unresolved)) {
            revert TCV4InvalidVerdictCode(verdictCode);
        }

        VerdictRecord storage verdict = _requireVerdict(taskId, attemptIndex, verdictIndex);
        if (verdict.evaluator != evaluator) {
            revert TCV4NotVerdictEvaluator(taskId, attemptIndex, verdictIndex, evaluator);
        }
        if (verdict.status != VerdictStatus.Live) {
            if (verdict.status == VerdictStatus.Delivered) {
                revert TCV4VerdictAlreadySettled(taskId, attemptIndex, verdictIndex);
            }
            revert TCV4VerdictNotFound(taskId, attemptIndex, verdictIndex);
        }
        if (block.timestamp > verdict.deadline) revert TCV4VerdictNotFound(taskId, attemptIndex, verdictIndex);

        AttemptRecord storage attempt = _attempts[taskId][attemptIndex];
        // Self-eval hard reject even if somehow claimed.
        if (evaluator == attempt.operator) {
            revert TCV4SolverSelfEvaluation(taskId, attemptIndex, evaluator);
        }

        verdict.evaluationDeliveryDigest = evaluationDeliveryDigest;
        verdict.verdictCode = VerdictCode(verdictCode);
        verdict.status = VerdictStatus.Delivered;
        attempt.deliveredVerdictCount += 1;

        emit VerdictDelivered(
            taskId, attemptIndex, verdictIndex, evaluator, evaluationDeliveryDigest, verdictCode
        );

        TaskRecord storage task = _tasks[taskId];
        if (
            attempt.status == AttemptStatus.Submitted
                && attempt.deliveredVerdictCount >= task.policy.minVerdicts
        ) {
            attempt.status = AttemptStatus.Finalized;
            task.finalizedAttemptCount += 1;
            attemptFinalized = true;
            emit AttemptFinalized(taskId, attemptIndex);
            if (!task.creatorCredited) {
                task.creatorCredited = true;
                creditCreator = true;
                creator = task.creator;
                creatorWeight = 1e18;
            }
            _maybeMarkCapacityExhausted(task, taskId);
        }
    }

    function getTask(uint256 taskId) external view returns (TaskRecord memory) {
        return _tasks[taskId];
    }

    function getAttempt(uint256 taskId, uint32 attemptIndex) external view returns (AttemptRecord memory) {
        return _attempts[taskId][attemptIndex];
    }

    function getVerdict(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex)
        external
        view
        returns (VerdictRecord memory)
    {
        return _verdicts[taskId][attemptIndex][verdictIndex];
    }

    function _validatePolicy(TaskPolicy calldata policy) internal view {
        if (policy.maxTotal < 1) revert TCV4InvalidPolicy();
        if (policy.maxConcurrent < 1 || policy.maxConcurrent > policy.maxTotal) revert TCV4InvalidPolicy();
        if (policy.minVerdicts < 1) revert TCV4InvalidPolicy();
        if (policy.responseTimeout == 0) revert TCV4InvalidPolicy();
        if (policy.submissionDeadline <= block.timestamp) revert TCV4InvalidPolicy();
        if (policy.closeAt != 0 && policy.closeAt < policy.submissionDeadline) revert TCV4InvalidPolicy();
    }

    function _requireTask(uint256 taskId) internal view returns (TaskRecord storage record) {
        record = _tasks[taskId];
        if (record.status == TaskStatus.None) revert TCV4TaskNotFound(taskId);
    }

    function _requireAttempt(uint256 taskId, uint32 attemptIndex)
        internal
        view
        returns (AttemptRecord storage attempt)
    {
        attempt = _attempts[taskId][attemptIndex];
        if (attempt.status == AttemptStatus.None) revert TCV4AttemptNotFound(taskId, attemptIndex);
    }

    function _requireVerdict(uint256 taskId, uint32 attemptIndex, uint32 verdictIndex)
        internal
        view
        returns (VerdictRecord storage verdict)
    {
        verdict = _verdicts[taskId][attemptIndex][verdictIndex];
        if (verdict.evaluator == address(0) && verdict.status == VerdictStatus.None) {
            revert TCV4VerdictNotFound(taskId, attemptIndex, verdictIndex);
        }
    }

    function _maybeMarkCapacityExhausted(TaskRecord storage record, uint256 taskId) internal {
        if (
            record.terminalCause == TerminalCause.None
                && record.settledAttemptCount >= record.policy.maxTotal
                && record.liveOccupancy == 0
        ) {
            record.terminalCause = TerminalCause.CapacityExhausted;
            emit TaskTerminalCause(taskId, uint8(TerminalCause.CapacityExhausted));
        }
    }
}
