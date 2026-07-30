// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SafeTransferLib} from "../vendor/registries/SafeTransferLib.sol";

interface ISignatureValidator {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
}

interface ITokenMech {
    function paymentType() external view returns (bytes32);
    function isOperator(address multisig) external view returns (bool);
    function maxDeliveryRate() external view returns (uint256);
}

/// @title MockTokenBalanceTracker
/// @notice Local FixedPriceToken-shaped tracker: pulls ERC20 from requester on signed delivery.
contract MockTokenBalanceTracker {
    address public immutable mechMarketplace;
    address public immutable token;

    mapping(address => uint256) public mapRequesterBalances;
    mapping(address => uint256) public mapMechBalances;

    error TrackerMarketplaceOnly(address sender, address marketplace);
    error TrackerZeroValue();

    constructor(address _mechMarketplace, address _token) {
        mechMarketplace = _mechMarketplace;
        token = _token;
    }

    function adjustMechRequesterBalances(
        address mech,
        address requester,
        uint256[] calldata mechDeliveryRates,
        bytes calldata
    ) external {
        if (msg.sender != mechMarketplace) revert TrackerMarketplaceOnly(msg.sender, mechMarketplace);
        uint256 total;
        for (uint256 i = 0; i < mechDeliveryRates.length; i++) {
            total += mechDeliveryRates[i];
        }
        if (total == 0) revert TrackerZeroValue();
        SafeTransferLib.safeTransferFrom(token, requester, address(this), total);
        mapMechBalances[mech] += total;
        // Keep requester balance book at zero for signed-delivery pulls (no pre-deposit required).
        mapRequesterBalances[requester] = 0;
    }
}

