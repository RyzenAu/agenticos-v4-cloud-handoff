import { mix, parse } from "../engine/color";
import {
  bake,
  clamp,
  font,
  frameOf,
  grain,
  hash,
  LOOP,
  noise3,
  rng,
  smoothstep,
  TAU,
  vignette,
  wordFor,
  type AnyCanvas,
} from "../engine/kit";
import type { Ctx2D, MotionStyle, Theme } from "../engine/types";
import { sprite } from "./_s2-helpers";

/**
 * Oil impasto. Every dab is a tiny lit height field: bristle ridges, a paint
 * load where the brush landed, a lip where it lifted, specular glints and a
 * cast shadow. Sprites are baked per colour, shape and orientation bin (the
 * light is fixed top-left), so a rotating dab keeps a physically lit ridge.
 */
const BINS = 24;
const SHAPES = 3;
/** Light from the top left, a little in front of the canvas. */
const LIGHT: [number, number, number] = (() => {
  const v = [-0.55, -0.62, 0.85];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

/** Brush loads: a main colour and the colour streaked through it. */
function palette(theme: Theme): [string, string][] {
  const deep = mix(theme.accent2, theme.bg, 0.55);
  const blue = theme.accent2;
  const pale = mix(theme.accent2, theme.ink, 0.42);
  const white = theme.ink;
  const paleGold = mix(theme.accent, theme.ink, 0.35);
  const gold = theme.accent;
  const night = mix(theme.bg, theme.accent2, 0.22);
  const green = mix(theme.accent, theme.accent2, 0.55);
  const mid = mix(theme.accent2, theme.bg, 0.3);
  const light = mix(theme.accent2, theme.ink, 0.2);
  const lemon = mix(theme.accent, "#ffffff", 0.14);
  return [
    [deep, mid],
    [blue, pale],
    [pale, white],
    [white, paleGold],
    [paleGold, white],
    [gold, lemon],
    [night, deep],
    [green, blue],
    [mid, blue],
    [light, white],
    [lemon, white],
  ];
}

/** One dab sprite in local coordinates, lit for orientation bin `bin`. */
const BEND = [0.16, -0.12, 0.28];
const SLANT = [0.06, -0.08, 0.1];

function dabSprite(load: [string, string], shape: number, bin: number, len: number): AnyCanvas {
  const L = Math.max(6, Math.round(len));
  const W = Math.max(3, Math.round(len * (0.32 + shape * 0.05)));
  const pad = Math.ceil(W * 0.5) + 2;
  const cw = L + pad * 2;
  const ch = W + pad * 2;
  return sprite(`oil-dab:${load[0]}${load[1]}:${shape}:${bin}:${L}`, cw, ch, (g) => {
    const img = g.createImageData(cw, ch);
    const d = img.data;
    const [ar, ag, ab] = parse(load[0]);
    const [br, bg, bb] = parse(load[1]);
    const ang = (bin / BINS) * TAU;
    // Light in the sprite's local frame (the sprite is drawn rotated by ang).
    const lx = LIGHT[0] * Math.cos(-ang) - LIGHT[1] * Math.sin(-ang);
    const ly = LIGHT[0] * Math.sin(-ang) + LIGHT[1] * Math.cos(-ang);
    const lz = LIGHT[2];
    const seed = shape * 17 + 3;
    const H = new Float32Array(cw * ch);
    const M = new Float32Array(cw * ch);
    const C = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const u = (x - pad) / L;
        const v0 = (y - ch / 2) / (W / 2);
        // A curved stroke: the centre line arches.
        const v = v0 - BEND[shape] * (1 - (2 * u - 1) ** 2);
        const half = (1 - 0.18 * u) * (1 + 0.07 * noise3(u * 6, seed, 2.1));
        const startU = 0.04 + SLANT[shape] * (v + 1);
        const endU = 0.8 + 0.2 * (0.5 + 0.5 * noise3(v * 4.3, seed, 0.4));
        let inside = Math.min((half - Math.abs(v)) * 7, (endU - u) * 24, (u - startU) * 26);
        if (inside <= 0) continue;
        inside = Math.min(1, inside);
        const plateau = smoothstep(half, half * 0.6, Math.abs(v));
        const freq = 13 + 4 * noise3(u * 1.7, seed, 5.5);
        const groove = 0.5 + 0.5 * Math.sin(v * freq + noise3(v * 7, u * 1.4, seed) * 2.6);
        const depth = 0.32 + 0.22 * noise3(u * 3, v, seed + 9);
        let hgt = plateau * (0.55 + depth * groove) * (1 - 0.32 * u);
        hgt += 0.3 * Math.exp(-(((u - startU - 0.05) / 0.09) ** 2)) * plateau;
        hgt += 0.16 * Math.exp(-(((u - endU + 0.05) / 0.045) ** 2)) * plateau;
        H[y * cw + x] = hgt;
        // Paint runs thin toward the lift: grooves open onto the layer below.
        const thin = smoothstep(0.55, 0.95, u) * (1 - groove) * 0.8;
        M[y * cw + x] = inside * (1 - thin);
        // The second colour loaded on the brush streaks along the grooves.
        C[y * cw + x] = smoothstep(0.35, 0.75, noise3(v * 8.5, u * 0.6, seed + 31)) * 0.85;
      }
    const k = W * 0.1;
    // Cast shadow first: the dab's mask pushed away from the light.
    const sx = Math.round(-lx * W * 0.14);
    const sy = Math.round(-ly * W * 0.14);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const o = (y * cw + x) * 4;
        const m = M[y * cw + x];
        const xs = x - sx;
        const ys = y - sy;
        const ms = xs >= 0 && ys >= 0 && xs < cw && ys < ch ? M[ys * cw + xs] : 0;
        if (m <= 0.01) {
          if (ms > 0) d[o + 3] = Math.round(ms * 80);
          continue;
        }
        const hx = (H[y * cw + Math.min(cw - 1, x + 1)] - H[y * cw + Math.max(0, x - 1)]) * 0.5;
        const hy = (H[Math.min(ch - 1, y + 1) * cw + x] - H[Math.max(0, y - 1) * cw + x]) * 0.5;
        let nx = -hx * k;
        let ny = -hy * k;
        let nz = 1;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const dif = Math.max(0, nx * lx + ny * ly + nz * lz);
        // Blinn highlight: small and bright, only on ridge tops facing the light.
        const hl = Math.hypot(lx, ly, lz + 1);
        const spec = Math.pow(Math.max(0, (nx * lx + ny * ly + nz * (lz + 1)) / hl), 60);
        const shade = 0.38 + 0.78 * dif;
        const s = spec * 0.85;
        const mixK = C[y * cw + x];
        const r0 = ar + (br - ar) * mixK;
        const g0 = ag + (bg - ag) * mixK;
        const b0 = ab + (bb - ab) * mixK;
        d[o] = clamp(r0 * shade + 255 * s, 0, 255);
        d[o + 1] = clamp(g0 * shade + 250 * s, 0, 255);
        d[o + 2] = clamp(b0 * shade + 235 * s, 0, 255);
        d[o + 3] = Math.round(Math.max(m, ms * 0.3) * 255);
      }
    g.putImageData(img, 0, 0);
  });
}

