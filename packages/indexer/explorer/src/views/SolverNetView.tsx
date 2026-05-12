/**
 * SolverNetView — stub.
 * Real implementation lands in ebu7.5+.
 */

import { useParams } from 'wouter';
import { useSolverNet } from '../lib/api';
import { StatusBar } from '../components/StatusBar';

export function SolverNetView() {
  const params = useParams<{ cid: string }>();
  const cid = params.cid ?? '';
  const { data, isLoading, isError } = useSolverNet(cid);

  return (
    <div style={{ padding: '32px 28px 80px' }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          marginBottom: 16,
        }}
      >
        SolverNet &middot; {cid || '…'}
      </div>

      {isLoading && (
        <p style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          loading…
        </p>
      )}
      {isError && (
        <p style={{ color: 'var(--break-red)', fontFamily: 'var(--font-mono)' }}>
          failed to load
        </p>
      )}
      {data && (
        <pre
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--fg-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {JSON.stringify(data, null, 2)}
        </pre>
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        degraded={isError}
      />
    </div>
  );
}
