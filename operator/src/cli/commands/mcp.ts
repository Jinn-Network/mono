import type { CommandContext, CommandModule } from '../command.js';
import { createOperatorServer } from '../../mcp/operator-server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function run(_ctx: CommandContext): Promise<void> {
  const server = createOperatorServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const command: CommandModule = {
  name: 'mcp',
  summary: 'Run the operator MCP server over stdio',
  helpText: `Usage: jinn mcp

Starts the operator MCP server over stdio so MCP hosts (Claude Desktop,
Cursor, etc.) can call the same tools backed by the jinn CLI modules.
`,
  run,
};

export default command;
