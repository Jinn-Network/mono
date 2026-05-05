import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfigField } from './ConfigField.js';

describe('ConfigField', () => {
  it('renders label, value, and restart pill when restartRequired', () => {
    render(
      <ConfigField label="Harness" restartRequired>
        <span>claude-code-learner</span>
      </ConfigField>,
    );
    expect(screen.getByText('Harness')).toBeTruthy();
    expect(screen.getByText(/restart/i)).toBeTruthy();
  });

  it('does not render the restart pill when not restartRequired', () => {
    render(
      <ConfigField label="Harness">
        <span>claude-code-learner</span>
      </ConfigField>,
    );
    expect(screen.queryByText(/restart/i)).toBeNull();
  });
});
