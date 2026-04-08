// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./VoteWeighting.sol";

/// @title VoteWeightingFast
/// @notice Fast-test timing variant of VoteWeighting for Phase 1a iteration.
contract VoteWeightingFast is VoteWeighting {
    constructor(address _ve) VoteWeighting(_ve) {}

    function _period() internal pure override returns (uint256) {
        return 900;
    }

    function _voteDelay() internal pure override returns (uint256) {
        return 900;
    }

    function _maxNumPeriods() internal pure override returns (uint256) {
        return 1000;
    }
}
