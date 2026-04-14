import { describe, expect, it } from 'vitest';
import { renderTopLevelHelp, renderCommandHelp } from '../../src/cli/help.js';
import type { CommandModule } from '../../src/cli/command.js';

const fakeCommand: CommandModule = {
  name: 'test-verb',
  summary: 'a fake verb for tests',
  helpText: 'Usage: jinn test-verb [--flag]\n\nExamples:\n  jinn test-verb --flag\n',
  run: async () => {
    /* unused */
  },
};

describe('renderTopLevelHelp', () => {
  it('lists every registered command with its summary', () => {
    const out = renderTopLevelHelp([fakeCommand]);
    expect(out).toContain('jinn test-verb');
    expect(out).toContain('a fake verb for tests');
    expect(out).toContain('Usage: jinn <verb>');
  });
});

describe('renderCommandHelp', () => {
  it('prepends the verb name and summary to helpText', () => {
    const out = renderCommandHelp(fakeCommand);
    expect(out).toContain('jinn test-verb');
    expect(out).toContain('a fake verb for tests');
    expect(out).toContain('Usage: jinn test-verb');
    expect(out).toContain('Examples:');
  });
});
