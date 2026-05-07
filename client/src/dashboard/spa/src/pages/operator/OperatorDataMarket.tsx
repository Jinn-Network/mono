import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionCard } from '../../components/SectionCard.js';
import { api } from '../../api/client.js';
import type {
  OperatorArtifact,
  OperatorArtifactSource,
  OperatorArtifactsResponse,
  OperatorPricingConfig,
} from '../../api/types.js';

interface OperatorDataMarketProps {
  defaultExpanded?: boolean;
  onRestartPending?: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function shortSha(sha: string): string {
  return sha.length > 14 ? `${sha.slice(0, 10)}…${sha.slice(-6)}` : sha;
}

function priceLabel(value: string | undefined): string {
  if (value === undefined) return '—';
  return value === '0' ? 'free' : `$${value}`;
}

function revenueLabel(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return `$${n.toFixed(n >= 1 ? 2 : 4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function samePricing(a: OperatorPricingConfig, b: OperatorPricingConfig): boolean {
  return (
    a.publicEndpoint === b.publicEndpoint &&
    a.defaultPriceUsdc === b.defaultPriceUsdc &&
    JSON.stringify(sortedRecord(a.perArtifactTypePrice)) === JSON.stringify(sortedRecord(b.perArtifactTypePrice))
  );
}

function Stat({
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
      data-testid="operator-data-market-stat"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
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

function PricingEditor({
  pricing,
  knownArtifactTypes,
  saving,
  error,
  onSave,
}: {
  pricing: OperatorPricingConfig;
  knownArtifactTypes: string[];
  saving: boolean;
  error: string | null;
  onSave: (pricing: OperatorPricingConfig) => void;
}): JSX.Element {
  const [publicEndpoint, setPublicEndpoint] = useState(pricing.publicEndpoint);
  const [defaultPriceUsdc, setDefaultPriceUsdc] = useState(pricing.defaultPriceUsdc);
  const [perArtifactTypePrice, setPerArtifactTypePrice] = useState(pricing.perArtifactTypePrice);
  const [newArtifactType, setNewArtifactType] = useState('');
  const [newPrice, setNewPrice] = useState('');

  const draft = useMemo<OperatorPricingConfig>(() => ({
    publicEndpoint,
    defaultPriceUsdc,
    perArtifactTypePrice,
  }), [defaultPriceUsdc, perArtifactTypePrice, publicEndpoint]);

  const dirty = !samePricing(pricing, draft);
  const displayedTypes = useMemo(() => {
    return Array.from(new Set([
      ...knownArtifactTypes,
      ...Object.keys(perArtifactTypePrice),
    ])).sort((a, b) => a.localeCompare(b));
  }, [knownArtifactTypes, perArtifactTypePrice]);

  const setTypePrice = (artifactType: string, price: string): void => {
    setPerArtifactTypePrice((prev) => ({
      ...prev,
      [artifactType]: price,
    }));
  };

  const removeTypePrice = (artifactType: string): void => {
    setPerArtifactTypePrice((prev) => {
      const next = { ...prev };
      delete next[artifactType];
      return next;
    });
  };

  const addTypePrice = (): void => {
    const artifactType = newArtifactType.trim();
    const price = newPrice.trim();
    if (!artifactType || !price) return;
    setTypePrice(artifactType, price);
    setNewArtifactType('');
    setNewPrice('');
  };

  return (
    <div
      data-testid="operator-pricing-editor"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-2)',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(120px, 0.5fr)', gap: '12px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span className="j-label">Public endpoint</span>
          <input
            type="url"
            value={publicEndpoint}
            onChange={(event) => setPublicEndpoint(event.target.value)}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              color: 'var(--fg)',
              minWidth: 0,
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span className="j-label">Default USDC</span>
          <input
            type="text"
            inputMode="decimal"
            value={defaultPriceUsdc}
            onChange={(event) => setDefaultPriceUsdc(event.target.value)}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '13px',
              color: 'var(--fg)',
              minWidth: 0,
            }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span className="j-label">Type overrides</span>
        {displayedTypes.length === 0 && (
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'var(--fg-muted)' }}>
            No artifact types recorded yet.
          </span>
        )}
        {displayedTypes.map((artifactType) => (
          <div
            key={artifactType}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 140px auto',
              gap: '8px',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
                color: 'var(--fg)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {artifactType}
            </span>
            <input
              aria-label={`Price for ${artifactType}`}
              type="text"
              inputMode="decimal"
              placeholder={defaultPriceUsdc}
              value={perArtifactTypePrice[artifactType] ?? ''}
              onChange={(event) => setTypePrice(artifactType, event.target.value)}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '8px 10px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
                color: 'var(--fg)',
                minWidth: 0,
              }}
            />
            <button
              type="button"
              onClick={() => removeTypePrice(artifactType)}
              style={{
                border: '1px solid var(--border)',
                borderRadius: '6px',
                background: 'transparent',
                color: 'var(--fg)',
                padding: '8px 10px',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              Clear
            </button>
          </div>
        ))}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 140px auto',
            gap: '8px',
            alignItems: 'center',
          }}
        >
          <input
            aria-label="New artifact type"
            type="text"
            value={newArtifactType}
            placeholder="artifact.type"
            onChange={(event) => setNewArtifactType(event.target.value)}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '8px 10px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: 'var(--fg)',
              minWidth: 0,
            }}
          />
          <input
            aria-label="New artifact price"
            type="text"
            inputMode="decimal"
            value={newPrice}
            placeholder="0"
            onChange={(event) => setNewPrice(event.target.value)}
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '8px 10px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: 'var(--fg)',
              minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={addTypePrice}
            style={{
              border: '1px solid var(--accent-sky)',
              borderRadius: '6px',
              background: 'transparent',
              color: 'var(--accent-sky)',
              padding: '8px 10px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Add
          </button>
        </div>
      </div>

      <div
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: '12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <span
          data-testid="operator-pricing-state"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: error ? 'var(--break-red)' : dirty ? 'var(--accent-sky)' : 'var(--fg-dim)',
          }}
        >
          {error ?? (dirty ? 'Pricing changed' : 'Pricing current')}
        </span>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => onSave({
            publicEndpoint: publicEndpoint.trim(),
            defaultPriceUsdc: defaultPriceUsdc.trim(),
            perArtifactTypePrice: Object.fromEntries(
              Object.entries(perArtifactTypePrice)
                .filter(([key]) => key.trim().length > 0)
                .map(([key, price]) => [key.trim(), price.trim()]),
            ),
          })}
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
          {saving ? 'Saving…' : 'Save pricing'}
        </button>
      </div>
    </div>
  );
}

function ArtifactRow({
  artifact,
  expanded,
  onToggle,
}: {
  artifact: OperatorArtifact;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const when = artifact.source === 'served' ? artifact.createdAt : artifact.fetchedAt;
  const price = artifact.source === 'served' ? artifact.priceUsdc : artifact.paidAmountUsdc;
  const access = artifact.source === 'served' ? artifact.access : null;
  return (
    <li
      data-testid="operator-artifact-row"
      style={{
        borderTop: '1px solid var(--border)',
        padding: '12px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: '24px minmax(0, 1fr)',
          gap: '10px',
          alignItems: 'start',
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <span style={{ color: 'var(--fg-dim)', fontSize: '13px' }}>{expanded ? '▾' : '▸'}</span>
        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span
            style={{
              display: 'block',
              color: 'var(--fg)',
              fontSize: '13px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {artifact.artifactType}
          </span>
          <span
            style={{
              display: 'flex',
              gap: '12px',
              flexWrap: 'wrap',
              alignItems: 'center',
              color: 'var(--fg-dim)',
              fontSize: '11px',
            }}
          >
            <span>{shortSha(artifact.sha256)}</span>
            <span style={{ color: price === '0' ? 'var(--fg-dim)' : 'var(--accent-gold)' }}>
              {artifact.source === 'served' ? priceLabel(price) : `paid ${priceLabel(price)}`}
            </span>
            <span style={{ color: 'var(--fg-muted)' }}>{formatBytes(artifact.contentSize)}</span>
            <span style={{ color: 'var(--fg-muted)' }}>{formatTime(when)}</span>
            {access && access.accessCount > 0 && (
              <span style={{ color: 'var(--accent-sky)' }}>{access.accessCount} accesses</span>
            )}
          </span>
        </span>
      </button>

      {expanded && (
        <dl
          data-testid="operator-artifact-details"
          style={{
            margin: 0,
            padding: '12px 14px',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
            display: 'grid',
            gridTemplateColumns: '140px minmax(0, 1fr)',
            gap: '8px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
          }}
        >
          <dt style={{ color: 'var(--fg-dim)' }}>sha256</dt>
          <dd style={{ margin: 0, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{artifact.sha256}</dd>
          <dt style={{ color: 'var(--fg-dim)' }}>envelope</dt>
          <dd style={{ margin: 0, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{artifact.envelopeCid ?? '—'}</dd>
          {artifact.source === 'served' ? (
            <>
              <dt style={{ color: 'var(--fg-dim)' }}>request</dt>
              <dd style={{ margin: 0, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{artifact.requestId ?? '—'}</dd>
              <dt style={{ color: 'var(--fg-dim)' }}>endpoint</dt>
              <dd style={{ margin: 0, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{artifact.endpoint ?? '—'}</dd>
              <dt style={{ color: 'var(--fg-dim)' }}>accesses</dt>
              <dd style={{ margin: 0, color: 'var(--fg)' }}>
                {artifact.access.accessCount} total · {artifact.access.paidServeCount} paid · {artifact.access.failedPaymentCount} failed
              </dd>
              <dt style={{ color: 'var(--fg-dim)' }}>revenue</dt>
              <dd style={{ margin: 0, color: 'var(--fg)' }}>{revenueLabel(artifact.access.revenueUsdc)}</dd>
              <dt style={{ color: 'var(--fg-dim)' }}>last access</dt>
              <dd style={{ margin: 0, color: 'var(--fg)' }}>{formatTime(artifact.access.lastAccessAt)}</dd>
            </>
          ) : (
            <>
              <dt style={{ color: 'var(--fg-dim)' }}>origin</dt>
              <dd style={{ margin: 0, color: 'var(--fg)' }}>{artifact.origin}</dd>
              <dt style={{ color: 'var(--fg-dim)' }}>operator</dt>
              <dd style={{ margin: 0, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{artifact.sourceOperator ?? '—'}</dd>
              <dt style={{ color: 'var(--fg-dim)' }}>endpoint</dt>
              <dd style={{ margin: 0, color: 'var(--fg)', overflowWrap: 'anywhere' }}>{artifact.sourceEndpoint ?? '—'}</dd>
            </>
          )}
        </dl>
      )}
    </li>
  );
}

export function OperatorDataMarket({
  defaultExpanded = false,
  onRestartPending = () => undefined,
}: OperatorDataMarketProps): JSX.Element {
  const [source, setSource] = useState<OperatorArtifactSource>('served');
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery<OperatorArtifactsResponse>({
    queryKey: ['operator-artifacts', source],
    queryFn: () => api.operator.listArtifacts({ source, limit: 100 }),
    refetchInterval: 10_000,
  });

  const pricingMutation = useMutation({
    mutationFn: (pricing: OperatorPricingConfig) => api.operator.updatePricing(pricing),
    onSuccess: async () => {
      onRestartPending();
      await queryClient.invalidateQueries({ queryKey: ['operator-artifacts'] });
    },
  });

  const knownArtifactTypes = useMemo(() => {
    const servedTypes = data?.summary.served.artifactTypes.map((row) => row.artifactType) ?? [];
    const networkTypes = data?.summary.network.artifactTypes.map((row) => row.artifactType) ?? [];
    return Array.from(new Set([...servedTypes, ...networkTypes])).sort((a, b) => a.localeCompare(b));
  }, [data?.summary.network.artifactTypes, data?.summary.served.artifactTypes]);

  const summary = data?.summary;
  const sectionSummary = summary
    ? `${summary.served.totalCount} served · ${summary.served.gatedCount} gated · ${summary.network.totalCount} cached`
    : 'Local artifact inventory and publish-time pricing';

  return (
    <SectionCard
      title="Data market"
      summary={sectionSummary}
      defaultExpanded={defaultExpanded}
      metaChip={{
        label: summary && summary.served.gatedCount > 0 ? 'Gated' : 'Free',
        tone: summary && summary.served.gatedCount > 0 ? 'attention' : 'default',
      }}
    >
      {isLoading && (
        <p data-testid="operator-data-market-loading" style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}>
          Loading artifact store…
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
            {error instanceof Error ? error.message : 'Failed to load artifact store.'}
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
          <div
            data-testid="operator-data-market"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: '10px',
            }}
          >
            <Stat
              label="Served"
              value={String(data.summary.served.totalCount)}
              meta={formatBytes(data.summary.served.totalBytes)}
            />
            <Stat
              label="Gated"
              value={String(data.summary.served.gatedCount)}
              meta={`${data.summary.served.freeCount} free`}
            />
            <Stat
              label="Accesses"
              value={String(data.summary.access.accessCount)}
              meta={`${data.summary.access.paidServeCount} paid · ${data.summary.access.failedPaymentCount} failed`}
            />
            <Stat
              label="Revenue"
              value={revenueLabel(data.summary.access.revenueUsdc)}
              meta={data.summary.access.lastPaidAt ? `last paid ${formatTime(data.summary.access.lastPaidAt)}` : 'no paid serves'}
            />
            <Stat
              label="Default price"
              value={priceLabel(data.pricing.defaultPriceUsdc)}
              meta={`${Object.keys(data.pricing.perArtifactTypePrice).length} overrides`}
            />
            <Stat
              label="Cached"
              value={String(data.summary.network.totalCount)}
              meta={formatBytes(data.summary.network.totalBytes)}
            />
          </div>

          <PricingEditor
            key={`${data.pricing.publicEndpoint}|${data.pricing.defaultPriceUsdc}|${JSON.stringify(sortedRecord(data.pricing.perArtifactTypePrice))}`}
            pricing={data.pricing}
            knownArtifactTypes={knownArtifactTypes}
            saving={pricingMutation.isPending}
            error={pricingMutation.error instanceof Error ? pricingMutation.error.message : null}
            onSave={(pricing) => pricingMutation.mutate(pricing)}
          />

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
            <div
              role="tablist"
              aria-label="Artifact source"
              style={{
                display: 'inline-flex',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                overflow: 'hidden',
              }}
            >
              {(['served', 'network'] as const).map((nextSource) => (
                <button
                  key={nextSource}
                  type="button"
                  role="tab"
                  aria-selected={source === nextSource}
                  onClick={() => {
                    setSource(nextSource);
                    setExpandedSha(null);
                  }}
                  style={{
                    border: 'none',
                    borderRight: nextSource === 'served' ? '1px solid var(--border)' : 'none',
                    background: source === nextSource ? 'var(--accent-sky)' : 'transparent',
                    color: source === nextSource ? 'var(--bg-sunken)' : 'var(--fg)',
                    padding: '8px 12px',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '12px',
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {nextSource}
                </button>
              ))}
            </div>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: 'var(--fg-dim)' }}>
              {formatTime(data.generatedAt)}
            </span>
          </div>

          {data.artifacts.length === 0 ? (
            <p data-testid="operator-artifacts-empty" style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px' }}>
              No {source} artifacts recorded yet.
            </p>
          ) : (
            <ul
              data-testid="operator-artifact-list"
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {data.artifacts.map((artifact) => (
                <ArtifactRow
                  key={`${artifact.source}:${artifact.sha256}`}
                  artifact={artifact}
                  expanded={expandedSha === artifact.sha256}
                  onToggle={() => setExpandedSha((prev) => prev === artifact.sha256 ? null : artifact.sha256)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </SectionCard>
  );
}
