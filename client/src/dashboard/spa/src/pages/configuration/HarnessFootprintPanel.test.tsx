/**
 * HarnessFootprintPanel — issue #815.
 *
 * Renders the per-task AI-units footprint for an operator's chosen
 * harness/model so they commit to a 48h burn-in knowing what their
 * node will consume. Three figures land:
 *   - per 6h block: `X / 100 units`
 *   - per week: `Y / 2800 units`
 *   - informational `~$N/day`
 *
 * Visual rules per BRAND.md / DESIGN.md: no emoji, softened-brutalist
 * corners, monospace where the design uses it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HarnessFootprintPanel } from './HarnessFootprintPanel.js';

afterEach(() => cleanup());

describe('HarnessFootprintPanel', () => {
  it('renders projected units per 6h block as X / 100 for a paid hermes+opus combo', () => {
    render(<HarnessFootprintPanel harness="hermes-agent" modelId="anthropic/claude-opus-4.7" />);
    const block = screen.getByTestId('harness-footprint-block');
    expect(block.textContent).toContain('/ 100');
    // Opus 4.7 should project to ~45 units per task — extracted text contains a number > 0.
    const match = /([0-9.]+)\s*\/\s*100/.exec(block.textContent ?? '');
    expect(match).not.toBeNull();
    expect(parseFloat(match![1])).toBeGreaterThan(0);
  });

  it('renders projected units per week as Y / 2800', () => {
    render(<HarnessFootprintPanel harness="hermes-agent" modelId="claude-haiku-4-5-20251001" />);
    expect(screen.getByTestId('harness-footprint-week').textContent).toContain('/ 2800');
  });

  it('renders ~$N/day informational figure', () => {
    render(<HarnessFootprintPanel harness="hermes-agent" modelId="claude-haiku-4-5-20251001" />);
    expect(screen.getByTestId('harness-footprint-daily-usd').textContent).toMatch(/\$\d/);
  });

  it('renders an unavailable state when the model is unknown to the cost table', () => {
    render(<HarnessFootprintPanel harness="hermes-agent" modelId="no-such-model-xyz" />);
    expect(screen.getByTestId('harness-footprint-unknown')).toBeTruthy();
  });

  it('renders the metered grid for claude-code + Haiku (subscription is metered per #901)', () => {
    const { container } = render(
      <HarnessFootprintPanel harness="claude-code" modelId="claude-haiku-4-5-20251001" />,
    );
    expect(container.querySelector('[data-testid="harness-footprint-subscription"]')).toBeNull();
    expect(container.querySelector('[data-testid="harness-footprint-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="harness-footprint-block"]')?.textContent)
      .toContain('/ 100');
  });

  it('suppresses entirely for non-paid-LLM harnesses (prediction baselines)', () => {
    const { container } = render(
      <HarnessFootprintPanel harness="prediction-v1-baseline" modelId={undefined} />,
    );
    expect(container.querySelector('[data-testid="harness-footprint-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="harness-footprint-subscription"]')).toBeNull();
  });
});
