// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20, ERC4626, FixedPointMathLib} from "../solmate/tokens/ERC4626.sol";

/// @dev Provided zero address.
error ZeroAddress();

/// @dev Provided zero value.
error ZeroValue();

/// @dev Value overflow.
/// @param provided Overflow value.
/// @param max Maximum possible value.
error Overflow(uint256 provided, uint256 max);

/// @dev The contract is already initialized.
error AlreadyInitialized();

/// @dev Only `treasury` has a privilege, but the `sender` was provided.
/// @param sender Sender address.
/// @param treasury Required sender address as a treasury.
error TreasuryOnly(address sender, address treasury);

/// @dev Only `depository` has a privilege, but the `sender` was provided.
/// @param sender Sender address.
/// @param depository Required sender address as a depository.
error DepositoryOnly(address sender, address depository);

/// @dev Only `distributor` has a privilege, but the `sender` was provided.
/// @param sender Sender address.
/// @param distributor Required sender address as a distributor.
error DistributorOnly(address sender, address distributor);

/// @dev Only `unstakeRelayer` has a privilege, but the `sender` was provided.
/// @param sender Sender address.
/// @param unstakeRelayer Required sender address as an unstakeRelayer.
error UnstakeRelayerOnly(address sender, address unstakeRelayer);

/// @dev The function is not implemented.
error NotImplemented();

