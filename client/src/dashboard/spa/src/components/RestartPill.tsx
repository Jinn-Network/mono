/**
 * Tiny inline indicator on field labels: this field requires a daemon
 * restart to apply. Wane-coloured to match the "needs attention" tone
 * without being alarming.
 */
export function RestartPill(): JSX.Element {
  return (
    <span
      style={{
        color: 'var(--wane)',
        fontSize: '9px',
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontFamily: "'JetBrains Mono', monospace",
        border: '1px solid var(--wane)',
        borderRadius: '999px',
        padding: '1px 6px',
      }}
    >
      restart
    </span>
  );
}
