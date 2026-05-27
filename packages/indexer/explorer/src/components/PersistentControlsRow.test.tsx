import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PersistentControlsRow } from './PersistentControlsRow';

describe('PersistentControlsRow', () => {
  it('renders + filter chip and Group by dropdown', () => {
    render(
      <PersistentControlsRow
        group="none"
        onGroupChange={() => {}}
        onAddFilter={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Add filter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Group by: none/i })).toBeInTheDocument();
  });

  it('right-aligns content with flex', () => {
    const { container } = render(
      <PersistentControlsRow
        group="none"
        onGroupChange={() => {}}
        onAddFilter={() => {}}
      />,
    );
    const row = container.firstChild as HTMLElement;
    expect(row.style.justifyContent).toBe('flex-end');
  });

  it('calls onAddFilter when + filter chip is clicked', () => {
    const onAddFilter = vi.fn();
    render(
      <PersistentControlsRow
        group="none"
        onGroupChange={() => {}}
        onAddFilter={onAddFilter}
      />,
    );
    screen.getByRole('button', { name: /Add filter/i }).click();
    expect(onAddFilter).toHaveBeenCalled();
  });
});
