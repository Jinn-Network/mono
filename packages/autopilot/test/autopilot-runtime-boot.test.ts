import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTOPILOT_RUNTIME_ENV } from '../src/autopilot-runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

describe('Autopilot runtime boot guard', () => {
  it('exits before a cycle when the process-wide runtime is invalid', () => {
    const result = spawnSync(
      'yarn',
      ['autopilot', '--dry-run'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          [AUTOPILOT_RUNTIME_ENV]: 'codex',
        },
        encoding: 'utf8',
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toMatch(/JINN_AUTOPILOT_RUNTIME.*claude.*hermes.*cursor/i);
    expect(output).not.toContain('Cycle report');
  });
});
