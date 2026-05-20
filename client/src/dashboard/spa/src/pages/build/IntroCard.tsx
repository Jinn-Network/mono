import { renderMarkdownSubset } from './markdown.js';
// Vite resolves `?raw` imports at build time. The path is relative to this
// file: src/dashboard/spa/src/pages/build/ → ../../../../../../docs/build/.
// In tests Vitest also honours `?raw` via its Vite integration.
import quickstartMd from '../../../../../../docs/build/quickstart.md?raw';
import { PanelCard } from '../../components/PanelCard.js';

const QUICKSTART_URL =
  'https://github.com/Jinn-Network/mono/blob/next/client/docs/build/quickstart.md';

export function IntroCard(): JSX.Element {
  return (
    <PanelCard>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '20px' }}>
        <span className="j-label">Quickstart · 60 seconds</span>
      </div>
      <div className="hfmf-intro-markdown">{renderMarkdownSubset(quickstartMd)}</div>
      <div
        style={{
          marginTop: '24px',
          paddingTop: '20px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <span className="j-label">Next</span>
        <a
          href={QUICKSTART_URL}
          target="_blank"
          rel="noreferrer"
          className="j-mono"
          style={{
            fontSize: '12px',
            color: 'var(--accent-sky)',
            textDecoration: 'none',
            borderBottom: '1px solid var(--border)',
            paddingBottom: '1px',
          }}
        >
          Read the full quickstart on GitHub →
        </a>
      </div>
    </PanelCard>
  );
}
