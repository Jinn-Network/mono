// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DefaultStakingProcessorL2} from "./DefaultStakingProcessorL2.sol";

// ERC20 token interface
interface IToken {
    /// @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
    /// @param spender Account address that will be able to transfer tokens on behalf of the caller.
    /// @param amount Token amount.
    /// @return True if the function execution is successful.
    function approve(address spender, uint256 amount) external returns (bool);

    /// @dev Transfers the token amount that was previously approved up until the maximum allowance.
    /// @param from Account address to transfer from.
    /// @param to Account address to transfer to.
    /// @param amount Amount to transfer to.
    /// @return True if the function execution is successful.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IBridge {
    // Source: https://github.com/ethereum-optimism/optimism/blob/65ec61dde94ffa93342728d324fecf474d228e1f/packages/contracts-bedrock/contracts/universal/CrossDomainMessenger.sol#L422
    // Doc: https://docs.optimism.io/builders/app-developers/bridging/messaging#accessing-msgsender
    /// @notice Retrieves the address of the contract or wallet that initiated the currently
    ///         executing message on the other chain. Will throw an error if there is no message
    ///         currently being executed. Allows the recipient of a call to see who triggered it.
    ///
    /// @return Address of the sender of the currently executing message on the other chain.
    function xDomainMessageSender() external view returns (address);

    // Source: https://github.com/ethereum-optimism/optimism/blob/65ec61dde94ffa93342728d324fecf474d228e1f/packages/contracts-bedrock/contracts/L2/L2StandardBridge.sol#L121
    /// @notice Initiates a withdrawal from L2 to L1 to a target account on L1.
    ///         Note that if ETH is sent to a contract on L1 and the call fails, then that ETH will
    ///         be locked in the L1StandardBridge. ETH may be recoverable if the call can be
    ///         successfully replayed by increasing the amount of gas supplied to the call. If the
    ///         call will fail for any amount of gas, then the ETH will be locked permanently.
    ///         This function only works with OptimismMintableERC20 tokens or ether. Use the
    ///         `bridgeERC20To` function to bridge native L2 tokens to L1.
    /// @param _l2Token     Address of the L2 token to withdraw.
    /// @param _to          Recipient account on L1.
    /// @param _amount      Amount of the L2 token to withdraw.
    /// @param _minGasLimit Minimum gas limit to use for the transaction.
    /// @param _extraData   Extra data attached to the withdrawal.
    function withdrawTo(address _l2Token, address _to, uint256 _amount, uint32 _minGasLimit, bytes calldata _extraData)
        external;
}

/// @dev Zero value only allowed
error ZeroValueOnly();

/// @title BaseStakingProcessorL2 - Smart contract for processing tokens and data received on Gnosis L2, and tokens sent back to L1.
contract BaseStakingProcessorL2 is DefaultStakingProcessorL2 {
    // Token transfer gas limit for L1
    // This is safe as the value is practically bigger than observed ones on numerous chains
    uint32 public constant TOKEN_GAS_LIMIT = 300_000;

    /// @dev GnosisTargetDispenserL2 constructor.
    /// @param _olas OLAS token address.
    /// @param _stakingManager StakingManager address.
    /// @param _externalStakingDistributor ExternalStakingDistributor address.
    /// @param _collector Collector address.
    /// @param _l2TokenRelayer L2 token relayer bridging contract address.
    /// @param _l2MessageRelayer L2 message relayer bridging contract address (AMBHomeProxy).
    /// @param _l1DepositProcessor L1 deposit processor address.
    /// @param _l1SourceChainId L1 source chain Id.
    constructor(
        address _olas,
        address _stakingManager,
        address _externalStakingDistributor,
        address _collector,
        address _l2TokenRelayer,
        address _l2MessageRelayer,
        address _l1DepositProcessor,
        uint256 _l1SourceChainId
    )
        DefaultStakingProcessorL2(
            _olas,
            _stakingManager,
            _externalStakingDistributor,
            _collector,
            _l2TokenRelayer,
            _l2MessageRelayer,
            _l1DepositProcessor,
            _l1SourceChainId
        )
    {}

    /// @dev Processes a message received from L1 deposit processor contract.
    /// @param data Bytes message data sent from L1.
    function receiveMessage(bytes memory data) external payable {
        // Check for the target dispenser address
        address l1Processor = IBridge(l2MessageRelayer).xDomainMessageSender();

        // Process the data
        _receiveMessage(msg.sender, l1Processor, data);
    }

    /// @inheritdoc DefaultStakingProcessorL2
    function relayToL1(address to, uint256 olasAmount, bytes memory) external payable virtual override {
        // msg.value must be zero
        if (msg.value > 0) {
            revert ZeroValueOnly();
        }

        // Get tokens
        IToken(olas).transferFrom(msg.sender, address(this), olasAmount);
        // Approve for bridging
        IToken(olas).approve(l2TokenRelayer, olasAmount);
        // Bridge tokens
        IBridge(l2TokenRelayer).withdrawTo(olas, to, olasAmount, TOKEN_GAS_LIMIT, "0x");
    }
}