/// @title MockTokenMarketplace
/// @notice Minimal Marketplace surface for deliverMarketplaceWithSignatures + getRequestId + EIP-1271.
contract MockTokenMarketplace {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;

    enum RequestStatus {
        DoesNotExist,
        RequestedPriority,
        RequestedExpired,
        Delivered
    }

    struct DeliverWithSignature {
        bytes requestData;
        bytes signature;
        bytes deliveryData;
    }

    struct RequestInfo {
        address priorityMech;
        address deliveryMech;
        address requester;
        uint256 responseTimeout;
        uint256 deliveryRate;
        bytes32 paymentType;
    }

    bytes32 public immutable domainSeparator;
    mapping(address => uint256) public mapNonces;
    mapping(bytes32 => RequestInfo) private _infos;
    mapping(bytes32 => RequestStatus) public statuses;
    mapping(bytes32 => address) public mapPaymentTypeBalanceTrackers;
    mapping(address => address) public mapAgentMechFactories;

    event Deliver(
        address indexed mech,
        address indexed mechServiceMultisig,
        bytes32 requestId,
        uint256 deliveryRate,
        bytes requestData,
        bytes deliveryData
    );

    error ZeroValue();
    error ZeroAddress();
    error AlreadyRequested(bytes32 requestId);
    error SignatureNotValidated(address requester, bytes32 requestHash, bytes signature);
    error WrongArrayLength(uint256 a, uint256 b);
    error UnauthorizedAccount(address account);
    error ReentrancyGuard();

    uint256 private _locked = 1;

    constructor() {
        domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MechMarketplace"),
                keccak256("1.1.0"),
                block.chainid,
                address(this)
            )
        );
    }

    function setPaymentTypeBalanceTracker(bytes32 paymentType, address tracker) external {
        mapPaymentTypeBalanceTrackers[paymentType] = tracker;
    }

    function registerMech(address mech, address factory) external {
        mapAgentMechFactories[mech] = factory;
    }

    function getDomainSeparator() public view returns (bytes32) {
        return domainSeparator;
    }

    function getRequestId(
        address mech,
        address requester,
        bytes memory data,
        uint256 deliveryRate,
        bytes32 paymentType,
        uint256 nonce
    ) public view returns (bytes32 requestId) {
        requestId = keccak256(
            abi.encodePacked(
                "\x19\x01",
                getDomainSeparator(),
                keccak256(
                    abi.encode(address(this), mech, requester, keccak256(data), deliveryRate, paymentType, nonce)
                )
            )
        );
    }

    function deliverMarketplaceWithSignatures(
        address requester,
        DeliverWithSignature[] calldata deliverWithSignatures,
        uint256[] calldata deliveryRates,
        bytes calldata paymentData
    ) external {
        if (_locked == 2) revert ReentrancyGuard();
        _locked = 2;

        if (deliverWithSignatures.length == 0 || deliverWithSignatures.length != deliveryRates.length) {
            revert WrongArrayLength(deliverWithSignatures.length, deliveryRates.length);
        }
        if (mapAgentMechFactories[msg.sender] == address(0)) revert UnauthorizedAccount(msg.sender);

        bytes32 paymentType = ITokenMech(msg.sender).paymentType();
        address balanceTracker = mapPaymentTypeBalanceTrackers[paymentType];
        if (balanceTracker == address(0)) revert ZeroAddress();

        address mechServiceMultisig = msg.sender; // tests set operator separately; Deliver uses operator from mech
        // Prefer mech operator if available
        // solhint-disable-next-line no-empty-blocks
        try ITokenMech(msg.sender).isOperator(tx.origin) returns (bool) {} catch {}

        uint256 nonce = mapNonces[requester];
        bytes32[] memory requestIds = new bytes32[](deliverWithSignatures.length);

        for (uint256 i = 0; i < deliverWithSignatures.length; i++) {
            if (deliverWithSignatures[i].requestData.length == 0) revert ZeroValue();
            requestIds[i] = getRequestId(
                msg.sender, requester, deliverWithSignatures[i].requestData, deliveryRates[i], paymentType, nonce
            );

            if (requester.code.length > 0) {
                if (ISignatureValidator(requester).isValidSignature(requestIds[i], deliverWithSignatures[i].signature)
                    != MAGIC_VALUE
                ) {
                    revert SignatureNotValidated(requester, requestIds[i], deliverWithSignatures[i].signature);
                }
            }

            if (_infos[requestIds[i]].priorityMech != address(0)) revert AlreadyRequested(requestIds[i]);

            _infos[requestIds[i]] = RequestInfo({
                priorityMech: msg.sender,
                deliveryMech: msg.sender,
                requester: requester,
                responseTimeout: 0,
                deliveryRate: deliveryRates[i],
                paymentType: paymentType
            });
            statuses[requestIds[i]] = RequestStatus.Delivered;
            nonce++;

            emit Deliver(
                msg.sender,
                ITokenMechOperator(msg.sender).getOperator(),
                requestIds[i],
                deliveryRates[i],
                deliverWithSignatures[i].requestData,
                deliverWithSignatures[i].deliveryData
            );
        }

        mapNonces[requester] = nonce;
        MockTokenBalanceTracker(balanceTracker).adjustMechRequesterBalances(
            msg.sender, requester, deliveryRates, paymentData
        );

        _locked = 1;
    }

    function mapRequestIdInfos(bytes32 requestId)
        external
        view
        returns (
            address priorityMech,
            address deliveryMech,
            address requester,
            uint256 responseTimeout,
            uint256 deliveryRate,
            bytes32 paymentType
        )
    {
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

interface ITokenMechOperator {
    function getOperator() external view returns (address);
}

/// @title MockTokenMech
/// @notice FixedPriceToken-shaped mech for local signed-delivery tests.
contract MockTokenMech {
    uint256 public maxDeliveryRate;
    bytes32 public paymentType;
    address public operator;
    MockTokenMarketplace public marketplace;

    error OperatorOnly();

    constructor(uint256 _maxDeliveryRate, bytes32 _paymentType, address _operator, address _marketplace) {
        maxDeliveryRate = _maxDeliveryRate;
        paymentType = _paymentType;
        operator = _operator;
        marketplace = MockTokenMarketplace(_marketplace);
    }

    function isOperator(address multisig) external view returns (bool) {
        return multisig == operator;
    }

    function getOperator() external view returns (address) {
        return operator;
    }

    function deliverMarketplaceWithSignatures(
        address requester,
        MockTokenMarketplace.DeliverWithSignature[] calldata deliverWithSignatures,
        uint256[] calldata deliveryRates,
        bytes calldata paymentData
    ) external {
        if (msg.sender != operator) revert OperatorOnly();
        marketplace.deliverMarketplaceWithSignatures(requester, deliverWithSignatures, deliveryRates, paymentData);
    }
}

/// @title AtomicSettlementBatch
/// @notice Test helper proving prepare → Mech deliver → router claim succeed or revert together.
contract AtomicSettlementBatch {
    error BatchCallFailed(uint256 index, bytes revertData);

    function execute(address firstTarget, bytes calldata firstData, address secondTarget, bytes calldata secondData)
        external
    {
        (bool ok1, bytes memory ret1) = firstTarget.call(firstData);
        if (!ok1) revert BatchCallFailed(0, ret1);
        (bool ok2, bytes memory ret2) = secondTarget.call(secondData);
        if (!ok2) revert BatchCallFailed(1, ret2);
    }

    function execute3(
        address t0,
        bytes calldata d0,
        address t1,
        bytes calldata d1,
        address t2,
        bytes calldata d2
    ) external {
        (bool ok0, bytes memory r0) = t0.call(d0);
        if (!ok0) revert BatchCallFailed(0, r0);
        (bool ok1, bytes memory r1) = t1.call(d1);
        if (!ok1) revert BatchCallFailed(1, r1);
        (bool ok2, bytes memory r2) = t2.call(d2);
        if (!ok2) revert BatchCallFailed(2, r2);
    }
}
