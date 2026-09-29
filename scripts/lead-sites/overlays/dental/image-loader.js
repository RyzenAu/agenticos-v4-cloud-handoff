// PREVIEW TEMPLATE: static exports have no image optimiser, so next-templates.ts pre-renders
// WebP variants at these widths into /_img/<width>/… after the build, and next/image points at them.
const WIDTHS = [640, 1080, 1600, 2400];
export default function loader({ src, width }) {
  if (!src.startsWith("/") || /\.svg$/i.test(src)) return src;
  const w = WIDTHS.find((x) => x >= width) ?? WIDTHS[WIDTHS.length - 1];
  return `/_img/${w}${src.replace(/\.(jpe?g|png|webp|avif)$/i, "")}.webp`;
}
