import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from './AppShell.js';

describe('AppShell', () => {
  it('renders header, tabs, main outlet, and rail slots', () => {
    render(
      <AppShell
        header={<div data-testid="header">H</div>}
        tabs={<div data-testid="tabs">T</div>}
        rail={<div data-testid="rail">R</div>}
      >
        <div data-testid="main">M</div>
      </AppShell>,
    );
    expect(screen.getByTestId('header')).toBeTruthy();
    expect(screen.getByTestId('tabs')).toBeTruthy();
    expect(screen.getByTestId('rail')).toBeTruthy();
    expect(screen.getByTestId('main')).toBeTruthy();
  });

  // Issue #326: when the embedded agent surface is hidden the rail prop is
  // omitted; the shell renders no aside and collapses to a single column.
  it('renders no rail aside when the rail prop is omitted', () => {
    render(
      <AppShell
        header={<div data-testid="header">H</div>}
        tabs={<div data-testid="tabs">T</div>}
      >
        <div data-testid="main">M</div>
      </AppShell>,
    );
    expect(screen.getByTestId('header')).toBeTruthy();
    expect(screen.getByTestId('main')).toBeTruthy();
    expect(screen.queryByTestId('rail')).toBeNull();
  });
});
