/**
 * Unit tests for BlueprintBuilder
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BlueprintBuilder, createBlueprintBuilder } from 'jinn-node/worker/prompt/BlueprintBuilder.js';
import {
  getBlueprintEnableContextPhases,
  getBlueprintEnableRecognition,
  getBlueprintEnableProgress,
} from 'jinn-node/config/index.js';
import type {
  IpfsMetadata,
} from 'jinn-node/worker/types.js';
import type {
  Invariant,
  BlueprintContext,
  ContextProvider,
  InvariantProvider,
  BuildContext,
  BlueprintBuilderConfig,
} from 'jinn-node/worker/prompt/types.js';

describe('BlueprintBuilder', () => {
  describe('createBlueprintBuilder', () => {
    it('should create a builder with all default providers registered', () => {
      const builder = createBlueprintBuilder();
      expect(builder).toBeInstanceOf(BlueprintBuilder);

      const config = builder.getConfig();
      const expectedRecognition = getBlueprintEnableContextPhases() && getBlueprintEnableRecognition();
      const expectedProgress = getBlueprintEnableContextPhases() && getBlueprintEnableProgress();
      expect(config.enableSystemBlueprint).toBe(true);
      expect(config.enableContextAssertions).toBe(true);
      expect(config.enableRecognitionLearnings).toBe(expectedRecognition);
      expect(config.enableJobContext).toBe(true);
      expect(config.enableProgressCheckpoint).toBe(expectedProgress);
    });

    it('should allow config overrides', () => {
      const builder = createBlueprintBuilder({
        enableSystemBlueprint: false,
        debug: true,
      });

      const config = builder.getConfig();
      expect(config.enableSystemBlueprint).toBe(false);
      expect(config.debug).toBe(true);
    });
  });

  describe('build', () => {
    let builder: BlueprintBuilder;
    let mockMetadata: IpfsMetadata;

    beforeEach(() => {
      builder = new BlueprintBuilder({
        enableSystemBlueprint: false, // Disable to avoid file dependencies
        enableContextAssertions: false,
        enableRecognitionLearnings: false,
        enableJobContext: false,
        enableProgressCheckpoint: false,
      });

      mockMetadata = {
        jobName: 'test-job',
        jobDefinitionId: 'test-def-123',
      };
    });

    it('should build an empty blueprint with no providers', async () => {
      const { blueprint, buildTime } = await builder.build(
        'req-123',
        mockMetadata
      );

      expect(blueprint.invariants).toEqual([]);
      expect(blueprint.context).toEqual({});
      expect(blueprint.metadata.requestId).toBe('req-123');
      expect(blueprint.metadata.providers).toEqual([]);
      expect(buildTime).toBeGreaterThanOrEqual(0);
    });

    it('should run context providers first', async () => {
      const executionOrder: string[] = [];

      const mockContextProvider: ContextProvider = {
        name: 'test-context',
        enabled: () => true,
        provide: async () => {
          executionOrder.push('context');
          return { hierarchy: { totalJobs: 5, completedJobs: 3, activeJobs: 2, children: [] } };
        },
      };

      const mockInvariantProvider: InvariantProvider = {
        name: 'test-invariant',
        domain: 'goal',
        enabled: () => true,
        provide: async (ctx, builtContext) => {
          executionOrder.push('invariant');
          // Should have access to context
          expect(builtContext.hierarchy).toBeDefined();
          return [];
        },
      };

      builder.registerContextProvider(mockContextProvider);
      builder.registerInvariantProvider(mockInvariantProvider);

      await builder.build('req-123', mockMetadata);

      expect(executionOrder).toEqual(['context', 'invariant']);
    });

    it('should pass built context to invariant providers', async () => {
      const mockContextProvider: ContextProvider = {
        name: 'test-context',
        enabled: () => true,
        provide: async () => ({
          hierarchy: { totalJobs: 5, completedJobs: 3, activeJobs: 2, children: [] },
        }),
      };

      const mockInvariantProvider: InvariantProvider = {
        name: 'test-invariant',
        domain: 'goal',
        enabled: () => true,
        provide: async (_ctx, builtContext) => {
          expect(builtContext.hierarchy?.totalJobs).toBe(5);
          return [
            {
              id: 'GOAL-001',
              form: 'boolean',
              domain: 'goal',
              description: `There are ${builtContext.hierarchy?.totalJobs} jobs in the hierarchy`,
              examples: { do: ['test'], dont: ['test'] },
              commentary: 'Test invariant',
            },
          ];
        },
      };

      builder.registerContextProvider(mockContextProvider);
      builder.registerInvariantProvider(mockInvariantProvider);

      const { blueprint } = await builder.build('req-123', mockMetadata);

      expect(blueprint.context.hierarchy?.totalJobs).toBe(5);
      expect(blueprint.invariants).toHaveLength(1);
      expect(blueprint.invariants[0].description).toContain('5 jobs');
    });

    it('should skip disabled providers', async () => {
      const mockProvider: ContextProvider = {
        name: 'disabled-provider',
        enabled: () => false,
        provide: async () => ({ hierarchy: { totalJobs: 5, completedJobs: 3, activeJobs: 2, children: [] } }),
      };

      builder.registerContextProvider(mockProvider);

      const { blueprint } = await builder.build('req-123', mockMetadata);

      expect(blueprint.context).toEqual({});
      expect(blueprint.metadata.providers).not.toContain('disabled-provider');
    });

    it('should handle provider errors gracefully', async () => {
      const mockProvider: ContextProvider = {
        name: 'error-provider',
        enabled: () => true,
        provide: async () => {
          throw new Error('Test error');
        },
      };

      builder.registerContextProvider(mockProvider);

      const { blueprint } = await builder.build('req-123', mockMetadata);

      // Should continue despite error
      expect(blueprint.context).toEqual({});
    });
  });

  describe('buildPrompt', () => {
    it('should return prose string for agent consumption', async () => {
      const builder = new BlueprintBuilder({
        enableSystemBlueprint: false,
        enableContextAssertions: false,
        enableRecognitionLearnings: false,
        enableJobContext: false,
        enableProgressCheckpoint: false,
      });

      const prompt = await builder.buildPrompt('req-123', {});

      // buildPrompt returns prose, not JSON
      expect(typeof prompt).toBe('string');
      // Prose contains "No invariants defined" when empty
      expect(prompt).toContain('No invariants defined');
    });

    it('should render invariants in three-layer structure', async () => {
      // Use createBlueprintBuilder which registers all providers including system
      const builder = createBlueprintBuilder({
        enableContextAssertions: false,
        enableRecognitionLearnings: false,
        enableJobContext: false,
        enableProgressCheckpoint: false,
      });

      const prompt = await builder.buildPrompt('req-123', {});

      // Should contain PROTOCOL layer header for SYS-* invariants
      expect(prompt).toContain('PROTOCOL: Operating Principles');
      // Should contain system invariants
      expect(prompt).toContain('SYS-');
    });
  });

  describe('build vs buildPrompt separation', () => {
    it('build() returns structured data, buildPrompt() returns prose', async () => {
      const builder = new BlueprintBuilder({
        enableSystemBlueprint: false,
        enableContextAssertions: false,
        enableRecognitionLearnings: false,
        enableJobContext: false,
        enableProgressCheckpoint: false,
      });

      // build() returns structured UnifiedBlueprint
      const { blueprint } = await builder.build('req-123', {});
      expect(blueprint.invariants).toBeDefined();
      expect(blueprint.context).toBeDefined();
      expect(blueprint.metadata).toBeDefined();
      expect(Array.isArray(blueprint.invariants)).toBe(true);

      // buildPrompt() returns prose string
      const prompt = await builder.buildPrompt('req-123', {});
      expect(typeof prompt).toBe('string');
      // Not JSON - should throw if we try to parse
      expect(() => JSON.parse(prompt)).toThrow();
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const builder = new BlueprintBuilder();
      expect(builder.getConfig().debug).toBe(false);

      builder.updateConfig({ debug: true });
      expect(builder.getConfig().debug).toBe(true);
    });

    it('should merge with existing config', () => {
      const builder = new BlueprintBuilder({ enableSystemBlueprint: false });
      expect(builder.getConfig().enableSystemBlueprint).toBe(false);
      expect(builder.getConfig().enableJobContext).toBe(true);

      builder.updateConfig({ enableJobContext: false });
      expect(builder.getConfig().enableSystemBlueprint).toBe(false);
      expect(builder.getConfig().enableJobContext).toBe(false);
    });
  });
});
