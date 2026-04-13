// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Zero address.
error ZeroAddress();

/// @dev Only `owner` has a privilege, but the `sender` was provided.
/// @param sender Sender address.
/// @param owner Required sender address as an owner.
error OwnerOnly(address sender, address owner);

/// @title Beacon - Smart contract for implementation beacon
contract Beacon {
    event OwnerUpdated(address indexed owner);
    event ImplementationUpdated(address indexed implementation);

    address public implementation;
    address public owner;

    /// @dev Beacon constructor.
    /// @param _implementation Implementation address.
    constructor(address _implementation) {
        if (_implementation == address(0)) {
            revert ZeroAddress();
        }

        implementation = _implementation;
        owner = msg.sender;
    }

    /// @dev Changes contract owner address.
    /// @param newOwner Address of a new owner.
    function changeOwner(address newOwner) external {
        // Check for the ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for the zero address
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }

        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    function changeImplementation(address newImplementation) external {
        // Check for ownership
        if (msg.sender != owner) {
            revert OwnerOnly(msg.sender, owner);
        }

        // Check for zero address
        if (newImplementation == address(0)) {
            revert ZeroAddress();
        }

        implementation = newImplementation;
        emit ImplementationUpdated(newImplementation);
    }
}
