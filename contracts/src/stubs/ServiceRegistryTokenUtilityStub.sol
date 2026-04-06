// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title ServiceRegistryTokenUtilityStub - Minimal stub for StakingToken tests.
 * @notice StakingToken._checkTokenStakingDeposit() calls mapServiceIdTokenDeposit()
 *         and getAgentBond(). This stub lets tests configure those return values.
 */
contract ServiceRegistryTokenUtilityStub {
    struct TokenDeposit {
        address token;
        uint96 deposit;
    }

    // serviceId => token deposit info
    mapping(uint256 => TokenDeposit) public deposits;
    // serviceId => agentId => bond
    mapping(uint256 => mapping(uint256 => uint256)) public bonds;

    /// @dev Set the token deposit for a service.
    function setServiceTokenDeposit(uint256 serviceId, address token, uint96 deposit) external {
        deposits[serviceId] = TokenDeposit(token, deposit);
    }

    /// @dev Set the agent bond for a service.
    function setAgentBond(uint256 serviceId, uint256 agentId, uint256 bond) external {
        bonds[serviceId][agentId] = bond;
    }

    /// @dev Required by IServiceTokenUtility.
    function mapServiceIdTokenDeposit(uint256 serviceId) external view returns (address, uint96) {
        TokenDeposit memory td = deposits[serviceId];
        return (td.token, td.deposit);
    }

    /// @dev Required by IServiceTokenUtility.
    function getAgentBond(uint256 serviceId, uint256 agentId) external view returns (uint256) {
        return bonds[serviceId][agentId];
    }
}
