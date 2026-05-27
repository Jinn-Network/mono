import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AddFilterPopover } from './AddFilterPopover';
import type { FilterDim } from '../lib/url-state';

function defaults() {
  return {
    pickedDim: null as FilterDim | null,
    onPickDim: () => {},
    onBack: () => {},
    values: [] as string[],
    loading: false,
    onSelect: () => {},
    onDismiss: () => {},
  };
}

describe('AddFilterPopover', () => {
  it('renders the dimension picker at step 1 (pickedDim === null)', () => {
    render(<AddFilterPopover {...defaults()} />);
    expect(screen.getByText(/Add filter/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'operator' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'harness' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'plugin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'model' })).toBeInTheDocument();
  });

  it('calls onPickDim when a dimension is clicked at step 1', () => {
    const onPickDim = vi.fn();
    render(<AddFilterPopover {...defaults()} onPickDim={onPickDim} />);
    fireEvent.click(screen.getByRole('button', { name: 'harness' }));
    expect(onPickDim).toHaveBeenCalledWith('harness');
  });

  it('renders value buttons at step 2 (pickedDim set)', () => {
    render(
      <AddFilterPopover
        {...defaults()}
        pickedDim="harness"
        values={['codex', 'hermes-agent']}
      />,
    );
    expect(screen.getByRole('button', { name: 'codex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'hermes-agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back/i })).toBeInTheDocument();
  });

  it('shows a loading state at step 2 when loading is true (#687 bug 2)', () => {
    render(
      <AddFilterPopover
        {...defaults()}
        pickedDim="harness"
        values={[]}
        loading={true}
      />,
    );
    expect(screen.getByRole('status', { name: /Loading values/i })).toBeInTheDocument();
    expect(screen.queryByText(/No values to filter by/i)).toBeNull();
  });

  it('shows "No values to filter by" only when not loading and values is empty', () => {
    render(
      <AddFilterPopover
        {...defaults()}
        pickedDim="harness"
        values={[]}
        loading={false}
      />,
    );
    expect(screen.getByText(/No values to filter by/i)).toBeInTheDocument();
  });

  it('calls onSelect(dim, value) when a value button is clicked', () => {
    const onSelect = vi.fn();
    render(
      <AddFilterPopover
        {...defaults()}
        pickedDim="harness"
        values={['codex']}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    expect(onSelect).toHaveBeenCalledWith('harness', 'codex');
  });

  it('calls onBack when the Back button is clicked at step 2', () => {
    const onBack = vi.fn();
    render(
      <AddFilterPopover
        {...defaults()}
        pickedDim="harness"
        values={['codex']}
        onBack={onBack}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it('calls onDismiss on Escape', () => {
    const onDismiss = vi.fn();
    render(<AddFilterPopover {...defaults()} onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('calls onDismiss on outside mousedown (#687 bug 3)', () => {
    const onDismiss = vi.fn();
    render(<AddFilterPopover {...defaults()} onDismiss={onDismiss} />);
    document.body.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onDismiss on a mousedown inside the panel', () => {
    const onDismiss = vi.fn();
    render(<AddFilterPopover {...defaults()} onDismiss={onDismiss} />);
    const dimBtn = screen.getByRole('button', { name: 'harness' });
    dimBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
