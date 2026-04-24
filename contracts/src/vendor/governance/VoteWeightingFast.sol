// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "./VoteWeighting.sol";

/// @title VoteWeightingFast
/// @notice Fast-test timing variant of VoteWeighting for Phase 1a iteration.
/// @dev _maxNumPeriods was raised from 1000 → 10_000 to widen the quiet-tolerance
///      window from 10.4 days to ~104 days. With _period=900s the internal
///      _getSum() walk can only advance timeSum if the walker reaches
///      block.timestamp within _maxNumPeriods iterations; any longer gap leaves
///      timeSum permanently behind. See jinn-mono-5hc for the prior Sepolia
///      stall reproduction. Fast-test deployments should still heartbeat at
///      least weekly — see phase1a-heartbeat-vote-weighting.ts.
contract VoteWeightingFast is VoteWeighting {
    constructor(address _ve) VoteWeighting(_ve) {}

    function _period() internal pure override returns (uint256) {
        return 900;
    }

    function _voteDelay() internal pure override returns (uint256) {
        return 900;
    }

    function _maxNumPeriods() internal pure override returns (uint256) {
        return 10_000;
    }
}
