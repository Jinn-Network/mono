import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FilterChipStrip } from './FilterChipStrip';
import type { FilterMap } from '../lib/url-state';

describe('FilterChipStrip', () => {
  it('returns null when filters are empty', () => {
    const { container } = render(
      <FilterChipStrip filters={{}} onRemove={() => {}} onAddFilter={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one chip per (dim, value) pair', () => {
    const filters: FilterMap = { harness: ['codex'], model: ['gpt-5.4-mini'] };
    render(
      <FilterChipStrip filters={filters} onRemove={() => {}} onAddFilter={() => {}} />,
    );
    expect(screen.getByText('harness:codex')).toBeInTheDocument();
    expect(screen.getByText('model:gpt-5.4-mini')).toBeInTheDocument();
  });

  it('renders multiple chips for a dim with multiple values', () => {
    const filters: FilterMap = { plugin: ['a@1.0', 'b@1.0'] };
    render(
      <FilterChipStrip filters={filters} onRemove={() => {}} onAddFilter={() => {}} />,
    );
    expect(screen.getByText('plugin:a@1.0')).toBeInTheDocument();
    expect(screen.getByText('plugin:b@1.0')).toBeInTheDocument();
  });

  it('calls onRemove(dim, value) when × is clicked', () => {
    const onRemove = vi.fn();
    render(
      <FilterChipStrip
        filters={{ harness: ['codex'] }}
        onRemove={onRemove}
        onAddFilter={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Remove harness=codex/i }));
    expect(onRemove).toHaveBeenCalledWith('harness', 'codex');
  });

  it('renders a + filter chip that calls onAddFilter when clicked', () => {
    const onAddFilter = vi.fn();
    render(
      <FilterChipStrip
        filters={{ harness: ['codex'] }}
        onRemove={() => {}}
        onAddFilter={onAddFilter}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add filter/i }));
    expect(onAddFilter).toHaveBeenCalled();
  });
});
