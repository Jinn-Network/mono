// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockTaskMech {
    uint256 public maxDeliveryRate;
    bytes32 public paymentType;
    address public operator;

    constructor(uint256 _maxDeliveryRate, bytes32 _paymentType, address _operator) {
        maxDeliveryRate = _maxDeliveryRate;
        paymentType = _paymentType;
        operator = _operator;
    }

    function isOperator(address multisig) external view returns (bool) {
        return multisig == operator;
    }
}

contract MockTaskMechWithDelivery {
    uint256 public maxDeliveryRate;
    bytes32 public paymentType;
    address public operator;
    MockTaskMarketplace public marketplace;

    event Deliver(
        address indexed mech,
        address indexed mechServiceMultisig,
        bytes32 requestId,
        uint256 deliveryRate,
        bytes data
    );

    constructor(
        uint256 _maxDeliveryRate,
        bytes32 _paymentType,
        address _operator,
        address _marketplace
    ) {
        maxDeliveryRate = _maxDeliveryRate;
        paymentType = _paymentType;
        operator = _operator;
        marketplace = MockTaskMarketplace(_marketplace);
    }

    function isOperator(address multisig) external view returns (bool) {
        return multisig == operator;
    }

    function getOperator() external view returns (address) {
        return operator;
    }

    function deliverToMarketplace(bytes32[] calldata requestIds, bytes[] calldata datas)
        external
        returns (bool[] memory deliveredRequests)
    {
        require(msg.sender == operator, "operator only");
        require(requestIds.length == datas.length, "length mismatch");

        deliveredRequests = new bool[](requestIds.length);
        for (uint256 i = 0; i < requestIds.length; i++) {
            marketplace.markDelivered(requestIds[i], address(this));
            emit Deliver(address(this), operator, requestIds[i], maxDeliveryRate, datas[i]);
            deliveredRequests[i] = true;
        }
    }
}

contract MockTaskMarketplace {
    enum RequestStatus {
        DoesNotExist,
        RequestedPriority,
        RequestedExpired,
        Delivered,
        Revoked
    }

    struct RequestInfo {
        address priorityMech;
        address deliveryMech;
        address requester;
        uint256 responseTimeout;
        uint256 deliveryRate;
        bytes32 paymentType;
    }

    uint256 public nonce;
    uint256 public minResponseTimeout = 1;
    uint256 public maxResponseTimeout = 3600;
    mapping(bytes32 => RequestInfo) private _infos;
    mapping(bytes32 => RequestStatus) public statuses;

    function request(
        bytes calldata requestData,
        uint256,
        bytes32 paymentType,
        address priorityMech,
        uint256 responseTimeout,
        bytes calldata
    ) external payable returns (bytes32 requestId) {
        nonce++;
        requestId = keccak256(abi.encode(priorityMech, msg.sender, requestData, nonce));
        _infos[requestId] = RequestInfo({
            priorityMech: priorityMech,
            deliveryMech: address(0),
            requester: msg.sender,
            responseTimeout: responseTimeout,
            deliveryRate: msg.value,
            paymentType: paymentType
        });
        statuses[requestId] = RequestStatus.RequestedPriority;
    }

    function markDelivered(bytes32 requestId, address deliveryMech) external {
        _infos[requestId].deliveryMech = deliveryMech;
        statuses[requestId] = RequestStatus.Delivered;
    }

    function mapRequestIdInfos(bytes32 requestId) external view returns (
        address priorityMech,
        address deliveryMech,
        address requester,
        uint256 responseTimeout,
        uint256 deliveryRate,
        bytes32 paymentType
    ) {
        RequestInfo memory info = _infos[requestId];
        return (
            info.priorityMech,
            info.deliveryMech,
            info.requester,
            info.responseTimeout,
            info.deliveryRate,
            info.paymentType
        );
    }

    function getRequestStatus(bytes32 requestId) external view returns (RequestStatus) {
        return statuses[requestId];
    }
}

contract MockTaskActivityChecker {
    mapping(address => bytes32) public lastSolutionDigest;
    mapping(address => bytes32) public lastVerdictDigest;
    mapping(address => uint256) public solutionDeliveryWeight;
    mapping(address => uint256) public verdictDeliveryWeight;
    mapping(address => uint256) public taskCreationWeight;
    mapping(uint256 => bool) public taskCreationFinalized;

    function recordSolutionDelivery(address operator, bytes32 solutionDigest) external returns (uint256 weight) {
        weight = 1e18;
        lastSolutionDigest[operator] = solutionDigest;
        solutionDeliveryWeight[operator] += weight;
    }

    function recordVerdictDelivery(address evaluator, bytes32 verdictDigest) external returns (uint256 weight) {
        weight = 1e18;
        lastVerdictDigest[evaluator] = verdictDigest;
        verdictDeliveryWeight[evaluator] += weight;
    }

    function recordTaskCreationFinalized(address creator, uint256 taskId, uint256 weight) external {
        require(!taskCreationFinalized[taskId], "already finalized");
        taskCreationFinalized[taskId] = true;
        taskCreationWeight[creator] += weight;
    }
}
