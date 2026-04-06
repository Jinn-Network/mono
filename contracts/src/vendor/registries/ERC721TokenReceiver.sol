// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Sourced from: https://github.com/transmissions11/solmate/blob/main/src/tokens/ERC721.sol
// Only ERC721TokenReceiver is needed by StakingBase.

/// @notice A generic interface for a contract which properly accepts ERC721 tokens.
/// @author Solmate (https://github.com/Rari-Capital/solmate/blob/main/src/tokens/ERC721.sol)
abstract contract ERC721TokenReceiver {
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external virtual returns (bytes4) {
        return ERC721TokenReceiver.onERC721Received.selector;
    }
}
