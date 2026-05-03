// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IClaimMessenger} from "../interfaces/IClaimMessenger.sol";

/// @notice Test-only mocks for the {JinnDistributor} test suite.
///         Compiled into the Hardhat artifact set so the TypeScript
///         tests can deploy them via getContractFactory.

interface IDistributorClaim {
    function claim(bytes calldata proof) external;
}

/// @notice An {IClaimMessenger} that always returns
///         `multisig == address(0)`. Used to exercise the
///         distributor's `ZeroMultisig` revert branch (the real
///         {MockMessenger} refuses fixtures with multisig=0, so it
///         can't reach this case).
contract ZeroMultisigMessenger is IClaimMessenger {
    function verifyClaim(bytes calldata)
        external
        pure
        override
        returns (
            uint256 serviceId,
            uint256 taskCreationWeight,
            uint256 solutionDeliveryWeight,
            uint256 verdictDeliveryWeight,
            address multisig
        )
    {
        return (0, 0, 0, 0, address(0));
    }
}

/// @notice A minimal "JINN" stand-in that lets the test suite stub
///         out the real ERC20 surface and, on demand, attempt a
///         reentrant call back into the distributor from inside
///         {mint}. Used to verify the distributor's CEI ordering.
contract ReentrantMockJinn {
    /// @notice Configurable reentrancy target. When non-zero, every
    ///         {mint} call also invokes
    ///         `target.claim(reentrantProof)` once before returning,
    ///         then disarms itself so the reentrant call doesn't
    ///         recurse forever.
    address public reentrantTarget;
    bytes public reentrantProof;
    bool internal armed;

    /// @notice Per-recipient mint log so tests can verify total
    ///         minted balances without needing a real ERC20.
    mapping(address => uint256) public balanceOf;
    uint256 public totalMinted;

    event MintCalled(address indexed to, uint256 amount);

    function setReentrancy(address target, bytes calldata proof) external {
        reentrantTarget = target;
        reentrantProof = proof;
        armed = target != address(0);
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalMinted += amount;
        emit MintCalled(to, amount);

        if (armed) {
            // Disarm BEFORE the reentrant call so that the inner
            // {claim} → {mint} chain doesn't attempt to recurse.
            armed = false;
            IDistributorClaim(reentrantTarget).claim(reentrantProof);
        }
    }
}
