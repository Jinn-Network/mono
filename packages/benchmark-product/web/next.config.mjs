/**
 * Server build (no static export, unlike apps/website): the GUI is specified to
 * call the product's operations library in-process on the server (product design
 * spec §5.3). This skeleton ships no wiring yet; the build shape is chosen so the
 * wiring packet does not have to change it.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  reactStrictMode: true,
};

export default config;
