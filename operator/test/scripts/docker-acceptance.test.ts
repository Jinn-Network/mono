import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildDockerComposeEnv,
  dockerAcceptanceComposeEnvPath,
  dockerAcceptanceConfigPath,
  dockerAcceptanceEvidenceRoot,
  dockerAcceptanceWorkspaceRoot,
  dockerAcceptanceClaudeAuthRemedy,
  formatEnvFile,
  hasDockerAcceptanceClaudeToken,
  resolveDockerAcceptanceBaseEnv,
} from '../../scripts/lib/docker-acceptance.mjs';
import { cycleTaskId, isoToSqliteTimestamp, summarizeArtifactRows, summarizeRunWindowArtifacts } from '../../scripts/lib/acceptance-artifacts.mjs';

const tempDirs: string[] = [];
const repoClientRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    expect(composeEnv.JINN_DISABLE_AUTO_TASKS).toBe('1');
    expect(composeEnv.JINN_PREDICTION_V0_WINDOW_MS).toBe('120000');
    expect(composeEnv.JINN_PREDICTION_V0_RESOLVE_GAP_MS).toBe('60000');
    expect(composeEnv.JINN_POLYMARKET_GAMMA_BASE_URL).toBe('');
    expect(composeEnv.JINN_POLYMARKET_CLOB_BASE_URL).toBe('');
    expect(composeEnv.JINN_ACCEPTANCE_CONFIG_FILE).toBe(dockerAcceptanceConfigPath(clientRoot));
    expect(dockerAcceptanceWorkspaceRoot(clientRoot)).toBe(join(clientRoot, '.acceptance'));
    expect(dockerAcceptanceComposeEnvPath(clientRoot)).toBe(join(clientRoot, '.acceptance', 'docker-compose.env'));
    expect(dockerAcceptanceEvidenceRoot(clientRoot)).toBe(join(clientRoot, 'acceptance-runs'));
  });

  it('maps host.docker.internal for Linux Docker acceptance fixtures', () => {
    const compose = readFileSync(join(repoClientRoot, 'docker-compose.acceptance.yml'), 'utf8');

    expect(compose).toContain('extra_hosts:');
    expect(compose).toContain('"host.docker.internal:host-gateway"');
  });

  it('formats env files in sorted key order', () => {
    const rendered = formatEnvFile({
      B_KEY: 'second',
      A_KEY: 'first',
    });

    expect(rendered).toBe('A_KEY=first\nB_KEY=second\n');
  });

  it('detects whether non-interactive Claude auth is configured', () => {
    expect(hasDockerAcceptanceClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token' })).toBe(true);
    expect(hasDockerAcceptanceClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: '   ' })).toBe(false);
    expect(hasDockerAcceptanceClaudeToken({})).toBe(false);
  });

  it('explains the durable Claude auth fix without treating generated env as persistent', () => {
    const remedy = dockerAcceptanceClaudeAuthRemedy();

    expect(remedy).toContain('operator/.env.acceptance');
    expect(remedy).toContain('Do not edit that generated file directly');
    expect(remedy).toContain('claude setup-token');
    expect(remedy).toContain('auth login');
  });
});

describe('artifact cycle summaries', () => {
  it('counts successful cycles per Task from append-only artifacts', () => {
    const summary = summarizeArtifactRows([
      {
        task_id: 'one',
        request_id: 'req-1',
        title: 'restoration one',
        tags: '["restoration-result"]',
        outcome: 'SUCCESS',
        created_at: '2026-04-16T10:00:00.000Z',
      },
      {
        task_id: 'one',
        request_id: 'req-1',
        title: 'evaluation one',
        tags: '["evaluation-verdict"]',
        outcome: 'SUCCESS',
        created_at: '2026-04-16T10:05:00.000Z',
      },
      {
        task_id: 'two',
        request_id: 'req-2',
        title: 'restoration two',
        tags: '["restoration-result"]',
        outcome: 'SUCCESS',
        created_at: '2026-04-16T10:10:00.000Z',
      },
      {
        task_id: 'two',
        request_id: 'req-2',
        title: 'evaluation two',
        tags: '["evaluation-verdict"]',
        outcome: 'FAILURE',
        created_at: '2026-04-16T10:15:00.000Z',
      },
    ], ['one', 'two']);

    expect(summary.completedCycles).toBe(1);
    expect(summary.byTask.one.successfulRestorations).toBe(1);
    expect(summary.byTask.one.successfulEvaluations).toBe(1);
    expect(summary.byTask.two.successfulRestorations).toBe(1);
    expect(summary.byTask.two.successfulEvaluations).toBe(0);
  });
});

