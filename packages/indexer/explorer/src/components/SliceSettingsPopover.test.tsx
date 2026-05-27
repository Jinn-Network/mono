import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SliceSettingsPopover } from './SliceSettingsPopover';

describe('SliceSettingsPopover', () => {
  it('shows Include raw data toggle with correct initial state', () => {
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={() => {}}
        onReset={() => {}}
      />,
    );
    const toggle = screen.getByRole('switch', { name: /Include raw data/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('renders toggle as checked when includeRaw is true', () => {
    render(
      <SliceSettingsPopover
        includeRaw={true}
        onIncludeRawChange={() => {}}
        onReset={() => {}}
      />,
    );
    const toggle = screen.getByRole('switch', { name: /Include raw data/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('calls onIncludeRawChange(true) when toggling off→on', () => {
    const onIncludeRawChange = vi.fn();
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={onIncludeRawChange}
        onReset={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: /Include raw data/i }));
    expect(onIncludeRawChange).toHaveBeenCalledWith(true);
  });

  it('renders a Reset to default action and calls onReset when clicked', () => {
    const onReset = vi.fn();
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={() => {}}
        onReset={onReset}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/i }));
    expect(onReset).toHaveBeenCalled();
  });
});
