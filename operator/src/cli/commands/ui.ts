import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { openBrowser } from '../open-browser.js';

const command: CommandModule = {
  name: 'ui',
  summary: 'Open the operator panel in your browser (assumes daemon is running)',
  helpText: `Usage: jinn ui [--port <n>]

Opens http://127.0.0.1:7331 (or the configured port) in the default browser.
This is a convenience wrapper — the panel is also auto-opened by \`jinn run\`.

If the daemon isn't running, the page will fail to load; start the daemon
with \`jinn run\` first.

Examples:
  jinn ui
  jinn ui --port 7332
`,
  async run(ctx: CommandContext): Promise<void> {
    let parsed;
    try {
      parsed = parseArgs({
        args: ctx.argv,
        options: { ...COMMON_FLAGS, port: { type: 'string' } },
        allowPositionals: false,
      });
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: 'jinn ui',
          details: { field: 'flags' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    const port =
      (parsed.values.port as string | undefined) ?? ctx.env['JINN_API_PORT'] ?? '7331';
    const url = `http://127.0.0.1:${port}/`;
    openBrowser(url);
    ctx.writer.write(JSON.stringify({ schemaVersion: 1, opened: url }) + '\n');
  },
};

export default command;
