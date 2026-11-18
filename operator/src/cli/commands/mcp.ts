import type { CommandContext, CommandModule } from '../command.js';
import { createOperatorServer } from '../../mcp/operator-server.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function run(ctx: CommandContext): Promise<void> {
  // The tools run CLI verbs in this process with an argv of their own, so none of them reads a
  // --password-fd given here (#5390). Refused rather than set aside.
  if (ctx.argv.some((arg) => arg === '--password-fd' || arg.startsWith('--password-fd='))) {
    return emitEnvelope({
      code: 'invalid_invocation',
      message: 'mcp does not take --password-fd',
      hint: 'Drop --password-fd: the MCP tools take the keystore password from JINN_PASSWORD or a '
        + 'keystore-password file in the server environment.',
      exampleCli: 'JINN_PASSWORD=... jinn mcp',
      details: { field: 'password-fd', state: 'unused-flag', sideEffects: false },
    }, { writer: ctx.writer, exit: ctx.exit });
  }
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
The tools take the keystore password from JINN_PASSWORD or a
keystore-password file in this environment; --password-fd is refused.
`,
  run,
};

export default command;
