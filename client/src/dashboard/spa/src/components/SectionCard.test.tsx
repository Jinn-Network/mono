import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SectionCard } from './SectionCard.js';

describe('SectionCard', () => {
  it('renders the head and hides the body when collapsed', () => {
    render(
      <SectionCard
        title="SolverNets"
        summary="3 available · 1 enabled"
        defaultExpanded={false}
      >
        <div data-testid="body">body content</div>
      </SectionCard>,
    );
    expect(screen.getByText(/solvernets/i)).toBeTruthy();
    expect(screen.queryByTestId('body')).toBeNull();
  });

  it('expands when the head is clicked', () => {
    render(
      <SectionCard title="SolverNets" summary="" defaultExpanded={false}>
        <div data-testid="body">body content</div>
      </SectionCard>,
    );
    fireEvent.click(screen.getByText(/solvernets/i));
    expect(screen.getByTestId('body')).toBeTruthy();
  });

  it('opens when a deep-link target becomes active after mount', () => {
    const { rerender } = render(
      <SectionCard title="Security" summary="" defaultExpanded={false}>
        <div data-testid="body">body content</div>
      </SectionCard>,
    );
    expect(screen.queryByTestId('body')).toBeNull();

    rerender(
      <SectionCard title="Security" summary="" defaultExpanded={true}>
        <div data-testid="body">body content</div>
      </SectionCard>,
    );
    expect(screen.getByTestId('body')).toBeTruthy();
  });

  it('renders the save footer when dirty', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(
      <SectionCard
        title="SolverNets"
        summary=""
        defaultExpanded={true}
        dirty={{ pendingSummary: '2 changes pending', onSave, onCancel }}
      >
        <div>body</div>
      </SectionCard>,
    );
    expect(screen.getByText('2 changes pending')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(onSave).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
