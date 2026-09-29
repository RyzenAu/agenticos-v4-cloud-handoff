import type { NextConfig } from "next";

// PREVIEW TEMPLATE: a static export (with its client JS) for M&U lead previews. Images go through
// image-loader.js (pre-rendered WebP widths); type errors in flagship files the preview doesn't
// use are ignored; only the home page is built.
const nextConfig: NextConfig = {
  output: "export",
  images: { loader: "custom", loaderFile: "./image-loader.js", deviceSizes: [640, 1080, 1600, 2400], imageSizes: [256, 384] },
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
};

export default nextConfig;
