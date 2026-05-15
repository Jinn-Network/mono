import type { HarnessAdapter, TaskSessionInputs } from '../types.js';
import { fakeFullPipelineRun } from './fake-plugin-outputs.js';

export type NoOpRunHandler = (inputs: TaskSessionInputs, pluginRoot: string) => void | Promise<void>;

/**
 * Test-only HarnessAdapter. By default, a runTask call simulates a
 * full happy-path pipeline by writing all seven phase artifacts to
 * inputs.workingDir. Tests can override via .on() to inject failures,
 * partial completion, etc.
 */
export class NoOpHarnessAdapter implements HarnessAdapter {
  readonly name = 'noop';
  readonly allowsHarnessSelfModification = false;

  private handler: NoOpRunHandler | null = null;
  private invocations: Array<{ inputs: TaskSessionInputs; pluginRoot: string }> = [];

  /** Override the default happy-path simulation. */
  on(handler: NoOpRunHandler): this {
    this.handler = handler;
    return this;
  }

  /** Inspect what runTask was called with — useful for assertions. */
  getInvocations(): ReadonlyArray<{ inputs: TaskSessionInputs; pluginRoot: string }> {
    return this.invocations;
  }

  async runTask(inputs: TaskSessionInputs, pluginRoot: string): Promise<void> {
    this.invocations.push({ inputs, pluginRoot });
    if (this.handler) {
      await this.handler(inputs, pluginRoot);
    } else {
      fakeFullPipelineRun(inputs.workingDir, {
        taskId: inputs.taskId,
        solverType: inputs.solverType ?? 'unknown',
      });
    }
  }
}
