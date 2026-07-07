/**
 * CorpusItemView — one attempt's detail (#1406).
 *
 * A single published attempt (scrubbed, consented task trace) at a stable,
 * deep-linkable URL (/corpus/:cid) — the target the jinn-agent CLI's ledger
 * and preview link to.
 *
 * Two columns: the attempt itself on the left (the full task text, then every
 * step's full scrubbed payloads), its provenance + metadata on the right. The
 * full per-step payloads are NOT indexed — they are fetched from the IPFS trace
 * artifact in the browser (useCorpusTrace); when that public copy is absent or
 * the gateway is unreachable, the view falls back to the indexed tool-name
 * list. The two outbound links (IPFS content ref, Base Sepolia anchor) close
 * the verifiability path.
 *
 * Unknown CID → not-found notice (spec §2.4 state message).
 */

import { Link, useParams } from 'wouter';
import { useCorpusItem } from '../lib/api';
import { useCorpusTrace, type TraceStep } from '../lib/corpus-trace';
import { StatusBar } from '../components/StatusBar';
import { Card } from '../components/Card';
import { CorpusTagChip } from '../components/CorpusChips';
import { InfoTooltip } from '../components/InfoTooltip';
import { shortCid, shortAddr, relUnix, basescanTxUrl, basescanAddressUrl, ipfsUrl } from '../lib/format';

const CLUSTER_EXPLAINER =
  'A cluster groups attempts by task domain — the primary distribution tag the harness assigned (e.g. jinn-agent, typescript). It is how the corpus is broken down for browsing and search.';

// ── aside meta row (label above value) ─────────────────────────────────────────

function MetaRow({ label, value, info }: { label: string; value: React.ReactNode; info?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        {label}
        {info && <InfoTooltip label={`About ${label}`}>{info}</InfoTooltip>}
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

// ── one step, rendered in full ─────────────────────────────────────────────────

const preStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--fg)',
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-1)',
  padding: '8px 10px',
  margin: 0,
  maxHeight: 320,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

function StepCard({ step, i }: { step: TraceStep; i: number }) {
  const argsText =
    step.args == null
      ? ''
      : typeof step.args === 'string'
        ? step.args
        : JSON.stringify(step.args, null, 2);
  return (
    <div
      style={{
        borderTop: i === 0 ? 'none' : '1px solid var(--border)',
        padding: i === 0 ? '0 0 16px' : '16px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          className="data"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', width: 18, textAlign: 'right' }}
        >
          {i + 1}
        </span>
        <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', flexShrink: 0 }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          {step.name}
        </span>
        {step.redactedKeyCount > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--wane)' }}>
            · {step.redactedKeyCount} redacted
          </span>
        )}
      </div>
      {argsText && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <StepLabel>args</StepLabel>
          <pre style={preStyle}>{argsText}</pre>
        </div>
      )}
      {step.result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <StepLabel>result</StepLabel>
          <pre style={preStyle}>{step.result}</pre>
        </div>
      )}
    </div>
  );
}

function StepLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--fg-dim)',
      }}
    >
      {children}
    </span>
  );
}

// ── tool-name fallback (degraded: indexed names only) ──────────────────────────

function ToolNameRow({ tool, i }: { tool: string; i: number }) {
  return (
    <div
      style={{
        borderTop: i === 0 ? 'none' : '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 0',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span className="data" style={{ fontSize: 10, color: 'var(--fg-dim)', width: 18, textAlign: 'right' }}>
        {i + 1}
      </span>
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--accent)', flexShrink: 0 }} />
      <span style={{ fontSize: 11, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>
        {tool}
      </span>
    </div>
  );
}

// ── outbound link ──────────────────────────────────────────────────────────────

function OutboundLink({ label, value, href }: { label: string; value: string; href: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
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
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: 'var(--accent)', textDecoration: 'none', fontFamily: 'var(--font-mono)', fontSize: 12, overflowWrap: 'anywhere' }}
        >
          {value} ↗
        </a>
      ) : (
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{value}</span>
      )}
    </div>
  );
}

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

// ── Steps section (full payloads, with fallback) ───────────────────────────────

