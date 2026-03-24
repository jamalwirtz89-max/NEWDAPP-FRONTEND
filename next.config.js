/** @type {import('next').NextConfig} */
const nextConfig = {

  // ── Polyfills requis par @walletconnect/ethereum-provider ──
  // WalletConnect utilise des modules Node.js (fs, net, tls) qui
  // n'existent pas dans le navigateur. On les désactive proprement.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs    : false,
        net   : false,
        tls   : false,
        crypto: false,
      };
    }
    return config;
  },

  // ── Proxy /api/* → backend Express en développement local ──
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return [
      { source: "/api/:path*", destination: "http://localhost:3001/api/:path*" },
    ];
  },
};

module.exports = nextConfig;
