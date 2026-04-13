// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Implementation} from "../Implementation.sol";
import {IToken} from "../interfaces/IToken.sol";

interface IST {
    /// @dev Top-ups unstake balance from retired models via Depository: increase reserve balance and decrease staked one.
    /// @param amount OLAS amount.
    function topUpRetiredBalance(uint256 amount) external;
}

/// @dev Zero value.
error ZeroValue();

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Unauthorized account.
/// @param account Account address.
error UnauthorizedAccount(address account);

/// @dev Caught reentrancy violation.
error ReentrancyGuard();

/// @title UnstakeRelayer - Smart contract for relaying funds obtained via bridging when unstaked from retired models.
contract UnstakeRelayer is Implementation {
    event UnstakeRelayed(address indexed account, address indexed st, uint256 olasAmount);

    // Depository version
    string public constant VERSION = "0.1.0";

    // OLAS contract address
    address public immutable olas;
    // stOLAS contract address
    address public immutable st;

    // Reentrancy lock
    bool transient _locked;

    /// @dev UnstakeRelayer constructor.
    /// @param _olas OLAS address.
    /// @param _st stOLAS address.
    constructor(address _olas, address _st) {
        olas = _olas;
        st = _st;
    }

    /// @dev UnstakeRelayer initializer.
    function initialize() external {
        // Check for already initialized
        if (owner != address(0)) {
            revert AlreadyInitialized();
        }

        owner = msg.sender;
    }

    /// @dev Relay OLAS to stOLAS for balances re-distribution.
    function relay() external {
        // Reentrancy guard
        if (_locked) {
            revert ReentrancyGuard();
        }
        _locked = true;

        // Get OLAS balance
        uint256 olasAmount = IToken(olas).balanceOf(address(this));

        if (olasAmount > 0) {
            // Approve OLAS for stOLAS
            IToken(olas).approve(st, olasAmount);

            // Top-up stOLAS with the approved amount
            IST(st).topUpRetiredBalance(olasAmount);

            emit UnstakeRelayed(msg.sender, st, olasAmount);
        }
    }
}
