// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

error ZeroImplementationAddress();
error ZeroData();
error InitializationFailed();

/// @title JinnRouterProxy - UUPS proxy for the JinnRouter
contract JinnRouterProxy {
    // Code position in storage is keccak256("JINN_ROUTER_PROXY") = "0x7ff8b2d5fad2fe8fb4c75b11d9b640a3b52819959b6fe5f04434cf6cdafd7222"
    bytes32 public constant JINN_ROUTER_PROXY = 0x7ff8b2d5fad2fe8fb4c75b11d9b640a3b52819959b6fe5f04434cf6cdafd7222;

    /// @dev JinnRouterProxy constructor.
    /// @param implementation JinnRouter implementation address.
    /// @param initData Initialization data.
    constructor(address implementation, bytes memory initData) {
        // Check for the zero address, since the delegatecall works even with the zero one
        if (implementation == address(0)) {
            revert ZeroImplementationAddress();
        }

        // Check for the zero data
        if (initData.length == 0) {
            revert ZeroData();
        }

        // Store the implementation address
        assembly {
            sstore(JINN_ROUTER_PROXY, implementation)
        }
        // Initialize proxy storage
        (bool success, ) = implementation.delegatecall(initData);
        if (!success) {
            revert InitializationFailed();
        }
    }

    /// @dev Delegatecall to all the incoming data.
    fallback() external payable {
        assembly {
            let implementation := sload(JINN_ROUTER_PROXY)
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if eq(success, 0) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }

    /// @dev Gets the implementation address.
    /// @return implementation Implementation address.
    function getImplementation() external view returns (address implementation) {
        // solhint-disable-next-line avoid-low-level-calls
        assembly {
            implementation := sload(JINN_ROUTER_PROXY)
        }
    }
}
