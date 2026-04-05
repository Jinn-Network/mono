// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @dev Multisig interface for getting nonce
interface IMultisig {
    /// @dev Gets the multisig nonce.
    /// @return Multisig nonce.
    function nonce() external view returns (uint256);
}

/// @dev Provided zero address.
error ZeroAddress();

/// @dev Zero value when it has to be different from zero.
error ZeroValue();

/// @dev Only owner can call this function.
/// @param sender Sender address.
/// @param owner Required owner address.
error OwnerOnly(address sender, address owner);

/// @title RestorationActivityChecker - Activity checker for EIP-8183 restoration marketplace
/// @author JIN Network
/// @notice Counts restoration activities (CREATE, DELIVER, EVALUATE) per multisig per epoch.
///         Workers call recordActivity() after each 8183 action. The OLAS staking contract
///         reads activity counts via getMultisigNonces().
/// @dev Follows the standard OLAS activity checker interface (getMultisigNonces + isRatioPass).
///      Uses a counter-based design rather than parsing on-chain events.
contract RestorationActivityChecker {
    /// @dev Activity types that workers can record
    enum ActivityType { CREATE, DELIVER, EVALUATE }

    /// @dev Liveness ratio in the format of 1e18
    uint256 public immutable livenessRatio;

    /// @dev Contract owner (can authorize callers)
    address public owner;

    /// @dev Addresses authorized to record activities (worker agents/Safes)
    mapping(address => bool) public authorizedCallers;

    /// @dev Total activity count per multisig (monotonically increasing)
    /// @notice This is what getMultisigNonces returns as nonces[1]
    mapping(address => uint256) public activityCounts;

    /// @dev Activity count per type per multisig (for off-chain inspection)
    mapping(address => mapping(uint8 => uint256)) public activityCountsByType;

    /// @dev Emitted when an activity is recorded
    event ActivityRecorded(address indexed multisig, uint8 indexed activityType, uint256 totalCount);

    /// @dev Emitted when a caller is authorized or deauthorized
    event CallerAuthorizationChanged(address indexed caller, bool authorized);

    /// @dev Emitted when ownership is transferred
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(uint256 _livenessRatio, address _owner) {
        if (_livenessRatio == 0) revert ZeroValue();
        if (_owner == address(0)) revert ZeroAddress();
        livenessRatio = _livenessRatio;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ============ Activity Recording ============

    /// @notice Record a restoration activity for a multisig.
    /// @dev Called by the worker after each 8183 action (create/deliver/evaluate).
    ///      Permissionless — any staked agent can record activity. The staking contract
    ///      itself validates that the multisig is a staked service.
    /// @param multisig The service multisig (Safe) address
    /// @param activityType 0=CREATE, 1=DELIVER, 2=EVALUATE
    function recordActivity(address multisig, uint8 activityType) external {
        require(multisig != address(0), "RestorationActivityChecker: zero multisig");
        require(activityType <= uint8(ActivityType.EVALUATE), "RestorationActivityChecker: invalid type");

        activityCounts[multisig] += 1;
        activityCountsByType[multisig][activityType] += 1;

        emit ActivityRecorded(multisig, activityType, activityCounts[multisig]);
    }

    // ============ OLAS Activity Checker Interface ============

    /// @dev Gets service multisig nonces.
    /// @param multisig Service multisig address.
    /// @return nonces [Safe nonce, total activity count]
    function getMultisigNonces(address multisig) external view returns (uint256[] memory nonces) {
        nonces = new uint256[](2);
        nonces[0] = IMultisig(multisig).nonce();
        nonces[1] = activityCounts[multisig];
    }

    /// @dev Checks if the service multisig liveness ratio passes the defined liveness threshold.
    /// @param curNonces Current [Safe nonce, activity count].
    /// @param lastNonces Previous [Safe nonce, activity count].
    /// @param ts Time difference between current and last timestamps.
    /// @return ratioPass True if the liveness ratio passes.
    function isRatioPass(
        uint256[] memory curNonces,
        uint256[] memory lastNonces,
        uint256 ts
    ) external view returns (bool ratioPass) {
        if (ts > 0 && curNonces[1] > lastNonces[1]) {
            uint256 diffActivities = curNonces[1] - lastNonces[1];
            uint256 ratio = (diffActivities * 1e18) / ts;
            ratioPass = (ratio >= livenessRatio);
        }
    }

    // ============ Admin ============

    /// @notice Authorize or deauthorize an address to record activities
    function setCallerAuthorization(address caller, bool authorized) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;
        emit CallerAuthorizationChanged(caller, authorized);
    }

    /// @notice Transfer ownership
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert OwnerOnly(msg.sender, owner);
        if (newOwner == address(0)) revert ZeroAddress();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}
