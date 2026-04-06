# Jinn Node Service

Jinn Network worker node service package for OLAS protocol registration.

This service claims and executes jobs from the Jinn Marketplace, runs AI agents
with MCP tools, and delivers results on-chain via IPFS.

## Overview

- **Author:** jinn
- **Version:** 0.1.0
- **License:** Apache-2.0
- **Chain:** Base (8453)

## Architecture

The jinn-node worker operates as a Docker container that:
1. Polls the Jinn Marketplace (Ponder indexer) for pending jobs
2. Claims jobs on-chain via the MechMarketplace contract
3. Executes AI agent workflows using Gemini CLI with MCP tools
4. Delivers results to IPFS and records delivery on-chain

## Deployment

This service is deployed via `yarn setup` in the jinn-node repository.
See https://github.com/Jinn-Network/jinn-node for operator instructions.
