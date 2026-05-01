import type { ExternalRestorerEnv } from '@jinn-network/restorer-sdk';
import type { HarnessAdapter, HarnessPromptArgs } from './harness.js';

/**
 * Deterministic in-process mock harness. Returns canned per-phase
 * shapes so tests run offline. Real builders replace this with a
 * subprocess wrapper around their actual harness (Pi.dev, Codex, etc.).
 */
export function createMockHarness(_env: ExternalRestorerEnv): HarnessAdapter {
  return {
    name: 'mock-harness',
    async promptForJson<T>({ promptId }: HarnessPromptArgs): Promise<T> {
      switch (promptId) {
        case 'orient':
          return { topics: [{ name: 'intent-parse', summary: 'parsed' }] } as T;
        case 'strategize':
          return {
            approach: 'mock approach',
            successCriteria: 'always succeed',
            timingPosture: 'early-return',
          } as T;
        case 'plan':
          return { steps: [{ id: 's1', description: 'do the thing' }] } as T;
        case 'execute':
          return {
            stepsCompleted: ['s1'],
            stepsFailed: [],
            returnReason: 'all-steps-completed',
          } as T;
        case 'debrief':
          return { successCriteriaMet: 'yes', rationale: 'mock rationale' } as T;
        case 'improve':
          return { mutations: [] } as T;
        case 'memory':
          return { kept: 0, pruned: 0 } as T;
        default:
          throw new Error(`mock-harness: unknown promptId ${promptId}`);
      }
    },
  };
}
