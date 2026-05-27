import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostEstimatePanel } from './CostEstimatePanel.js';

describe('CostEstimatePanel', () => {
  it('renders subscription reassurance when usesPaidApiKey is false', () => {
    render(
      <CostEstimatePanel
        modelId="claude-opus-4-7"
        usesPaidApiKey={false}
        testIdPrefix="cost-test"
      />,
    );
    const row = screen.getByTestId('cost-test-subscription');
    expect(row.getAttribute('data-cost-mode')).toBe('subscription');
  });

  it('renders paid-api panel with high-cost gate for claude-code + Opus when usesPaidApiKey is true', () => {
    render(
      <CostEstimatePanel
        modelId="claude-opus-4-7"
        usesPaidApiKey={true}
        testIdPrefix="cost-test"
      />,
    );
    const panel = screen.getByTestId('cost-test-panel');
    expect(panel.getAttribute('data-cost-mode')).toBe('paid-api');
    expect(panel.getAttribute('data-cost-high-cost')).toBe('true');
    expect(screen.getByTestId('cost-test-amount').textContent).toContain('$2.25');
  });

  it('renders paid-api panel without high-cost gate for hermes + cheap model', () => {
    render(
      <CostEstimatePanel
        modelId="deepseek/deepseek-v4-flash"
        usesPaidApiKey={true}
        testIdPrefix="cost-test"
      />,
    );
    const panel = screen.getByTestId('cost-test-panel');
    expect(panel.getAttribute('data-cost-mode')).toBe('paid-api');
    expect(panel.getAttribute('data-cost-high-cost')).toBe('false');
  });
});
