// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {MarketplaceRequestData} from "./MarketplaceRequestData.sol";

/// @dev Closed EIP-1271 authorization payload helpers (nested to stay under stack limits).
library RouterV4Auth {
    struct AuthSig {
        uint8 legKind;
        uint256 taskId;
        uint32 attemptIndex;
        uint32 verdictIndex;
        address mech;
        bytes requestData;
        uint256 rate;
        bytes32 paymentType;
        uint256 nonce;
    }

    error AuthDomainMismatch();

    function encode(
        uint8 legKind,
        uint256 taskId,
        uint32 attemptIndex,
        uint32 verdictIndex,
        address mech,
        bytes memory requestData,
        uint256 rate,
        bytes32 paymentType,
        uint256 nonce
    ) internal pure returns (bytes memory) {
        return abi.encode(
            MarketplaceRequestData.DOMAIN,
            MarketplaceRequestData.VERSION,
            abi.encode(legKind, taskId, attemptIndex, verdictIndex, mech, requestData, rate, paymentType, nonce)
        );
    }

    function decode(bytes memory signature) internal pure returns (AuthSig memory auth) {
        (bytes32 domain, uint8 version, bytes memory inner) = abi.decode(signature, (bytes32, uint8, bytes));
        if (domain != MarketplaceRequestData.DOMAIN || version != MarketplaceRequestData.VERSION) {
            revert AuthDomainMismatch();
        }
        (
            auth.legKind,
            auth.taskId,
            auth.attemptIndex,
            auth.verdictIndex,
            auth.mech,
            auth.requestData,
            auth.rate,
            auth.paymentType,
            auth.nonce
        ) = abi.decode(inner, (uint8, uint256, uint32, uint32, address, bytes, uint256, bytes32, uint256));
    }
}
