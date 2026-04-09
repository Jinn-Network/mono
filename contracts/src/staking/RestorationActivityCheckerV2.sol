// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @dev Multisig interface for getting nonce
interface IMultisig {
    /// @dev Gets the multisig nonce.
    /// @return Multisig nonce.
    function nonce() external view returns (uint256);
}

/// @dev JinnRouter interface for reading activity counters
interface IJinnRouter {
    function creationCount(address multisig) external view returns (uint256);
    function restorationDeliveryCount(address multisig) external view returns (uint256);
    function evaluationCreationCount(address multisig) external view returns (uint256);
    function evaluationDeliveryCount(address multisig) external view returns (uint256);
}

/// @dev Provided zero address.
error ZeroAddress();

/// @dev Zero value when it has to be different from zero.
error ZeroValue();

/// @dev Only owner can call this function.
/// @param sender Sender address.
/// @param owner Required owner address.
error OwnerOnly(address sender, address owner);

/// @dev Value exceeds maximum.
/// @param value Provided value.
/// @param max Maximum allowed.
error Overflow(uint256 value, uint256 max);

/// @dev Unauthorized router caller.
/// @param sender Sender address.
/// @param authorizedRouter Required authorized router address.
error UnauthorizedRouter(address sender, address authorizedRouter);

