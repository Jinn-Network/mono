import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { SectionCard } from '../../components/SectionCard.js';
import { api } from '../../api/client.js';
import type {
  OperatorArtifactsResponse,
  OperatorPricingConfig,
} from '../../api/types.js';

interface OperatorDataMarketProps {
  defaultExpanded?: boolean;
  onRestartPending?: () => void;
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function samePricing(a: OperatorPricingConfig, b: OperatorPricingConfig): boolean {
  return (
    a.publicEndpoint === b.publicEndpoint &&
    a.defaultPriceUsdc === b.defaultPriceUsdc &&
    JSON.stringify(sortedRecord(a.perArtifactTypePrice)) === JSON.stringify(sortedRecord(b.perArtifactTypePrice)) &&
    a.donation.enabled === b.donation.enabled
  );
}

function DecisionFact({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}): JSX.Element {
  return (
    <div
      data-testid="operator-donation-fact"
      style={{
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '12px 14px',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <span className="j-label">{label}</span>
      <strong
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '18px',
          color: 'var(--fg)',
          fontWeight: 500,
        }}
      >
        {value}
      </strong>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          color: 'var(--fg-dim)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {meta}
      </span>
    </div>
  );
}

function DonationStatusPanel({
  pricing,
  eligibleRuns,
  peerDatasetsUsed,
  saving,
  error,
  onSave,
}: {
  pricing: OperatorPricingConfig;
  eligibleRuns: number;
  peerDatasetsUsed: number;
  saving: boolean;
  error: string | null;
  onSave: (pricing: OperatorPricingConfig) => void;
}): JSX.Element {
  // Optimistic local state: starts from persisted value; reverts if the write-through fails.
  const [donationEnabled, setDonationEnabled] = useState(pricing.donation.enabled);
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  // Track whether we initiated a donation write-through so we can revert on error.
  const writeThroughPending = useRef(false);
  const prevError = useRef(error);
  useEffect(() => {
    const errorJustArrived = error !== null && prevError.current === null;
    prevError.current = error;
    if (errorJustArrived && writeThroughPending.current) {
      writeThroughPending.current = false;
      setDonationEnabled(pricing.donation.enabled);
    }
  }, [error, pricing.donation.enabled]);

  // Build a draft for the non-donation pricing fields — Save covers those.
  // Donation writes through immediately so it is always "in sync" with server.
  const draft = useMemo<OperatorPricingConfig>(() => ({
    publicEndpoint: pricing.publicEndpoint,
    defaultPriceUsdc: pricing.defaultPriceUsdc,
    perArtifactTypePrice: pricing.perArtifactTypePrice,
    donation: { enabled: pricing.donation.enabled },
  }), [pricing.defaultPriceUsdc, pricing.donation.enabled, pricing.perArtifactTypePrice, pricing.publicEndpoint]);

  const dirty = !samePricing(pricing, draft);
  const requestDonationChange = (enabled: boolean): void => {
    if (enabled && !donationEnabled && !pricing.donation.enabled) {
      setConfirmationOpen(true);
      return;
    }
    setDonationEnabled(enabled);
  };

  const confirmDonationEnable = (): void => {
    // Optimistically show "on" immediately; revert in the useEffect above if mutation fails.
    setDonationEnabled(true);
    setConfirmationOpen(false);
    writeThroughPending.current = true;
    prevError.current = null; // reset so the next error is treated as fresh
    onSave({ ...pricing, donation: { enabled: true } });
  };

  return (
    <div
      data-testid="operator-donation-status"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', minWidth: '260px', flex: '1 1 360px' }}>
          <span className="j-label">Donate execution data</span>
          <strong
            data-testid="operator-donation-mode"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '18px',
              color: donationEnabled ? 'var(--vow-green)' : 'var(--fg)',
              fontWeight: 500,
            }}
          >
            {donationEnabled ? 'Donation is on' : 'Donation is off'}
          </strong>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'var(--fg-dim)', lineHeight: 1.45 }}>
            Share scrubbed and anonymized solver/evaluator data from future
            runs with other operators. This lets the network learn from real
            executions and improve itself. Public testnet donations are free
            and published to IPFS.
          </span>
        </div>

        <label
          data-testid="operator-donation-toggle"
          style={{
            border: '1px solid var(--border)',
            borderRadius: '999px',
            padding: '5px',
            display: 'inline-grid',
            gridTemplateColumns: 'minmax(72px, auto) 42px',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            background: 'var(--bg-sunken)',
            position: 'relative',
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              color: donationEnabled ? 'var(--vow-green)' : 'var(--fg-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              paddingLeft: '8px',
              whiteSpace: 'nowrap',
            }}
          >
            {donationEnabled ? 'On' : 'Off'}
          </span>
          <span
            aria-hidden="true"
            style={{
              width: '38px',
              height: '22px',
              borderRadius: '999px',
              background: donationEnabled ? 'var(--vow-green)' : 'var(--border)',
              position: 'relative',
              display: 'inline-block',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: '3px',
                left: donationEnabled ? '19px' : '3px',
                width: '16px',
                height: '16px',
                borderRadius: '999px',
                background: 'var(--bg)',
                transition: 'left 120ms ease',
              }}
            />
          </span>
          <input
            aria-label="Donate produced data"
            type="checkbox"
            checked={donationEnabled}
            onChange={(event) => requestDonationChange(event.target.checked)}
            style={{
              position: 'absolute',
              opacity: 0,
              pointerEvents: 'none',
            }}
          />
        </label>
      </div>

      <div
        data-testid="operator-donation-facts"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '10px',
        }}
      >
        <DecisionFact
          label="Eligible runs"
          value={String(eligibleRuns)}
          meta="local history"
        />
        <DecisionFact
          label="Peer datasets used"
          value={String(peerDatasetsUsed)}
          meta="from other operators"
        />
      </div>

      <div
        data-testid="operator-donation-caveat"
        style={{
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '11px 13px',
          color: 'var(--fg-muted)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12px',
          lineHeight: 1.45,
        }}
      >
        Turning donation off stops future publishing. Data already published to
        IPFS may remain available.
      </div>

      <div
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: '12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <Link
          href="/operator/execution-data"
          style={{
            color: 'var(--accent-sky)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            textDecoration: 'none',
          }}
        >
          Review execution data →
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: 'auto' }}>
          <span
            data-testid="operator-donation-settings-state"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: error ? 'var(--break-red)' : dirty ? 'var(--accent-sky)' : 'var(--fg-dim)',
            }}
          >
            {error ?? (dirty ? 'Donation changed' : 'Current')}
          </span>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => onSave(draft)}
            style={{
              border: '1px solid var(--accent-sky)',
              background: dirty ? 'var(--accent-sky)' : 'transparent',
              color: dirty ? 'var(--bg-sunken)' : 'var(--fg-dim)',
              borderRadius: '6px',
              padding: '9px 14px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              cursor: !dirty || saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {confirmationOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="operator-donation-confirm-title"
          data-testid="operator-donation-confirm"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 40,
            background: 'rgba(0, 0, 0, 0.55)',
            display: 'grid',
            placeItems: 'center',
            padding: '24px',
          }}
        >
          <div
            style={{
              width: 'min(460px, 100%)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              background: 'var(--bg-elevated)',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              boxShadow: '0 22px 70px rgba(0, 0, 0, 0.36)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              <span className="j-label">Enable donation</span>
              <strong
                id="operator-donation-confirm-title"
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '18px',
                  color: 'var(--fg)',
                  fontWeight: 500,
                }}
              >
                Share future execution data
              </strong>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'var(--fg-dim)', lineHeight: 1.5 }}>
                Future solver/evaluator runs will be scrubbed, anonymized, and
                published to IPFS so other operators can use them. This helps
                the network learn from real executions and improve itself.
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                Turning donation off later stops future publishing, but data
                already published to IPFS may remain available.
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setConfirmationOpen(false)}
                style={{
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--fg)',
                  borderRadius: '6px',
                  padding: '9px 14px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDonationEnable}
                style={{
                  border: '1px solid var(--accent-sky)',
                  background: 'var(--accent-sky)',
                  color: 'var(--bg-sunken)',
                  borderRadius: '6px',
                  padding: '9px 14px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Enable donation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function OperatorDataMarket({
  defaultExpanded = false,
  onRestartPending = () => undefined,
}: OperatorDataMarketProps): JSX.Element {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery<OperatorArtifactsResponse>({
    queryKey: ['operator-artifacts', 'served'],
    queryFn: () => api.operator.listArtifacts({ source: 'served', limit: 100 }),
    refetchInterval: 10_000,
  });

  const pricingMutation = useMutation({
    mutationFn: (pricing: OperatorPricingConfig) => api.operator.updatePricing(pricing),
    onSuccess: async () => {
      onRestartPending();
      await queryClient.invalidateQueries({ queryKey: ['operator-artifacts'] });
    },
  });

  const summary = data?.summary;
  const sectionSummary = summary
    ? `${summary.served.totalCount} eligible runs · donation ${data?.pricing.donation.enabled ? 'on' : 'off'} · ${summary.network.totalCount} peer datasets used`
    : 'Donate scrubbed and anonymized run data to IPFS so other operators can use it.';

  return (
    <SectionCard
      title="Data donation"
      summary={sectionSummary}
      defaultExpanded={defaultExpanded}
      metaChip={
        {
          label: data?.pricing.donation.enabled ? 'IPFS donation on' : 'Donation off',
          tone: data?.pricing.donation.enabled ? 'live' : 'default',
        }
      }
    >
      {isLoading && (
        <p data-testid="operator-data-market-loading" style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}>
          Loading execution data…
        </p>
      )}

      {isError && (
        <div
          role="alert"
          data-testid="operator-data-market-error"
          style={{
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '14px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            gap: '12px',
            alignItems: 'center',
          }}
        >
          <span style={{ color: 'var(--break-red)', fontSize: '13px' }}>
            {error instanceof Error ? error.message : 'Failed to load execution data.'}
          </span>
          <button
            type="button"
            onClick={() => { void refetch(); }}
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-1)',
              background: 'transparent',
              color: 'var(--fg)',
              padding: '7px 10px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          <DonationStatusPanel
            key={`${data.pricing.publicEndpoint}|${data.pricing.defaultPriceUsdc}|${data.pricing.donation.enabled}|${JSON.stringify(sortedRecord(data.pricing.perArtifactTypePrice))}`}
            pricing={data.pricing}
            eligibleRuns={data.summary.served.totalCount}
            peerDatasetsUsed={data.summary.network.totalCount}
            saving={pricingMutation.isPending}
            error={pricingMutation.error instanceof Error ? pricingMutation.error.message : null}
            onSave={(pricing) => pricingMutation.mutate(pricing)}
          />
        </>
      )}
    </SectionCard>
  );
}
