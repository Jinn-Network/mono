// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

error ZeroImplementationAddress();
error ZeroData();
error InitializationFailed();

/// @title ActivityCheckerProxy - UUPS proxy for the activity checker
contract ActivityCheckerProxy {
    // Code position in storage is keccak256("ACTIVITY_CHECKER_PROXY") = "0x6b19506f33181dcd8bf12ba9eb8091ae9adf0d818d65c32001c0c109646101b8"
    bytes32 public constant ACTIVITY_CHECKER_PROXY = 0x6b19506f33181dcd8bf12ba9eb8091ae9adf0d818d65c32001c0c109646101b8;

    /// @dev ActivityCheckerProxy constructor.
    /// @param implementation Activity checker implementation address.
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
            sstore(ACTIVITY_CHECKER_PROXY, implementation)
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
            let implementation := sload(ACTIVITY_CHECKER_PROXY)
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
            implementation := sload(ACTIVITY_CHECKER_PROXY)
        }
    }
}
