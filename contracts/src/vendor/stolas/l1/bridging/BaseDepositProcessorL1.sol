// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DefaultDepositProcessorL1, IToken} from "./DefaultDepositProcessorL1.sol";

interface IBridge {
    // Source: https://github.com/ethereum-optimism/optimism/blob/65ec61dde94ffa93342728d324fecf474d228e1f/packages/contracts-bedrock/contracts/L1/L1StandardBridge.sol#L188
    // Doc: https://docs.optimism.io/builders/app-developers/bridging/standard-bridge#architecture
    /// @custom:legacy
    /// @notice Deposits some amount of ERC20 tokens into a target account on L2.
    ///
    /// @param _l1Token     Address of the L1 token being deposited.
    /// @param _l2Token     Address of the corresponding token on L2.
    /// @param _to          Address of the recipient on L2.
    /// @param _amount      Amount of the ERC20 to deposit.
    /// @param _minGasLimit Minimum gas limit for the deposit message on L2.
    /// @param _extraData   Optional data to forward to L2. Data supplied here will not be used to
    ///                     execute any code on L2 and is only emitted as extra data for the
    ///                     convenience of off-chain tooling.
    function depositERC20To(
        address _l1Token,
        address _l2Token,
        address _to,
        uint256 _amount,
        uint32 _minGasLimit,
        bytes calldata _extraData
    ) external;

    // Source: https://github.com/ethereum-optimism/optimism/blob/65ec61dde94ffa93342728d324fecf474d228e1f/packages/contracts-bedrock/contracts/universal/CrossDomainMessenger.sol#L259
    // Doc: https://docs.optimism.io/builders/app-developers/bridging/messaging
    /// @notice Sends a message to some target address on the other chain. Note that if the call
    ///         always reverts, then the message will be unrelayable, and any ETH sent will be
    ///         permanently locked. The same will occur if the target on the other chain is
    ///         considered unsafe (see the _isUnsafeTarget() function).
    ///
    /// @param _target      Target contract or wallet address.
    /// @param _message     Message to trigger the target address with.
    /// @param _minGasLimit Minimum gas limit that the message can be executed with.
    function sendMessage(address _target, bytes calldata _message, uint32 _minGasLimit) external payable;
}

/// @title BaseDepositProcessorL1 - Smart contract for sending tokens and data via Base bridge from L1 to L2 and processing data received from L2.
contract BaseDepositProcessorL1 is DefaultDepositProcessorL1 {
    // Bridge payload length
    uint256 public constant BRIDGE_PAYLOAD_LENGTH = 32;
    // OLAS address on L2
    address public immutable olasL2;

    /// @dev BaseDepositProcessorL1 constructor.
    /// @param _olas OLAS token address.
    /// @param _l1Dispenser L1 tokenomics dispenser address.
    /// @param _l1TokenRelayer L1 token relayer bridging contract address (OmniBridge).
    /// @param _l1MessageRelayer L1 message relayer bridging contract address (AMB Proxy Foreign).
    /// @param _olasL2 OLAS token address on L2.
    constructor(
        address _olas,
        address _l1Dispenser,
        address _l1TokenRelayer,
        address _l1MessageRelayer,
        address _olasL2
    ) DefaultDepositProcessorL1(_olas, _l1Dispenser, _l1TokenRelayer, _l1MessageRelayer) {
        // Check for zero address
        if (_olasL2 == address(0)) {
            revert ZeroAddress();
        }

        olasL2 = _olasL2;
    }

    /// @inheritdoc DefaultDepositProcessorL1
    function _sendMessage(
        address target,
        uint256 amount,
        bytes memory bridgePayload,
        bytes32 batchHash,
        bytes32 operation
    ) internal override returns (uint256 sequence, uint256 leftovers) {
        // Transfer OLAS tokens
        if (operation == STAKE) {
            // Deposit OLAS
            // Approve tokens for the predicate bridge contract
            // Source: https://github.com/maticnetwork/pos-portal/blob/5fbd35ba9cdc8a07bf32d81d6d1f4ce745feabd6/flat/RootChainManager.sol#L2218
            IToken(olas).approve(l1TokenRelayer, amount);

            // Transfer OLAS to L2 staking dispenser contract across the bridge
            IBridge(l1TokenRelayer).depositERC20To(
                olas, olasL2, l2StakingProcessor, amount, uint32(TOKEN_GAS_LIMIT), ""
            );
        }

        uint32 gasLimitMessage;
        // Check for the bridge payload length
        if (bridgePayload.length == BRIDGE_PAYLOAD_LENGTH) {
            // Decode bridge payload
            gasLimitMessage = abi.decode(bridgePayload, (uint32));
        }

        // Check for the recommended message gas limit
        if (gasLimitMessage < MESSAGE_GAS_LIMIT) {
            gasLimitMessage = uint32(MESSAGE_GAS_LIMIT);
        }

        // Assemble data payload
        bytes memory data = abi.encodeWithSelector(RECEIVE_MESSAGE, abi.encode(target, amount, batchHash, operation));

        // Send message to L2
        // Reference: https://docs.optimism.io/builders/app-developers/bridging/messaging#for-l1-to-l2-transactions-1
        IBridge(l1MessageRelayer).sendMessage(l2StakingProcessor, data, gasLimitMessage);

        // Since there is no returned message sequence, use the batch hash
        sequence = uint256(batchHash);

        // Return msg.value, if provided by mistake
        leftovers = msg.value;
    }
}
