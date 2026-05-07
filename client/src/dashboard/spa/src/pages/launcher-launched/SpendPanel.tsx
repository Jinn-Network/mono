import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type {
  LauncherStatusResponse,
  LaunchedSolverNetRecord,
  SolverNetManifestV1,
} from '../../api/types.js';
import { formatEthFromWei, projectRunwayTasks, truncateAddress } from './helpers.js';

/**
 * Safe-funded budget overview for the launched SolverNet.
 *
 * Sources:
 *   - Solution + verdict prices come straight from the manifest.
 *   - Safe balance comes from the existing `/v1/launcher/status` endpoint —
 *     the daemon's launcher-status assembler returns the launcher's master
 *     Safe balance per net. Until a per-SolverNet Safe lands (out of scope
 *     for Task 19), this panel matches the manifest's `name` against the
 *     launcher-status `nets[i].name` to pick the right entry.
 *
 * If `/v1/launcher/status` returns no matching net (e.g., the operator
 * disabled the launching role manually, or the daemon hasn't surfaced it
 * yet), we degrade to "balance unavailable" rather than fail the panel —
 * the manifest prices remain visible.
 */

export interface SpendPanelProps {
  record: LaunchedSolverNetRecord;
  manifest?: SolverNetManifestV1;
  /** Override fetcher in tests. */
  fetchLauncherStatus?: () => Promise<LauncherStatusResponse>;
}

export function SpendPanel({
  record,
  manifest,
  fetchLauncherStatus,
}: SpendPanelProps): JSX.Element {
  const fetcher = fetchLauncherStatus ?? (() => api.fetchLauncherStatus());
  const { data: status, isLoading, isError } = useQuery<LauncherStatusResponse>({
    queryKey: ['launcher-status', record.solverNetId],
    queryFn: () => fetcher(),
    refetchInterval: 30_000,
  });

  const matchedEntry = manifest
    ? status?.nets.find((n) => n.name === manifest.name)
    : undefined;

  const safeBalanceWei = matchedEntry?.budget.safeBalanceWei;
  const safeAddress =
    matchedEntry?.budget.safeAddress ?? record.launcherSafeAddress;

  const solutionPriceWei = manifest?.solutionPriceWei;
  const verdictPriceWei = manifest?.verdictPriceWei;

  const projection = projectRunwayTasks(
    safeBalanceWei,
    solutionPriceWei,
    verdictPriceWei,
  );

  return (
    <section data-testid="launcher-launched-spend-panel" style={panelStyle}>
      <header style={headerStyle}>
        <h2 style={titleStyle}>Spend & runway</h2>
      </header>

      <dl style={gridStyle}>
        <Field
          label="Safe address"
          value={truncateAddress(safeAddress)}
          title={safeAddress}
          testid="launcher-launched-spend-safe-address"
        />
        <Field
          label="Safe balance"
          value={
            isLoading
              ? '—'
              : safeBalanceWei
                ? `${formatEthFromWei(safeBalanceWei)} (${safeBalanceWei} wei)`
                : 'unavailable'
          }
          testid="launcher-launched-spend-safe-balance"
        />
        <Field
          label="Solution price"
          value={
            solutionPriceWei
              ? `${solutionPriceWei} wei (${formatEthFromWei(solutionPriceWei)})`
              : '—'
          }
          testid="launcher-launched-spend-solution-price"
        />
        <Field
          label="Verdict price"
          value={
            verdictPriceWei
              ? `${verdictPriceWei} wei (${formatEthFromWei(verdictPriceWei)})`
              : '—'
          }
          testid="launcher-launched-spend-verdict-price"
        />
        <Field
          label="Per-Task cost"
          value={
            projection
              ? `${projection.perTaskWei.toString()} wei (${formatEthFromWei(projection.perTaskWei.toString())})`
              : '—'
          }
          testid="launcher-launched-spend-per-task"
        />
        <Field
          label="Projected runway"
          value={
            projection
              ? `${projection.tasks.toLocaleString()} Tasks at current prices`
              : 'manifest or balance unavailable'
          }
          testid="launcher-launched-spend-runway"
        />
      </dl>

      {isError && (
        <span
          data-testid="launcher-launched-spend-error"
          style={{
            color: 'var(--break-red)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
          }}
        >
          Failed to load Safe balance.
        </span>
      )}

      <p
        style={{
          margin: 0,
          color: 'var(--fg-dim)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          lineHeight: 1.5,
        }}
      >
        Runway projects how many Tasks the Safe can fund at the current
        manifest prices, before any operator participation cost adjustments.
      </p>
    </section>
  );
}

function Field({
  label,
  value,
  testid,
  title,
}: {
  label: string;
  value: string;
  testid?: string;
  title?: string;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
      <dt
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '10px',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
        }}
      >
        {label}
      </dt>
      <dd
        data-testid={testid}
        title={title}
        style={{
          margin: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '13px',
          color: 'var(--fg)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </dd>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-3)',
  padding: '20px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: "'Instrument Serif', 'Times New Roman', serif",
  fontSize: '22px',
  color: 'var(--fg)',
  fontWeight: 400,
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: '8px 16px',
  margin: 0,
};
