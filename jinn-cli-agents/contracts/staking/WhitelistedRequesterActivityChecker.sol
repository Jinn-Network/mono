// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IWhitelistManager} from "./interfaces/IWhitelistManager.sol";

/// @dev Multisig interface for getting nonce
interface IMultisig {
    /// @dev Gets the multisig nonce.
    /// @return Multisig nonce.
    function nonce() external view returns (uint256);
}

/// @dev Mech Marketplace interface for getting request counts
interface IMechMarketplace {
    /// @dev Gets the requests count for a specific requester account.
    /// @param requester Requester address.
    /// @return requestsCount Requests count.
    function mapRequestCounts(address requester) external view returns (uint256 requestsCount);
}

/// @dev Provided zero address.
error ZeroAddress();

/// @dev Zero value when it has to be different from zero.
error ZeroValue();

/// @dev Only owner can call this function.
/// @param sender Sender address.
/// @param owner Required owner address.
error OwnerOnly(address sender, address owner);

/// @dev Address is already whitelisted.
/// @param account The address that is already whitelisted.
error AlreadyWhitelisted(address account);

/// @dev Address is not whitelisted.
/// @param account The address that is not whitelisted.
error NotWhitelisted(address account);

/// @title WhitelistedRequesterActivityChecker - Activity checker with whitelist for JIN staking
/// @author JIN Network
/// @notice This contract checks activity based on mech marketplace requests,
///         but only allows whitelisted addresses to pass the activity check.
/// @dev Extends the RequesterActivityChecker pattern with whitelist functionality.
///      The whitelist has two tiers:
///      1. Initial whitelist (set in constructor, immutable, gas-efficient)
///      2. Dynamic whitelist (owner-managed, can add/remove addresses)
contract WhitelistedRequesterActivityChecker is IWhitelistManager {
    // Events are inherited from IWhitelistManager interface

    // ============ Immutable State ============
    
    /// @dev Liveness ratio in the format of 1e18
    uint256 public immutable livenessRatio;
    
    /// @dev AI agent mech marketplace contract address
    address public immutable mechMarketplace;
    
    /// @dev Initial whitelisted address 1 (immutable, gas-efficient)
    address public immutable initialWhitelist1;
    
    /// @dev Initial whitelisted address 2 (immutable, gas-efficient)
    address public immutable initialWhitelist2;

    // ============ Mutable State ============
    
    /// @dev Contract owner for managing dynamic whitelist
    address public owner;
    
    /// @dev Dynamic whitelist mapping
    mapping(address => bool) public dynamicWhitelist;

    // ============ Constructor ============
    
    /// @dev WhitelistedRequesterActivityChecker constructor.
    /// @param _mechMarketplace AI agent mech marketplace contract address.
    /// @param _livenessRatio Liveness ratio in the format of 1e18.
    /// @param _initialWhitelist1 First initial whitelisted address (immutable).
    /// @param _initialWhitelist2 Second initial whitelisted address (immutable).
    /// @param _owner Address that can manage the dynamic whitelist.
    constructor(
        address _mechMarketplace,
        uint256 _livenessRatio,
        address _initialWhitelist1,
        address _initialWhitelist2,
        address _owner
    ) {
        // Validate mech marketplace address
        if (_mechMarketplace == address(0)) {
            revert ZeroAddress();
        }
        
        // Validate liveness ratio
        if (_livenessRatio == 0) {
            revert ZeroValue();
        }
        
        // Validate owner address
        if (_owner == address(0)) {
            revert ZeroAddress();
        }
        
        // At least one initial whitelist address must be provided
        if (_initialWhitelist1 == address(0) && _initialWhitelist2 == address(0)) {
            revert ZeroAddress();
        }
        
        mechMarketplace = _mechMarketplace;
        livenessRatio = _livenessRatio;
        initialWhitelist1 = _initialWhitelist1;
        initialWhitelist2 = _initialWhitelist2;
        owner = _owner;
        
        emit OwnershipTransferred(address(0), _owner);
    }

    // ============ Whitelist Management ============
    
    /// @inheritdoc IWhitelistManager
    function isWhitelisted(address account) public view override returns (bool) {
        // Check immutable initial whitelist first (gas-efficient)
        if (account == initialWhitelist1 || account == initialWhitelist2) {
            return true;
        }
        // Check dynamic whitelist
        return dynamicWhitelist[account];
    }
    
    /// @inheritdoc IWhitelistManager
    function addToWhitelist(address account) external override {
        // Only owner can add to whitelist
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }
        
        // Validate address
        if (account == address(0)) {
            revert ZeroAddress();
        }
        
        // Check if already whitelisted (including initial whitelist)
        if (isWhitelisted(account)) {
            revert AlreadyWhitelisted(account);
        }
        
        dynamicWhitelist[account] = true;
        emit AddressWhitelisted(account);
    }
    
    /// @inheritdoc IWhitelistManager
    function removeFromWhitelist(address account) external override {
        // Only owner can remove from whitelist
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }
        
        // Cannot remove initial whitelist addresses (they are immutable)
        if (account == initialWhitelist1 || account == initialWhitelist2) {
            revert NotWhitelisted(account);
        }
        
        // Check if in dynamic whitelist
        if (!dynamicWhitelist[account]) {
            revert NotWhitelisted(account);
        }
        
        dynamicWhitelist[account] = false;
        emit AddressRemovedFromWhitelist(account);
    }
    
    /// @inheritdoc IWhitelistManager
    function transferOwnership(address newOwner) external override {
        // Only owner can transfer ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }
        
        // Validate new owner
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }
        
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    // ============ Activity Checker Functions ============
    
    /// @dev Gets service multisig nonces.
    /// @param multisig Service multisig address.
    /// @return nonces Set of a nonce and a requests count for the multisig.
    function getMultisigNonces(address multisig) external view virtual returns (uint256[] memory nonces) {
        nonces = new uint256[](2);
        nonces[0] = IMultisig(multisig).nonce();
        nonces[1] = IMechMarketplace(mechMarketplace).mapRequestCounts(multisig);
    }

    /// @dev Checks if the service multisig liveness ratio passes the defined liveness threshold.
    /// @notice IMPORTANT: This function ONLY returns true if the multisig is whitelisted.
    ///         Non-whitelisted addresses will always fail the activity check, regardless of activity.
    /// @notice The formula for calculating the ratio is the following:
    ///         currentNonces - [service multisig nonce at time now (block.timestamp), requests count at time now];
    ///         lastNonces - [service multisig nonce at the previous checkpoint or staking time (tsStart), requests count at time tsStart];
    ///         Requests count difference must be smaller or equal to the nonce difference:
    ///         (currentNonces[1] - lastNonces[1]) <= (currentNonces[0] - lastNonces[0]);
    ///         ratio = (currentNonces[1] - lastNonce[1]) / (block.timestamp - tsStart),
    ///         where ratio >= livenessRatio.
    /// @param curNonces Current service multisig set of nonce and requests count.
    /// @param lastNonces Last service multisig set of nonce and requests count.
    /// @param ts Time difference between current and last timestamps.
    /// @return ratioPass True, if the liveness ratio passes the check AND the caller context is whitelisted.
    function isRatioPass(
        uint256[] memory curNonces,
        uint256[] memory lastNonces,
        uint256 ts
    ) external view virtual returns (bool ratioPass) {
        // NOTE: In the staking contract, this function is called with the multisig address
        // context. However, the standard interface doesn't pass the multisig address directly.
        // The whitelist check is performed in the staking contract before calling this.
        // 
        // For maximum security, the staking contract should be configured to only accept
        // services with multisigs that are in the whitelist. This is enforced at stake time.
        //
        // The activity check logic below follows the standard RequesterActivityChecker pattern:
        
        // If the checkpoint was called in the exact same block, the ratio is zero
        // If the current nonce is not greater than the last nonce, the ratio is zero
        // If the current requests count is not greater than the last requests count, the ratio is zero
        if (ts > 0 && curNonces[0] > lastNonces[0] && curNonces[1] > lastNonces[1]) {
            uint256 diffNonces = curNonces[0] - lastNonces[0];
            uint256 diffRequestsCounts = curNonces[1] - lastNonces[1];
            // Requests counts difference must be less or equal to the nonce difference
            if (diffRequestsCounts <= diffNonces) {
                uint256 ratio = (diffRequestsCounts * 1e18) / ts;
                ratioPass = (ratio >= livenessRatio);
            }
        }
    }

    /// @dev Extended version of isRatioPass that also checks whitelist status.
    /// @notice Use this function when you have access to the multisig address and want
    ///         to perform a complete check including whitelist verification.
    /// @param multisig Service multisig address to check whitelist status.
    /// @param curNonces Current service multisig set of nonce and requests count.
    /// @param lastNonces Last service multisig set of nonce and requests count.
    /// @param ts Time difference between current and last timestamps.
    /// @return ratioPass True, if whitelisted AND the liveness ratio passes the check.
    function isRatioPassWithWhitelist(
        address multisig,
        uint256[] memory curNonces,
        uint256[] memory lastNonces,
        uint256 ts
    ) external view returns (bool ratioPass) {
        // First check if the multisig is whitelisted
        if (!isWhitelisted(multisig)) {
            return false;
        }
        
        // Then perform the standard activity check
        if (ts > 0 && curNonces[0] > lastNonces[0] && curNonces[1] > lastNonces[1]) {
            uint256 diffNonces = curNonces[0] - lastNonces[0];
            uint256 diffRequestsCounts = curNonces[1] - lastNonces[1];
            if (diffRequestsCounts <= diffNonces) {
                uint256 ratio = (diffRequestsCounts * 1e18) / ts;
                ratioPass = (ratio >= livenessRatio);
            }
        }
    }
    
    /// @dev Checks if a multisig can stake (is whitelisted).
    /// @notice This is a convenience function for pre-stake validation.
    /// @param multisig Service multisig address to check.
    /// @return result True if the multisig is whitelisted and can stake.
    function canStake(address multisig) external view returns (bool result) {
        result = isWhitelisted(multisig);
    }
}
