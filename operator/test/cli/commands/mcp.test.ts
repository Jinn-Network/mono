import { describe, expect, it } from 'vitest';
import mcp from '../../../src/cli/commands/mcp.js';
import { makeCommandCtx } from '@test/cli.js';

/**
 * #5390: the MCP tools run CLI verbs in this process with an argv of their own, so none of them
 * reads a --password-fd given to `jinn mcp`. The server refuses it instead of setting it aside.
 */
describe('jinn mcp --password-fd (#5390)', () => {
  it.each([[['--password-fd', '0']], [['--password-fd=3']]])(
    'refuses %j before starting the server',
    async (argv) => {
      const { ctx, writes, exits } = makeCommandCtx({ argv });
      await mcp.run(ctx);
      expect(writes).toHaveLength(1);
      const envelope = JSON.parse(writes[0]!);
      expect(envelope).toMatchObject({
        code: 'invalid_invocation',
        message: 'mcp does not take --password-fd',
        details: { field: 'password-fd', state: 'unused-flag', sideEffects: false },
      });
      expect(envelope.hint).toContain('JINN_PASSWORD');
      expect(envelope.hint).toContain('keystore-password');
      expect(exits).toEqual([11]);
    },
  );
});
