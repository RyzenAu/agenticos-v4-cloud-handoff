// The model orb, drawn entirely in code from one pure render(ctx, t, frame) call (the RISE
// approach: no video, no image assets). A Fibonacci sphere of glowing particles whose colour is
// the brain that is answering; it breathes at rest, swirls while thinking, ripples toward you
// with your mic level while listening, and pulses with the real TTS level while speaking.
// Same inputs, same picture — the component only smooths the inputs and schedules frames.
import type { BrainId } from "./jarvis-signal";

export type OrbPalette = { core: string; mid: [number, number, number]; rim: [number, number, number] };

/** Hue, saturation, lightness per brain. Kept soft so the orb reads as light, not a logo. */
export const ORB_PALETTES: Record<BrainId, OrbPalette> = {
  jarvis: { core: "#eef8ff", mid: [196, 78, 72], rim: [262, 58, 74] },
  claude: { core: "#fff2e8", mid: [22, 76, 67], rim: [8, 58, 60] },
  sol: { core: "#fffdf3", mid: [46, 56, 80], rim: [192, 24, 82] },
  groq: { core: "#eefcff", mid: [187, 88, 62], rim: [212, 76, 64] },
  jev: { core: "#f7f1ff", mid: [268, 68, 77], rim: [292, 48, 66] },
  mimo: { core: "#effff7", mid: [152, 58, 63], rim: [172, 52, 54] },
  gemini: { core: "#f1f5ff", mid: [222, 78, 71], rim: [252, 58, 70] },
};

export type OrbFrame = {
  width: number;
  height: number;
  /** 0..1 blend weights, already smoothed by the caller. */
  listen: number;
  think: number;
  speak: number;
  /** Smoothed live levels, 0..1. */
  mic: number;
  out: number;
  /** Glow sprites for this palette: [core, mid, rim]. */
  sprites: CanvasImageSource[];
  palette: OrbPalette;
  compact: boolean;
};

/** Deterministic unit vectors on a Fibonacci sphere, plus a per-particle phase and size. */
export function orbParticles(count: number): Float32Array {
  const out = new Float32Array(count * 5);
  const golden = Math.PI * (3 - Math.sqrt(5));
  let seed = 1337;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const a = i * golden;
    out[i * 5] = Math.cos(a) * r;
    out[i * 5 + 1] = y;
    out[i * 5 + 2] = Math.sin(a) * r;
    out[i * 5 + 3] = random() * Math.PI * 2;
    out[i * 5 + 4] = 0.55 + random() * 0.9;
  }
  return out;
}

/** One soft radial glow, pre-rendered once per colour so each particle is a single drawImage. */
export function orbSprite(hsl: [number, number, number] | string, size = 48): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const brush = canvas.getContext("2d")!;
  const c = size / 2;
  const glow = brush.createRadialGradient(c, c, 0, c, c, c);
  const colour = (alpha: number, light = 0) =>
    typeof hsl === "string" ? hsl : `hsla(${hsl[0]},${hsl[1]}%,${Math.min(97, hsl[2] + light)}%,${alpha})`;
  // A crisp bright point with a short halo: reads as a particle, not a smudge.
  glow.addColorStop(0, typeof hsl === "string" ? "rgba(255,255,255,1)" : colour(1, 24));
  glow.addColorStop(0.16, colour(0.95, 14));
  glow.addColorStop(0.26, colour(0.5, 4));
  glow.addColorStop(0.5, colour(0.1));
  glow.addColorStop(1, typeof hsl === "string" ? "rgba(255,255,255,0)" : colour(0));
  brush.fillStyle = glow;
  brush.fillRect(0, 0, size, size);
  return canvas;
}

const TAU = Math.PI * 2;

