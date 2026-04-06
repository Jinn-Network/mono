// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title IWhitelistManager - Interface for managing whitelisted addresses
/// @author JIN Network
/// @notice Interface for contracts that manage a whitelist of authorized addresses
interface IWhitelistManager {
    /// @dev Emitted when an address is added to the whitelist
    /// @param account The address that was added
    event AddressWhitelisted(address indexed account);

    /// @dev Emitted when an address is removed from the whitelist
    /// @param account The address that was removed
    event AddressRemovedFromWhitelist(address indexed account);

    /// @dev Emitted when ownership is transferred
    /// @param previousOwner The previous owner address
    /// @param newOwner The new owner address
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @dev Checks if an address is whitelisted
    /// @param account The address to check
    /// @return True if the address is whitelisted
    function isWhitelisted(address account) external view returns (bool);

    /// @dev Adds an address to the whitelist
    /// @param account The address to add
    function addToWhitelist(address account) external;

    /// @dev Removes an address from the whitelist
    /// @param account The address to remove
    function removeFromWhitelist(address account) external;

    /// @dev Returns the current owner
    /// @return The owner address
    function owner() external view returns (address);

    /// @dev Transfers ownership to a new address
    /// @param newOwner The new owner address
    function transferOwnership(address newOwner) external;
}
