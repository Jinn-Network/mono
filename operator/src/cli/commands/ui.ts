import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { openBrowser } from '../open-browser.js';

const DEFAULT_CONSOLE_URL = 'http://127.0.0.1:3000';

const command: CommandModule = {
  name: 'ui',
  summary: 'Open the operator console in your browser (assumes the console is running)',
  helpText: `Usage: jinn ui [--url <url>]

Opens the operator console (default http://127.0.0.1:3000) in the default
browser. The daemon origin has no human surface; run the console separately
(\`cd apps/operator-console && yarn dev\`) and point it at the daemon with
\`x-jinn-ui-token\`.

Examples:
  jinn ui
  jinn ui --url http://127.0.0.1:3000
`,
  async run(ctx: CommandContext): Promise<void> {
    let parsed;
    try {
      parsed = parseArgs({
        args: ctx.argv,
        options: { ...COMMON_FLAGS, url: { type: 'string' }, port: { type: 'string' } },
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
    const url =
      (parsed.values.url as string | undefined) ??
      ctx.env['JINN_CONSOLE_URL'] ??
      DEFAULT_CONSOLE_URL;
    openBrowser(url);
    ctx.writer.write(JSON.stringify({ schemaVersion: 1, opened: url }) + '\n');
  },
};

export default command;
