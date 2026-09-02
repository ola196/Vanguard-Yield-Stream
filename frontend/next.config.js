/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for @stellar/stellar-sdk which uses Node.js built-ins
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
