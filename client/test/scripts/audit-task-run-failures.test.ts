import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const clientRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxBin = join(clientRoot, 'node_modules/.bin/tsx');
const scriptPath = join(clientRoot, 'scripts/audit-task-run-failures.ts');

function auditEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('JINN_') || key === 'BASE_RPC_URL' || key === 'BASE_SEPOLIA_RPC_URL') {
      delete env[key];
    }
  }
  return { ...env, ...overrides, NO_COLOR: '1' };
}

function withTempDb(fn: (dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-audit-failures-'));
  try {
    fn(join(dir, 'jinn.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runAudit(dbPath: string, args: string[]): string {
  return execFileSync(process.execPath, [tsxBin, scriptPath, '--db', dbPath, ...args], {
    cwd: clientRoot,
    encoding: 'utf8',
    env: auditEnv(),
  });
}

function runAuditProcess(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxBin, scriptPath, ...args], {
    cwd: clientRoot,
    encoding: 'utf8',
    env: auditEnv(env),
  });
}

function createFullSchemaDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE task_runs (
        request_id TEXT NOT NULL,
        task_id TEXT,
        attempt_index INTEGER,
        solver_type TEXT,
        task_role TEXT,
        impl_name TEXT,
        solver_net_manifest_cid TEXT,
        state_updated_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        failure_reason TEXT
      );
    `);
    db.prepare(
      `INSERT INTO task_runs
        (request_id, task_id, attempt_index, solver_type, task_role, impl_name,
         solver_net_manifest_cid, state_updated_at, state, failure_reason)
       VALUES
        (@request_id, @task_id, @attempt_index, @solver_type, @task_role, @impl_name,
         @solver_net_manifest_cid, @state_updated_at, @state, @failure_reason)`,
    ).run({
      request_id: 'req-raw-secret-1234567890',
      task_id: 'task-raw-secret-id',
      attempt_index: 7,
      solver_type: 'prediction.v0',
      task_role: 'restoration',
      impl_name: 'impl-raw-secret-name',
      solver_net_manifest_cid: 'bafyRawSecretManifestCid1234567890',
      state_updated_at: Date.UTC(2026, 5, 14),
      state: 'FAILED',
      failure_reason:
        'OPENROUTER_API_KEY=sk-or-v1-raw-secret ' +
        'Bearer raw-bearer-token ' +
        'https://rpc.example.test/v3/rpc-raw-secret-token ' +
        '\u001b]0;owned\u0007\u001b[31mred\u001b[0m ' +
        'Error code: 429 - rate limited',
    });
  } finally {
    db.close();
  }
}

function createDbWithFailureReasons(dbPath: string, failureReasons: string[]): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE task_runs (
        request_id TEXT NOT NULL,
        task_id TEXT,
        attempt_index INTEGER,
        solver_type TEXT,
        task_role TEXT,
        impl_name TEXT,
        solver_net_manifest_cid TEXT,
        state_updated_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        failure_reason TEXT
      );
    `);
    const insert = db.prepare(
      `INSERT INTO task_runs
        (request_id, task_id, attempt_index, solver_type, task_role, impl_name,
         solver_net_manifest_cid, state_updated_at, state, failure_reason)
       VALUES
        (@request_id, @task_id, @attempt_index, @solver_type, @task_role, @impl_name,
         @solver_net_manifest_cid, @state_updated_at, @state, @failure_reason)`,
    );
    for (const [index, failure_reason] of failureReasons.entries()) {
      insert.run({
        request_id: `req-row-${index}`,
        task_id: `task-row-${index}`,
        attempt_index: index,
        solver_type: 'prediction.v0',
        task_role: 'restoration',
        impl_name: `impl-row-${index}`,
        solver_net_manifest_cid: `bafy-row-${index}`,
        state_updated_at: Date.UTC(2026, 5, 14) + index,
        state: 'FAILED',
        failure_reason,
      });
    }
  } finally {
    db.close();
  }
}

