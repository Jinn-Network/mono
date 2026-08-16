import { spawnSync } from 'node:child_process';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { canonicalHarnessName, CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../src/harnesses/names.js';
import type { Harness } from '../../src/harnesses/types.js';

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

export type LearnerFullCycleBootstrap =
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string }
  | { kind: 'ready'; config: LearnerHarnessE2EConfig; harness: Harness; cliVersion: string };

export function bootstrapLearnerFullCycleE2e(): LearnerFullCycleBootstrap {
  const config = readLearnerHarnessE2EConfig();
  const cliCheck = checkLearnerCli(config);
  if (!cliCheck.ok) {
    return { kind: 'skip', reason: cliCheck.reason };
  }

  const harness = buildHarnesses({
    stub: true,
    rpcUrl: 'http://stub',
    claudePath: config.harnessName === CLAUDE_CODE_HARNESS ? config.cliPath : 'claude',
    claudeModel: config.model,
    codexPath: config.harnessName === CODEX_HARNESS ? config.cliPath : 'codex',
    codexModel: config.model,
  }).find((impl) => impl.name === config.harnessName);

  if (!harness) {
    return {
      kind: 'fail',
      reason: `configured learner harness not registered: ${config.harnessName}`,
    };
  }

  return { kind: 'ready', config, harness, cliVersion: cliCheck.version };
}

export function logLearnerHarnessBanner(config: LearnerHarnessE2EConfig, cliVersion: string): void {
  console.log(`learner harness: ${config.harnessName}`);
  console.log(`learner CLI:     ${config.cliPath} (${cliVersion})`);
  console.log(`learner model:   ${config.model}`);
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
