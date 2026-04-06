import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'fs/promises';
import { Ledger, NewViolation } from '../../codespec/lib/ledger.js';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Ledger', () => {
  let testDir: string;
  let ledger: Ledger;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ledger-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    ledger = new Ledger(join(testDir, 'ledger.jsonl'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should create a new violation with fingerprint', async () => {
    const newViolation: NewViolation = {
      clauses: ['obj1'],
      severity: 'medium',
      path: 'test.ts',
      line: 42,
      title: 'Test violation',
      description: 'This is a test',
      suggested_fix: 'Fix it like this',
      status: 'open',
    };

    const violation = await ledger.addViolation(newViolation);

    expect(violation.id).toMatch(/^V-[a-f0-9]{6}$/);
    expect(violation.fingerprint).toBeTruthy();
    expect(violation.first_seen).toBeTruthy();
    expect(violation.last_seen).toBeTruthy();
    expect(violation.clauses).toEqual(['obj1']);
  });

  it('should deduplicate violations by fingerprint', async () => {
    const newViolation: NewViolation = {
      clauses: ['obj3'],
      severity: 'critical',
      path: 'security.ts',
      line: 10,
      title: 'Security issue',
      description: 'Hardcoded secret',
      suggested_fix: 'Use environment variable',
      status: 'open',
    };

    // Add same violation twice
    const v1 = await ledger.addViolation(newViolation);
    await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
    const v2 = await ledger.addViolation(newViolation);

    // Should have same fingerprint and ID
    expect(v2.fingerprint).toBe(v1.fingerprint);
    expect(v2.id).toBe(v1.id);

    // last_seen should be updated
    expect(new Date(v2.last_seen).getTime()).toBeGreaterThanOrEqual(
      new Date(v1.last_seen).getTime()
    );

    // Total should be 1 (deduplicated)
    const all = await ledger.getAll();
    expect(all.length).toBe(1);
  });

  it('should update violation status', async () => {
    const newViolation: NewViolation = {
      clauses: ['obj1'],
      severity: 'medium',
      path: 'test.ts',
      line: 42,
      title: 'Test violation',
      description: 'This is a test',
      suggested_fix: 'Fix it',
      status: 'open',
    };

    const violation = await ledger.addViolation(newViolation);

    // Update status
    await ledger.updateStatus(violation.fingerprint, {
      status: 'in_progress',
      owner: '@test-user',
    });

    // Retrieve updated violation
    const updated = await ledger.getByFingerprint(violation.fingerprint);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.owner).toBe('@test-user');
  });

  it('should get violations by clauses', async () => {
    await ledger.addViolation({
      clauses: ['obj1'],
      severity: 'medium',
      path: 'test1.ts',
      line: 1,
      title: 'Obj1 violation',
      description: 'Test',
      suggested_fix: 'Fix',
      status: 'open',
    });

    await ledger.addViolation({
      clauses: ['obj3'],
      severity: 'critical',
      path: 'test2.ts',
      line: 2,
      title: 'Obj3 violation',
      description: 'Test',
      suggested_fix: 'Fix',
      status: 'open',
    });

    const obj3Violations = await ledger.getByClauses(['obj3']);
    expect(obj3Violations.length).toBe(1);
    expect(obj3Violations[0].clauses).toContain('obj3');
  });

  it('should get violations by path', async () => {
    await ledger.addViolation({
      clauses: ['obj1'],
      severity: 'medium',
      path: 'worker/config.ts',
      line: 10,
      title: 'Config violation',
      description: 'Test',
      suggested_fix: 'Fix',
      status: 'open',
    });

    await ledger.addViolation({
      clauses: ['obj1'],
      severity: 'medium',
      path: 'worker/worker.ts',
      line: 20,
      title: 'Worker violation',
      description: 'Test',
      suggested_fix: 'Fix',
      status: 'open',
    });

    const configViolations = await ledger.getByPath('worker/config.ts');
    expect(configViolations.length).toBe(1);
    expect(configViolations[0].path).toBe('worker/config.ts');
  });

  it('should calculate statistics', async () => {
    await ledger.addViolation({
      clauses: ['obj3'],
      severity: 'critical',
      path: 'test1.ts',
      line: 1,
      title: 'Critical issue',
      description: 'Test',
      suggested_fix: 'Fix',
      status: 'open',
    });

    await ledger.addViolation({
      clauses: ['obj1'],
      severity: 'medium',
      path: 'test2.ts',
      line: 2,
      title: 'Medium issue',
      description: 'Test',
      suggested_fix: 'Fix',
      status: 'triaged',
    });

    const stats = await ledger.getStats();

    expect(stats.total).toBe(2);
    expect(stats.by_status['open']).toBe(1);
    expect(stats.by_status['triaged']).toBe(1);
    expect(stats.by_severity['critical']).toBe(1);
    expect(stats.by_severity['medium']).toBe(1);
    expect(stats.by_clause['obj3']).toBe(1);
    expect(stats.by_clause['obj1']).toBe(1);
  });
});
