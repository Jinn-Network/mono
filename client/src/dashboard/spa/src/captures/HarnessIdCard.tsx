import type { CaptureSummary } from '../api/types.js';

export function HarnessIdCard({ capture }: { capture: CaptureSummary }): JSX.Element {
  return (
    <section style={{ display: 'grid', gap: 6 }}>
      <h2 style={{ margin: 0, fontSize: 14 }}>Executor</h2>
      <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '6px 12px', margin: 0 }}>
        <dt style={{ color: 'var(--fg-muted)' }}>Tool</dt>
        <dd style={{ margin: 0 }}>{capture.originatingTool.name}</dd>
        <dt style={{ color: 'var(--fg-muted)' }}>Version</dt>
        <dd style={{ margin: 0 }}>{capture.originatingTool.version ?? 'unknown'}</dd>
        <dt style={{ color: 'var(--fg-muted)' }}>Repo</dt>
        <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{capture.repoRemoteUrl ?? 'none'}</dd>
        <dt style={{ color: 'var(--fg-muted)' }}>Commit</dt>
        <dd style={{ margin: 0, fontFamily: 'monospace' }}>{capture.repoCommitHash?.slice(0, 12) ?? 'none'}</dd>
      </dl>
    </section>
  );
}
