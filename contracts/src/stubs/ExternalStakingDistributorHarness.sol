// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ExternalStakingDistributor} from "../vendor/stolas/ExternalStakingDistributor.sol";

contract ExternalStakingDistributorHarness is ExternalStakingDistributor {
    constructor(
        address _olas,
        address _serviceManager,
        address _safeMultisigWithRecoveryModule,
        address _safeSameAddressMultisig,
        address _fallbackHandler,
        address _multiSend,
        address _collector
    )
        ExternalStakingDistributor(
            _olas,
            _serviceManager,
            _safeMultisigWithRecoveryModule,
            _safeSameAddressMultisig,
            _fallbackHandler,
            _multiSend,
            _collector
        )
    {}

    function setServiceCuratingAgent(uint256 serviceId, address curatingAgent) external {
        mapServiceIdCuratingAgents[serviceId] = curatingAgent;
    }
}

contract MockStolasServiceManager {
    address public immutable serviceRegistry;
    address public immutable serviceRegistryTokenUtility;

    constructor(address _serviceRegistry, address _serviceRegistryTokenUtility) {
        serviceRegistry = _serviceRegistry;
        serviceRegistryTokenUtility = _serviceRegistryTokenUtility;
    }
}

contract MockSafeMultisigWithRecoveryModule {
    address public immutable recoveryModule;

    constructor(address _recoveryModule) {
        recoveryModule = _recoveryModule;
    }
}

contract MockServiceRegistryNft {
    mapping(uint256 => address) public approvals;

    function approve(address spender, uint256 tokenId) external {
        approvals[tokenId] = spender;
    }
}

contract MockStolasStaking {
    enum StakingState {
        Unstaked,
        Staked,
        Evicted
    }

    StakingState public state = StakingState.Evicted;
    uint256 public unstakeCalls;
    uint256 public stakeCalls;
    uint256 public reward;
    uint256 public lastStakedServiceId;

    function setState(StakingState _state) external {
        state = _state;
    }

    function setReward(uint256 _reward) external {
        reward = _reward;
    }

    function getStakingState(uint256) external view returns (StakingState) {
        return state;
    }

    function unstake(uint256) external returns (uint256) {
        unstakeCalls++;
        state = StakingState.Unstaked;
        return reward;
    }

    function stake(uint256 serviceId) external {
        stakeCalls++;
        lastStakedServiceId = serviceId;
        state = StakingState.Staked;
    }
}
