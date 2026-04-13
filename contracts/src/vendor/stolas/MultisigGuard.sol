// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Implementation, ZeroAddress} from "./Implementation.sol";

// External staking distributor interface
interface IExternalStakingDistributor {
    /// @dev Gets service Id by multisig address.
    function mapMultisigServiceIds(address multisig) external view returns (uint256);
}

// Generic Safe interface
interface ISafe {
    enum Operation {
        Call,
        DelegateCall
    }

    /// @dev Allows a Module to execute a Safe transaction without any further confirmations.
    /// @param to Destination address of module transaction.
    /// @param value Ether value of module transaction.
    /// @param data Data payload of module transaction.
    /// @param operation Operation type of module transaction.
    function execTransactionFromModule(address to, uint256 value, bytes memory data, Operation operation)
        external
        returns (bool success);

    /// @dev Returns true if module is enabled.
    function isModuleEnabled(address module) external view returns (bool);
}

// Service interface
interface IService {
    struct TokenSecurityDeposit {
        // Token address
        address token;
        // Bond per agent instance
        uint96 securityDeposit;
    }

    /// @dev Gets token security deposit struct.
    /// @param serviceId Service Id.
    function mapServiceIdTokenDeposit(uint256 serviceId) external view returns (TokenSecurityDeposit memory);

    /// @dev Gets agent instance bonding balance.
    /// @param operatorServiceId Combined value of (serviceId | operator address).
    function mapOperatorAndServiceIdOperatorBalances(uint256 operatorServiceId) external view returns (uint256);
}

/// @dev Zero value.
error ZeroValue();

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Multisig call has failed.
/// @param multisig Multisig address.
/// @param payload Data payload.
error CallFailed(address multisig, bytes payload);

/// @dev Unauthorized guard.
/// @param guard Guard address.
error UnauthorizedGuard(address guard);

/// @dev Module is disabled.
/// @param module Module address.
error ModuleDisabled(address module);

/// @dev Operator balance was slashed.
/// @param serviceId Service Id.
/// @param provided Current operator balance.
/// @param expected Expected operator balance.
error OperatorBalanceSlashed(uint256 serviceId, uint256 provided, uint256 expected);

/// @dev Caught reentrancy violation.
error ReentrancyGuard();

/// @title MultisigGuard - Smart contract for multisig guard
contract MultisigGuard is Implementation {
    // keccak256("guard_manager.guard.address")
    bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    // Service registry token utility address
    address public immutable serviceRegistryTokenUtility;
    // External staking distributor address
    address public immutable externalStakingDistributor;

    // Reentrancy lock
    uint256 internal _locked = 1;

    /// @dev MultisigGuard constructor.
    /// @param _serviceRegistryTokenUtility Service registry token utility address.
    /// @param _externalStakingDistributor External staking distributor address.
    constructor(address _serviceRegistryTokenUtility, address _externalStakingDistributor) {
        // Check for zero addresses
        if (_serviceRegistryTokenUtility == address(0) || _externalStakingDistributor == address(0)) {
            revert ZeroAddress();
        }

        serviceRegistryTokenUtility = _serviceRegistryTokenUtility;
        externalStakingDistributor = _externalStakingDistributor;
    }

    /// @dev Initializes multisig guard.
    function initialize() external {
        if (owner != address(0)) {
            revert AlreadyInitialized();
        }

        owner = msg.sender;
    }

    function checkTransaction(
        address,
        uint256,
        bytes memory,
        ISafe.Operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes memory,
        address
    ) external {}

    /// @dev Checks state after multisig execution.
    /// @param success True if multisig transaction has been executed.
    function checkAfterExecution(bytes32, bool success) external {
        // Reentrancy guard
        if (_locked > 1) {
            revert ReentrancyGuard();
        }
        _locked = 2;

        if (!success) return;

        // Check guard slot
        // Get guard payload
        bytes memory payload = abi.encodeCall(this.checkGuard, (address(this)));

        // Get implementation address
        address implementation;
        // solhint-disable-next-line avoid-low-level-calls
        assembly {
            implementation := sload(PROXY_SLOT)
        }

        // Execute multisig call
        // Need to delegatecall implementation directly, as delegatecall to address(this) would result in zero address,
        // since it will be storage of multisig at the time of delegatecall
        success = ISafe(msg.sender).execTransactionFromModule(implementation, 0, payload, ISafe.Operation.DelegateCall);

        // Check for success
        if (!success) {
            revert CallFailed(msg.sender, payload);
        }

        // Check modules
        success = ISafe(msg.sender).isModuleEnabled(externalStakingDistributor);
        if (!success) {
            revert ModuleDisabled(externalStakingDistributor);
        }

        success = ISafe(msg.sender).isModuleEnabled(address(this));
        if (!success) {
            revert ModuleDisabled(address(this));
        }

        // Check operator balance
        // Get service Id
        uint256 serviceId = IExternalStakingDistributor(externalStakingDistributor).mapMultisigServiceIds(msg.sender);
        // Check for zero value
        if (serviceId == 0) {
            revert ZeroValue();
        }

        // Get token security deposit struct
        IService.TokenSecurityDeposit memory tokenSecurityDeposit =
            IService(serviceRegistryTokenUtility).mapServiceIdTokenDeposit(serviceId);

        // Push a pair of key defining variables into one key. Service Id or operator are not enough by themselves
        // operator occupies first 160 bits
        uint256 operatorServiceId = uint256(uint160(externalStakingDistributor));
        // serviceId occupies next 32 bits
        operatorServiceId |= serviceId << 160;

        // Get operator balance
        uint256 operatorBalance =
            IService(serviceRegistryTokenUtility).mapOperatorAndServiceIdOperatorBalances(operatorServiceId);

        // Check for operator balance value, which must be equal to security deposit due to current staking models
        if (operatorBalance != tokenSecurityDeposit.securityDeposit) {
            revert OperatorBalanceSlashed(serviceId, operatorBalance, tokenSecurityDeposit.securityDeposit);
        }

        _locked = 1;
    }

    /// @dev Checks multisig guard via delegatecall.
    /// @param guard Required guard address.
    function checkGuard(address guard) external view {
        // Get guard address from slot
        address slotGuard;

        // solhint-disable-next-line no-inline-assembly
        assembly {
            slotGuard := sload(GUARD_STORAGE_SLOT)
        }

        // Compare guard addresses
        if (slotGuard != guard) {
            revert UnauthorizedGuard(slotGuard);
        }
    }
}
