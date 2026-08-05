import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * Static export. The apex site has no data source — every page, the search
 * index, and the `llms*.txt` corpus are build-time outputs (WEBSITE-APP-SPEC.md
 * §1, deliberate divergence). `vercel deploy --prod` publishes `out/`.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
};

export default withMDX(config);
