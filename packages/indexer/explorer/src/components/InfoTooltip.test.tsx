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

  it('portals the open body to document.body so an overflow:hidden parent does not clip it (issue #905)', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden', height: 20, width: 20 }}>
        <InfoTooltip>tooltip body — portal</InfoTooltip>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /more info/i }));
    const body = screen.getByText('tooltip body — portal');
    // Body should not be nested under the clipped container — it lives
    // directly under document.body via createPortal.
    expect(container.contains(body)).toBe(false);
    expect(document.body.contains(body)).toBe(true);
  });

  it('positions the open body with position:fixed coordinates derived from the trigger', () => {
    render(<InfoTooltip>tooltip body — fixed</InfoTooltip>);
    const trigger = screen.getByRole('button', { name: /more info/i });
    // jsdom returns zeros from getBoundingClientRect, but `position: fixed`
    // must be set so the body anchors to the viewport rather than the
    // closest positioned ancestor.
    fireEvent.click(trigger);
    const body = screen.getByText('tooltip body — fixed');
    expect(body.getAttribute('style')).toMatch(/position:\s*fixed/);
  });

  it('outside mousedown still dismisses after the body portals out', () => {
    render(
      <div>
        <span data-testid="outside">outside</span>
        <InfoTooltip>tooltip body — portaled</InfoTooltip>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /more info/i }));
    expect(screen.getByText('tooltip body — portaled')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('tooltip body — portaled')).toBeNull();
  });

  it('mousedown INSIDE the portaled body does not dismiss (the body is part of the open surface)', () => {
    render(<InfoTooltip>tooltip body — clickable</InfoTooltip>);
    fireEvent.click(screen.getByRole('button', { name: /more info/i }));
    const body = screen.getByText('tooltip body — clickable');
    fireEvent.mouseDown(body);
    // Body should remain visible — outside-click check must treat the portal
    // content as "inside".
    expect(screen.getByText('tooltip body — clickable')).toBeInTheDocument();
  });
});
