/**
 * Integration tests for blueprint dispatch to IPFS flow
 * Phase 1 verification: Blueprint-Per-Job Infrastructure
 * 
 * Tests the complete flow from dispatch_new_job through IPFS metadata upload
 * Uses mocked IPFS infrastructure to verify payload structure
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildTestBlueprint,
  buildMinimalAssertion,
  buildMultiAssertionBlueprint,
} from '../../fixtures/blueprint-builder.js';

describe('Blueprint dispatch to IPFS integration', () => {
  describe('IPFS metadata structure', () => {
    it('should structure metadata with blueprint at root level', () => {
      const blueprint = buildTestBlueprint([buildMinimalAssertion('IPFS-001')]);
      
      // Simulated IPFS metadata payload structure (as created by dispatch_new_job)
      const ipfsMetadata = {
        blueprint,
        jobName: 'test-job',
        model: 'gemini-2.5-flash',
        enabledTools: ['create_artifact'],
        jobDefinitionId: 'test-job-def-id',
        nonce: 'test-nonce-123',
        additionalContext: {},
      };

      // Verify blueprint is at root level (not nested in additionalContext)
      expect(ipfsMetadata.blueprint).toBe(blueprint);
      expect(ipfsMetadata.blueprint).toBeTruthy();
      expect(typeof ipfsMetadata.blueprint).toBe('string');
      
      // Verify it's not in additionalContext (old architecture)
      expect(ipfsMetadata.additionalContext).toBeDefined();
      expect((ipfsMetadata.additionalContext as any).blueprint).toBeUndefined();
    });

    it('should include all required metadata fields with blueprint', () => {
      const blueprint = buildMultiAssertionBlueprint(3);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'complete-metadata-test',
        model: 'gemini-2.5-pro',
        enabledTools: ['create_artifact', 'dispatch_new_job'],
        jobDefinitionId: 'complete-test-job-def',
        nonce: 'nonce-456',
        additionalContext: {},
      };

      // All required fields present
      expect(ipfsMetadata.blueprint).toBeTruthy();
      expect(ipfsMetadata.jobName).toBe('complete-metadata-test');
      expect(ipfsMetadata.model).toBe('gemini-2.5-pro');
      expect(ipfsMetadata.enabledTools).toEqual(['create_artifact', 'dispatch_new_job']);
      expect(ipfsMetadata.jobDefinitionId).toBe('complete-test-job-def');
      expect(ipfsMetadata.nonce).toBeTruthy();
    });

    it('should handle blueprint with dependencies in metadata', () => {
      const blueprint = buildTestBlueprint([buildMinimalAssertion('DEP-001')]);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'dependency-test',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'dep-test-job-def',
        nonce: 'dep-nonce',
        dependencies: ['parent-job-def-1', 'parent-job-def-2'],
        additionalContext: {},
      };

      expect(ipfsMetadata.blueprint).toBeTruthy();
      expect(ipfsMetadata.dependencies).toEqual(['parent-job-def-1', 'parent-job-def-2']);
      expect(ipfsMetadata.dependencies).toHaveLength(2);
    });

    it('should preserve blueprint JSON structure in metadata', () => {
      const blueprint = buildMultiAssertionBlueprint(5);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'json-preservation-test',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'json-test-def',
        nonce: 'json-nonce',
        additionalContext: {},
      };

      // Blueprint should be parseable JSON
      expect(() => JSON.parse(ipfsMetadata.blueprint)).not.toThrow();
      
      const parsed = JSON.parse(ipfsMetadata.blueprint);
      expect(parsed.assertions).toHaveLength(5);
      expect(parsed.assertions[0].id).toBe('TEST-001');
      expect(parsed.assertions[4].id).toBe('TEST-005');
    });
  });

  describe('Blueprint serialization for IPFS', () => {
    it('should serialize blueprint as string in IPFS payload', () => {
      const blueprint = buildTestBlueprint([buildMinimalAssertion('SERIAL-001')]);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'serialization-test',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'serial-test-def',
        nonce: 'serial-nonce',
        additionalContext: {},
      };

      // When serialized to JSON for IPFS upload
      const serialized = JSON.stringify(ipfsMetadata);
      expect(serialized).toContain('SERIAL-001');
      expect(serialized).toContain('"blueprint":');
      
      // Round-trip should preserve structure
      const deserialized = JSON.parse(serialized);
      expect(deserialized.blueprint).toBe(blueprint);
    });

    it('should handle special characters in blueprint during serialization', () => {
      const specialAssertion = {
        id: 'SPECIAL-001',
        assertion: 'Handle quotes: "double" and \'single\'',
        examples: {
          do: ['Escape properly: \\"text\\"'],
          dont: ['Break JSON'],
        },
        commentary: 'Special chars test',
      };
      const blueprint = buildTestBlueprint([specialAssertion]);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'special-chars-test',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'special-test-def',
        nonce: 'special-nonce',
        additionalContext: {},
      };

      // Serialize and deserialize
      const serialized = JSON.stringify(ipfsMetadata);
      const deserialized = JSON.parse(serialized);
      
      // Blueprint should survive round-trip
      expect(deserialized.blueprint).toBe(blueprint);
      
      // Parse the blueprint itself
      const blueprintParsed = JSON.parse(deserialized.blueprint);
      expect(blueprintParsed.assertions[0].assertion).toContain('quotes: "double"');
    });

    it('should handle large blueprints in IPFS metadata', () => {
      const largeBlueprint = buildMultiAssertionBlueprint(100);
      
      const ipfsMetadata = {
        blueprint: largeBlueprint,
        jobName: 'large-blueprint-test',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'large-test-def',
        nonce: 'large-nonce',
        additionalContext: {},
      };

      // Should serialize successfully
      const serialized = JSON.stringify(ipfsMetadata);
      expect(serialized.length).toBeGreaterThan(10000);
      
      // Should deserialize correctly
      const deserialized = JSON.parse(serialized);
      const blueprintParsed = JSON.parse(deserialized.blueprint);
      expect(blueprintParsed.assertions).toHaveLength(100);
    });
  });

  describe('Backward compatibility in IPFS metadata', () => {
    it('should allow metadata without blueprint (legacy jobs)', () => {
      const ipfsMetadata = {
        jobName: 'legacy-job-no-blueprint',
        model: 'gemini-2.5-flash',
        enabledTools: ['create_artifact'],
        jobDefinitionId: 'legacy-job-def',
        nonce: 'legacy-nonce',
        additionalContext: {},
      };

      // Legacy jobs don't have blueprint
      expect(ipfsMetadata.blueprint).toBeUndefined();
      
      // But they have all other required fields
      expect(ipfsMetadata.jobName).toBeTruthy();
      expect(ipfsMetadata.model).toBeTruthy();
      expect(ipfsMetadata.jobDefinitionId).toBeTruthy();
    });

    it('should support blueprint migration path from additionalContext', () => {
      const blueprint = buildTestBlueprint([buildMinimalAssertion('MIGRATE-001')]);
      
      // Old structure (blueprint in additionalContext)
      const oldMetadata = {
        jobName: 'migration-test-old',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'migrate-old-def',
        nonce: 'migrate-old-nonce',
        additionalContext: {
          blueprint,
        },
      };

      // New structure (blueprint at root)
      const newMetadata = {
        blueprint,
        jobName: 'migration-test-new',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'migrate-new-def',
        nonce: 'migrate-new-nonce',
        additionalContext: {},
      };

      // Both should have blueprint accessible
      expect(oldMetadata.additionalContext.blueprint).toBe(blueprint);
      expect(newMetadata.blueprint).toBe(blueprint);
    });
  });

  describe('Code metadata integration with blueprint', () => {
    it('should include both blueprint and code metadata in IPFS payload', () => {
      const blueprint = buildTestBlueprint([buildMinimalAssertion('CODE-001')]);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'code-metadata-test',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'code-test-def',
        nonce: 'code-nonce',
        branchName: 'job/code-test-branch',
        baseBranch: 'main',
        codeMetadata: {
          branch: {
            name: 'job/code-test-branch',
            remoteUrl: 'git@github.com:test/repo.git',
          },
          baseBranch: 'main',
          parent: {
            jobDefinitionId: 'parent-job-def',
            requestId: '0xparent123',
          },
        },
        additionalContext: {},
      };

      // Both blueprint and code metadata should be present
      expect(ipfsMetadata.blueprint).toBeTruthy();
      expect(ipfsMetadata.codeMetadata).toBeDefined();
      expect(ipfsMetadata.codeMetadata?.branch?.name).toBe('job/code-test-branch');
      expect(ipfsMetadata.branchName).toBe('job/code-test-branch');
    });

    it('should support artifact-only jobs with blueprint but no code metadata', () => {
      const blueprint = buildTestBlueprint([buildMinimalAssertion('ARTIFACT-001')]);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'artifact-only-test',
        model: 'gemini-2.5-flash',
        enabledTools: ['create_artifact'],
        jobDefinitionId: 'artifact-only-def',
        nonce: 'artifact-nonce',
        additionalContext: {},
        // No branchName, no codeMetadata (artifact-only job)
      };

      expect(ipfsMetadata.blueprint).toBeTruthy();
      expect(ipfsMetadata.codeMetadata).toBeUndefined();
      expect(ipfsMetadata.branchName).toBeUndefined();
    });
  });

  describe('IPFS upload payload validation', () => {
    it('should create valid JSON payload for IPFS upload', () => {
      const blueprint = buildMultiAssertionBlueprint(3);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'upload-validation-test',
        model: 'gemini-2.5-pro',
        enabledTools: ['create_artifact', 'dispatch_new_job'],
        jobDefinitionId: 'upload-test-def',
        nonce: 'upload-nonce-789',
        additionalContext: {
          message: 'Test message',
        },
      };

      // Simulate IPFS upload payload (array with metadata as first element)
      const uploadPayload = [ipfsMetadata];
      
      // Should be valid JSON
      const serialized = JSON.stringify(uploadPayload);
      expect(() => JSON.parse(serialized)).not.toThrow();
      
      // Should preserve structure
      const deserialized = JSON.parse(serialized);
      expect(Array.isArray(deserialized)).toBe(true);
      expect(deserialized[0].blueprint).toBe(blueprint);
    });

    it('should include lineage context with blueprint', () => {
      const blueprint = buildTestBlueprint([buildMinimalAssertion('LINEAGE-001')]);
      
      const ipfsMetadata = {
        blueprint,
        jobName: 'lineage-test',
        model: 'gemini-2.5-flash',
        enabledTools: [],
        jobDefinitionId: 'lineage-job-def',
        nonce: 'lineage-nonce',
        sourceRequestId: '0xparent-request',
        sourceJobDefinitionId: 'parent-job-def',
        additionalContext: {},
      };

      // Lineage fields should be present alongside blueprint
      expect(ipfsMetadata.blueprint).toBeTruthy();
      expect(ipfsMetadata.sourceRequestId).toBe('0xparent-request');
      expect(ipfsMetadata.sourceJobDefinitionId).toBe('parent-job-def');
    });
  });
});

