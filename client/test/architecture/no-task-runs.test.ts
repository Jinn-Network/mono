import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('task_runs state machine is retired', () => {
  it('has no remaining references in operator source', () => {
    // git grep exits 1 with no output when there are no matches.
    let output = '';
    try {
      output = execFileSync(
        'git',
        ['grep', '-n', 'task_runs', '--', 'src', 'scripts'],
        { cwd: new URL('../../', import.meta.url).pathname, encoding: 'utf8' },
      );
    } catch {
      output = '';
    }
    expect(output.trim()).toBe('');
  });
});