/// @title RestorationActivityCheckerV2 - Activity checker with SimHash-based anti-farming decay
/// @author JIN Network
/// @notice Extends V1 with evidence novelty checking. Activities submitted with evidence hashes
///         are weighted by novelty — novel evidence earns full weight, similar evidence earns
///         reduced (or zero) weight. The OLAS staking contract reads novelty-weighted counts
///         via getMultisigNonces() and isRatioPass(), so farming operators fail liveness checks.
/// @dev Evidence SimHashes are computed off-chain by the client and submitted as bytes32.
///      Similarity is measured by Hamming distance between 256-bit SimHash values.
///      The contract stores a sliding window of recent hashes per multisig for comparison.
contract RestorationActivityCheckerV2 {
    /// @dev Activity types that workers can record
    enum ActivityType { CREATE, DELIVER, EVALUATE }

    // ============ Immutables ============

    /// @dev Liveness ratio in the format of 1e18
    uint256 public immutable livenessRatio;

    // ============ State ============

    /// @dev Contract owner (can update anti-farming parameters)
    address public owner;

    /// @dev Raw activity count per multisig (monotonically increasing, for off-chain inspection)
    mapping(address => uint256) public activityCounts;

    /// @dev Activity count per type per multisig (for off-chain inspection)
    mapping(address => mapping(uint8 => uint256)) public activityCountsByType;

    /// @dev Novelty-weighted activity count per multisig (1e18 scale).
    ///      This is what getMultisigNonces returns and isRatioPass uses.
    ///      1 fully novel activity = 1e18 added. Similar evidence adds less (or zero).
    mapping(address => uint256) public noveltyWeightedCounts;

    /// @dev SimHash of evidence for each recorded activity, per multisig.
    ///      Used by _computeNoveltyWeight to detect similarity.
    mapping(address => bytes32[]) public evidenceHashes;

    // ============ Anti-farming parameters (owner-settable) ============

    /// @dev Hamming distance threshold (0-256). Hashes closer than this are "similar".
    ///      Default: 64 (25% of 256 bits).
    uint256 public similarityThreshold;

    /// @dev Weight multiplier for similar evidence (1e18 scale).
    ///      0 = zero reward for farming. 5e17 = half weight. 1e18 = no decay.
    uint256 public similarDecayMultiplier;

    /// @dev Number of recent hashes to compare against per multisig.
    ///      Bounds gas cost of recordActivityWithEvidence.
    uint256 public comparisonWindow;

    /// @dev JinnRouter address (to read raw activity counters for non-delivery activities)
    address public jinnRouter;

    /// @dev Only this address can call recordRestorationEvidence
    address public authorizedRouter;

    // ============ Events ============

    event ActivityRecorded(address indexed multisig, uint8 indexed activityType, uint256 totalCount);

    event ActivityRecordedWithEvidence(
        address indexed multisig,
        uint8 indexed activityType,
        bytes32 evidenceHash,
        uint256 noveltyWeight
    );

    event AntifarmingParametersUpdated(
        uint256 similarityThreshold,
        uint256 similarDecayMultiplier,
        uint256 comparisonWindow
    );

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ============ Constructor ============

    /// @param _livenessRatio Liveness ratio threshold (1e18 format)
    /// @param _owner Contract owner
    /// @param _similarityThreshold Hamming distance threshold (0-256)
    /// @param _similarDecayMultiplier Weight for similar evidence (1e18 scale)
    /// @param _comparisonWindow Number of recent hashes to compare against
    constructor(
        uint256 _livenessRatio,
        address _owner,
        uint256 _similarityThreshold,
        uint256 _similarDecayMultiplier,
        uint256 _comparisonWindow
    ) {
        if (_livenessRatio == 0) revert ZeroValue();
        if (_owner == address(0)) revert ZeroAddress();
        if (_similarityThreshold > 256) revert Overflow(_similarityThreshold, 256);
        if (_similarDecayMultiplier > 1e18) revert Overflow(_similarDecayMultiplier, 1e18);
        if (_comparisonWindow == 0) revert ZeroValue();

        livenessRatio = _livenessRatio;
        owner = _owner;
        similarityThreshold = _similarityThreshold;
        similarDecayMultiplier = _similarDecayMultiplier;
        comparisonWindow = _comparisonWindow;

        emit OwnershipTransferred(address(0), _owner);
    }

    // ============ Activity Recording ============

    /// @notice Record activity with evidence hash for anti-farming novelty checking.
    /// @param multisig The service multisig (Safe) address
    /// @param activityType 0=CREATE, 1=DELIVER, 2=EVALUATE
    /// @param evidenceHash SimHash of the evidence checkpoint data (computed off-chain)
    function recordActivityWithEvidence(
        address multisig,
        uint8 activityType,
        bytes32 evidenceHash
    ) external {
        require(multisig != address(0), "RestorationActivityCheckerV2: zero multisig");
        require(activityType <= uint8(ActivityType.EVALUATE), "RestorationActivityCheckerV2: invalid type");

        // Compute novelty weight by comparing against recent hashes
        uint256 weight = _computeNoveltyWeight(multisig, evidenceHash);

        // Store the hash for future comparisons
        evidenceHashes[multisig].push(evidenceHash);

        // Increment raw count (for backward compat / off-chain inspection)
        activityCounts[multisig] += 1;
        activityCountsByType[multisig][activityType] += 1;

        // Increment novelty-weighted count
        noveltyWeightedCounts[multisig] += weight;

        emit ActivityRecordedWithEvidence(multisig, activityType, evidenceHash, weight);
    }

    /// @notice Called by the JinnRouter when a restoration delivery is claimed with evidence.
    ///         Only the authorized router can call this.
    /// @param multisig The service multisig (Safe) address
    /// @param evidenceHash SimHash of the restoration evidence
    function recordRestorationEvidence(address multisig, bytes32 evidenceHash) external {
        if (msg.sender != authorizedRouter) revert UnauthorizedRouter(msg.sender, authorizedRouter);
        require(multisig != address(0), "RestorationActivityCheckerV2: zero multisig");

        uint256 weight = _computeNoveltyWeight(multisig, evidenceHash);
        evidenceHashes[multisig].push(evidenceHash);
        noveltyWeightedCounts[multisig] += weight;

        emit ActivityRecordedWithEvidence(multisig, uint8(ActivityType.DELIVER), evidenceHash, weight);
    }

    /// @notice Record activity without evidence (backward compatible with V1).
    ///         Full weight is granted since we cannot assess novelty without evidence.
    /// @param multisig The service multisig (Safe) address
    /// @param activityType 0=CREATE, 1=DELIVER, 2=EVALUATE
    function recordActivity(address multisig, uint8 activityType) external {
        require(multisig != address(0), "RestorationActivityCheckerV2: zero multisig");
        require(activityType <= uint8(ActivityType.EVALUATE), "RestorationActivityCheckerV2: invalid type");

        activityCounts[multisig] += 1;
        activityCountsByType[multisig][activityType] += 1;
        noveltyWeightedCounts[multisig] += 1e18;

        emit ActivityRecorded(multisig, activityType, activityCounts[multisig]);
    }

    // ============ OLAS Activity Checker Interface ============

    /// @dev Gets service multisig nonces. When a JinnRouter is configured, combines the router's
    ///      raw activity counts (creation, eval creation, eval delivery — full weight) with this
    ///      checker's novelty-weighted restoration delivery count.
    ///      If no jinnRouter is set, falls back to standalone mode (noveltyWeightedCounts only).
    /// @param multisig Service multisig address.
    /// @return nonces [Safe nonce, total weighted activity (1e18 scale)]
    function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces) {
        nonces = new uint256[](2);
        nonces[0] = IMultisig(multisig).nonce();

        if (jinnRouter != address(0)) {
            // Read raw counts from router — full weight (1e18 each)
            // Note: restorationDeliveryCount is NOT included here — it's tracked via
            // noveltyWeightedCounts through recordRestorationEvidence instead
            uint256 routerActivity =
                (IJinnRouter(jinnRouter).creationCount(multisig) +
                 IJinnRouter(jinnRouter).evaluationCreationCount(multisig) +
                 IJinnRouter(jinnRouter).evaluationDeliveryCount(multisig)) * 1e18;
            // Add novelty-weighted restoration delivery count
            nonces[1] = routerActivity + noveltyWeightedCounts[multisig];
        } else {
            // Standalone mode (backward compat — direct recordActivity/recordActivityWithEvidence calls)
            nonces[1] = noveltyWeightedCounts[multisig];
        }
    }

    /// @dev Checks if the service multisig liveness ratio passes the defined liveness threshold.
    ///      Uses novelty-weighted counts: farming operators accumulate zero/low weight and fail.
    /// @param curNonces Current [Safe nonce, novelty-weighted count].
    /// @param lastNonces Previous [Safe nonce, novelty-weighted count].
    /// @param ts Time difference between current and last timestamps.
    /// @return ratioPass True if the liveness ratio passes.
    function isRatioPass(
        uint256[] memory curNonces,
        uint256[] memory lastNonces,
        uint256 ts
    ) external view returns (bool ratioPass) {
        if (ts > 0 && curNonces[1] > lastNonces[1]) {
            uint256 diffWeighted = curNonces[1] - lastNonces[1];
            // diffWeighted is in 1e18 scale (1 novel activity = 1e18).
            // ratio = diffWeighted / ts. livenessRatio is also in 1e18 scale.
            uint256 ratio = diffWeighted / ts;
            ratioPass = (ratio >= livenessRatio);
        }
    }

    // ============ View helpers ============

    /// @notice Get the number of stored evidence hashes for a multisig.
    function getEvidenceHashCount(address multisig) external view returns (uint256) {
        return evidenceHashes[multisig].length;
    }

    /// @notice Get a specific evidence hash by index.
    function getEvidenceHash(address multisig, uint256 index) external view returns (bytes32) {
        return evidenceHashes[multisig][index];
    }

    // ============ Internal: Novelty computation ============

    /// @dev Compare a new evidence hash against the multisig's recent hashes.
    ///      Returns 1e18 for novel evidence, or similarDecayMultiplier for similar evidence.
    function _computeNoveltyWeight(address multisig, bytes32 newHash) internal view returns (uint256) {
        bytes32[] storage hashes = evidenceHashes[multisig];
        uint256 len = hashes.length;

        // First activity is always novel
        if (len == 0) {
            return 1e18;
        }

        // Compare against the last `comparisonWindow` hashes
        uint256 start = len > comparisonWindow ? len - comparisonWindow : 0;
        uint256 minDistance = 256; // Max possible Hamming distance

        for (uint256 i = start; i < len; i++) {
            uint256 dist = _hammingDistance(newHash, hashes[i]);
            if (dist < minDistance) {
                minDistance = dist;
            }
            // Early exit: if we already found identical, no need to keep looking
            if (minDistance == 0) {
                break;
            }
        }

        // If closest hash is at or above threshold, evidence is novel
        if (minDistance >= similarityThreshold) {
            return 1e18;
        }

        // Otherwise, apply decay
        return similarDecayMultiplier;
    }

    /// @dev Compute the Hamming distance between two bytes32 values.
    ///      Hamming distance = number of differing bits = popcount(a XOR b).
    function _hammingDistance(bytes32 a, bytes32 b) internal pure returns (uint256) {
        return _popcount256(uint256(a) ^ uint256(b));
    }

    /// @dev Count the number of set bits in a 256-bit integer.
    ///      Uses the parallel bit-counting algorithm (Wegner / Hamming weight).
    function _popcount256(uint256 x) internal pure returns (uint256 count) {
        unchecked {
            // Step 1: Replace each pair of bits with their sum
            x = x - ((x >> 1) & 0x5555555555555555555555555555555555555555555555555555555555555555);
            // Step 2: Replace each nibble with the sum of its two pairs
            x = (x & 0x3333333333333333333333333333333333333333333333333333333333333333)
              + ((x >> 2) & 0x3333333333333333333333333333333333333333333333333333333333333333);
            // Step 3: Replace each byte with the sum of its two nibbles
            x = (x + (x >> 4)) & 0x0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F;
            // Step 4: Sum all bytes by multiplying with a pattern of 1s and taking the top byte
            x = x * 0x0101010101010101010101010101010101010101010101010101010101010101;
            count = x >> 248;
        }
    }

    // ============ Admin ============

    /// @notice Update anti-farming parameters.
    function setAntifarmingParameters(
        uint256 _similarityThreshold,
        uint256 _similarDecayMultiplier,
        uint256 _comparisonWindow
    ) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (_similarityThreshold > 256) revert Overflow(_similarityThreshold, 256);
        if (_similarDecayMultiplier > 1e18) revert Overflow(_similarDecayMultiplier, 1e18);
        if (_comparisonWindow == 0) revert ZeroValue();

        similarityThreshold = _similarityThreshold;
        similarDecayMultiplier = _similarDecayMultiplier;
        comparisonWindow = _comparisonWindow;

        emit AntifarmingParametersUpdated(_similarityThreshold, _similarDecayMultiplier, _comparisonWindow);
    }

    /// @notice Set JinnRouter and authorized router addresses.
    function setRouterAddresses(address _jinnRouter, address _authorizedRouter) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (_jinnRouter == address(0)) revert ZeroAddress();
        if (_authorizedRouter == address(0)) revert ZeroAddress();
        jinnRouter = _jinnRouter;
        authorizedRouter = _authorizedRouter;
    }

    /// @notice Transfer ownership.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (newOwner == address(0)) revert ZeroAddress();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}