function StepsSection({ cid, toolNames, stepCount }: { cid: string; toolNames: string[]; stepCount: number }) {
  const { data: trace, isLoading } = useCorpusTrace(cid);
  // `trace` present ⇒ the fetch succeeded (it may legitimately have 0 steps);
  // absent-after-settle ⇒ error or no public source, so fall back. Keying on
  // presence (not steps.length) keeps the "not reachable" caption off a
  // genuinely stepless-but-fetched attempt.
  const traceLoaded = Boolean(trace);

  return (
    <Card title={`Steps · ${stepCount}`}>
      {isLoading && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)', margin: 0 }}>
          Loading full payloads from IPFS…
        </p>
      )}

      {!isLoading && traceLoaded && (
        trace!.steps.length > 0 ? (
          <div>
            {trace!.steps.map((step, i) => (
              <StepCard key={`${step.name}-${i}`} step={step} i={i} />
            ))}
          </div>
        ) : (
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)', margin: 0 }}>
            No steps recorded on this attempt.
          </p>
        )
      )}

      {/* Fallback: no public trace source or the gateway failed — show the
          indexed tool names (still useful), plus the IPFS link for the full copy. */}
      {!isLoading && !traceLoaded && (
        toolNames.length > 0 ? (
          <>
            <div>
              {toolNames.map((tool, i) => (
                <ToolNameRow key={`${tool}-${i}`} tool={tool} i={i} />
              ))}
            </div>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', margin: '12px 0 0' }}>
              Full payloads aren’t reachable from here — open the attempt on IPFS below.
            </p>
          </>
        ) : (
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)', margin: 0 }}>
            No steps recorded on this attempt.
          </p>
        )
      )}
    </Card>
  );
}

// ── CorpusItemView ─────────────────────────────────────────────────────────────

export function CorpusItemView() {
  const params = useParams<{ cid: string }>();
  const cid = decodeURIComponent(params?.cid ?? '');
  const { data, isLoading, isError } = useCorpusItem(cid);

  const contributorHref = data ? basescanAddressUrl(data.contributor) : null;

  return (
    <div style={{ padding: '40px 28px 80px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <BackLink />

      {isLoading && (
        <div style={{ height: 200, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-3)' }} />
      )}

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
          <span>No attempt at this CID. It may not be indexed yet, or the link is wrong.</span>
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

      {data && (
        <>
          {/* Header — one-line title, full text lives in the Task card below */}
          <div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--fg-dim)',
                marginBottom: 8,
              }}
            >
              {relUnix(data.createdAt)}
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
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '100%',
              }}
            >
              {data.summary || '(no summary)'}
            </h1>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>
              {shortCid(data.cid, 14, 8)}
            </div>
          </div>

          {/* Two columns: the attempt (left) · its provenance + metadata (right) */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
            {/* LEFT — the attempt itself */}
            <div style={{ flex: '3 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <Card title="Task">
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.55, color: 'var(--fg)', margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {data.summary || '(no summary)'}
                </p>
              </Card>

              <StepsSection cid={data.cid} toolNames={data.tools} stepCount={data.stepCount} />
            </div>

            {/* RIGHT — metadata + provenance */}
            <aside style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <Card title="Details">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <MetaRow
                    label="Cluster"
                    info={CLUSTER_EXPLAINER}
                    value={data.cluster ? <CorpusTagChip>{data.cluster}</CorpusTagChip> : '—'}
                  />
                  <MetaRow label="Harness" value={data.harness || '—'} />
                  <MetaRow label="Model" value={data.model || '—'} />
                  <MetaRow
                    label="Contributor"
                    value={
                      data.contributor ? (
                        contributorHref ? (
                          <a href={contributorHref} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                            {shortAddr(data.contributor)} ↗
                          </a>
                        ) : (
                          shortAddr(data.contributor)
                        )
                      ) : (
                        '—'
                      )
                    }
                  />
                  {data.tags.length > 0 && (
                    <MetaRow
                      label="Tags"
                      value={
                        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                          {data.tags.map((t) => (
                            <CorpusTagChip key={t}>{t}</CorpusTagChip>
                          ))}
                        </span>
                      }
                    />
                  )}
                </div>
              </Card>

              <Card title="Provenance">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <MetaRow
                    label="Origin"
                    value={
                      data.provenance === 'imported' ? (
                        <span style={{ color: 'var(--wane)' }}>imported seed</span>
                      ) : (
                        'contributed'
                      )
                    }
                  />
                  <OutboundLink label="IPFS content" value={shortCid(data.cid, 14, 8)} href={ipfsUrl(data.cid)} />
                  <OutboundLink
                    label="On-chain anchor"
                    value={data.anchorTx ? `${data.anchorTx.slice(0, 10)}… · basescan` : 'not yet anchored'}
                    href={basescanTxUrl(data.anchorTx)}
                  />
                </div>
              </Card>
            </aside>
          </div>
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
