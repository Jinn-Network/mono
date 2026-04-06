// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @dev Mock MechMarketplace for testing JinnRouter.
///      Allows setting request statuses and returns predictable request IDs.
contract MockMechMarketplace {
    enum RequestStatus {
        DoesNotExist,
        RequestedPriority,
        RequestedExpired,
        Delivered
    }

    uint256 public requestNonce;
    mapping(bytes32 => RequestStatus) public requestStatuses;

    event MockRequest(bytes32 indexed requestId, address indexed requester, address priorityMech);

    /// @dev Mock request — increments nonce, returns deterministic requestId.
    function request(
        bytes memory,
        uint256,
        bytes32,
        address priorityMech,
        uint256,
        bytes calldata
    ) external payable returns (bytes32 requestId) {
        requestId = keccak256(abi.encodePacked(msg.sender, requestNonce));
        requestNonce++;
        requestStatuses[requestId] = RequestStatus.RequestedPriority;
        emit MockRequest(requestId, msg.sender, priorityMech);
    }

    /// @dev Returns the configured status for a request.
    function getRequestStatus(bytes32 requestId) external view returns (RequestStatus) {
        return requestStatuses[requestId];
    }

    /// @dev Test helper — set a request's status to Delivered.
    function setDelivered(bytes32 requestId) external {
        requestStatuses[requestId] = RequestStatus.Delivered;
    }

    /// @dev Test helper — set a request's status to any value.
    function setStatus(bytes32 requestId, RequestStatus status) external {
        requestStatuses[requestId] = status;
    }
}
