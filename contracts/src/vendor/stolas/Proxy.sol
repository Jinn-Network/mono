// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Zero implementation address.
error ZeroImplementationAddress();

/// @dev Zero proxy data.
error ZeroProxyData();

/// @dev Proxy initialization failed.
error InitializationFailed();

/*
* This is a proxy contract.
* Proxy implementation is created based on the Slots (ERC-1967) and Universal Upgradeable Proxy Standard (UUPS) EIP-1822.
* The implementation address must be located in a unique storage slot of the proxy contract.
* The upgrade logic must be located in the implementation contract.
* Special lock implementation address slot is produced by hashing the "eip1967.proxy.implementation"
* string in order to make the slot unique.
* The fallback() implementation for all the delegatecall-s is inspired by the Gnosis Safe set of contracts.
*/

/// @title Proxy - Smart contract for proxy implementation
contract Proxy {
    // Code position in storage is bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1) = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
    bytes32 public constant PROXY_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @dev Proxy constructor.
    /// @param implementation Implementation address.
    /// @param proxyData Proxy initialization data.
    constructor(address implementation, bytes memory proxyData) {
        // Check for the zero address, since the delegatecall works even with the zero one
        if (implementation == address(0)) {
            revert ZeroImplementationAddress();
        }

        // Check for the zero data
        if (proxyData.length == 0) {
            revert ZeroProxyData();
        }

        // Store the lock implementation address
        assembly {
            sstore(PROXY_SLOT, implementation)
        }
        // Initialize proxy tokenomics storage
        (bool success,) = implementation.delegatecall(proxyData);
        if (!success) {
            revert InitializationFailed();
        }
    }

    /// @dev Delegatecall to all the incoming data.
    fallback() external payable {
        assembly {
            let implementation := sload(PROXY_SLOT)
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if eq(success, 0) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    /// @dev Gets the implementation address.
    /// @return implementation Implementation address.
    function getImplementation() external view returns (address implementation) {
        // solhint-disable-next-line avoid-low-level-calls
        assembly {
            implementation := sload(PROXY_SLOT)
        }
    }
}
