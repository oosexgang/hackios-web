/** @type {import('next').NextConfig} */
const nextConfig = {
  // "standalone" produces a self-contained server in .next/standalone for VPS / Docker hosting.
  output: "standalone",
  poweredByHeader: false,
  images: { unoptimized: true },
};
export default nextConfig;
