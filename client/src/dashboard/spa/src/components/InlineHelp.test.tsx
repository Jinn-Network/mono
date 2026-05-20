import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineHelp } from './InlineHelp.js';

afterEach(() => {
  cleanup();
});

describe('InlineHelp', () => {
  it('renders the trigger collapsed by default', () => {
    render(<InlineHelp label="Roles help">Decision context.</InlineHelp>);
    const trigger = screen.getByTestId('inline-help-trigger');
    expect(trigger.getAttribute('aria-label')).toBe('Roles help');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('inline-help-panel')).toBeNull();
  });

  it('expands the panel when the trigger is clicked', () => {
    render(<InlineHelp label="Roles help">Decision context.</InlineHelp>);
    fireEvent.click(screen.getByTestId('inline-help-trigger'));
    const panel = screen.getByTestId('inline-help-panel');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toMatch(/decision context/i);
    expect(
      screen.getByTestId('inline-help-trigger').getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('collapses again on a second click', () => {
    render(<InlineHelp label="Roles help">Decision context.</InlineHelp>);
    const trigger = screen.getByTestId('inline-help-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('inline-help-panel')).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('inline-help-panel')).toBeNull();
  });

  it('renders a doc link inside the panel when docHref is supplied', () => {
    render(
      <InlineHelp
        label="Roles help"
        docHref="https://example.com/docs#roles"
        docLabel="Full guide"
      >
        Short copy.
      </InlineHelp>,
    );
    fireEvent.click(screen.getByTestId('inline-help-trigger'));
    const link = screen.getByTestId('inline-help-doc-link');
    expect(link.getAttribute('href')).toBe('https://example.com/docs#roles');
    expect(link.textContent).toBe('Full guide');
  });

  it('omits the doc link when docHref is not supplied', () => {
    render(<InlineHelp label="Roles help">Short copy.</InlineHelp>);
    fireEvent.click(screen.getByTestId('inline-help-trigger'));
    expect(screen.queryByTestId('inline-help-doc-link')).toBeNull();
  });
});
