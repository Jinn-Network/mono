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
});
