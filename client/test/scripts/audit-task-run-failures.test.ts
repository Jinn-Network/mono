import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const clientRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxBin = join(clientRoot, 'node_modules/.bin/tsx');
const scriptPath = join(clientRoot, 'scripts/audit-task-run-failures.ts');

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
    env: { ...process.env, NO_COLOR: '1' },
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

describe('audit-task-run-failures CLI output safety', () => {
  it('redacts raw operator data and terminal controls from default human and JSON drilldown output', () => {
    withTempDb((dbPath) => {
      createFullSchemaDb(dbPath);

      const human = runAudit(dbPath, ['--all', '--drilldown']);
      const jsonText = runAudit(dbPath, ['--all', '--drilldown', '--json']);

      for (const output of [human, jsonText]) {
        expect(output).not.toContain('OPENROUTER_API_KEY');
        expect(output).not.toContain('sk-or-v1-raw-secret');
        expect(output).not.toContain('raw-bearer-token');
        expect(output).not.toContain('rpc-raw-secret-token');
        expect(output).not.toContain('\u001b');
        expect(output).not.toContain('\u0007');
        expect(output).not.toContain(dbPath);
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

      expect(() => runAudit(dbPath, ['--all', '--config', '/tmp/jinn-config.json', '--drildown'])).toThrow(
        /Unknown flag: --drildown/,
      );
    });
  });
});
