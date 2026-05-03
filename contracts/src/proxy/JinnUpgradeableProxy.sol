// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

error ProxyZeroAddress();
error ProxyZeroData();
error ProxyOwnerOnly(address sender, address owner);
error ProxyInitializationFailed();
error ProxyUpgradeFailed();

/// @title JinnUpgradeableProxy
/// @notice Minimal owner-controlled proxy for testnet protocol components.
/// @dev Uses ERC-1967 implementation/admin slots to avoid implementation storage collisions.
contract JinnUpgradeableProxy {
    bytes32 private constant IMPLEMENTATION_SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 private constant ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);

    event Upgraded(address indexed implementation);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);

    constructor(address implementation, address admin, bytes memory initData) payable {
        if (implementation == address(0) || admin == address(0)) revert ProxyZeroAddress();
        if (initData.length == 0) revert ProxyZeroData();

        _setImplementation(implementation);
        _setAdmin(admin);

        (bool success,) = implementation.delegatecall(initData);
        if (!success) revert ProxyInitializationFailed();

        emit AdminChanged(address(0), admin);
        emit Upgraded(implementation);
    }

    function getImplementation() external view returns (address implementation) {
        implementation = _implementation();
    }

    function getAdmin() external view returns (address admin) {
        admin = _admin();
    }

    function upgradeTo(address newImplementation) external {
        address admin = _admin();
        if (msg.sender != admin) revert ProxyOwnerOnly(msg.sender, admin);
        if (newImplementation == address(0)) revert ProxyZeroAddress();
        _setImplementation(newImplementation);
        emit Upgraded(newImplementation);
    }

    function changeAdmin(address newAdmin) external {
        address admin = _admin();
        if (msg.sender != admin) revert ProxyOwnerOnly(msg.sender, admin);
        if (newAdmin == address(0)) revert ProxyZeroAddress();
        _setAdmin(newAdmin);
        emit AdminChanged(admin, newAdmin);
    }

    function _implementation() internal view returns (address implementation) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            implementation := sload(slot)
        }
    }

    function _admin() internal view returns (address admin) {
        bytes32 slot = ADMIN_SLOT;
        assembly {
            admin := sload(slot)
        }
    }

    function _setImplementation(address implementation) internal {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, implementation)
        }
    }

    function _setAdmin(address admin) internal {
        bytes32 slot = ADMIN_SLOT;
        assembly {
            sstore(slot, admin)
        }
    }

    fallback() external payable {
        _delegate();
    }

    receive() external payable {
        _delegate();
    }

    function _delegate() internal {
        address implementation = _implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
