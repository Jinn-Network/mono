import { RegistryCatalog } from '../operator-catalog/RegistryCatalog.js';

/**
 * /operator/registry — SolverNet registry browse + join (§2.5).
 * Extracted from SolverNetsSection DISCOVER block (Task 5.4).
 */
export function RegistryTab(): JSX.Element {
  return (
    <div
      data-testid="registry-tab"
      style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        Discover
      </span>
      <RegistryCatalog />
    </div>
  );
}
