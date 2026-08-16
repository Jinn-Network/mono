// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title MockV3Aggregator
/// @notice Minimal Chainlink AggregatorV3Interface implementation for e2e testing.
/// @dev Used by operator/scripts/e2e-prediction-v0.ts to produce deterministic
///      oracle rounds on an Anvil fork. Owner-pushed rounds let tests drive
///      the round-spanning-resolveTs logic in prediction-v0-evaluator.
contract MockV3Aggregator {
    uint8 public immutable decimals;
    int256 public latestAnswer;
    uint256 public latestTimestamp;
    uint80 public latestRound;
    mapping(uint80 => int256) public getAnswer;
    mapping(uint80 => uint256) public getTimestamp;

    string public constant description = "MOCK / USD";
    uint256 public constant version = 0;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        updateAnswer(_initialAnswer);
    }

    /// @notice Push a new round using the current block.timestamp.
    function updateAnswer(int256 _answer) public {
        latestAnswer = _answer;
        latestTimestamp = block.timestamp;
        latestRound++;
        getAnswer[latestRound] = _answer;
        getTimestamp[latestRound] = block.timestamp;
    }

    /// @notice Push a round with an explicit roundId + updatedAt — used to
    ///         simulate a specific Chainlink round spanning a given resolveTs.
    /// @dev _roundId must be strictly greater than latestRound.
    function pushRound(uint80 _roundId, int256 _answer, uint256 _updatedAt) external {
        require(_roundId > latestRound, "round must be strictly increasing");
        latestRound = _roundId;
        latestAnswer = _answer;
        latestTimestamp = _updatedAt;
        getAnswer[_roundId] = _answer;
        getTimestamp[_roundId] = _updatedAt;
    }

    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return (latestRound, latestAnswer, latestTimestamp, latestTimestamp, latestRound);
    }

    function getRoundData(uint80 _roundId) external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return (_roundId, getAnswer[_roundId], getTimestamp[_roundId], getTimestamp[_roundId], _roundId);
    }
}
