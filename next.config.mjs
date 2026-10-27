/** @type {import('next').NextConfig} */
const nextConfig = {
  // "standalone" produces a self-contained server in .next/standalone for VPS / Docker hosting.
  output: "standalone",
  poweredByHeader: false,
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: "/media/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};
export default nextConfig;
