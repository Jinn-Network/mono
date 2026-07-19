import { describe, it, expect } from 'vitest';
import {
  buildHeadlessPrompt,
  headlessOverride,
  headlessOverrideFor,
} from '../src/headless.js';

describe('headlessOverride', () => {
  it('loads the override block and mentions overriding HARD-GATEs', () => {
    const block = headlessOverride();
    expect(block).toMatch(/headless mode/i);
    expect(block).toMatch(/HARD-GATE/);
  });
});

describe('buildHeadlessPrompt', () => {
  it('composes the override block, the skill invocation, and the scenario', () => {
    const prompt = buildHeadlessPrompt('superpowers:writing-plans', 'Plan the widget.');
    expect(prompt.indexOf('Headless mode')).toBeGreaterThanOrEqual(0);
    expect(prompt).toContain('Use the superpowers:writing-plans skill');
    expect(prompt).toContain('Plan the widget.');
    // Override block comes before the task.
    expect(prompt.indexOf('Headless mode')).toBeLessThan(prompt.indexOf('Plan the widget.'));
  });
});

describe('headlessOverrideFor', () => {
  it('reframes the shared override for Hermes chat', () => {
    const block = headlessOverrideFor('hermes');

    expect(block).toContain('`hermes chat -q`');
    expect(block).not.toContain('`claude -p` / `--print`');
  });

  it('preserves the Claude override verbatim', () => {
    expect(headlessOverrideFor('claude')).toBe(headlessOverride());
  });
});
