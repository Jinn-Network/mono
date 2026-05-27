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
        onDismiss={() => {}}
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
        onDismiss={() => {}}
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
        onDismiss={() => {}}
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
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Reset to default/i }));
    expect(onReset).toHaveBeenCalled();
  });

  it('calls onDismiss when Escape is pressed (#687 bug 3)', () => {
    const onDismiss = vi.fn();
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={() => {}}
        onReset={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('calls onDismiss when a mousedown lands outside the panel (#687 bug 3)', () => {
    const onDismiss = vi.fn();
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={() => {}}
        onReset={() => {}}
        onDismiss={onDismiss}
      />,
    );
    // Click on document.body (outside the role=dialog panel).
    document.body.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onDismiss when a mousedown lands inside the panel', () => {
    const onDismiss = vi.fn();
    render(
      <SliceSettingsPopover
        includeRaw={false}
        onIncludeRawChange={() => {}}
        onReset={() => {}}
        onDismiss={onDismiss}
      />,
    );
    const inside = screen.getByRole('button', { name: /Reset to default/i });
    inside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
