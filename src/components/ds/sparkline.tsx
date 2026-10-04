import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * A quiet trend line for REAL series only (never synthesised). Draws in
 * currentColor, so the parent sets the colour — muted by default, the
 * accent only when the trend is the point of the tile.
 */
export function Sparkline({
  values,
  className,
  filled = true,
  label,
}: {
  values: number[];
  className?: string;
  filled?: boolean;
  label?: string;
}) {
  const id = useId().replace(/:/g, "");
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * 100,
    28 - ((v - lo) / (hi - lo || 1)) * 24,
  ]);
  const fx = (n: number) => n.toFixed(2);
  let d = `M${fx(pts[0][0])},${fx(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    const cx = (px + x) / 2;
    d += ` C${fx(cx)},${fx(py)} ${fx(cx)},${fx(y)} ${fx(x)},${fx(y)}`;
  }
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className={cn("h-8 w-full overflow-visible", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {filled && (
        <>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d} L100,30 L0,30 Z`} fill={`url(#spark-${id})`} />
        </>
      )}
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
