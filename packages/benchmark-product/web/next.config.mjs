import { resolve } from "node:path";
import { PINNED_PERMISSIONS_POLICY } from "./permissions-policy.mjs";

// Next's production App Router emits small inline bootstrap scripts and shadcn/Tailwind uses
// inline style attributes. Those two allowances are kept explicit; every network-capable
// directive remains same-origin and active embedded content is denied. Server Actions post back
// to this origin, so form-action/connect-src must retain 'self'.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "media-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

const privateResponseHeaders = [
  { key: "Cache-Control", value: "no-store, max-age=0" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: PINNED_PERMISSIONS_POLICY },
];

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
  async headers() {
    return [{ source: "/:path*", headers: privateResponseHeaders }];
  },
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
