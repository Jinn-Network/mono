// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Implementation, OwnerOnly, ZeroAddress} from "../vendor/stolas/Implementation.sol";

interface ITaskActivitySafe {
    function nonce() external view returns (uint256);
}

error TACAlreadyInitialized();
error TACZeroValue();
error TACOverflow(uint256 value, uint256 max);
error TACUnauthorizedRouter(address sender, address authorizedRouter);
error TACTaskAlreadyCredited(uint256 taskId);

/// @title TaskActivityCheckerV3
/// @notice Task-native activity checker for staking and distribution eligibility.
/// @dev Layout intentionally preserves RestorationActivityCheckerV2 slots before appending V3 state.
contract TaskActivityCheckerV3 is Implementation {
    uint256 public livenessRatio;

    mapping(address => uint256) private _legacyActivityCounts;
    mapping(address => mapping(uint8 => uint256)) private _legacyActivityCountsByType;
    mapping(address => uint256) private _legacyNoveltyWeightedCounts;
    mapping(address => uint256) private _legacyVerifiedCreations;
    mapping(address => bytes32[]) private _solutionEvidenceHashes;
    mapping(address => uint256) private _solutionEvidenceWriteIndex;

    uint256 public similarityThreshold;
    uint256 public similarDecayMultiplier;
    uint256 public comparisonWindow;

    address private _legacyJinnRouter;
    address public authorizedRouter;

    mapping(address => uint256) public taskCreationWeight;
    mapping(address => uint256) public solutionDeliveryWeight;
    mapping(address => uint256) public verdictDeliveryWeight;
    mapping(address => uint256) public eligibleActivityWeight;
    mapping(uint256 => bool) public taskCreationFinalized;

    event RouterUpdated(address indexed authorizedRouter);
    event SolutionDeliveryRecorded(address indexed operator, bytes32 indexed solutionDigest, uint256 weight);
    event VerdictDeliveryRecorded(address indexed evaluator, bytes32 indexed verdictDigest, uint256 weight);
    event TaskCreationFinalized(address indexed creator, uint256 indexed taskId, uint256 weight);
    event AntifarmingParametersUpdated(
        uint256 similarityThreshold,
        uint256 similarDecayMultiplier,
        uint256 comparisonWindow
    );

    function initialize(
        uint256 _livenessRatio,
        address _owner,
        uint256 _similarityThreshold,
        uint256 _similarDecayMultiplier,
        uint256 _comparisonWindow
    ) external {
        if (owner != address(0)) revert TACAlreadyInitialized();
        if (_livenessRatio == 0) revert TACZeroValue();
        if (_owner == address(0)) revert ZeroAddress();
        if (_similarityThreshold > 256) revert TACOverflow(_similarityThreshold, 256);
        if (_similarDecayMultiplier > 1e18) revert TACOverflow(_similarDecayMultiplier, 1e18);
        if (_comparisonWindow == 0) revert TACZeroValue();

        livenessRatio = _livenessRatio;
        owner = _owner;
        similarityThreshold = _similarityThreshold;
        similarDecayMultiplier = _similarDecayMultiplier;
        comparisonWindow = _comparisonWindow;

        emit OwnerUpdated(_owner);
    }

    function setAuthorizedRouter(address newAuthorizedRouter) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (newAuthorizedRouter == address(0)) revert ZeroAddress();
        authorizedRouter = newAuthorizedRouter;
        emit RouterUpdated(newAuthorizedRouter);
    }

    function setAntifarmingParameters(
        uint256 _similarityThreshold,
        uint256 _similarDecayMultiplier,
        uint256 _comparisonWindow
    ) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (_similarityThreshold > 256) revert TACOverflow(_similarityThreshold, 256);
        if (_similarDecayMultiplier > 1e18) revert TACOverflow(_similarDecayMultiplier, 1e18);
        if (_comparisonWindow == 0) revert TACZeroValue();

        similarityThreshold = _similarityThreshold;
        similarDecayMultiplier = _similarDecayMultiplier;
        comparisonWindow = _comparisonWindow;

        emit AntifarmingParametersUpdated(_similarityThreshold, _similarDecayMultiplier, _comparisonWindow);
    }

    function recordSolutionDelivery(address operator, bytes32 solutionDigest)
        external
        returns (uint256 weight)
    {
        _requireRouter();
        if (operator == address(0)) revert ZeroAddress();
        if (solutionDigest == bytes32(0)) revert TACZeroValue();

        weight = _computeNoveltyWeight(operator, solutionDigest);
        _writeSolutionEvidenceHash(operator, solutionDigest);
        solutionDeliveryWeight[operator] += weight;
        eligibleActivityWeight[operator] += weight;

        emit SolutionDeliveryRecorded(operator, solutionDigest, weight);
    }

    function recordVerdictDelivery(address evaluator, bytes32 verdictDigest)
        external
        returns (uint256 weight)
    {
        _requireRouter();
        if (evaluator == address(0)) revert ZeroAddress();
        if (verdictDigest == bytes32(0)) revert TACZeroValue();

        weight = 1e18;
        verdictDeliveryWeight[evaluator] += weight;
        eligibleActivityWeight[evaluator] += weight;

        emit VerdictDeliveryRecorded(evaluator, verdictDigest, weight);
    }

    function recordTaskCreationFinalized(address creator, uint256 taskId, uint256 weight) external {
        _requireRouter();
        if (creator == address(0)) revert ZeroAddress();
        if (taskCreationFinalized[taskId]) revert TACTaskAlreadyCredited(taskId);

        taskCreationFinalized[taskId] = true;
        taskCreationWeight[creator] += weight;
        eligibleActivityWeight[creator] += weight;

        emit TaskCreationFinalized(creator, taskId, weight);
    }

    function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces) {
        nonces = new uint256[](2);
        nonces[0] = ITaskActivitySafe(multisig).nonce();
        nonces[1] = eligibleActivityWeight[multisig];
    }

    function isRatioPass(
        uint256[] memory curNonces,
        uint256[] memory lastNonces,
        uint256 ts
    ) external view returns (bool ratioPass) {
        if (ts > 0 && curNonces[1] > lastNonces[1]) {
            uint256 diffWeighted = curNonces[1] - lastNonces[1];
            uint256 ratio = diffWeighted / ts;
            ratioPass = ratio >= livenessRatio;
        }
    }

    function getSolutionEvidenceHashCount(address operator) external view returns (uint256) {
        return _solutionEvidenceHashes[operator].length;
    }

    function getSolutionEvidenceHash(address operator, uint256 index) external view returns (bytes32) {
        bytes32[] storage hashes = _solutionEvidenceHashes[operator];
        uint256 len = hashes.length;
        require(index < len, "TaskActivityCheckerV3: index out of bounds");

        if (len < comparisonWindow) {
            return hashes[index];
        }
        uint256 oldest = _solutionEvidenceWriteIndex[operator];
        return hashes[(oldest + index) % len];
    }

    function _requireRouter() internal view {
        if (msg.sender != authorizedRouter) revert TACUnauthorizedRouter(msg.sender, authorizedRouter);
    }

    function _writeSolutionEvidenceHash(address operator, bytes32 newHash) internal {
        bytes32[] storage hashes = _solutionEvidenceHashes[operator];
        uint256 window = comparisonWindow;

        if (hashes.length < window) {
            hashes.push(newHash);
            return;
        }

        uint256 idx = _solutionEvidenceWriteIndex[operator];
        hashes[idx] = newHash;
        unchecked {
            _solutionEvidenceWriteIndex[operator] = (idx + 1) % window;
        }
    }

    function _computeNoveltyWeight(address operator, bytes32 newHash) internal view returns (uint256) {
        bytes32[] storage hashes = _solutionEvidenceHashes[operator];
        uint256 len = hashes.length;
        if (len == 0) return 1e18;

        uint256 minDistance = 256;
        for (uint256 i = 0; i < len; i++) {
            uint256 distance = _hammingDistance(newHash, hashes[i]);
            if (distance < minDistance) {
                minDistance = distance;
            }
        }
        return minDistance < similarityThreshold ? similarDecayMultiplier : 1e18;
    }

    function _hammingDistance(bytes32 a, bytes32 b) internal pure returns (uint256 count) {
        uint256 x = uint256(a ^ b);
        unchecked {
            x = x - ((x >> 1) & 0x5555555555555555555555555555555555555555555555555555555555555555);
            x = (x & 0x3333333333333333333333333333333333333333333333333333333333333333)
                + ((x >> 2) & 0x3333333333333333333333333333333333333333333333333333333333333333);
            x = (x + (x >> 4)) & 0x0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F;
            x = x * 0x0101010101010101010101010101010101010101010101010101010101010101;
            count = x >> 248;
        }
    }
}
