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

  it('renders the nav items — Corpus first, no redundant Network', () => {
    renderChrome();
    expect(screen.getByText('Corpus')).toBeInTheDocument();
    expect(screen.getByText('SolverNets')).toBeInTheDocument();
    expect(screen.getByText('Operators')).toBeInTheDocument();
    // Network is the logo's job now, not a duplicate nav item.
    expect(screen.queryByText('Network')).toBeNull();
  });

  it('leads the nav with Corpus', () => {
    renderChrome();
    const nav = screen.getByRole('navigation', { name: /primary/i });
    const links = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(links[0]).toBe('Corpus');
  });

  it('marks the Corpus link as active on "/corpus" and its deep paths', () => {
    renderChrome('/corpus/bafkreicorpusitem');
    const corpusLink = screen.getByText('Corpus');
    expect(corpusLink).toHaveAttribute('aria-current', 'page');
  });

  it('marks no nav item active on the Dashboard "/" (the logo is home)', () => {
    renderChrome('/');
    expect(screen.getByText('Corpus')).not.toHaveAttribute('aria-current', 'page');
  });

  it('marks the Operators link as active on "/operators"', () => {
    renderChrome('/operators');
    const operatorsLink = screen.getByText('Operators');
    expect(operatorsLink).toHaveAttribute('aria-current', 'page');
    // Corpus should NOT be active
    expect(screen.getByText('Corpus')).not.toHaveAttribute('aria-current', 'page');
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
