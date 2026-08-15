import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNBOOK = readFileSync(
  resolve(REPOSITORY_ROOT, 'docs/runbooks/phase-b-native-vertical.md'),
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
});
