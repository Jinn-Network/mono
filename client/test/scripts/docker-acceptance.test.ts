import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildDockerComposeEnv,
  dockerAcceptanceComposeEnvPath,
  dockerAcceptanceConfigPath,
  dockerAcceptanceEvidenceRoot,
  dockerAcceptanceWorkspaceRoot,
  formatEnvFile,
  resolveDockerAcceptanceBaseEnv,
} from '../../scripts/lib/docker-acceptance.mjs';
import { summarizeArtifactRows } from '../../scripts/lib/acceptance-artifacts.mjs';

const tempDirs: string[] = [];

function makeClientRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jinn-docker-acceptance-'));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('docker acceptance helpers', () => {
  it('merges .env, .env.acceptance, and process env in precedence order', () => {
    const clientRoot = makeClientRoot();
    writeFileSync(join(clientRoot, '.env'), 'BASE_SEPOLIA_RPC_URL=https://public.example\nJINN_PASSWORD=from-dotenv\n');
    writeFileSync(join(clientRoot, '.env.acceptance'), 'JINN_PASSWORD=from-acceptance\nJINN_ACCEPTANCE_IMAGE=image:from-file\n');

    const env = resolveDockerAcceptanceBaseEnv({
      clientRoot,
      env: {
        JINN_PASSWORD: 'from-process',
        JINN_TESTNET_ACCEPTANCE_RPC_URL: 'https://acceptance.example',
      },
    });

    expect(env.BASE_SEPOLIA_RPC_URL).toBe('https://public.example');
    expect(env.JINN_ACCEPTANCE_IMAGE).toBe('image:from-file');
    expect(env.JINN_PASSWORD).toBe('from-process');
    expect(env.JINN_TESTNET_ACCEPTANCE_RPC_URL).toBe('https://acceptance.example');
  });

  it('builds compose env with deterministic defaults and explicit config path', () => {
    const clientRoot = makeClientRoot();
    writeFileSync(join(clientRoot, '.env'), 'BASE_SEPOLIA_RPC_URL=https://public.example\n');

    const composeEnv = buildDockerComposeEnv({
      clientRoot,
      env: { JINN_PASSWORD: 'secret' },
      imageTag: 'jinn-client:test',
    });

    expect(composeEnv.JINN_ACCEPTANCE_IMAGE).toBe('jinn-client:test');
    expect(composeEnv.JINN_PASSWORD).toBe('secret');
    expect(composeEnv.JINN_RPC_URL).toBe('https://public.example');
    expect(composeEnv.JINN_ACCEPTANCE_CONFIG_FILE).toBe(dockerAcceptanceConfigPath(clientRoot));
    expect(dockerAcceptanceWorkspaceRoot(clientRoot)).toBe(join(clientRoot, '.acceptance'));
    expect(dockerAcceptanceComposeEnvPath(clientRoot)).toBe(join(clientRoot, '.acceptance', 'docker-compose.env'));
    expect(dockerAcceptanceEvidenceRoot(clientRoot)).toBe(join(clientRoot, 'acceptance-runs'));
  });

  it('formats env files in sorted key order', () => {
    const rendered = formatEnvFile({
      B_KEY: 'second',
      A_KEY: 'first',
    });

    expect(rendered).toBe('A_KEY=first\nB_KEY=second\n');
  });
});

describe('artifact cycle summaries', () => {
  it('counts successful cycles per desired state from append-only artifacts', () => {
    const summary = summarizeArtifactRows([
      {
        desired_state_id: 'one',
        request_id: 'req-1',
        title: 'restoration one',
        tags: '["restoration-result"]',
        outcome: 'SUCCESS',
        created_at: '2026-04-16T10:00:00.000Z',
      },
      {
        desired_state_id: 'one',
        request_id: 'req-1',
        title: 'evaluation one',
        tags: '["evaluation-verdict"]',
        outcome: 'SUCCESS',
        created_at: '2026-04-16T10:05:00.000Z',
      },
      {
        desired_state_id: 'two',
        request_id: 'req-2',
        title: 'restoration two',
        tags: '["restoration-result"]',
        outcome: 'SUCCESS',
        created_at: '2026-04-16T10:10:00.000Z',
      },
      {
        desired_state_id: 'two',
        request_id: 'req-2',
        title: 'evaluation two',
        tags: '["evaluation-verdict"]',
        outcome: 'FAILURE',
        created_at: '2026-04-16T10:15:00.000Z',
      },
    ], ['one', 'two']);

    expect(summary.completedCycles).toBe(1);
    expect(summary.byDesiredState.one.successfulRestorations).toBe(1);
    expect(summary.byDesiredState.one.successfulEvaluations).toBe(1);
    expect(summary.byDesiredState.two.successfulRestorations).toBe(1);
    expect(summary.byDesiredState.two.successfulEvaluations).toBe(0);
  });
});
