import { spawnSync } from 'node:child_process';
import { canonicalHarnessName, CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../src/harnesses/names.js';

export type LearnerHarnessName = typeof CLAUDE_CODE_HARNESS | typeof CODEX_HARNESS;

export interface LearnerHarnessE2EConfig {
  harnessName: LearnerHarnessName;
  cliPath: string;
  model: string;
}

const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';

export function readLearnerHarnessE2EConfig(env: NodeJS.ProcessEnv = process.env): LearnerHarnessE2EConfig {
  const rawHarness = canonicalHarnessName(
    env['JINN_E2E_LEARNER_HARNESS'] ?? env['JINN_LEARNER_HARNESS'] ?? CLAUDE_CODE_HARNESS,
  );
  if (rawHarness !== CLAUDE_CODE_HARNESS && rawHarness !== CODEX_HARNESS) {
    throw new Error(
      `Unsupported JINN_E2E_LEARNER_HARNESS=${JSON.stringify(rawHarness)}; ` +
        'expected claude-code or codex',
    );
  }

  const cliPath = env['JINN_E2E_LEARNER_CLI_PATH']
    ?? (rawHarness === CODEX_HARNESS ? 'codex' : 'claude');
  const model = env['JINN_E2E_LEARNER_MODEL']
    ?? (rawHarness === CODEX_HARNESS ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL);

  return {
    harnessName: rawHarness,
    cliPath,
    model,
  };
}

export function checkLearnerCli(config: LearnerHarnessE2EConfig): { ok: true; version: string } | { ok: false; reason: string } {
  const check = spawnSync(config.cliPath, ['--version'], { encoding: 'utf8' });
  if (check.status !== 0) {
    return {
      ok: false,
      reason: `${config.cliPath} CLI not in PATH or not executable; set JINN_E2E_LEARNER_CLI_PATH to override`,
    };
  }
  return {
    ok: true,
    version: (check.stdout || check.stderr).trim(),
  };
}
