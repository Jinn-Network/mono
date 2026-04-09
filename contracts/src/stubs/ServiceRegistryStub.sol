// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @title ServiceRegistryStub - Minimal service registry for staking tests.
 * @notice Supports creating mock services that satisfy StakingBase._stake() checks.
 *         Implements a minimal ERC721 for service NFT transfers.
 *         Not a production contract — test-only.
 */
contract ServiceRegistryStub {
    enum ServiceState {
        NonExistent,
        PreRegistration,
        ActiveRegistration,
        FinishedRegistration,
        Deployed,
        TerminatedBonded
    }

    struct AgentParams {
        uint32 slots;
        uint96 bond;
    }

    struct Service {
        uint96 securityDeposit;
        address multisig;
        bytes32 configHash;
        uint32 threshold;
        uint32 maxNumAgentInstances;
        uint32 numAgentInstances;
        ServiceState state;
        uint32[] agentIds;
    }

    uint256 public nextServiceId = 1;
    mapping(uint256 => Service) internal _services;

    // Minimal ERC721 state
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => address) internal _approvals;
    // Agent instance address => operator address
    mapping(address => address) public mapAgentInstanceOperators;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);

    /// @dev Create a mock deployed service. Mints the NFT to msg.sender.
    function createMockService(
        address multisig,
        uint96 securityDeposit,
        uint32 numAgentInstances,
        uint32 threshold,
        uint32[] memory agentIds,
        bytes32 configHash
    ) external returns (uint256 serviceId) {
        serviceId = nextServiceId++;
        _services[serviceId] = Service({
            securityDeposit: securityDeposit,
            multisig: multisig,
            configHash: configHash,
            threshold: threshold,
            maxNumAgentInstances: numAgentInstances,
            numAgentInstances: numAgentInstances,
            state: ServiceState.Deployed,
            agentIds: agentIds
        });
        _owners[serviceId] = msg.sender;
        emit Transfer(address(0), msg.sender, serviceId);
    }

    /// @dev Required by StakingBase._stake() via IService interface.
    function getService(uint256 serviceId) external view returns (Service memory) {
        return _services[serviceId];
    }

    /// @dev Required by OlasMech / MechMarketplace (IServiceRegistry.mapServices).
    function mapServices(uint256 serviceId) external view returns (
        uint96 securityDeposit,
        address multisig,
        bytes32 configHash,
        uint32 threshold,
        uint32 maxNumAgentInstances,
        uint32 numAgentInstances,
        ServiceState state
    ) {
        Service storage s = _services[serviceId];
        return (
            s.securityDeposit,
            s.multisig,
            s.configHash,
            s.threshold,
            s.maxNumAgentInstances,
            s.numAgentInstances,
            s.state
        );
    }

    /// @dev Required by StakingBase._checkTokenStakingDeposit() default implementation.
    function getAgentParams(uint256 serviceId)
        external
        view
        returns (uint256 numAgentIds, AgentParams[] memory agentParams)
    {
        Service storage s = _services[serviceId];
        numAgentIds = s.agentIds.length;
        agentParams = new AgentParams[](numAgentIds);
        for (uint256 i = 0; i < numAgentIds; i++) {
            agentParams[i] = AgentParams({slots: 1, bond: s.securityDeposit});
        }
    }

    /// @dev Required by StakingBase for agent instance lookups.
    function getAgentInstances(uint256 serviceId)
        external
        view
        returns (uint256 numAgentInstances, address[] memory agentInstances)
    {
        Service storage s = _services[serviceId];
        numAgentInstances = s.numAgentInstances;
        agentInstances = new address[](0);
    }

    /// @dev Register an agent instance -> operator mapping.
    function setAgentInstanceOperator(address agentInstance, address operator) external {
        mapAgentInstanceOperators[agentInstance] = operator;
    }

    // --- Minimal ERC721 ---

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "ERC721: nonexistent token");
        return owner;
    }

    function approve(address to, uint256 tokenId) external {
        require(msg.sender == _owners[tokenId], "ERC721: not owner");
        _approvals[tokenId] = to;
        emit Approval(msg.sender, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _approvals[tokenId];
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(_owners[tokenId] == from, "ERC721: not owner");
        require(
            msg.sender == from || _approvals[tokenId] == msg.sender,
            "ERC721: not approved"
        );
        _owners[tokenId] = to;
        delete _approvals[tokenId];
        emit Transfer(from, to, tokenId);
    }

    // --- Stubs for RegistryStub compatibility ---

    function slashedFunds() external pure returns (uint256) {
        return 0;
    }

    function getUnitIdsOfService(uint256) external pure returns (uint256[] memory, uint256[] memory) {
        return (new uint256[](0), new uint256[](0));
    }

    function exists(uint256) external pure returns (bool) {
        return false;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }
}
