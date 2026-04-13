// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Only `owner` has a privilege, but the `sender` was provided.
/// @param sender Sender address.
/// @param owner Required sender address as an owner.
error OwnerOnly(address sender, address owner);

/// @dev Zero address.
error ZeroAddress();

/// @title Implementation - Smart contract for default minimal implementation
contract Implementation {
    event OwnerUpdated(address indexed owner);
    event ImplementationUpdated(address indexed implementation);

    // Code position in storage is bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1) = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
    bytes32 public constant PROXY_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    // Contract owner address
    address public owner;

    /// @dev Changes contract owner address.
    /// @param newOwner Address of a new owner.
    function changeOwner(address newOwner) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for zero address
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }

        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    /// @dev Changes depository implementation contract address.
    /// @param newImplementation New implementation contract address.
    function changeImplementation(address newImplementation) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for zero address
        if (newImplementation == address(0)) {
            revert ZeroAddress();
        }

        // Store depository implementation address
        assembly {
            sstore(PROXY_SLOT, newImplementation)
        }

        emit ImplementationUpdated(newImplementation);
    }
}
