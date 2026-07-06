/**
 * CorpusItemView — one corpus item's detail (#1406).
 *
 * A single published capture envelope at a stable, deep-linkable URL
 * (/corpus/:cid) — the target the jinn-agent CLI's /jinn ledger and
 * /jinn preview link to.
 *
 * Renders the indexed envelope fingerprint: summary (headline), tier, age,
 * cluster / harness / model / contributor / provenance, tags, the tool
 * sequence (tool names — the per-step scrubbed args/results live in the IPFS
 * envelope body, spec §4 open question), and the two outbound links: the IPFS
 * content ref and the Base Sepolia on-chain anchor (basescan).
 *
 * No gold hero on this surface — the tier chip carries the emphasis; a detail
 * page has no single aggregate KPI to promote (spec §3.5).
 *
 * Unknown CID → not-found notice (spec §2.4 state message).
 */

import { Link, useParams } from 'wouter';
import { useCorpusItem } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { Card } from '../components/Card';
import { CorpusTierChip, CorpusTagChip } from '../components/CorpusChips';
import { shortCid, shortAddr, relUnix, basescanTxUrl, ipfsUrl } from '../lib/format';

// ── Meta cell ─────────────────────────────────────────────────────────────────

function MetaCell({ label, value, first }: { label: string; value: React.ReactNode; first?: boolean }) {
  return (
    <div
      style={{
        padding: '14px 20px',
        borderLeft: first ? 'none' : '1px solid var(--border)',
        flex: '1 1 150px',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--fg)',
          lineHeight: 1.45,
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ── Tool step row ─────────────────────────────────────────────────────────────

function ToolRow({ tool, i }: { tool: string; i: number }) {
  return (
    <div
      style={{
        borderTop: i === 0 ? 'none' : '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span
        className="data"
        style={{
          fontSize: 10,
          color: 'var(--fg-dim)',
          width: 18,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
        }}
      >
        {i + 1}
      </span>
      <span
        aria-hidden="true"
        style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', flexShrink: 0 }}
      />
      <span
        style={{
          fontSize: 11,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        {tool}
      </span>
    </div>
  );
}

// ── Outbound link ─────────────────────────────────────────────────────────────

function OutboundLink({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string | null;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
        padding: '10px 0',
        borderTop: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          width: 130,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            color: 'var(--accent)',
            textDecoration: 'none',
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {value} ↗
        </a>
      ) : (
        <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>{value}</span>
      )}
    </div>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

function BackLink() {
  return (
    <Link
      href="/corpus"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        textDecoration: 'none',
        color: 'var(--fg-dim)',
      }}
    >
      ← Corpus
    </Link>
  );
}

// ── CorpusItemView ────────────────────────────────────────────────────────────

export function CorpusItemView() {
  const params = useParams<{ cid: string }>();
  const cid = decodeURIComponent(params?.cid ?? '');
  const { data, isLoading, isError } = useCorpusItem(cid);

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      <BackLink />

      {/* Loading */}
      {isLoading && (
        <div
          style={{
            height: 200,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-3)',
          }}
        />
      )}

      {/* Not-found / error — an unknown CID resolves here (retry:false in the hook) */}
      {isError && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--wane)',
            border: '1px solid var(--wane)',
            borderRadius: 'var(--radius-2)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <span>No corpus item at this CID. It may not be indexed yet, or the link is wrong.</span>
          <Link
            href="/corpus"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--wane)',
              border: '1px solid currentColor',
              borderRadius: 'var(--radius-1)',
              padding: '4px 10px',
              textDecoration: 'none',
            }}
          >
            Back to Corpus
          </Link>
        </div>
      )}

      {/* Data */}
      {data && (
        <>
          {/* Header */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
              <CorpusTierChip tier={data.tier} />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--fg-dim)',
                }}
              >
                {relUnix(data.createdAt)}
              </span>
            </div>
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 40,
                fontStyle: 'italic',
                lineHeight: 1.08,
                color: 'var(--fg)',
                margin: '0 0 10px',
                fontWeight: 400,
              }}
            >
              {data.summary || '(no summary)'}
            </h1>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>
              {shortCid(data.cid, 14, 8)}
            </div>
          </div>

          {/* Meta row */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-3)',
              background: 'var(--bg-elevated)',
              overflow: 'hidden',
            }}
          >
            <MetaCell first label="Cluster" value={data.cluster || '—'} />
            <MetaCell label="Harness" value={data.harness || '—'} />
            <MetaCell label="Model" value={data.model || '—'} />
            <MetaCell
              label="Contributor"
              value={
                data.contributor ? (
                  <Link
                    href={`/operator/${encodeURIComponent(data.contributor)}`}
                    style={{ color: 'var(--accent)', textDecoration: 'none' }}
                  >
                    {shortAddr(data.contributor)}
                  </Link>
                ) : (
                  '—'
                )
              }
            />
            <MetaCell
              label="Provenance"
              value={
                data.provenance === 'imported' ? (
                  // Seed provenance is a per-item fact (design: retired as a filter);
                  // surfaced here in --wane so a seeded trace reads plainly.
                  <span style={{ color: 'var(--wane)' }}>imported seed</span>
                ) : (
                  data.provenance || 'contributed'
                )
              }
            />
          </div>

          {/* Tags */}
          {data.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {data.tags.map((t) => (
                <CorpusTagChip key={t}>{t}</CorpusTagChip>
              ))}
            </div>
          )}

          {/* Tool sequence */}
          <Card title={`Tool sequence · ${data.stepCount} steps`}>
            {data.tools.length > 0 ? (
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-3)',
                  overflow: 'hidden',
                  background: 'var(--bg-elevated)',
                }}
              >
                {data.tools.map((tool, i) => (
                  <ToolRow key={`${tool}-${i}`} tool={tool} i={i} />
                ))}
              </div>
            ) : (
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)', margin: 0 }}>
                No tool names recorded on this envelope.
              </p>
            )}
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.02em',
                color: 'var(--fg-dim)',
                marginTop: 12,
              }}
            >
              Summarised sequence — the full scrubbed per-step payloads live in the IPFS envelope content below.
            </div>
          </Card>

          {/* Provenance — outbound links */}
          <Card title="Provenance">
            <OutboundLink
              label="IPFS content"
              value={shortCid(data.cid, 14, 8)}
              href={ipfsUrl(data.cid)}
            />
            <OutboundLink
              label="On-chain anchor"
              value={data.anchorTx ? `${data.anchorTx.slice(0, 10)}… · basescan` : 'not yet anchored'}
              href={basescanTxUrl(data.anchorTx)}
            />
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.02em',
                color: 'var(--fg-dim)',
                marginTop: 12,
              }}
            >
              Both links leave the explorer. The anchor is the ERC-8004 registration on Base Sepolia; the content
              ref resolves the envelope itself.
            </div>
          </Card>
        </>
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        behindHead={data?.behindHead}
        degraded={isError}
      />
    </div>
  );
}
