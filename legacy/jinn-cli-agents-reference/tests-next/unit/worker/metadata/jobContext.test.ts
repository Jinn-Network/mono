/**
 * Unit Test: Job Context Management
 * Module: worker/metadata/jobContext.ts
 * Priority: P1 (HIGH)
 *
 * Tests job context environment variable management for JINN_* variables.
 * Critical for passing context to agent execution environment.
 *
 * Impact: Ensures correct job context propagation
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  setJobContext,
  clearJobContext,
  snapshotJobContext,
  restoreJobContext,
} from 'jinn-node/worker/metadata/jobContext.js';

describe('jobContext', () => {
  // Save original environment to restore after tests
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    clearJobContext();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('setJobContext', () => {
    it('sets request ID', () => {
      setJobContext({ requestId: '0x123' });

      expect(process.env.JINN_REQUEST_ID).toBe('0x123');
    });

    it('sets job definition ID', () => {
      setJobContext({ jobDefinitionId: 'job-456' });

      expect(process.env.JINN_JOB_DEFINITION_ID).toBe('job-456');
    });

    it('sets base branch', () => {
      setJobContext({ baseBranch: 'main' });

      expect(process.env.JINN_BASE_BRANCH).toBe('main');
    });

    it('sets mech address', () => {
      setJobContext({ mechAddress: '0xmechaddr' });

      expect(process.env.JINN_MECH_ADDRESS).toBe('0xmechaddr');
    });

    it('sets all fields at once', () => {
      setJobContext({
        requestId: '0x123',
        jobDefinitionId: 'job-456',
        baseBranch: 'main',
        mechAddress: '0xmech',
      });

      expect(process.env.JINN_REQUEST_ID).toBe('0x123');
      expect(process.env.JINN_JOB_DEFINITION_ID).toBe('job-456');
      expect(process.env.JINN_BASE_BRANCH).toBe('main');
      expect(process.env.JINN_MECH_ADDRESS).toBe('0xmech');
    });

    it('sets only provided fields', () => {
      setJobContext({
        requestId: '0x123',
        baseBranch: 'main',
      });

      expect(process.env.JINN_REQUEST_ID).toBe('0x123');
      expect(process.env.JINN_BASE_BRANCH).toBe('main');
      expect(process.env.JINN_JOB_DEFINITION_ID).toBeUndefined();
      expect(process.env.JINN_MECH_ADDRESS).toBeUndefined();
    });

    it('overwrites existing values', () => {
      setJobContext({ requestId: '0x123' });
      setJobContext({ requestId: '0x456' });

      expect(process.env.JINN_REQUEST_ID).toBe('0x456');
    });

    it('handles empty object', () => {
      setJobContext({});

      expect(process.env.JINN_REQUEST_ID).toBeUndefined();
      expect(process.env.JINN_JOB_DEFINITION_ID).toBeUndefined();
      expect(process.env.JINN_BASE_BRANCH).toBeUndefined();
      expect(process.env.JINN_MECH_ADDRESS).toBeUndefined();
    });

    it('ignores undefined values', () => {
      setJobContext({
        requestId: '0x123',
        jobDefinitionId: undefined,
      });

      expect(process.env.JINN_REQUEST_ID).toBe('0x123');
      expect(process.env.JINN_JOB_DEFINITION_ID).toBeUndefined();
    });

    it('does not set null jobDefinitionId', () => {
      setJobContext({ jobDefinitionId: null });

      expect(process.env.JINN_JOB_DEFINITION_ID).toBeUndefined();
    });
  });

  describe('clearJobContext', () => {
    it('clears all context variables', () => {
      process.env.JINN_REQUEST_ID = '0x123';
      process.env.JINN_JOB_DEFINITION_ID = 'job-456';
      process.env.JINN_BASE_BRANCH = 'main';
      process.env.JINN_MECH_ADDRESS = '0xmech';

      clearJobContext();

      expect(process.env.JINN_REQUEST_ID).toBeUndefined();
      expect(process.env.JINN_JOB_DEFINITION_ID).toBeUndefined();
      expect(process.env.JINN_BASE_BRANCH).toBeUndefined();
      expect(process.env.JINN_MECH_ADDRESS).toBeUndefined();
    });

    it('handles already cleared context', () => {
      clearJobContext();
      clearJobContext();

      expect(process.env.JINN_REQUEST_ID).toBeUndefined();
    });

    it('does not affect other environment variables', () => {
      process.env.JINN_REQUEST_ID = '0x123';
      process.env.NODE_ENV = 'test';
      process.env.OTHER_VAR = 'value';

      clearJobContext();

      expect(process.env.NODE_ENV).toBe('test');
      expect(process.env.OTHER_VAR).toBe('value');
    });
  });

  describe('snapshotJobContext', () => {
    it('captures current context', () => {
      process.env.JINN_REQUEST_ID = '0x123';
      process.env.JINN_JOB_DEFINITION_ID = 'job-456';
      process.env.JINN_BASE_BRANCH = 'main';
      process.env.JINN_MECH_ADDRESS = '0xmech';

      const snapshot = snapshotJobContext();

      expect(snapshot).toEqual({
        requestId: '0x123',
        jobDefinitionId: 'job-456',
        baseBranch: 'main',
        mechAddress: '0xmech',
      });
    });

    it('captures partial context', () => {
      process.env.JINN_REQUEST_ID = '0x123';
      process.env.JINN_BASE_BRANCH = 'main';

      const snapshot = snapshotJobContext();

      expect(snapshot).toEqual({
        requestId: '0x123',
        jobDefinitionId: undefined,
        baseBranch: 'main',
        mechAddress: undefined,
      });
    });

    it('captures empty context', () => {
      clearJobContext();

      const snapshot = snapshotJobContext();

      expect(snapshot).toEqual({
        requestId: undefined,
        jobDefinitionId: undefined,
        baseBranch: undefined,
        mechAddress: undefined,
      });
    });

    it('creates independent copy', () => {
      process.env.JINN_REQUEST_ID = '0x123';

      const snapshot = snapshotJobContext();

      process.env.JINN_REQUEST_ID = '0x456';

      expect(snapshot.requestId).toBe('0x123');
    });
  });

  describe('restoreJobContext', () => {
    it('restores full snapshot', () => {
      const snapshot = {
        requestId: '0x123',
        jobDefinitionId: 'job-456',
        baseBranch: 'main',
        mechAddress: '0xmech',
      };

      restoreJobContext(snapshot);

      expect(process.env.JINN_REQUEST_ID).toBe('0x123');
      expect(process.env.JINN_JOB_DEFINITION_ID).toBe('job-456');
      expect(process.env.JINN_BASE_BRANCH).toBe('main');
      expect(process.env.JINN_MECH_ADDRESS).toBe('0xmech');
    });

    it('restores partial snapshot', () => {
      const snapshot = {
        requestId: '0x123',
        baseBranch: 'main',
      };

      restoreJobContext(snapshot);

      expect(process.env.JINN_REQUEST_ID).toBe('0x123');
      expect(process.env.JINN_BASE_BRANCH).toBe('main');
      expect(process.env.JINN_JOB_DEFINITION_ID).toBeUndefined();
    });

    it('clears existing context before restoring', () => {
      process.env.JINN_REQUEST_ID = '0x999';
      process.env.JINN_MECH_ADDRESS = '0xold';

      const snapshot = {
        jobDefinitionId: 'job-456',
      };

      restoreJobContext(snapshot);

      expect(process.env.JINN_REQUEST_ID).toBeUndefined();
      expect(process.env.JINN_JOB_DEFINITION_ID).toBe('job-456');
      expect(process.env.JINN_MECH_ADDRESS).toBeUndefined();
    });

    it('restores empty snapshot', () => {
      process.env.JINN_REQUEST_ID = '0x123';

      restoreJobContext({});

      expect(process.env.JINN_REQUEST_ID).toBeUndefined();
    });
  });

  describe('snapshot and restore workflow', () => {
    it('saves and restores context correctly', () => {
      // Set initial context
      setJobContext({
        requestId: '0x123',
        jobDefinitionId: 'job-456',
      });

      // Take snapshot
      const snapshot = snapshotJobContext();

      // Modify context
      setJobContext({
        requestId: '0x999',
        baseBranch: 'feature',
      });

      // Restore original
      restoreJobContext(snapshot);

      expect(process.env.JINN_REQUEST_ID).toBe('0x123');
      expect(process.env.JINN_JOB_DEFINITION_ID).toBe('job-456');
      expect(process.env.JINN_BASE_BRANCH).toBeUndefined();
    });

    it('handles nested context switching', () => {
      // Level 1
      setJobContext({ requestId: '0x1' });
      const snapshot1 = snapshotJobContext();

      // Level 2
      setJobContext({ requestId: '0x2' });
      const snapshot2 = snapshotJobContext();

      // Level 3
      setJobContext({ requestId: '0x3' });

      // Restore to level 2
      restoreJobContext(snapshot2);
      expect(process.env.JINN_REQUEST_ID).toBe('0x2');

      // Restore to level 1
      restoreJobContext(snapshot1);
      expect(process.env.JINN_REQUEST_ID).toBe('0x1');
    });
  });
});
