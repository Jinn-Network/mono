import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTOPILOT_ROOT = join(HERE, '..');
const LAUNCHER_PATH = join(AUTOPILOT_ROOT, 'bin', 'jinn-hermes-stateless.py');

it('runs Hermes with synchronous delivery and clears the session context on exit', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jinn-hermes-stateless-'));
  const fakeModulesRoot = join(tempRoot, 'modules');
  const tracePath = join(tempRoot, 'trace.jsonl');

  try {
    mkdirSync(join(fakeModulesRoot, 'gateway'), { recursive: true });
    mkdirSync(join(fakeModulesRoot, 'hermes_cli'), { recursive: true });

    writeFileSync(
      join(fakeModulesRoot, 'gateway', 'session_context.py'),
      `import json
import os


def _trace(event):
    with open(os.environ["TRACE_FILE"], "a", encoding="utf-8") as trace_file:
        trace_file.write(json.dumps(event) + "\\n")


def set_session_vars(**kwargs):
    _trace({"event": "set", **kwargs})
    return [object()]


def clear_session_vars(tokens):
    _trace({"event": "clear", "token_count": len(tokens)})
`,
    );
    writeFileSync(
      join(fakeModulesRoot, 'hermes_cli', 'main.py'),
      `import json
import os
import sys


def main():
    with open(os.environ["TRACE_FILE"], "a", encoding="utf-8") as trace_file:
        trace_file.write(json.dumps({"event": "main", "argv": sys.argv[1:]}) + "\\n")
    raise SystemExit(0)
`,
    );

    const result = spawnSync(
      process.env.PYTHON ?? 'python3',
      [LAUNCHER_PATH, 'chat', '-q', 'PROMPT-MARKER'],
      {
        cwd: AUTOPILOT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: fakeModulesRoot,
          TRACE_FILE: tracePath,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(
      readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        event: 'set',
        source: 'jinn-autopilot',
        cwd: AUTOPILOT_ROOT,
        async_delivery: false,
      },
      { event: 'main', argv: ['chat', '-q', 'PROMPT-MARKER'] },
      { event: 'clear', token_count: 1 },
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
