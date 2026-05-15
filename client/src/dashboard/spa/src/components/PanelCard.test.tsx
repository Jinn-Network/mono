import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PanelCard } from './PanelCard.js';

describe('PanelCard', () => {
  it('renders children', () => {
    render(<PanelCard><span data-testid="child">content</span></PanelCard>);
    expect(screen.getByTestId('child')).toBeTruthy();
  });

  it('renders a title when provided', () => {
    render(<PanelCard title="Section Title"><span>body</span></PanelCard>);
    expect(screen.getByRole('heading', { name: 'Section Title' })).toBeTruthy();
  });

  it('does not render a heading element when title is omitted', () => {
    render(<PanelCard><span>body</span></PanelCard>);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('applies the canonical border, radius, padding and background style', () => {
    const { container } = render(<PanelCard><span>body</span></PanelCard>);
    const section = container.querySelector('section')!;
    expect(section.style.border).toBe('1px solid var(--border)');
    expect(section.style.borderRadius).toBe('var(--radius-3, 10px)');
    expect(section.style.padding).toBe('24px');
    expect(section.style.background).toBe('var(--surface)');
  });

  it('merges a custom className onto the section', () => {
    const { container } = render(<PanelCard className="my-class"><span>body</span></PanelCard>);
    expect(container.querySelector('section')!.classList.contains('my-class')).toBe(true);
  });

  it('merges custom style props — overrides take precedence over defaults', () => {
    const { container } = render(
      <PanelCard style={{ background: 'var(--surface-sunken)', marginTop: '16px' }}>
        <span>body</span>
      </PanelCard>,
    );
    const section = container.querySelector('section')!;
    expect(section.style.background).toBe('var(--surface-sunken)');
    expect(section.style.marginTop).toBe('16px');
    // canonical props that were not overridden are still present
    expect(section.style.border).toBe('1px solid var(--border)');
  });
});