describe('audit-task-run-failures CLI output safety', () => {
  it('does not leak the default config path when resolving the DB path in safe mode', () => {
    const home = mkdtempSync(join(tmpdir(), 'jinn-audit-home-'));
    try {
      const clientHome = join(home, '.jinn-client');
      const configPath = join(clientHome, 'config.json');
      const dbPath = join(clientHome, 'jinn.db');
      mkdirSync(clientHome, { recursive: true });
      createFullSchemaDb(dbPath);
      writeFileSync(configPath, JSON.stringify({ dbPath }), 'utf8');

      const result = runAuditProcess(['--all'], { HOME: home });
      expect(result.status).toBe(0);

      for (const output of [result.stdout, result.stderr]) {
        expect(output).not.toContain(configPath);
        expect(output).not.toContain(home);
        expect(output).not.toContain('.jinn-client/config.json');
      }
      expect(result.stdout).toContain('<redacted-db>');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts the documented Yarn -- passthrough argument', () => {
    withTempDb((dbPath) => {
      createFullSchemaDb(dbPath);

      const output = runAudit(dbPath, ['--', '--all']);

      expect(output).toContain('Failure-cause audit');
      expect(output).toContain('TOTAL');
    });
  });

  it('prints sanitized CLI errors without stack traces for unknown flags', () => {
    const result = runAuditProcess(['--unknown-audit-flag']);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unknown flag: --unknown-audit-flag');
    expect(result.stderr).not.toContain(scriptPath);
    expect(result.stderr).not.toContain(clientRoot);
    expect(result.stderr).not.toContain('/scripts/audit-task-run-failures.ts');
    expect(result.stderr).not.toContain('at ');
  });

  it('redacts raw operator data and terminal controls from default human and JSON drilldown output', () => {
    withTempDb((dbPath) => {
      createFullSchemaDb(dbPath);

      const human = runAudit(dbPath, ['--all', '--drilldown']);
      const jsonText = runAudit(dbPath, ['--all', '--drilldown', '--json']);

      for (const output of [human, jsonText]) {
        expect(output).toContain('<redacted-db>');
        expect(output).not.toContain('OPENROUTER_API_KEY');
        expect(output).not.toContain('sk-or-v1-raw-secret');
        expect(output).not.toContain('raw-bearer-token');
        expect(output).not.toContain('rpc-raw-secret-token');
        expect(output).not.toContain('\u001b');
        expect(output).not.toContain('\u0007');
        expect(output).not.toContain(dbPath);
        expect(output).not.toContain('jinn.db');
        expect(output).not.toContain('req-raw-secret-1234567890');
        expect(output).not.toContain('task-raw-secret-id');
        expect(output).not.toContain('impl-raw-secret-name');
        expect(output).not.toContain('bafyRawSecretManifestCid1234567890');
      }
    });
  });

  it('exposes raw drilldown fields only behind --unsafe-raw', () => {
    withTempDb((dbPath) => {
      createFullSchemaDb(dbPath);

      const output = runAudit(dbPath, ['--all', '--drilldown', '--unsafe-raw']);

      expect(output).toContain(dbPath);
      expect(output).toContain('OPENROUTER_API_KEY=sk-or-v1-raw-secret');
      expect(output).toContain('Bearer raw-bearer-token');
      expect(output).toContain('rpc-raw-secret-token');
      expect(output).toContain('req-raw-secret-1234567890');
      expect(output).toContain('task-raw-secret-id');
      expect(output).toContain('impl-raw-secret-name');
      expect(output).toContain('bafyRawSecretManifestCid1234567890');
    });
  });

  it('redacts local paths and embedded identifiers from safe reason snippets', () => {
    withTempDb((dbPath) => {
      const requestPathId = '01J3Q9RM0T0A7P9B6C5D4E3F2G';
      const walletAddress = '0x1234567890abcdef1234567890abcdef12345678';
      const privateKeyLikeHex = 'a'.repeat(64);
      const staleHookPath = "/Users/alice/life's-work/jinn-mono/client/hooks/session-start";
      createDbWithFailureReasons(dbPath, [
        `Required artifact missing: /Users/alice/Library/Application Support/jinn/engine-work/requests/${requestPathId}/.orient/summary.json sk-proj-local-secret ghp_localSecretToken1234567890 ${walletAddress} ${privateKeyLikeHex}`,
        `Failed to load stale hook path ${staleHookPath}`,
      ]);

      const human = runAudit(dbPath, ['--all', '--drilldown']);
      const jsonText = runAudit(dbPath, ['--all', '--drilldown', '--json']);

      for (const output of [human, jsonText]) {
        expect(output).not.toContain('/Users/alice');
        expect(output).not.toContain('Application Support');
        expect(output).not.toContain('engine-work');
        expect(output).not.toContain(requestPathId);
        expect(output).not.toContain('summary.json');
        expect(output).not.toContain(staleHookPath);
        expect(output).not.toContain('hooks/session-start');
        expect(output).not.toContain('sk-proj-local-secret');
        expect(output).not.toContain('ghp_localSecretToken1234567890');
        expect(output).not.toContain(walletAddress);
        expect(output).not.toContain(privateKeyLikeHex);
      }
    });
  });

  it('redacts generic POSIX paths and labelled request IDs from safe drilldown snippets', () => {
    withTempDb((dbPath) => {
      const rootConfigPath = '/root/.jinn-client/config.json';
      const requestIds = ['producer-request', 'camel-request', 'spaced-request'];
      createDbWithFailureReasons(dbPath, [
        `failed to open ${rootConfigPath}: permission denied`,
        `failed while processing request_id=${requestIds[0]}: no delivery`,
        `failed while processing requestId: ${requestIds[1]}: no delivery`,
        `failed while processing request id ${requestIds[2]}: no delivery`,
      ]);

      const human = runAudit(dbPath, ['--all', '--drilldown']);
      const bucket = runAudit(dbPath, ['--all', '--bucket', 'unknown']);
      const jsonText = runAudit(dbPath, ['--all', '--drilldown', '--json']);

      for (const output of [human, bucket, jsonText]) {
        expect(output).not.toContain(rootConfigPath);
        expect(output).not.toContain('/root/.jinn-client');
        expect(output).not.toContain('config.json');
        for (const requestId of requestIds) {
          expect(output).not.toContain(requestId);
        }
        expect(output).not.toContain(`request_id=${requestIds[0]}`);
        expect(output).not.toContain(`requestId: ${requestIds[1]}`);
        expect(output).not.toContain(`request id ${requestIds[2]}`);
        expect(output).toContain('<redacted-path>');
        expect(output).toContain('<redacted-id>');
      }
    });
  });

  it('redacts file URI filesystem paths from safe drilldown snippets', () => {
    withTempDb((dbPath) => {
      const fileUri = 'file:///root/.jinn-client/config.json';
      const producerRequestId = 'producer-request';
      createDbWithFailureReasons(dbPath, [
        `failed reading ${fileUri} for request_id=${producerRequestId}`,
      ]);

      const human = runAudit(dbPath, ['--all', '--drilldown']);
      const bucket = runAudit(dbPath, ['--all', '--bucket', 'unknown']);
      const jsonText = runAudit(dbPath, ['--all', '--json', '--drilldown']);

      for (const output of [human, bucket, jsonText]) {
        expect(output).not.toContain(fileUri);
        expect(output).not.toContain('file:///root/.jinn-client/config.json');
        expect(output).not.toContain('/root/.jinn-client');
        expect(output).not.toContain('config.json');
        expect(output).not.toContain(producerRequestId);
        expect(output).not.toContain(`request_id=${producerRequestId}`);
        expect(output).toContain('<redacted-path>');
        expect(output).toContain('<redacted-id>');
      }
    });
  });

  it('keeps embedded failure_reason paths available behind --unsafe-raw', () => {
    withTempDb((dbPath) => {
      const requestPathId = '01J3Q9RM0T0A7P9B6C5D4E3F2G';
      const missingArtifactPath = `/Users/alice/engine-work/requests/${requestPathId}/.orient/summary.json`;
      const staleHookPath = "/Users/alice/life's-work/jinn-mono/client/hooks/session-start";
      createDbWithFailureReasons(dbPath, [
        `Required artifact missing: ${missingArtifactPath}`,
        `Failed to load stale hook path ${staleHookPath}`,
      ]);

      const output = runAudit(dbPath, ['--all', '--drilldown', '--unsafe-raw']);

      expect(output).toContain(missingArtifactPath);
      expect(output).toContain(staleHookPath);
    });
  });

  it('keeps generic POSIX paths and labelled request IDs raw behind --unsafe-raw', () => {
    withTempDb((dbPath) => {
      const rootConfigPath = '/root/.jinn-client/config.json';
      const producerRequestId = 'producer-request';
      const camelRequestId = 'camel-request';
      const spacedRequestId = 'spaced-request';
      createDbWithFailureReasons(dbPath, [
        `failed to open ${rootConfigPath}: permission denied`,
        `failed while processing request_id=${producerRequestId}: no delivery`,
        `failed while processing requestId: ${camelRequestId}: no delivery`,
        `failed while processing request id ${spacedRequestId}: no delivery`,
      ]);

      const output = runAudit(dbPath, ['--all', '--drilldown', '--unsafe-raw']);

      expect(output).toContain(rootConfigPath);
      expect(output).toContain(`request_id=${producerRequestId}`);
      expect(output).toContain(`requestId: ${camelRequestId}`);
      expect(output).toContain(`request id ${spacedRequestId}`);
    });
  });

  it('keeps file URI filesystem paths raw behind --unsafe-raw', () => {
    withTempDb((dbPath) => {
      const fileUri = 'file:///root/.jinn-client/config.json';
      const producerRequestId = 'producer-request';
      createDbWithFailureReasons(dbPath, [
        `failed reading ${fileUri} for request_id=${producerRequestId}`,
      ]);

      const output = runAudit(dbPath, ['--all', '--drilldown', '--unsafe-raw']);

      expect(output).toContain(fileUri);
      expect(output).toContain(`request_id=${producerRequestId}`);
    });
  });

  it('selects NULL for optional legacy columns that are absent from older task_runs tables', () => {
    withTempDb((dbPath) => {
      const db = new Database(dbPath);
      try {
        db.exec(`
          CREATE TABLE task_runs (
            request_id TEXT NOT NULL,
            solver_type TEXT,
            impl_name TEXT,
            state_updated_at INTEGER NOT NULL,
            state TEXT NOT NULL,
            failure_reason TEXT
          );
        `);
        db.prepare(
          `INSERT INTO task_runs
            (request_id, solver_type, impl_name, state_updated_at, state, failure_reason)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run('legacy-request-id', 'prediction.v0', 'legacy-impl', Date.UTC(2026, 5, 14), 'FAILED', 'fetch failed');
      } finally {
        db.close();
      }

      const output = runAudit(dbPath, ['--all']);

      expect(output).toContain('rpc_outage');
      expect(output).toContain('TOTAL');
    });
  });

  it('rejects unknown CLI flags while still accepting --config passthrough', () => {
    withTempDb((dbPath) => {
      createFullSchemaDb(dbPath);

      const result = runAuditProcess([
        '--db',
        dbPath,
        '--all',
        '--config',
        '/tmp/jinn-config.json',
        '--drildown',
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Unknown flag: --drildown');
    });
  });
});
