// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @dev Gate-only minimal ERC-20 surface: balanceOf, allowance, approve + Approval.
contract MiniToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }
}
