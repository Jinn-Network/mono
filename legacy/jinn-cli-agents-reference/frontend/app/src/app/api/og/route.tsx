import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const name = searchParams.get('name') || 'Jinn Venture';
  const description = searchParams.get('description') || '';
  const status = searchParams.get('status') || 'proposed';
  const symbol = searchParams.get('symbol') || '';
  const category = searchParams.get('category') || '';

  const truncatedDesc = description.length > 120
    ? description.slice(0, 117) + '...'
    : description;

  const statusColors: Record<string, { bg: string; text: string }> = {
    proposed: { bg: '#7c3aed20', text: '#a78bfa' },
    bonding: { bg: '#d9770620', text: '#fbbf24' },
    active: { bg: '#05966920', text: '#34d399' },
    graduated: { bg: '#05966920', text: '#34d399' },
  };

  const colors = statusColors[status] || statusColors.proposed;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '60px',
          background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%)',
          color: 'white',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ fontSize: '28px', fontWeight: 700, opacity: 0.7 }}>Jinn</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '52px', fontWeight: 700, lineHeight: 1.1 }}>
              {name}
            </span>
            {symbol && (
              <span
                style={{
                  fontSize: '24px',
                  fontWeight: 600,
                  background: '#ffffff15',
                  padding: '6px 16px',
                  borderRadius: '8px',
                  fontFamily: 'monospace',
                }}
              >
                ${symbol}
              </span>
            )}
          </div>

          {truncatedDesc && (
            <span style={{ fontSize: '24px', color: '#a0a0a0', lineHeight: 1.4 }}>
              {truncatedDesc}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span
            style={{
              fontSize: '16px',
              fontWeight: 600,
              background: colors.bg,
              color: colors.text,
              padding: '6px 16px',
              borderRadius: '999px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {status}
          </span>
          {category && (
            <span
              style={{
                fontSize: '16px',
                fontWeight: 500,
                background: '#ffffff10',
                color: '#a0a0a0',
                padding: '6px 16px',
                borderRadius: '999px',
              }}
            >
              {category}
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: '18px', color: '#666', fontWeight: 500 }}>
            app.jinn.network
          </span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
