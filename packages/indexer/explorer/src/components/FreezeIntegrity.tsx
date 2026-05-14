/**
 * FreezeIntegrity — shows freeze-mode integrity status.
 *
 * Design:
 *   - No violations + attempts > 0: green "No freeze violations recorded"
 *   - No frozen attempts: muted "No frozen-mode attempts yet"
 *   - Violations: small table of operators + break-red accents
 *   - Plus a "Verified-frozen: pct(verifiedFrozenShare)" line
 *   - No emoji, no gradients, tabular-nums, linear motion
 */

import type { FreezeViolation } from '../lib/api';
import { shortAddr, shortCid, pct, int } from '../lib/format';

export interface FreezeIntegrityData {
  violations: FreezeViolation[];
  verifiedFrozenShare: number;
  frozenAttempts: number;
}

export interface FreezeIntegrityProps {
  data: FreezeIntegrityData;
}

export function FreezeIntegrity({ data }: FreezeIntegrityProps) {
  const { violations, verifiedFrozenShare, frozenAttempts } = data;

  const hasViolations = violations.length > 0;
  const hasAttempts = frozenAttempts > 0;

  return (
    <div>
      {/* Status line */}
      <div style={{ marginBottom: hasViolations ? 16 : 0 }}>
        {!hasAttempts ? (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-dim)',
            }}
          >
            No frozen-mode attempts yet.
          </span>
        ) : !hasViolations ? (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--vow-green)',
            }}
          >
            No freeze violations recorded.
          </span>
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--break-red)',
            }}
          >
            {violations.length} violation{violations.length !== 1 ? 's' : ''} detected.
          </span>
        )}
      </div>

      {/* Violations table */}
      {hasViolations && (
        <div
          style={{
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            overflow: 'hidden',
            marginBottom: 16,
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: '1px solid rgba(168,90,90,0.4)',
                  background: 'rgba(168,90,90,0.06)',
                }}
              >
                {['Operator', 'Code digest', 'Total', 'Violations'].map(
                  (col, i) => (
                    <th
                      key={col}
                      style={{
                        padding: '8px 12px',
                        textAlign: i >= 2 ? 'right' : 'left',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                        color: 'var(--break-red)',
                        fontWeight: 500,
                      }}
                    >
                      {col}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {violations.map((v, i) => (
                <tr
                  key={v.operator + v.modalCodeDigest}
                  style={{
                    borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                  }}
                >
                  <td
                    style={{
                      padding: '10px 12px',
                      color: 'var(--fg)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {shortAddr(v.operator)}
                  </td>
                  <td
                    style={{
                      padding: '10px 12px',
                      color: 'var(--fg-muted)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {shortCid(v.modalCodeDigest)}
                  </td>
                  <td
                    className="data"
                    style={{
                      padding: '10px 12px',
                      textAlign: 'right',
                      color: 'var(--fg-muted)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {int(v.total)}
                  </td>
                  <td
                    className="data"
                    style={{
                      padding: '10px 12px',
                      textAlign: 'right',
                      color: 'var(--break-red)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {int(v.violatingCount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Verified-frozen share line */}
      {hasAttempts && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-dim)',
            display: 'flex',
            gap: 12,
          }}
        >
          <span>
            Verified-frozen:{' '}
            <span
              className="data"
              style={{
                color: 'var(--fg-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {pct(verifiedFrozenShare)}
            </span>
          </span>
          <span>
            Frozen attempts:{' '}
            <span
              className="data"
              style={{
                color: 'var(--fg-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {int(frozenAttempts)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