describe('summarizeRunWindowArtifacts', () => {
  const runStartAt = '2026-04-30T10:00:00.000Z';

  it('counts a cycle complete only when both restoration and evaluation succeed for the same task_id', () => {
    // Real shape: SQLite stores `created_at` as `YYYY-MM-DD HH:MM:SS`
    // (CURRENT_TIMESTAMP default), not ISO 8601. Restoration and evaluation
    // phases each get their own on-chain request_id; they share the
    // prediction.v0 auto-gen bucket id (`pred-v0-auto-<bucket>`) as
    // task_id.
    const summary = summarizeRunWindowArtifacts(
      [
        {
          task_id: 'pred-v0-auto-1714464000000',
          request_id: '0xrestreq1',
          tags: '["restoration-result"]',
          outcome: 'SUCCESS',
          created_at: '2026-04-30 10:03:00',
        },
        {
          task_id: 'pred-v0-auto-1714464000000',
          request_id: '0xevalreq1',
          tags: '["evaluation-verdict"]',
          outcome: 'SUCCESS',
          created_at: '2026-04-30 10:06:00',
        },
        {
          task_id: 'pred-v0-auto-1714464120000',
          request_id: '0xrestreq2',
          tags: '["restoration-result"]',
          outcome: 'SUCCESS',
          created_at: '2026-04-30 10:09:00',
        },
      ],
      runStartAt,
    );

    expect(summary.completedCycles).toBe(1);
    expect(summary.byTaskId).toHaveLength(2);
    const cycle1 = summary.byTaskId.find((e) => e.taskId === 'pred-v0-auto-1714464000000');
    expect(cycle1?.restorationOk).toBe(true);
    expect(cycle1?.evaluationOk).toBe(true);
    expect(cycle1?.restorationRequestId).toBe('0xrestreq1');
    expect(cycle1?.evaluationRequestId).toBe('0xevalreq1');
    const cycle2 = summary.byTaskId.find((e) => e.taskId === 'pred-v0-auto-1714464120000');
    expect(cycle2?.restorationOk).toBe(true);
    expect(cycle2?.evaluationOk).toBe(false);
  });

  it('groups Task-native evaluation suffixes back to the restoration task id', () => {
    const summary = summarizeRunWindowArtifacts(
      [
        {
          task_id: 'release-acceptance-1',
          request_id: '0xrestreq',
          tags: '["restoration-result"]',
          outcome: 'SUCCESS',
          created_at: '2026-04-30 10:03:00',
        },
        {
          task_id: 'release-acceptance-1:evaluation:0',
          request_id: '0xevalreq',
          tags: '["evaluation-verdict"]',
          outcome: 'SUCCESS',
          created_at: '2026-04-30 10:04:00',
        },
      ],
      runStartAt,
    );

    expect(cycleTaskId('release-acceptance-1:evaluation:0')).toBe('release-acceptance-1');
    expect(summary.completedCycles).toBe(1);
    expect(summary.byTaskId).toEqual([
      expect.objectContaining({
        taskId: 'release-acceptance-1',
        restorationOk: true,
        evaluationOk: true,
      }),
    ]);
  });

  it('excludes rows created before runStartAt (SQLite TEXT format comparison)', () => {
    const summary = summarizeRunWindowArtifacts(
      [
        {
          task_id: 'pred-v0-auto-old',
          request_id: '0xstaleR',
          tags: '["restoration-result"]',
          outcome: 'SUCCESS',
          created_at: '2026-04-30 09:30:00',
        },
        {
          task_id: 'pred-v0-auto-old',
          request_id: '0xstaleE',
          tags: '["evaluation-verdict"]',
          outcome: 'SUCCESS',
          created_at: '2026-04-30 09:45:00',
        },
      ],
      runStartAt,
    );

    expect(summary.completedCycles).toBe(0);
    expect(summary.byTaskId).toHaveLength(0);
  });

  it('returns zero cycles for an empty row set', () => {
    const summary = summarizeRunWindowArtifacts([], runStartAt);
    expect(summary.completedCycles).toBe(0);
    expect(summary.byTaskId).toEqual([]);
  });

  it('does not silently exclude rows due to timezone interpretation mismatch', () => {
    // Regression: SQLite `created_at` parsed via Date.parse() was treated as
    // local time while ISO `runStartAt` (with Z) is UTC. With the local zone
    // ahead of UTC, every SQLite row appeared "earlier" than runStartAt by a
    // full TZ offset and was silently dropped — the live gate saw 0 cycles
    // even when complete pairs existed.
    const summary = summarizeRunWindowArtifacts(
      [
        {
          task_id: 'pred-v0-auto-1777545600000',
          request_id: '0xrestreq',
          tags: '["restoration-result"]',
          outcome: 'SUCCESS',
          // SQLite-format, only seconds after the ISO runStartAt below.
          created_at: '2026-04-30 10:00:30',
        },
        {
          task_id: 'pred-v0-auto-1777545600000',
          request_id: '0xevalreq',
          tags: '["evaluation-verdict"]',
          outcome: 'SUCCESS',
          created_at: '2026-04-30 10:01:00',
        },
      ],
      // runStartAt is the ISO format new Date().toISOString() produces.
      '2026-04-30T10:00:00.000Z',
    );
    expect(summary.completedCycles).toBe(1);
  });
});

describe('isoToSqliteTimestamp', () => {
  it('rewrites ISO 8601 with milliseconds and Z to SQLite TEXT format', () => {
    expect(isoToSqliteTimestamp('2026-04-30T10:18:50.041Z')).toBe('2026-04-30 10:18:50');
  });

  it('rewrites ISO 8601 without milliseconds to SQLite TEXT format', () => {
    expect(isoToSqliteTimestamp('2026-04-30T10:18:50Z')).toBe('2026-04-30 10:18:50');
  });

  it('leaves SQLite-style timestamps unchanged', () => {
    expect(isoToSqliteTimestamp('2026-04-30 10:18:50')).toBe('2026-04-30 10:18:50');
  });

  it('preserves comparison ordering against SQLite-stored timestamps', () => {
    // Lexicographic check: with the bug, '2026-04-30T10:18:50.041Z' > '2026-04-30 10:35:00'
    // (because 'T' > ' '), so a row dated 10:35 would be excluded by `>= '2026-04-30T10:18...'`.
    // After conversion, '2026-04-30 10:18:50' < '2026-04-30 10:35:00' as expected.
    const since = isoToSqliteTimestamp('2026-04-30T10:18:50.041Z');
    expect(since < '2026-04-30 10:35:06').toBe(true);
  });
});
