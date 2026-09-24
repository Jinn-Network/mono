import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNBOOK = readFileSync(
  resolve(REPOSITORY_ROOT, 'docs/runbooks/phase-b-native-vertical.md'),
  'utf8',
);
const RESTART_DRILL_WORKFLOW = readFileSync(
  resolve(REPOSITORY_ROOT, '.github/workflows/native-restart-drill.yml'),
  'utf8',
);

describe('Phase B native vertical runbook contract', () => {
  it('pins the accepted command and Base Sepolia deployment', () => {
    expect(RUNBOOK).toContain('jinn native-vertical request \\\n');
    expect(RUNBOOK).toContain('--network base-sepolia');
    expect(RUNBOOK).toContain('--fixture prediction-forecast-golden.json');
    expect(RUNBOOK).toContain('--run-id <unique-run-id>');
    expect(RUNBOOK).toContain('`0x14a34` (`84532`)');
    expect(RUNBOOK).toContain('`0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98`');
    expect(RUNBOOK).toContain('`0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247`');
    expect(RUNBOOK).toContain('`0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7`');
    expect(RUNBOOK).toContain('`0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70`');
    expect(RUNBOOK).toContain('BASE_SEPOLIA_RPC_URL');
    expect(RUNBOOK).toContain('JINN_NO_UI=1');
  });

  it('requires read-only chain, code, simulation, fee, and funding checks before keys', () => {
    const preflight = RUNBOOK.indexOf('## Preflight: complete before loading keys');
    const keyLoading = RUNBOOK.indexOf('Only after that report passes may each process request its password');
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(keyLoading).toBeGreaterThan(preflight);
    for (const rpcMethod of [
      'eth_chainId',
      'eth_getCode',
      'eth_call',
      'eth_estimateGas',
      'eth_getBalance',
    ]) {
      expect(RUNBOOK).toContain(rpcMethod);
    }
    for (const cap of [
      'createTaskMaxWei',
      'claimMaxWei',
      'solutionSettlementMaxWei',
      'evaluationClaimMaxWei',
      'verdictSettlementMaxWei',
      'escrowMaxWei',
    ]) {
      expect(RUNBOOK).toContain(cap);
    }
  });

  it('pins all six recovery boundaries and refuses premature closure or mainnet', () => {
    for (const checkpoint of [
      'posting',
      'claim',
      'backend-submit',
      'evidence',
      'solution-settlement',
      'verdict-settlement',
    ]) {
      expect(RUNBOOK).toContain(`\`${checkpoint}\``);
    }
    expect(RUNBOOK).toContain('no live run');
    expect(RUNBOOK).toContain('no default flip');
    expect(RUNBOOK).toContain('chain ID `8453`');
    expect(RUNBOOK).toContain('operator.verticalMode = "legacy"');
  });

  it('requires public closure evidence without producer-private material', () => {
    for (const section of [
      '## Startup order',
      '## Required health before request',
      '## Public artifact capture',
      '## Completion and explicit non-completion',
      '## Rollback to compatibility mode',
    ]) {
      expect(RUNBOOK).toContain(section);
    }
    for (const evidence of [
      'package tarball digests',
      'requester, solver, and evaluator signed source heads',
      'solution and verdict operation IDs',
      'https://sepolia.basescan.org/tx/<hash>',
      'all six recovery-report digests',
      'independent consumer report',
      'not a producer-private configuration path',
    ]) {
      expect(RUNBOOK).toContain(evidence);
    }
    expect(RUNBOOK).toContain('Do not retain passwords, private keys');
  });

  it('names the restart-drill CI lane, harness fence, and seeded-fixture liveRunDelta', () => {
    expect(RUNBOOK).toContain('yarn drill:native-restart:verify');
    expect(RUNBOOK).toContain('.github/workflows/native-restart-drill.yml');
    expect(RUNBOOK).toContain('broadcastOnce');
    expect(RUNBOOK).toContain('invocations.broadcast');
    expect(RUNBOOK).toContain('invocations.broadcastSent');
    expect(RUNBOOK).toContain('single-role seeded-fixture framing');
  });

  it('keeps the restart-drill lane off the merge path and fail-closed', () => {
    expect(RESTART_DRILL_WORKFLOW).toContain('yarn drill:native-restart:verify');
    expect(RESTART_DRILL_WORKFLOW).toContain('foundry-rs/foundry-toolchain@v1');
    expect(RESTART_DRILL_WORKFLOW).toContain('workflow_dispatch');
    expect(RESTART_DRILL_WORKFLOW).toContain('schedule:');
    expect(RESTART_DRILL_WORKFLOW).not.toMatch(/^ {2}pull_request:/mu);
    expect(RESTART_DRILL_WORKFLOW).not.toMatch(/^ {2}merge_group:/mu);
    expect(RESTART_DRILL_WORKFLOW).not.toContain('continue-on-error');
  });

  it('builds the operator dependency stack before the drill runs', () => {
    // The drill's role-host processes import several @jinn-network/* portal packages by their
    // built dist/index.js entry point; dist/ is gitignored and install alone does not produce it.
    // build:stack alone is not enough — build:core depends on the plugin package.
    const buildStep = 'yarn build:sdk && yarn build:stack && yarn build:plugin && yarn build:core';
    expect(RESTART_DRILL_WORKFLOW).toContain(buildStep);
    const installIndex = RESTART_DRILL_WORKFLOW.indexOf('yarn install --immutable');
    const buildIndex = RESTART_DRILL_WORKFLOW.indexOf(buildStep);
    // lastIndexOf: the header comment also names the verify command ahead of the actual step.
    const verifyIndex = RESTART_DRILL_WORKFLOW.lastIndexOf('yarn drill:native-restart:verify');
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
    // 60 minutes only covered install + verify; the build step adds real time
    // on top of the drill's own 900s + 1800s per-case allowance.
    expect(RESTART_DRILL_WORKFLOW).toContain('timeout-minutes: 120');
  });
});
