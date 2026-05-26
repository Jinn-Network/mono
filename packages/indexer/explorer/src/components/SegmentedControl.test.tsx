import { render, screen, fireEvent } from '@testing-library/react';
import { SegmentedControl } from './SegmentedControl';

describe('SegmentedControl', () => {
  it('renders each option button with its label', () => {
    render(
      <SegmentedControl
        options={[
          { label: '20', value: '20' },
          { label: '30', value: '30' },
        ]}
        value="20"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '20' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30' })).toBeInTheDocument();
  });

  it('marks the active option with aria-pressed=true', () => {
    render(
      <SegmentedControl
        options={[
          { label: '20', value: '20' },
          { label: '30', value: '30' },
        ]}
        value="30"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '30' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '20' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('calls onChange with the clicked value', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={[
          { label: '20', value: '20' },
          { label: '30', value: '30' },
        ]}
        value="20"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '30' }));
    expect(onChange).toHaveBeenCalledWith('30');
  });
});
