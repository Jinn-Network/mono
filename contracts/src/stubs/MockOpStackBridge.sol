// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title MockFaultDisputeGame
/// @notice Configurable stand-in for OP-Stack dispute games. Tests
///         set the four immutable getters used by
///         `CanonicalOpStackMessenger`. All other Bedrock surface is
///         out-of-scope.
contract MockFaultDisputeGame {
    uint8 public statusValue;
    uint32 public gameTypeValue;
    uint64 public resolvedAtValue;
    bytes32 public rootClaimValue;
    bool public wasRespectedGameTypeWhenCreatedValue = true;

    function status() external view returns (uint8) { return statusValue; }
    function gameType() external view returns (uint32) { return gameTypeValue; }
    function resolvedAt() external view returns (uint64) { return resolvedAtValue; }
    function rootClaim() external view returns (bytes32) { return rootClaimValue; }
    function wasRespectedGameTypeWhenCreated() external view returns (bool) {
        return wasRespectedGameTypeWhenCreatedValue;
    }

    function configure(
        uint8 _status,
        uint32 _gameType,
        uint64 _resolvedAt,
        bytes32 _rootClaim
    ) external {
        statusValue = _status;
        gameTypeValue = _gameType;
        resolvedAtValue = _resolvedAt;
        rootClaimValue = _rootClaim;
    }

    function setWasRespectedGameTypeWhenCreated(bool value) external {
        wasRespectedGameTypeWhenCreatedValue = value;
    }
}

/// @title MockDisputeGameFactory
/// @notice Configurable `DisputeGameFactory` mock. Tests register
///         `MockFaultDisputeGame` proxies at controlled indices.
contract MockDisputeGameFactory {
    struct Entry {
        uint32 gameType;
        uint64 timestamp;
        address proxy;
        bool present;
    }
    mapping(uint256 => Entry) private _games;

    function setGame(uint256 index, uint32 _gameType, uint64 _timestamp, address proxy) external {
        _games[index] = Entry(_gameType, _timestamp, proxy, true);
    }

    function clearGame(uint256 index) external {
        delete _games[index];
    }

    function gameAtIndex(uint256 _index)
        external
        view
        returns (uint32 gameType_, uint64 timestamp_, address proxy_)
    {
        Entry memory e = _games[_index];
        // Return zero-proxy when unset; the messenger treats this as
        // InvalidDisputeGame.
        return (e.gameType, e.timestamp, e.proxy);
    }
}

/// @title MockOptimismPortal2
/// @notice Configurable `OptimismPortal2` mock — only the airgap delay
///         is consulted by the messenger.
contract MockOptimismPortal2 {
    uint256 public delay;
    uint256 public gameFinalityDelay;
    uint32 public respectedGameTypeValue;

    function setDelay(uint256 _delay) external { delay = _delay; }
    function setGameFinalityDelay(uint256 _delay) external { gameFinalityDelay = _delay; }
    function setRespectedGameType(uint32 _gameType) external { respectedGameTypeValue = _gameType; }
    function proofMaturityDelaySeconds() external view returns (uint256) { return delay; }
    function disputeGameFinalityDelaySeconds() external view returns (uint256) {
        return gameFinalityDelay;
    }
    function respectedGameType() external view returns (uint32) { return respectedGameTypeValue; }
}
