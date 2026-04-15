// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @dev Multisig interface for getting nonce
interface IMultisig {
    /// @dev Gets the multisig nonce.
    /// @return Multisig nonce.
    function nonce() external view returns (uint256);
}

/// @dev Mech Marketplace interface for getting delivery counts
interface IMechMarketplace {
    /// @dev Gets the delivery count for a specific mech/multisig address.
    /// @param mech Mech (multisig) address.
    /// @return deliveryCount Delivery count.
    function mapDeliveryCounts(address mech) external view returns (uint256 deliveryCount);
}

/// @dev Provided zero address.
error ZeroAddress();

/// @dev Zero value when it has to be different from zero.
error ZeroValue();

/// @title DeliveryActivityChecker - Permissionless activity checker based on mech delivery counts
/// @author JIN Network
/// @notice Checks staking liveness based on mech marketplace deliveries,
///         measuring worker output (deliveries) rather than input (requests).
///         Any staked service that meets the liveness ratio passes.
/// @dev Follows the standard OLAS activity checker interface (getMultisigNonces + isRatioPass).
///      Uses mapDeliveryCounts instead of mapRequestCounts from the MechMarketplace.
contract DeliveryActivityChecker {
    /// @dev Liveness ratio in the format of 1e18
    uint256 public immutable livenessRatio;

    /// @dev AI agent mech marketplace contract address
    address public immutable mechMarketplace;

    /// @dev DeliveryActivityChecker constructor.
    /// @param _mechMarketplace AI agent mech marketplace contract address.
    /// @param _livenessRatio Liveness ratio in the format of 1e18.
    constructor(address _mechMarketplace, uint256 _livenessRatio) {
        if (_mechMarketplace == address(0)) {
            revert ZeroAddress();
        }
        if (_livenessRatio == 0) {
            revert ZeroValue();
        }

        mechMarketplace = _mechMarketplace;
        livenessRatio = _livenessRatio;
    }

    /// @dev Gets service multisig nonces.
    /// @param multisig Service multisig address.
    /// @return nonces Set of a nonce and a delivery count for the multisig.
    function getMultisigNonces(address multisig) external view virtual returns (uint256[] memory nonces) {
        nonces = new uint256[](2);
        nonces[0] = IMultisig(multisig).nonce();
        nonces[1] = IMechMarketplace(mechMarketplace).mapDeliveryCounts(multisig);
    }

    /// @dev Checks if the service multisig liveness ratio passes the defined liveness threshold.
    /// @notice The formula:
    ///         ratio = (deliveryCountDiff) / (timeDiff), where ratio >= livenessRatio.
    ///         Delivery count difference must be <= nonce difference (sanity bound).
    /// @param curNonces Current [multisig nonce, delivery count].
    /// @param lastNonces Previous [multisig nonce, delivery count].
    /// @param ts Time difference between current and last checkpoint.
    /// @return ratioPass True if the liveness ratio passes.
    function isRatioPass(
        uint256[] memory curNonces,
        uint256[] memory lastNonces,
        uint256 ts
    ) external view virtual returns (bool ratioPass) {
        if (ts > 0 && curNonces[0] > lastNonces[0] && curNonces[1] > lastNonces[1]) {
            uint256 diffNonces = curNonces[0] - lastNonces[0];
            uint256 diffDeliveryCounts = curNonces[1] - lastNonces[1];
            if (diffDeliveryCounts <= diffNonces) {
                uint256 ratio = (diffDeliveryCounts * 1e18) / ts;
                ratioPass = (ratio >= livenessRatio);
            }
        }
    }
}
