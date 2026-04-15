# Olas Code Resources

This directory contains all the relevant codebases needed for implementing Olas Staking functionality.

## Repository Structure

### 1. autonolas-tokenomics/
**Repository**: https://github.com/valory-xyz/autonolas-tokenomics
**Purpose**: Core Autonolas tokenomics contracts and configurations

**Key Components**:
- **Agent Registry**: Contracts for managing autonomous agents
- **Service Registry**: Contracts for managing agent services
- **Staking Contracts**: All staking-related registry contracts
- **Token Dispensary**: Depository, Treasury, Tokenomics contracts
- **Deployed Addresses**: Located in `docs/configuration.json`

**Core Contracts**:
- `contracts/Depository.sol`
- `contracts/Dispenser.sol` 
- `contracts/Tokenomics.sol`
- `contracts/TokenomicsProxy.sol`
- `contracts/Treasury.sol`
- Various staking-related deposit processors and dispensers

### 2. olas-operate-middleware/
**Repository**: https://github.com/valory-xyz/olas-operate-middleware
**Purpose**: Olas middleware components for autonomous agent operations

**Key Components**:
- Middleware for agent orchestration
- APIs and interfaces for Olas operations
- Integration components for staking functionality

## Usage Notes

- Both repositories are cloned locally for development and reference
- Contract addresses and configurations can be found in the tokenomics repo
- Use these resources to understand the complete Olas ecosystem before implementing staking features

## Next Steps

1. Examine the deployed contract addresses in `autonolas-tokenomics/docs/configuration.json`
2. Review the core staking contracts in the tokenomics repository
3. Understand the middleware integration points for staking operations
4. Plan the integration of Olas staking into the current system