/// @title stOLAS - Smart contract for the stOLAS token.
contract stOLAS is ERC4626 {
    using FixedPointMathLib for uint256;

    event Initialized(
        address indexed treasury, address indexed depository, address indexed dstributor, address unstakeRelayer
    );
    event TotalReservesUpdated(
        uint256 stakedBalance, uint256 vaultBalance, uint256 reserveBalance, uint256 totalReserves
    );

    // Staked balance: funds allocated for staking contracts on different chains
    uint256 public stakedBalance;
    // Vault balance: Distributor and other possible deposits
    uint256 public vaultBalance;
    // Reserve balance: Depository incoming funds that are still not utilized
    uint256 public reserveBalance;
    // Total OLAS reserves that include staked, vault and reserve balance
    uint256 public totalReserves;

    // Treasury address
    address public treasury;
    // Depository address
    address public depository;
    // Distributor address
    address public distributor;
    // Unstake relayer address for retired model funds
    address public unstakeRelayer;

    /// @dev stOLAS constructor.
    /// @param _olas OLAS token address.
    constructor(ERC20 _olas) ERC4626(_olas, "Staked OLAS", "stOLAS") {}

    /// @dev Initializes stOLAS with various managing contract addresses.
    /// @notice The initialization is checked offchain before integration with other contracts.
    /// @param _treasury Treasury address.
    /// @param _depository Depository address.
    /// @param _distributor Distributor address.
    /// @param _unstakeRelayer UnstakeRelayer address.
    function initialize(address _treasury, address _depository, address _distributor, address _unstakeRelayer)
        external
    {
        // Check for already being initialized
        if (treasury != address(0)) {
            revert AlreadyInitialized();
        }

        // Check for zero addresses
        if (
            _treasury == address(0) || _depository == address(0) || _distributor == address(0)
                || _unstakeRelayer == address(0)
        ) {
            revert ZeroAddress();
        }

        // Set managing contract addresses
        treasury = _treasury;
        depository = _depository;
        distributor = _distributor;
        unstakeRelayer = _unstakeRelayer;

        emit Initialized(_treasury, _depository, _distributor, _unstakeRelayer);
    }

    /// @dev Deposits OLAS in exchange for stOLAS tokens.
    /// @param assets OLAS amount.
    /// @param receiver Receiver account address.
    /// @return shares stOLAS amount.
    function deposit(uint256 assets, address receiver) public override returns (uint256 shares) {
        // Check for access
        if (msg.sender != depository) {
            revert DepositoryOnly(msg.sender, depository);
        }

        // Check for zero balance
        if (assets == 0) {
            revert ZeroValue();
        }

        // Calculate shares
        shares = totalSupply;
        shares = shares == 0 ? assets : assets.mulDivDown(shares, totalReserves);

        // Check for rounding error since we round down in mulDivDown
        if (shares == 0) {
            revert ZeroValue();
        }

        _mint(receiver, shares);

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @dev Redeems OLAS in exchange for stOLAS tokens.
    /// @param shares stOLAS amount.
    /// @param receiver Receiver account address.
    /// @param tokenOwner Token owner account address.
    /// @return assets OLAS amount.
    function redeem(uint256 shares, address receiver, address tokenOwner) public override returns (uint256 assets) {
        // Check for access
        if (msg.sender != treasury) {
            revert TreasuryOnly(msg.sender, treasury);
        }

        (uint256 curStakedBalance, uint256 curVaultBalance, uint256 curReserveBalance, uint256 curTotalReserves) =
            calculateCurrentBalances();

        // Calculate assets
        assets = totalSupply;
        assets = assets == 0 ? shares : shares.mulDivDown(curTotalReserves, assets);

        // Check for rounding error since we round down in mulDivDown
        if (assets == 0) {
            revert ZeroValue();
        }

        _burn(tokenOwner, shares);

        // Update total assets
        uint256 transferAmount;

        uint256 vaultAndReserveBalance = curVaultBalance + curReserveBalance;
        // Shuffle balances depending on how many tokens are requested for redeem
        if (vaultAndReserveBalance >= assets) {
            // Vault and reserves have enough assets to cover requested amount
            transferAmount = assets;

            // Check if reserve balance can fully cover requested amount
            if (curReserveBalance >= assets) {
                curReserveBalance -= assets;
            } else {
                // Otherwise fully utilize reserve balance and use the rest from vault balance
                curVaultBalance = vaultAndReserveBalance - assets;
                curReserveBalance = 0;
            }
        } else {
            // If vault and reserve does not have enough balance, use it all and take rest from staked
            transferAmount = vaultAndReserveBalance;
            uint256 remainingAmount = assets - vaultAndReserveBalance;

            // Check for overflow, must never happen
            if (remainingAmount > curStakedBalance) {
                revert Overflow(remainingAmount, curStakedBalance);
            }

            // Update required values: vault and reserve balances are depleted, staking balance refund will be requested
            curStakedBalance -= remainingAmount;
            stakedBalance = curStakedBalance;
            curVaultBalance = 0;
            curReserveBalance = 0;
        }

        // Recalculate balances
        reserveBalance = curReserveBalance;
        vaultBalance = curVaultBalance;
        curTotalReserves = curStakedBalance + curVaultBalance + curReserveBalance;
        totalReserves = curTotalReserves;

        if (transferAmount > 0) {
            asset.transfer(receiver, transferAmount);
        }

        emit TotalReservesUpdated(curStakedBalance, curVaultBalance, curReserveBalance, curTotalReserves);
        emit Withdraw(msg.sender, receiver, tokenOwner, assets, shares);
    }

    /// @dev Overrides mint function that is never used.
    function mint(uint256, address) public pure override returns (uint256) {
        revert NotImplemented();
    }

    /// @dev Overrides withdraw function that is never used.
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert NotImplemented();
    }

    /// @dev Calculates reserve and stake balances, and top-ups stOLAS or Depository.
    /// @param reserveAmount Additional reserve OLAS amount.
    /// @param stakeAmount Additional stake OLAS amount.
    /// @param topUp Top up amount to be sent or received.
    /// @param direction To stOLAS, if true, and to Depository otherwise.
    function syncStakeBalances(uint256 reserveAmount, uint256 stakeAmount, uint256 topUp, bool direction) external {
        // Check for access
        if (msg.sender != depository) {
            revert DepositoryOnly(msg.sender, depository);
        }

        // Update balances accordingly
        // Reserve balance
        uint256 curReserveBalance = reserveBalance;
        if (curReserveBalance != reserveAmount) {
            curReserveBalance = reserveAmount;
            reserveBalance = reserveAmount;
        }

        // Staked balance
        uint256 curStakedBalance = stakedBalance;
        if (stakeAmount > 0) {
            curStakedBalance += stakeAmount;
            stakedBalance = curStakedBalance;
        }

        // Update total reserves, since either reserveAmount or stakeAmount are not zero
        // Current vault balance
        uint256 curVaultBalance = vaultBalance;
        // Total reserves
        uint256 curTotalReserves = curStakedBalance + curVaultBalance + curReserveBalance;
        totalReserves = curTotalReserves;

        // Direction is true if the transfer is from Depository to stOLAS, else the opposite direction
        if (direction == true) {
            // Pull OLAS from Depository
            asset.transferFrom(msg.sender, address(this), topUp);
        } else if (topUp > 0) {
            // Top-up can be zero in case when it is not transferred to stOLAS as it is fully utilized in Depository
            // Thus, no action is required and this block is skipped

            // Transfer OLAS to Depository
            asset.transfer(msg.sender, topUp);
        }

        emit TotalReservesUpdated(curStakedBalance, curVaultBalance, curReserveBalance, curTotalReserves);
    }

    /// @dev Top-ups vault balance via Distributor.
    /// @param amount OLAS amount.
    function topUpVaultBalance(uint256 amount) external {
        // Check for access
        if (msg.sender != distributor) {
            revert DistributorOnly(msg.sender, distributor);
        }

        // Update balances accordingly
        // Vault balance
        uint256 curVaultBalance = vaultBalance + amount;
        vaultBalance = curVaultBalance;
        // Total reserves
        uint256 curTotalReserves = totalReserves + amount;
        totalReserves = curTotalReserves;

        asset.transferFrom(msg.sender, address(this), amount);

        emit TotalReservesUpdated(stakedBalance, curVaultBalance, reserveBalance, curTotalReserves);
    }

    /// @dev Top-ups unstake balance from retired models via Depository: increase reserve balance and decrease staked one.
    /// @param amount OLAS amount.
    function topUpRetiredBalance(uint256 amount) external {
        // Check for access
        if (msg.sender != unstakeRelayer) {
            revert UnstakeRelayerOnly(msg.sender, unstakeRelayer);
        }

        // Update stakedBalance and possibly totalReserves
        uint256 curStakedBalance = stakedBalance;
        uint256 curTotalReserves = totalReserves;
        // This can only happen if OLAS funds have been additionally transferred to UnstakeRelayer contract
        // The leftover difference is passed to reserve balance
        if (amount > curStakedBalance) {
            // This needs totalReserves update for the amount exceeding stakedBalance
            uint256 overDeposit = amount - curStakedBalance;
            curTotalReserves += overDeposit;
            totalReserves = curTotalReserves;
            curStakedBalance = 0;
        } else {
            curStakedBalance -= amount;
        }
        stakedBalance = curStakedBalance;

        // Update reserve balance
        uint256 curReserveBalance = reserveBalance + amount;
        reserveBalance = curReserveBalance;

        asset.transferFrom(msg.sender, address(this), amount);

        emit TotalReservesUpdated(curStakedBalance, vaultBalance, curReserveBalance, curTotalReserves);
    }

    /// @dev Calculates current balances.
    /// @return curStakedBalance Current staked balance.
    /// @return curVaultBalance Current vault balance.
    /// @return curReserveBalance Current reserve balance.
    /// @return curTotalReserves Current total reserves.
    function calculateCurrentBalances()
        public
        view
        returns (uint256 curStakedBalance, uint256 curVaultBalance, uint256 curReserveBalance, uint256 curTotalReserves)
    {
        // Current staked balance
        curStakedBalance = stakedBalance;
        // Current vault balance
        curVaultBalance = vaultBalance;
        // Current reserve balance
        curReserveBalance = reserveBalance;

        // Total reserves
        curTotalReserves = curStakedBalance + curVaultBalance + curReserveBalance;
    }

    /// @dev Previews deposit assets to shares amount.
    /// @notice This function can only be used for a strict amount of provided assets value.
    ///       It might not correlate with the Depository's `deposit()` function since the provided amount
    ///       could be changed due to other input parameters. For accurate correspondence with the Depository's
    ///       `deposit()` function use its static call directly.
    /// @param assets Deposited assets amount.
    function previewDeposit(uint256 assets) public view override returns (uint256) {
        (,,, uint256 curTotalReserves) = calculateCurrentBalances();

        uint256 shares = totalSupply;
        return shares == 0 ? assets : assets.mulDivDown(shares, curTotalReserves);
    }

    /// @dev Previews redeem shares to assets amount.
    /// @param shares Redeemed shares amount.
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        (,,, uint256 curTotalReserves) = calculateCurrentBalances();

        uint256 assets = totalSupply;
        return assets == 0 ? shares : shares.mulDivDown(curTotalReserves, assets);
    }

    /// @dev Gets total assets amount.
    function totalAssets() public view override returns (uint256) {
        return totalReserves;
    }

    /// @dev Overrides unused function return value.
    function maxMint(address) public pure override returns (uint256) {
        return 0;
    }

    /// @dev Overrides unused function return value.
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }
}
