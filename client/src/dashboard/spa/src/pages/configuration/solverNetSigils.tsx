/**
 * Per-SolverNet sigil slot — a 26x26 mark rendered next to each SolverNet's
 * name in the Operator > SolverNets section.
 *
 * NOTE: The 'prediction' orb is a TEMPORARY placeholder pending real per-net
 * brand art (see bd issue jinn-mono-l2zl.15.4.10). The fallback uses the
 * existing mark-node.svg shape — a node-in-a-network — as a generic
 * SolverNet mark inlined here so we don't need a Vite SVG-import plugin.
 *
 * All SVGs use `currentColor` / token-driven inline color so they inherit
 * the card's color tokens cleanly.
 */

import type { CSSProperties, JSX } from 'react';

export interface SolverNetSigilProps {
  name: string;
}

export function SolverNetSigil({ name }: SolverNetSigilProps): JSX.Element {
  const slot: CSSProperties = {
    width: '26px',
    height: '26px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--fg-muted)',
    flexShrink: 0,
  };

  return (
    <span data-testid="solver-net-sigil" data-sigil-name={name} style={slot}>
      {renderMark(name)}
    </span>
  );
}

function renderMark(name: string): JSX.Element {
  if (name === 'prediction') {
    // Temporary prediction orb — circle (orb) with a small highlight gleam.
    // Replace with real Prediction sigil per bd issue jinn-mono-l2zl.15.4.10.
    return (
      <svg
        data-testid="solver-net-sigil-prediction"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <circle cx="9" cy="9" r="1.5" fill="currentColor" opacity="0.8" />
      </svg>
    );
  }

  // Fallback — generic SolverNet mark adapted from mark-node.svg.
  return (
    <svg
      data-testid="solver-net-sigil-fallback"
      width="18"
      height="18"
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
    >
      <rect x="8" y="8" width="104" height="104" stroke="currentColor" strokeWidth="6" fill="none" />
      <circle cx="60" cy="60" r="34" stroke="currentColor" strokeWidth="6" fill="none" />
      <circle cx="60" cy="60" r="10" fill="currentColor" />
    </svg>
  );
}
