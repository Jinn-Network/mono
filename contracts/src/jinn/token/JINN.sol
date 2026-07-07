// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title JINN
/// @notice ERC20Votes governance token for the Jinn protocol. A single minter
///         (typically the JinnDistributor) is authorised to mint; ownership is
///         held by an OZ Timelock and managed via two-step transfers.
///
/// @dev v0 minimum-viable token. Inflation logic from the OLAS-vendored JINN
///      is intentionally omitted at this layer — the JinnDistributor is the
///      sole minter and is the right place to enforce supply policy.
contract JINN is ERC20, ERC20Permit, ERC20Votes, Ownable2Step {
    /// @notice Address authorised to mint new JINN; zero disables minting.
    address public minter;

    /// @notice Emitted whenever the minter is updated (including unsetting).
    event MinterUpdated(address indexed newMinter);

    /// @notice Thrown when a non-minter attempts to call {mint}.
    error NotMinter(address sender);

    /// @param name_  Token name (e.g. `"JINN"` on mainnet, `"JINN (testnet)"` on Sepolia).
    /// @param symbol_ Token symbol (e.g. `"JINN"` on mainnet, `"tJINN"` on testnet).
    /// @param initialOwner Initial owner; expected to transfer to the Timelock post-deploy.
    constructor(string memory name_, string memory symbol_, address initialOwner)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
        Ownable(initialOwner)
    {}

    /// @notice Mint new JINN tokens. Restricted to the configured minter.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) {
            revert NotMinter(msg.sender);
        }
        _mint(to, amount);
    }

    /// @notice Set or unset the minter. Owner only.
    function setMinter(address newMinter) external onlyOwner {
        minter = newMinter;
        emit MinterUpdated(newMinter);
    }

    // -------------------------------------------------------------------------
    // OpenZeppelin v5 multiple-inheritance overrides
    // -------------------------------------------------------------------------

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }

    // -------------------------------------------------------------------------
    // ERC-6372 clock — timestamp mode
    // -------------------------------------------------------------------------
    //
    // The v0 governance plan locks Governor parameters in seconds (e.g.
    // 172,800 s voting delay), so we anchor checkpoints + voting to
    // {block.timestamp} rather than block numbers. Governors that read
    // {IERC5805} will pick this up via {CLOCK_MODE}.

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }
}
