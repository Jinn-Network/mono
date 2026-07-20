#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDistillMcpServer } from '../distill-mcp-server.js';

const server = createDistillMcpServer();
const transport = new StdioServerTransport();

server.connect(transport).catch((err) => {
  console.error('[jinn-distill-mcp] failed to start');
  console.error(err);
  process.exit(1);
});
