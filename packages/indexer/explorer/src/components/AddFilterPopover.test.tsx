import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AddFilterPopover } from './AddFilterPopover';

const AVAILABLE = {
  harness: ['codex', 'hermes-agent'],
  model: ['gpt-5.4-mini', 'claude-haiku-4-5'],
};

describe('AddFilterPopover', () => {
  it('renders the dimension picker at step 1', () => {
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/Add filter/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'operator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'harness' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'plugin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'model' })).toBeInTheDocument();
  });

  it('moves to step 2 (value picker) when a dimension is clicked', () => {
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'harness' }));
    expect(screen.getByText(/harness/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'codex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'hermes-agent' })).toBeInTheDocument();
  });

  it('shows an empty-state message when no values exist for the picked dim', () => {
    render(
      <AddFilterPopover
        availableValues={{ ...AVAILABLE, plugin: [] }}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'plugin' }));
    expect(screen.getByText(/No values to filter by/i)).toBeInTheDocument();
  });

  it('calls onSelect(dim, value) when a value is clicked', () => {
    const onSelect = vi.fn();
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={onSelect}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'harness' }));
    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    expect(onSelect).toHaveBeenCalledWith('harness', 'codex');
  });

  it('calls onDismiss on Escape', () => {
    const onDismiss = vi.fn();
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={() => {}}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('has a back button on step 2 that returns to step 1', () => {
    render(
      <AddFilterPopover
        availableValues={AVAILABLE}
        onSelect={() => {}}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'harness' }));
    expect(screen.getByRole('button', { name: /Back/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByRole('button', { name: 'harness' })).toBeInTheDocument();
  });
});
