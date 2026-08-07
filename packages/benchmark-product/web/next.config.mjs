import { resolve } from "node:path";

/**
 * Server build (no static export, unlike apps/website): the GUI is specified to
 * call the product's operations library in-process on the server (product design
 * spec §5.3). Core stays a server external: Node loads the built public package
 * entry in process, while no core code enters a browser bundle.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  reactStrictMode: true,
  serverExternalPackages: ["@jinn-network/benchmark-product-core"],
  outputFileTracingRoot: resolve(import.meta.dirname, "../../.."),
  turbopack: { root: resolve(import.meta.dirname, "../../..") },
  webpack(webpackConfig, { isServer }) {
    if (isServer) {
      webpackConfig.externals.push(({ request }, callback) => {
        if (request === "@jinn-network/benchmark-product-core") {
          callback(null, `commonjs ${request}`);
          return;
        }
        callback();
      });
    }
    return webpackConfig;
  },
};

export default config;
