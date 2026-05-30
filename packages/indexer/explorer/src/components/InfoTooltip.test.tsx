import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { InfoTooltip } from './InfoTooltip';

describe('InfoTooltip', () => {
  it('renders the `?` glyph as a button', () => {
    render(<InfoTooltip>body text</InfoTooltip>);
    const trigger = screen.getByRole('button', { name: /more info/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('?');
  });

  it('hides the body by default', () => {
    render(<InfoTooltip>tooltip body — definition</InfoTooltip>);
    expect(screen.queryByText('tooltip body — definition')).toBeNull();
  });

  it('clicks the trigger to toggle the body open', () => {
    render(<InfoTooltip>tooltip body — definition</InfoTooltip>);
    const trigger = screen.getByRole('button', { name: /more info/i });
    fireEvent.click(trigger);
    expect(screen.getByText('tooltip body — definition')).toBeInTheDocument();
  });

  it('clicking the trigger a second time closes the body', () => {
    render(<InfoTooltip>tooltip body — definition</InfoTooltip>);
    const trigger = screen.getByRole('button', { name: /more info/i });
    fireEvent.click(trigger);
    expect(screen.getByText('tooltip body — definition')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByText('tooltip body — definition')).toBeNull();
  });

  it('outside mousedown dismisses the body', () => {
    render(
      <div>
        <span data-testid="outside">outside</span>
        <InfoTooltip>tooltip body — definition</InfoTooltip>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /more info/i }));
    expect(screen.getByText('tooltip body — definition')).toBeInTheDocument();
    // mousedown on an outside element should dismiss.
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('tooltip body — definition')).toBeNull();
  });

  it('renders rich children inside the body', () => {
    render(
      <InfoTooltip>
        <strong>headline</strong>
        <div data-testid="bodyline">window line</div>
      </InfoTooltip>,
    );
    fireEvent.click(screen.getByRole('button', { name: /more info/i }));
    expect(screen.getByText('headline')).toBeInTheDocument();
    expect(screen.getByTestId('bodyline')).toHaveTextContent('window line');
  });

  it('honours a custom aria-label on the trigger', () => {
    render(<InfoTooltip label="active definition">body</InfoTooltip>);
    expect(
      screen.getByRole('button', { name: 'active definition' }),
    ).toBeInTheDocument();
  });
});
