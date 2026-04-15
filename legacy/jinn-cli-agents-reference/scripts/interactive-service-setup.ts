#!/usr/bin/env tsx
/**
 * Interactive Service Setup CLI - Thin Wrapper
 *
 * This is a thin wrapper that imports the actual implementation from jinn-node.
 * The source of truth is in jinn-node/src/setup/cli.ts
 *
 * Usage:
 *   yarn setup:service                    # Mainnet deployment (uses .env)
 *   yarn setup:service --testnet          # Testnet deployment (uses .env.test)
 *   yarn setup:service --chain=base       # Specify chain
 *   yarn setup:service --no-mech          # Deploy without mech contract
 *   yarn setup:service --isolated         # Run in isolated temp directory
 */

// Import and run the CLI from jinn-node
import 'jinn-node/setup/cli.js';
