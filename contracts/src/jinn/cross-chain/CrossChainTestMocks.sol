// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Test-only mocks for legacy V2 checker/router surfaces, plus the
///         Task-native checker snapshot used by `TaskClaimEmitter`.
///         Compiled into the Hardhat artifact set so the TypeScript
///         tests can deploy them via getContractFactory.

contract MockCheckerV2 {
    mapping(address => uint256) public verifiedCreations;
    mapping(address => uint256) public noveltyWeightedCounts;

    function setVerifiedCreations(address multisig, uint256 v) external {
        verifiedCreations[multisig] = v;
    }

    function setNoveltyWeightedCounts(address multisig, uint256 v) external {
        noveltyWeightedCounts[multisig] = v;
    }
}

contract MockRouterV2 {
    mapping(address => uint256) public evaluationDeliveryCount;

    function setEvaluationDeliveryCount(address multisig, uint256 v) external {
        evaluationDeliveryCount[multisig] = v;
    }
}

contract MockTaskActivityCheckerSnapshot {
    mapping(address => uint256) public taskCreationWeight;
    mapping(address => uint256) public solutionDeliveryWeight;
    mapping(address => uint256) public verdictDeliveryWeight;

    function setTaskCreationWeight(address multisig, uint256 v) external {
        taskCreationWeight[multisig] = v;
    }

    function setSolutionDeliveryWeight(address multisig, uint256 v) external {
        solutionDeliveryWeight[multisig] = v;
    }

    function setVerdictDeliveryWeight(address multisig, uint256 v) external {
        verdictDeliveryWeight[multisig] = v;
    }
}

contract MockServiceRegistryForEmitter {
    mapping(uint256 => address) public multisigs;

    function setMultisig(uint256 serviceId, address multisig) external {
        multisigs[serviceId] = multisig;
    }

    function mapServices(uint256 serviceId)
        external
        view
        returns (
            uint96 securityDeposit,
            address multisig,
            bytes32 configHash,
            uint32 threshold,
            uint32 maxNumAgentInstances,
            uint32 numAgentInstances,
            uint8 state
        )
    {
        return (0, multisigs[serviceId], bytes32(0), 0, 0, 0, 0);
    }
}
