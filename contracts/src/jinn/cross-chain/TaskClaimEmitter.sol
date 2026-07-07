// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ITaskActivityCheckerSnapshot {
    function taskCreationWeight(address multisig) external view returns (uint256);
    function solutionDeliveryWeight(address multisig) external view returns (uint256);
    function verdictDeliveryWeight(address multisig) external view returns (uint256);
}

interface ITaskClaimServiceRegistry {
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
        );
}

/// @title TaskClaimEmitter
/// @notice Snapshot emitter for Task-native activity weights on the measurement chain.
contract TaskClaimEmitter {
    ITaskActivityCheckerSnapshot public immutable checker;
    ITaskClaimServiceRegistry public immutable serviceRegistry;

    uint256 public nextClaimId;
    mapping(uint256 => bytes32) public claimSnapshotHashes;

    event ClaimTicket(
        uint256 indexed claimId,
        uint256 indexed serviceId,
        uint256 taskCreationWeight,
        uint256 solutionDeliveryWeight,
        uint256 verdictDeliveryWeight,
        address indexed multisig,
        address claimer
    );

    constructor(address _checker, address _registry) {
        require(_checker != address(0), "TaskClaimEmitter: checker=0");
        require(_registry != address(0), "TaskClaimEmitter: registry=0");
        checker = ITaskActivityCheckerSnapshot(_checker);
        serviceRegistry = ITaskClaimServiceRegistry(_registry);

        uint256 actualSlot;
        assembly {
            actualSlot := claimSnapshotHashes.slot
        }
        require(actualSlot == 1, "TaskClaimEmitter: snapshot slot drift");
    }

    function emitClaim(uint256 serviceId) external returns (uint256 claimId) {
        (, address multisig, , , , , ) = serviceRegistry.mapServices(serviceId);
        require(multisig != address(0), "TaskClaimEmitter: unknown service");

        claimId = nextClaimId + 1;
        nextClaimId = claimId;

        uint256 taskCreation = checker.taskCreationWeight(multisig);
        uint256 solutionDelivery = checker.solutionDeliveryWeight(multisig);
        uint256 verdictDelivery = checker.verdictDeliveryWeight(multisig);

        claimSnapshotHashes[claimId] = keccak256(
            abi.encode(
                claimId,
                serviceId,
                taskCreation,
                solutionDelivery,
                verdictDelivery,
                multisig
            )
        );

        emit ClaimTicket(
            claimId,
            serviceId,
            taskCreation,
            solutionDelivery,
            verdictDelivery,
            multisig,
            msg.sender
        );
    }
}
