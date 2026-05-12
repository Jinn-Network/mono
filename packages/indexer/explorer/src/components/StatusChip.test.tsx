import { render, screen } from '@testing-library/react';
import { StatusChip } from './StatusChip';

describe('StatusChip', () => {
  it('renders the label text', () => {
    render(<StatusChip kind="launched" label="launched" />);
    expect(screen.getByText('launched')).toBeInTheDocument();
  });

  it('uses kind as fallback label when label prop omitted', () => {
    render(<StatusChip kind="paused" />);
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('renders with vow-green color for launched', () => {
    const { container } = render(<StatusChip kind="launched" label="launched" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.color).toContain('vow-green');
  });

  it('renders with break-red color for violation', () => {
    const { container } = render(<StatusChip kind="violation" label="violation" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.color).toContain('break-red');
  });

  it('renders with gold-600 color for frozen (muted — does not compete with focal headline gold)', () => {
    const { container } = render(<StatusChip kind="frozen" label="frozen" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.color).toContain('gold-600');
  });

  it('renders with wane color for paused', () => {
    const { container } = render(<StatusChip kind="paused" label="paused" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.color).toContain('wane');
  });

  it('renders with accent color for train', () => {
    const { container } = render(<StatusChip kind="train" label="train" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.color).toContain('accent');
  });

  it('uses dashed border for paused', () => {
    const { container } = render(<StatusChip kind="paused" label="paused" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.border).toContain('dashed');
  });

  it('uses solid border for launched', () => {
    const { container } = render(<StatusChip kind="launched" label="launched" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.border).toContain('solid');
  });

  it('renders the dot indicator', () => {
    const { container } = render(<StatusChip kind="ok" label="ok" />);
    // The dot is an aria-hidden span
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).toBeInTheDocument();
  });

  it('falls back to fg-dim for unknown kinds', () => {
    const { container } = render(<StatusChip kind="totally-unknown" label="????" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.style.color).toContain('fg-dim');
  });
});
