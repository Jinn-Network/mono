// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// ERC20 token interface
interface IToken {
    /// @dev Transfers the token amount.
    /// @param to Address to transfer to.
    /// @param amount The amount to transfer.
    /// @return True if the function execution is successful.
    function transfer(address to, uint256 amount) external returns (bool);

    /// @dev Transfers the token amount that was previously approved up until the maximum allowance.
    /// @param from Account address to transfer from.
    /// @param to Account address to transfer to.
    /// @param amount Amount to transfer to.
    /// @return True if the function execution is successful.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
    /// @param spender Account address that will be able to transfer tokens on behalf of the caller.
    /// @param amount Token amount.
    /// @return True if the function execution is successful.
    function approve(address spender, uint256 amount) external returns (bool);

    /// @dev Mints tokens.
    /// @param account Account address.
    /// @param amount Token amount.
    function mint(address account, uint256 amount) external;

    /// @dev Burns tokens.
    /// @param amount Token amount.
    function burn(uint256 amount) external;

    /// @dev Gets the amount of tokens owned by a specified account.
    /// @param account Account address.
    /// @return Amount of tokens owned.
    function balanceOf(address account) external view returns (uint256);
}

// ERC721 token interface
interface INFToken {
    /// @dev Sets token `id` as the allowance of `spender` over the caller's tokens.
    /// @param spender Account address that will be able to transfer the token on behalf of the caller.
    /// @param id Token id.
    function approve(address spender, uint256 id) external;

    /// @dev Transfers a specified token Id.
    /// @param from Account address to transfer from.
    /// @param to Account address to transfer to.
    /// @param id Token id.
    function transferFrom(address from, address to, uint256 id) external;

    /// @dev Transfers a specified token Id with a callback.
    /// @param from Account address to transfer from.
    /// @param to Account address to transfer to.
    /// @param id Token id.
    function safeTransferFrom(address from, address to, uint256 id) external;
}