/** Draw one frame at time `t` (seconds). Pure: reads only its arguments. */
export function renderOrb(ctx: CanvasRenderingContext2D, t: number, frame: OrbFrame, particles: Float32Array) {
  const { width: w, height: h, listen, think, speak, mic, out, sprites, palette, compact } = frame;
  ctx.clearRect(0, 0, w, h);
  if (!w || !h) return;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * (compact ? 0.36 : 0.28);
  const rest = 1 - Math.min(1, listen + think + speak);
  // Breathing: a slow 5 s inhale at rest, calmer while he talks.
  const breath = 1 + Math.sin(t * 1.25) * 0.018 * (0.4 + rest * 0.6) + speak * out * 0.07;

  ctx.globalCompositeOperation = "lighter";

  // The heart: a soft core that brightens with the voice and while thinking.
  const [mh, ms, ml] = palette.mid;
  const heart = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.35 * breath);
  const heartAlpha = 0.18 + speak * out * 0.35 + think * 0.1 + listen * mic * 0.12;
  heart.addColorStop(0, `hsla(${mh},${ms}%,${Math.min(95, ml + 18)}%,${heartAlpha})`);
  heart.addColorStop(0.45, `hsla(${mh},${ms}%,${ml}%,${heartAlpha * 0.35})`);
  heart.addColorStop(1, `hsla(${mh},${ms}%,${ml}%,0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = heart;
  ctx.fillRect(cx - R * 1.5, cy - R * 1.5, R * 3, R * 3);

  // Rotation: a slow spin at rest; thinking adds speed and latitude-dependent swirl bands.
  const spin = t * (0.16 + think * 0.55);
  const tilt = 0.38 + Math.sin(t * 0.21) * 0.06;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const count = particles.length / 5;
  const dotBase = (compact ? 2 : 2.5) * Math.max(0.8, Math.min(1.4, R / 45));

  for (let i = 0; i < count; i++) {
    const o = i * 5;
    const px = particles[o];
    const py = particles[o + 1];
    const pz = particles[o + 2];
    const phase = particles[o + 3];
    const size = particles[o + 4];
    // Swirl: each latitude turns at its own rate while thinking (bounded, so it never winds up).
    const angle = spin + think * 1.1 * Math.sin(py * 3.2 + t * 1.5);
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    let x = px * ca - pz * sa;
    let z = px * sa + pz * ca;
    let y = py;
    // Radial displacement.
    let r = breath;
    // Speaking: the surface churns with the real playback level.
    if (speak > 0.001)
      r += speak * (0.05 + out * 0.2) * (0.62 * Math.sin(3 * px + t * 6.5) * Math.sin(2.4 * py - t * 4.8) + 0.38 * Math.sin(phase + t * 10));
    // Listening: rings travel from the far side toward the viewer, as tall as his mic level.
    if (listen > 0.001) {
      const d = Math.acos(Math.max(-1, Math.min(1, z))); // 0 = facing him
      r += listen * (0.018 + mic * 0.16) * Math.sin(d * 5.5 + t * 7.5) * (0.35 + 0.65 * (1 - d / Math.PI));
    }
    // Thinking: a faint shimmer, particles lift off the surface a touch.
    if (think > 0.001) r += think * 0.04 * Math.sin(phase * 2 + t * 3.1);
    x *= r;
    y *= r;
    z *= r;
    // Tilt toward the viewer.
    const ty = y * cosT - z * sinT;
    const tz = y * sinT + z * cosT;
    const depth = (tz + 1.3) / 2.6; // 0 back .. 1 front
    const persp = 0.78 + depth * 0.36;
    const sx = cx + x * R * persp;
    const sy = cy + ty * R * persp;
    const flicker = 0.78 + 0.22 * Math.sin(t * 1.7 + phase * 3);
    const alpha = (0.08 + depth * depth * 0.72) * flicker * (0.75 + speak * out * 0.35 + think * 0.1);
    const rad = dotBase * size * persp * (1 + speak * out * 0.35);
    // Front particles lean to the bright mid tone, the far side to the rim tone.
    const sprite = sprites[depth > 0.62 ? 1 : 2];
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sprite, sx - rad * 2, sy - rad * 2, rad * 4, rad * 4);
    // A few particles carry a white-hot centre on the near face.
    if (depth > 0.8 && (i & 7) === 0) {
      ctx.globalAlpha = Math.min(1, alpha * 0.9);
      ctx.drawImage(sprites[0], sx - rad, sy - rad, rad * 2, rad * 2);
    }
  }

  // HUD ring: a fine tick circle outside the sphere; a lit arc sweeps while thinking.
  if (!compact) {
    const ringR = R * 1.34;
    const ticks = 72;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    const quiet = think < 0.01 && speak * out < 0.01 && listen * mic < 0.01;
    if (quiet) {
      // At rest every tick is one of two strokes: batch them (2 draw calls instead of 72).
      for (const major of [false, true]) {
        ctx.strokeStyle = `hsla(${mh},${ms}%,${Math.min(95, ml + 10)}%,${major ? 0.28 : 0.16})`;
        ctx.beginPath();
        for (let k = major ? 0 : 1; k < ticks; k += major ? 6 : 1) {
          if (!major && k % 6 === 0) continue;
          const a = (k / ticks) * TAU + t * 0.05;
          const len = major ? 7 : 3.5;
          const c = Math.cos(a);
          const s = Math.sin(a);
          ctx.moveTo(cx + c * ringR, cy + s * ringR);
          ctx.lineTo(cx + c * (ringR + len), cy + s * (ringR + len));
        }
        ctx.stroke();
      }
    }
    for (let k = 0; !quiet && k < ticks; k++) {
      const a = (k / ticks) * TAU + t * 0.05;
      const sweep = think > 0.01 ? Math.max(0, Math.cos(a - t * 2.4)) ** 12 * think : 0;
      const pulse = speak * out * (0.5 + 0.5 * Math.sin(k * 0.9 + t * 8));
      const len = (k % 6 === 0 ? 7 : 3.5) + sweep * 8 + pulse * 5 + listen * mic * 6 * (0.5 + 0.5 * Math.sin(k * 1.3 - t * 6));
      const lightness = Math.min(95, ml + 10 + sweep * 20);
      ctx.strokeStyle = `hsla(${mh},${ms}%,${lightness}%,${0.16 + sweep * 0.7 + pulse * 0.25 + (k % 6 === 0 ? 0.12 : 0)})`;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + c * ringR, cy + s * ringR);
      ctx.lineTo(cx + c * (ringR + len), cy + s * (ringR + len));
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}
