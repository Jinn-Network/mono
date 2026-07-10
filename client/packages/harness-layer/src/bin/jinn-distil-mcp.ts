#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDistilMcpServer } from '../distil-mcp-server.js';

const server = createDistilMcpServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((err) => {
  console.error('[jinn-distil-mcp] failed to start');
  console.error(err);
  process.exit(1);
});
