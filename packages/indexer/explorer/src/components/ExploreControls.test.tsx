import { render, screen, fireEvent } from '@testing-library/react';
import { ExploreControls } from './ExploreControls';
import type { FilterMap, GroupValue } from '../lib/url-state';

function baseProps(over: Partial<React.ComponentProps<typeof ExploreControls>> = {}) {
  return {
    group: 'none' as GroupValue,
    onGroupChange: vi.fn(),
    filters: {} as FilterMap,
    onFiltersChange: vi.fn(),
    includeRaw: false,
    onIncludeRawChange: vi.fn(),
    window: 50,
    onWindowChange: vi.fn(),
    ...over,
  };
}

describe('ExploreControls', () => {
  it('renders the GROUP BY chip row with active state on `none`', () => {
    render(<ExploreControls {...baseProps()} />);
    expect(screen.getByText(/group by/i)).toBeInTheDocument();
    const noneChip = screen.getByRole('button', { name: /^none$/i });
    expect(noneChip).toHaveAttribute('aria-pressed', 'true');
  });

  it('emits onGroupChange when a different group chip is clicked', () => {
    const onGroupChange = vi.fn();
    render(<ExploreControls {...baseProps({ onGroupChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /^operator$/i }));
    expect(onGroupChange).toHaveBeenCalledWith('operator');
  });

  it('renders an active filter pill per (dim,value) with an X removal affordance', () => {
    render(
      <ExploreControls
        {...baseProps({
          filters: { harness: ['codex'], model: ['gpt-5.4-mini'] },
        })}
      />,
    );
    expect(screen.getByText(/harness:codex/i)).toBeInTheDocument();
    expect(screen.getByText(/model:gpt-5\.4-mini/i)).toBeInTheDocument();
    // 2 close affordances, one per pill
    expect(screen.getAllByRole('button', { name: /remove/i })).toHaveLength(2);
  });

  it('removing a pill calls onFiltersChange without that value', () => {
    const onFiltersChange = vi.fn();
    render(
      <ExploreControls
        {...baseProps({
          filters: { harness: ['codex'], model: ['gpt-5.4-mini'] },
          onFiltersChange,
        })}
      />,
    );
    const removeBtns = screen.getAllByRole('button', { name: /remove harness=codex/i });
    fireEvent.click(removeBtns[0]);
    expect(onFiltersChange).toHaveBeenCalledWith({ model: ['gpt-5.4-mini'] });
  });

  it('renders the raw toggle as an off chip by default', () => {
    render(<ExploreControls {...baseProps()} />);
    const toggle = screen.getByRole('button', { name: /^raw$/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders INCLUDES RAW DATA wane chip when raw is on', () => {
    render(<ExploreControls {...baseProps({ includeRaw: true })} />);
    expect(screen.getByText(/includes raw data/i)).toBeInTheDocument();
  });

  it('emits onIncludeRawChange when the raw toggle is clicked', () => {
    const onIncludeRawChange = vi.fn();
    render(<ExploreControls {...baseProps({ onIncludeRawChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /^raw$/i }));
    expect(onIncludeRawChange).toHaveBeenCalledWith(true);
  });

  it('renders the window selector with 20/30/50/100/all options', () => {
    render(<ExploreControls {...baseProps()} />);
    expect(screen.getByRole('button', { name: '20' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '50' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^all$/i })).toBeInTheDocument();
  });

  it('emits onWindowChange when a window option is clicked', () => {
    const onWindowChange = vi.fn();
    render(<ExploreControls {...baseProps({ onWindowChange })} />);
    fireEvent.click(screen.getByRole('button', { name: '30' }));
    expect(onWindowChange).toHaveBeenCalledWith(30);
  });

  it('marks the active window option with aria-pressed=true', () => {
    render(<ExploreControls {...baseProps({ window: 30 })} />);
    expect(screen.getByRole('button', { name: '30' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
