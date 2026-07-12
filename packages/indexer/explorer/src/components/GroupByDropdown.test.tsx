import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GroupByDropdown } from './GroupByDropdown';

describe('GroupByDropdown', () => {
  it('renders the current value in the trigger', () => {
    render(<GroupByDropdown value="harness" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Group by: harness/i })).toBeInTheDocument();
  });

  it('renders "none" trigger when value is none', () => {
    render(<GroupByDropdown value="none" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Group by: none/i })).toBeInTheDocument();
  });

  it('applies active styling when value !== none', () => {
    const { rerender } = render(<GroupByDropdown value="none" onChange={() => {}} />);
    const triggerInactive = screen.getByRole('button', { name: /Group by:/i });
    expect(triggerInactive).toHaveAttribute('data-active', 'false');
    rerender(<GroupByDropdown value="operator" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /Group by:/i })).toHaveAttribute('data-active', 'true');
  });

  it('opens menu on click and shows all seven options', () => {
    render(<GroupByDropdown value="none" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Group by:/i }));
    expect(screen.getByRole('menuitem', { name: 'none' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'operator' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'harness' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'plugin' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'mode' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'model' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'builder' })).toBeInTheDocument();
  });

  it('calls onChange with the picked dimension and closes the menu', () => {
    const onChange = vi.fn();
    render(<GroupByDropdown value="none" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Group by:/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'harness' }));
    expect(onChange).toHaveBeenCalledWith('harness');
    expect(screen.queryByRole('menuitem', { name: 'harness' })).not.toBeInTheDocument();
  });

  it('closes the menu on Escape', () => {
    render(<GroupByDropdown value="none" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Group by:/i }));
    expect(screen.getByRole('menuitem', { name: 'harness' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'harness' })).not.toBeInTheDocument();
  });
});
