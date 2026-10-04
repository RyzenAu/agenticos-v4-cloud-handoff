import type { NextConfig } from "next";

// PREVIEW TEMPLATE: a static export (with its client JS) for M&U lead previews. Images go through
// image-loader.js (pre-rendered WebP widths); all retained pages are checked and exported.
const nextConfig: NextConfig = {
  output: "export",
  images: { loader: "custom", loaderFile: "./image-loader.js", deviceSizes: [640, 1080, 1600, 2400], imageSizes: [256, 384] },
  poweredByHeader: false,
};

export default nextConfig;
