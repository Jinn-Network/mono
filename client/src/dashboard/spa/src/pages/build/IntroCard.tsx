import { renderMarkdownSubset } from './markdown.js';
// Vite resolves `?raw` imports at build time. The path is relative to this
// file: src/dashboard/spa/src/pages/build/ → ../../../../../../docs/build/.
// In tests Vitest also honours `?raw` via its Vite integration.
import quickstartMd from '../../../../../../docs/build/quickstart.md?raw';
import { PanelCard } from '../../components/PanelCard.js';

const QUICKSTART_URL =
  'https://github.com/Jinn-Network/mono/blob/main/cargo/client/docs/build/quickstart.md';

export function IntroCard(): JSX.Element {
  return (
    <PanelCard>
      <div className="hfmf-intro-markdown">{renderMarkdownSubset(quickstartMd)}</div>
      <p style={{ marginTop: '16px' }}>
        <a href={QUICKSTART_URL} target="_blank" rel="noreferrer">
          Read the full quickstart on GitHub
        </a>
      </p>
    </PanelCard>
  );
}