type Dab = { x: number; y: number; a: number; col: number; shape: number; len: number };

function drawDab(c: Ctx2D, pal: [string, string][], d: Dab, u: number) {
  const len = Math.max(6, Math.round(d.len * u));
  const angN = ((d.a % TAU) + TAU) % TAU;
  const bin = Math.round((angN / TAU) * BINS) % BINS;
  const spr = dabSprite(pal[d.col], d.shape, bin, len);
  const sw = (spr as { width: number }).width;
  const sh = (spr as { height: number }).height;
  const pad = Math.ceil(Math.max(3, Math.round(len * (0.32 + d.shape * 0.05))) * 0.5) + 2;
  const ca = Math.cos(d.a);
  const sa = Math.sin(d.a);
  c.setTransform(ca, sa, -sa, ca, d.x, d.y);
  c.drawImage(spr as CanvasImageSource, -pad - len * 0.45, -sh / 2, sw, sh);
}

/**
 * Original abstract composition, authored 24 September 2026 for this library.
 * Three folded pigment bands cross a field of short loaded-brush marks.
 * The material renderer above is retained; the composition uses no painting,
 * photograph, artist animation, logo, downloaded texture or reference image.
 */
function groundDabs(theme: Theme) {
  return (ctx: Ctx2D, w: number, h: number) => {
    const { u } = frameOf(w, h);
    const pal = palette(theme);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);
    const random = rng(18291);
    for (let y = -u * 0.03; y < h + u * 0.03; y += u * 0.029) {
      for (let x = -u * 0.03; x < w + u * 0.03; x += u * 0.046) {
        drawDab(ctx, pal, {
          x: x + (random() - 0.5) * u * 0.024,
          y: y + (random() - 0.5) * u * 0.019,
          a: -0.25 + random() * 0.26,
          col: random() > 0.54 ? 6 : 0,
          shape: Math.floor(random() * 3),
          len: 0.058,
        }, u);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };
}

function ribbonPoint(k: number, v: number, phase: number, w: number, h: number) {
  const x = w * (0.1 + 0.8 * v);
  const y = h * (0.25 + k * 0.22 + (k % 2 ? -1 : 1) * 0.1 * Math.sin(v * TAU + k * 1.2));
  const breathe = Math.sin(phase + v * TAU + k * 1.4) * h * 0.022;
  return { x, y: y + breathe };
}

export const style: MotionStyle = {
  id: "oil-impasto",
  name: "Oil Impasto",
  family: "Paint & Draw",
  tagline: "Folded bands of loaded pigment",
  look: "Three broad pigment bands over a dark field of short brush marks. Every dab has bristle grooves, raised edges and a small cast shadow.",
  move: "The folded bands flex gently while a lighter pigment travels through their ridges. Each band returns to its exact starting shape.",
  rules: [
    "An abstract arrangement of three painted bands; no landscape or recognizable painting.",
    "Every brush mark has relief, bristle grooves and a loaded leading edge.",
    "One fixed light above the left corner.",
    "Pigment moves along the bands while their folds breathe.",
    "Dark brushwork stays visible between the bands.",
    "Same time gives the same frame, including the loop seam.",
  ],
  prompt: `R — References
• Physical properties of loaded oil paint: bristle furrows, thick edges and small cast shadows.
• Three folded strips arranged diagonally across an otherwise quiet canvas. Use this abstract construction, without reproducing any existing painting.

I — Idea
Three bands of paint flex through one five-second cycle. A lighter pigment travels along each band and returns to its starting point. Leave dark, textured gaps between them. Put "{{name}}" small at the bottom.

S — Style
Looks: {{bg}} ground built from short dark strokes; three layered bands in {{accent}}, {{accent2}} and lighter mixtures toward {{ink}}. Thick bristle texture throughout. The bands have separate directions and a few uneven edges.
Moves: gentle cyclic bending, a travelling change in pigment, and fixed illumination from the top left.
Rules: preserve individual dabs, visible relief, dark gaps and generous space. No photographs, downloaded textures, third-party marks, recognizable artwork or artist-specific composition.

E — Examine
Build one canvas and a pure render(ctx, t, theme, w, h) function for a five-second loop. Use seeded geometry. Support 16:9, 9:16 and 1:1. Render t = 0, 1.25, 2.5, 3.75 and 5. Confirm identical endpoints, visible movement, legible type, raised strokes and no clipped foreground bands.`,
  theme: {
    bg: "#17151b",
    ink: "#f3e8d7",
    accent: "#c78961",
    accent2: "#778aab",
    font: "Caveat",
  },
  fonts: ["Caveat:wght@400..700"],
  tags: ["paint", "impasto", "abstract", "pigment", "brush", "texture", "folded bands"],
  word: "Pigment",
  render(ctx, t, theme, w, h) {
    const { u } = frameOf(w, h);
    const phase = (((t % LOOP) + LOOP) % LOOP) / LOOP * TAU;
    const pal = palette(theme);
    ctx.save();
    ctx.drawImage(bake(`oil-abstract-ground:${theme.bg}${theme.accent}${theme.accent2}${theme.ink}`, w, h, groundDabs(theme)) as CanvasImageSource, 0, 0);
    for (let band = 0; band < 3; band++) {
      for (let column = 0; column < 48; column++) {
        const v = column / 47;
        const point = ribbonPoint(band, v, phase, w, h);
        const next = ribbonPoint(band, v + 0.01, phase, w, h);
        const angle = Math.atan2(next.y - point.y, next.x - point.x);
        for (let row = -3; row <= 3; row++) {
          const step = u * 0.014;
          const offset = row * step;
          const sway = Math.sin(phase + v * TAU + band) * u * 0.006;
          const ridge = (1 + Math.sin(v * TAU - phase + band * 1.7 + row * 0.2)) / 2;
          const col = band === 0 ? (ridge > 0.7 ? 4 : 5) : band === 1 ? (ridge > 0.67 ? 2 : 1) : (ridge > 0.6 ? 3 : 9);
          drawDab(ctx, pal, {
            x: point.x - Math.sin(angle) * offset + (hash(column * 7 + row + 80, band + 1) - 0.5) * step,
            y: point.y + Math.cos(angle) * offset + sway,
            a: angle + 0.3 + Math.sin(phase + column * 0.6) * 0.08,
            col,
            shape: (column + row + 9) % SHAPES,
            len: 0.047 + 0.007 * Math.sin(column * 1.1 + row),
          }, u);
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.ink;
    ctx.globalAlpha = 0.72;
    ctx.font = font(500, u * 0.037, theme.font);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(wordFor(theme.name, "Pigment", 16), w * 0.1, h * 0.94);
    ctx.restore();
    grain(ctx, w, h, 0, 0.12);
    vignette(ctx, w, h, theme.bg, 0.26);
  },
};
