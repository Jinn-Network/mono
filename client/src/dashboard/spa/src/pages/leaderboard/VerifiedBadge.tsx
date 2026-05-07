export function VerifiedBadge({ verified }: { verified: boolean | null }): JSX.Element | null {
  if (verified === null) return null;
  return (
    <span
      title={
        verified
          ? 'Source bundle + implStateDir CID published; codeDigest independently verifiable'
          : 'Operator-claim only; codeDigest not independently verifiable'
      }
      style={{
        fontFamily: "'JetBrains Mono', ui-monospace, SF Mono, Menlo, monospace",
        fontSize: '11px',
        color: verified ? 'var(--vow-green)' : 'var(--fg-dim)',
      }}
    >
      {verified ? '✓ verified' : '◌ unverified'}
    </span>
  );
}
