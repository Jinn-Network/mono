import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Chrome } from './Chrome';

function renderChrome(path = '/') {
  const { hook } = memoryLocation({ path, static: true });
  return render(
    <Router hook={hook}>
      <Chrome />
    </Router>,
  );
}

describe('Chrome', () => {
  it('renders the jinn wordmark', () => {
    renderChrome();
    expect(screen.getByText('jinn')).toBeInTheDocument();
  });

  it('renders the explorer label', () => {
    renderChrome();
    expect(screen.getByText('explorer')).toBeInTheDocument();
  });

  it('renders all three nav items', () => {
    renderChrome();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('SolverNets')).toBeInTheDocument();
    expect(screen.getByText('Operators')).toBeInTheDocument();
  });

  it('marks the Network link as active on "/"', () => {
    renderChrome('/');
    const networkLink = screen.getByText('Network');
    expect(networkLink).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Operators link as active on "/operators"', () => {
    renderChrome('/operators');
    const operatorsLink = screen.getByText('Operators');
    expect(operatorsLink).toHaveAttribute('aria-current', 'page');
    // Network should NOT be active
    expect(screen.getByText('Network')).not.toHaveAttribute('aria-current', 'page');
  });

  it('renders the search box with placeholder', () => {
    renderChrome();
    expect(
      screen.getByPlaceholderText(/Search SolverNet/i),
    ).toBeInTheDocument();
  });

  it('renders the logo sigil image', () => {
    renderChrome();
    // The img has aria-hidden="true" and alt="" so role is "presentation".
    // Query it by src attribute directly.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const img = document.querySelector('img[src="/logo-sigil.svg"]')!;
    expect(img).toBeInTheDocument();
  });
});
