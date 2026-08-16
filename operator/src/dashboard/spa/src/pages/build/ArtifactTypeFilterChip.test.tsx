import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactTypeFilterChip } from './ArtifactTypeFilterChip.js';

describe('ArtifactTypeFilterChip (hfmf)', () => {
  it('renders "Plug-ins" selected and "Harnesses" disabled', () => {
    const onChange = vi.fn();
    render(<ArtifactTypeFilterChip value="plugin" onChange={onChange} />);
    const plugin = screen.getByRole('button', { name: /plug-ins/i });
    const harness = screen.getByRole('button', { name: /harnesses/i });
    expect(plugin.getAttribute('aria-pressed')).toBe('true');
    expect(harness.hasAttribute('disabled')).toBe(true);
  });

  it('shows "coming soon" tag on the harness chip', () => {
    render(<ArtifactTypeFilterChip value="plugin" onChange={() => {}} />);
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
  });

  it('clicking plug-ins (already selected) does not call onChange', () => {
    const onChange = vi.fn();
    render(<ArtifactTypeFilterChip value="plugin" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /plug-ins/i }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
