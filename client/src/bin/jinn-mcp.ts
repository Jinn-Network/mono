#!/usr/bin/env node
/**
 * jinn-mcp — standalone MCP server exposing operator-level tools.
 *
 * Designed to be launched by an MCP-aware host (Claude Desktop, Cursor, etc.)
 * via stdio transport.  Each tool delegates to the same command modules that
 * the `jinn` CLI uses, so behaviour is always consistent.
 *
 * Usage (in an MCP host config):
 *   { "command": "jinn-mcp" }
 *
 * Context: docs/research/2026-04-agent-packaging.md sections 2.2, 5.1-5.3
 */

import { createOperatorServer } from '../mcp/operator-server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createOperatorServer();
const transport = new StdioServerTransport();
await server.connect(transport);
