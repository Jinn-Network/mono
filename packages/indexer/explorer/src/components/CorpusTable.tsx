/**
 * Shared corpus table — the row shape used by BOTH the Corpus index
 * (CorpusView) and the Dashboard's "Latest 5 attempts" card (CorpusCard), so
 * the two render identically (one source of columns + one row renderer).
 *
 * Columns: Attempt (summary, 2-line clamp, links to the detail page) · Cluster ·
 * Contributor (links out to the on-chain record on basescan) · Age. No tier,
 * no step count, no content-hash subline — those moved to the detail view or
 * were dropped as noise on a monotone-tier testnet.
 *
 * `interactive` toggles server-side sort affordances: the index passes true
 * (sortable cluster + age); the dashboard preview passes false (a fixed
 * newest-first slice has nothing to sort).
 */

import { Link } from 'wouter';
import type { CorpusItemRow } from '../lib/api';
import { cellStyle, cellNumStyle } from './DataTable';
import { CorpusTagChip } from './CorpusChips';
import { shortAddr, relUnix, basescanAddressUrl } from '../lib/format';

export function corpusColumns(interactive: boolean) {
  return [
    { key: 'summary', label: 'Attempt', sortable: false },
    { key: 'cluster', label: 'Cluster', sortable: interactive },
    { key: 'contributor', label: 'Contributor', sortable: false },
    { key: 'createdAt', label: 'Age', numeric: true, sortable: interactive },
  ];
}

export function renderCorpusRow(row: CorpusItemRow) {
  const contributorHref = basescanAddressUrl(row.contributor);
  return (
    <>
      <td style={cellStyle}>
        <Link
          href={`/corpus/${encodeURIComponent(row.cid)}`}
          style={{
            color: 'var(--accent)',
            textDecoration: 'none',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            lineHeight: 1.35,
            fontSize: 12.5,
          }}
        >
          {row.summary || '(no summary)'}
        </Link>
      </td>
      <td style={cellStyle}>
        {row.cluster ? (
          <CorpusTagChip>{row.cluster}</CorpusTagChip>
        ) : (
          <span style={{ color: 'var(--fg-dim)' }}>—</span>
        )}
      </td>
      <td style={cellStyle}>
        {contributorHref ? (
          <a
            href={contributorHref}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
          >
            {shortAddr(row.contributor)} ↗
          </a>
        ) : (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)' }}>
            {shortAddr(row.contributor)}
          </span>
        )}
      </td>
      <td className="data" style={{ ...cellNumStyle, color: 'var(--fg-muted)' }}>
        {relUnix(row.createdAt)}
      </td>
    </>
  );
}
