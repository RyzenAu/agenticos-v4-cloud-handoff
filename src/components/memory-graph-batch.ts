/**
 * Batched renderer for the Memory graph (W-D, 29 Sep 2026: "it lags whenever I move something").
 *
 * The force-graph library draws one WebGL object per node (a mesh plus a glow sprite), one tube or
 * cylinder per link and one mesh per flow particle: about 5,500 draw calls for the 1,200-node cortex,
 * so the page ran at ~10 fps even at rest, and every hover rebuilt all of them. Here the records are
 * drawn in FOUR draw calls: one InstancedMesh (spheres), one Points (glows), one LineSegments (links,
 * curves included) and one Points (flow particles). The library keeps an invisible, cheap hit mesh per
 * node for hover, tooltips and clicks, and still runs the layout. Hover, focus and fades only rewrite
 * colour buffers; nothing is recreated.
 *
 * Pure three.js (no WebGL context needed to build it), so the maths is unit-tested headlessly.
 */
import type * as ThreeNS from "three";

type THREE = typeof ThreeNS;

export type BatchLayout = "network" | "sphere" | "neural";
export type BatchLinkKind = "core" | "file" | "decision" | "session" | "skill" | "cross";
export type BatchNode = {
  id: string;
  kind: string;
  color: string;
  categoryHub?: boolean;
  x?: number;
  y?: number;
  z?: number;
  visualTransition?: { from: number; to: 0 | 1; at: number; duration: number };
  index?: number;
};
export type BatchLink = { source: string | BatchNode; target: string | BatchNode; kind: BatchLinkKind };
/** How a node is drawn right now: lit (normal), dim (not the hovered neighbourhood) or focused (voice/search result). */
export type NodeTone = "lit" | "dim" | "focus";

/** Curve segments per link: enough for a smooth arc at page zoom, cheap enough for 3,000 links. */
export const LINK_SEGMENTS = 8;
/** Glow sprites are only drawn in the neural layout (as before). */
export const GLOW_LAYOUTS: BatchLayout[] = ["neural"];

const idOf = (v: string | BatchNode) => (typeof v === "object" ? v.id : v);

/** Is this node drawn by the batch (records) rather than as its own object (hubs, source hubs)? */
export function isBatched(node: Pick<BatchNode, "kind" | "categoryHub">) {
  return node.kind !== "hub" && !node.categoryHub;
}

/** Sphere radius for a batched record, matching the previous per-object sizes. */
export function recordRadius(kind: string, layout: BatchLayout) {
  if (kind === "vector_store") return 17;
  if (kind === "workspace") return layout === "neural" ? 6 : layout === "sphere" ? 8 : 14;
  if (kind === "skill") return layout === "neural" ? 3 : 4.5;
  if (kind === "session") return 7;
  if (kind === "decision") return 9;
  return layout === "neural" ? 2.8 : layout === "sphere" ? 3.8 : 5;
}

/** Relative emissive strength by kind (previous per-material values), folded into the instance colour. */
export function recordGlow(kind: string, layout: BatchLayout) {
  if (layout === "neural") return 1;
  return kind === "workspace" ? 0.45 / 0.28 : 1;
}

export function linkCurvature(kind: BatchLinkKind, layout: BatchLayout) {
  if (layout === "neural") return kind === "core" ? 0.34 : 0.17;
  return kind === "cross" ? 0.4 : kind === "skill" ? 0.25 : 0;
}

/** Deterministic per-link rotation of the arc around its axis (as the old linkCurveRotation). */
export function linkRotation(targetId: string) {
  return (targetId.charCodeAt(targetId.length - 1) || 0) * 0.31;
}

/** Flow particles per link: the same rules as before, kept sparse on big graphs. */
export function particleCount(kind: BatchLinkKind, layout: BatchLayout, totalLinks: number, targetId: string) {
  if (layout === "neural") return kind === "core" ? 3 : totalLinks > 1200 ? 0 : 1;
  if (kind === "core") return 3;
  if (kind === "session" || kind === "skill" || kind === "cross") return 2;
  const hash = [...targetId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return totalLinks < 400 || hash % 5 === 0 ? 1 : 0;
}

/** Link colour (rgb 0..1, alpha folded in) for a link in a layout. */
export function linkRgb(kind: BatchLinkKind, layout: BatchLayout, targetColor: string, parse: (css: string) => [number, number, number]): [number, number, number] {
  if (layout === "neural") return parse(targetColor || "#8acbbd");
  const table: Record<string, [string, number]> = {
    skill: ["#f472b6", 0.35],
    cross: ["#7be0c8", 0.35],
    decision: ["#a78bfa", 0.35],
    session: ["#60a5fa", 0.3],
    core: ["#3ddc97", 0.5],
  };
  const [hex, a] = table[kind] ?? ["#b4bed2", 0.18];
  const [r, g, b] = parse(hex);
  // Lines draw over a near-black stage: scaling the colour reads like the old per-link alpha. The old
  // links were sub-pixel cylinders, so a 1 px line is toned down further to keep the same faint web.
  return [r * a * 0.6, g * a * 0.6, b * a * 0.6];
}

/** A point on the quadratic arc from s to t (curvature 0 = straight), written into out. */
export function arcPoint(
  s: { x: number; y: number; z: number },
  t: { x: number; y: number; z: number },
  curvature: number,
  rotation: number,
  u: number,
  out: { x: number; y: number; z: number },
) {
  if (!curvature) {
    out.x = s.x + (t.x - s.x) * u;
    out.y = s.y + (t.y - s.y) * u;
    out.z = s.z + (t.z - s.z) * u;
    return out;
  }
  const dx = t.x - s.x, dy = t.y - s.y, dz = t.z - s.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / len, ay = dy / len, az = dz / len;
  // A perpendicular to the link: cross(axis, up), falling back to the x axis when parallel.
  let px = ay * 0 - az * 1, py = az * 0 - ax * 0, pz = ax * 1 - ay * 0;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) {
    px = 0; py = az; pz = -ay;
    pl = Math.hypot(px, py, pz) || 1;
  }
  px /= pl; py /= pl; pz /= pl;
  // Rodrigues: rotate p around the axis by `rotation` (p is perpendicular, so the dot term drops out).
  const c = Math.cos(rotation), sn = Math.sin(rotation);
  const cx = ay * pz - az * py, cy = az * px - ax * pz, cz = ax * py - ay * px;
  const rx = px * c + cx * sn, ry = py * c + cy * sn, rz = pz * c + cz * sn;
  const k = curvature * len;
  const mx = s.x + dx / 2 + rx * k, my = s.y + dy / 2 + ry * k, mz = s.z + dz / 2 + rz * k;
  const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, d = u * u;
  out.x = a * s.x + b * mx + d * t.x;
  out.y = a * s.y + b * my + d * t.y;
  out.z = a * s.z + b * mz + d * t.z;
  return out;
}

/** Smoothstep fade used for source switches (same curve as memoryNodeOpacity). */
export function fadeOpacity(node: Pick<BatchNode, "visualTransition">, now: number) {
  const fade = node.visualTransition;
  if (!fade) return 1;
  const p = Math.min(1, Math.max(0, (now - fade.at) / fade.duration));
  const e = p * p * (3 - 2 * p);
  return fade.from + (fade.to - fade.from) * e;
}

export const TONE_BRIGHTNESS: Record<NodeTone, number> = { lit: 1, dim: 0.18, focus: 1.9 };
const HIGHLIGHT_LINK: [number, number, number] = [0.77, 1, 0.93];

export type MemoryBatch = ReturnType<typeof createMemoryBatch>;

export function createMemoryBatch(THREE: THREE, options: { glowTexture?: ThreeNS.Texture | null } = {}) {
  const group = new THREE.Group();
  group.name = "memory-batch";
  // The library's raycaster must never pick the batch: hover/click go to the per-node hit meshes.
  group.raycast = () => {};
  const colorCache = new Map<string, [number, number, number]>();
  const scratch = new THREE.Color();
  const parse = (css: string): [number, number, number] => {
    let c = colorCache.get(css);
    if (!c) {
      try {
        scratch.setStyle(css, THREE.SRGBColorSpace);
      } catch {
        scratch.set("#a3b4cb");
      }
      c = [scratch.r, scratch.g, scratch.b];
      colorCache.set(css, c);
    }
    return c;
  };

  const sphere = new THREE.SphereGeometry(1, 14, 10);
  const nodeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.65, roughness: 0.35, metalness: 0.1 });
  // Emissive follows each instance's colour (MeshStandardMaterial's emissive is otherwise per material).
  nodeMaterial.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("vec3 totalEmissiveRadiance = emissive;", "vec3 totalEmissiveRadiance = emissive * vec3( vColor );");
  };
  nodeMaterial.customProgramCacheKey = () => "memory-batch-emissive";
  let mesh: ThreeNS.InstancedMesh | null = null;

  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: { map: { value: options.glowTexture ?? null }, scale: { value: 500 } },
    vertexShader: `attribute float size; attribute vec3 tint; varying vec3 vTint;
      uniform float scale;
      void main() { vTint = tint; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(256.0, size * scale / max(1.0, -mv.z)); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D map; varying vec3 vTint;
      void main() { vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vTint * t.rgb, t.a); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glowGeometry = new THREE.BufferGeometry();
  const glow = new THREE.Points(glowGeometry, glowMaterial);
  glow.frustumCulled = false;
  glow.raycast = () => {};

  const linkMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false });
  const linkGeometry = new THREE.BufferGeometry();
  const lines = new THREE.LineSegments(linkGeometry, linkMaterial);
  lines.frustumCulled = false;
  lines.raycast = () => {};

  const particleMaterial = new THREE.PointsMaterial({ size: 1.4, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true, map: options.glowTexture ?? null, blending: THREE.AdditiveBlending });
  const particleGeometry = new THREE.BufferGeometry();
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  particles.frustumCulled = false;
  particles.raycast = () => {};
  group.add(lines, glow, particles);

  let layout: BatchLayout = "neural";
  let nodes: BatchNode[] = [];
  let byId = new Map<string, BatchNode>();
  let links: { s: string; t: string; kind: BatchLinkKind; curvature: number; rotation: number }[] = [];
  let flows: { link: number; phase: number }[] = [];
  let tones = new Map<string, NodeTone>();
  let hoverId: string | null = null;
  let adjacency = new Map<string, Set<string>>();
  let positionsDirty = true;
  let colorsDirty = true;
  let fading = false;
  let pulsing = new Set<string>();
  let showGlow = false;
  let flowOn = true;
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const p = { x: 0, y: 0, z: 0 };
  const zero = { x: 0, y: 0, z: 0 };
  const pos = (n: BatchNode | undefined) => (n && Number.isFinite(n.x) ? (n as { x: number; y: number; z: number }) : zero);

  function setData(nextNodes: BatchNode[], nextLinks: BatchLink[], nextLayout: BatchLayout) {
    layout = nextLayout;
    nodes = nextNodes.filter(isBatched);
    byId = new Map(nextNodes.map((n) => [n.id, n]));
    links = nextLinks
      .map((l) => ({ s: idOf(l.source), t: idOf(l.target), kind: l.kind }))
      .filter((l) => byId.has(l.s) && byId.has(l.t))
      .map((l) => ({ ...l, curvature: linkCurvature(l.kind, layout), rotation: linkRotation(l.t) }));
    adjacency = new Map();
    for (const l of links) {
      if (!adjacency.has(l.s)) adjacency.set(l.s, new Set());
      if (!adjacency.has(l.t)) adjacency.set(l.t, new Set());
      adjacency.get(l.s)!.add(l.t);
      adjacency.get(l.t)!.add(l.s);
    }
    flows = [];
    links.forEach((l, i) => {
      const count = particleCount(l.kind, layout, links.length, l.t);
      for (let k = 0; k < count; k++) flows.push({ link: i, phase: (k / count + (l.t.length % 7) / 7) % 1 });
    });
    if (mesh) {
      group.remove(mesh);
      mesh.dispose();
    }
    mesh = new THREE.InstancedMesh(sphere, nodeMaterial, Math.max(1, nodes.length));
    mesh.count = nodes.length;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    group.add(mesh);
    nodeMaterial.emissiveIntensity = layout === "neural" ? 0.65 : 0.28;
    showGlow = GLOW_LAYOUTS.includes(layout) && !!options.glowTexture;
    glow.visible = showGlow;
    glowGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nodes.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
    glowGeometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(nodes.length * 3), 3));
    glowGeometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(nodes.map((n) => recordRadius(n.kind, layout) * 5)), 1));
    const vertices = links.length * LINK_SEGMENTS * 2;
    linkGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
    linkGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(flows.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
    particleGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(flows.length * 3), 3));
    particleMaterial.size = layout === "neural" ? 1.3 : 1.4;
    linkMaterial.opacity = layout === "neural" ? 0.7 * 0.45 : layout === "sphere" ? 0.36 : 0.7;
    positionsDirty = colorsDirty = true;
    fading = nextNodes.some((n) => n.visualTransition);
  }

  /** Node positions changed (layout tick, new data): rewrite matrices, glow and link vertices. */
  function writePositions(now: number) {
    if (!mesh) return;
    const glowPos = glowGeometry.getAttribute("position") as ThreeNS.BufferAttribute;
    nodes.forEach((n, i) => {
      const { x, y, z } = pos(n);
      const fade = fadeOpacity(n, now);
      const pulse = pulsing.has(n.id) ? 1.14 + Math.sin(now * 0.004 + (n.index || 0) * 0.2) * 0.12 : 1;
      const r = recordRadius(n.kind, layout) * pulse * (0.35 + 0.65 * fade) * (fade < 0.01 ? 0 : 1);
      v.set(x, y, z);
      sc.set(r, r, r);
      matrix.compose(v, q, sc);
      mesh!.setMatrixAt(i, matrix);
      glowPos.setXYZ(i, x, y, z);
    });
    mesh.instanceMatrix.needsUpdate = true;
    glowPos.needsUpdate = true;
    const linkPos = linkGeometry.getAttribute("position") as ThreeNS.BufferAttribute;
    let w = 0;
    for (const l of links) {
      const s = pos(byId.get(l.s)), t = pos(byId.get(l.t));
      for (let k = 0; k < LINK_SEGMENTS; k++) {
        arcPoint(s, t, l.curvature, l.rotation, k / LINK_SEGMENTS, p);
        linkPos.setXYZ(w++, p.x, p.y, p.z);
        arcPoint(s, t, l.curvature, l.rotation, (k + 1) / LINK_SEGMENTS, p);
        linkPos.setXYZ(w++, p.x, p.y, p.z);
      }
    }
    linkPos.needsUpdate = true;
    linkGeometry.computeBoundingSphere();
  }

  function toneOf(id: string): NodeTone {
    const t = tones.get(id);
    if (t) return t;
    if (!hoverId) return "lit";
    if (id === hoverId || adjacency.get(hoverId)?.has(id)) return "lit";
    return "dim";
  }

  /** Colours changed (hover, focus, fade): rewrite instance, glow, link and particle colours. */
  function writeColors(now: number) {
    if (!mesh) return;
    const glowTint = glowGeometry.getAttribute("tint") as ThreeNS.BufferAttribute;
    const c = new THREE.Color();
    nodes.forEach((n, i) => {
      const [r, g, b] = parse(n.color);
      const tone = toneOf(n.id);
      const k = TONE_BRIGHTNESS[tone] * recordGlow(n.kind, layout) * fadeOpacity(n, now);
      c.setRGB(r * k, g * k, b * k);
      mesh!.setColorAt(i, c);
      const gk = (tone === "dim" ? 0.18 : 1) * 0.2 * fadeOpacity(n, now);
      glowTint.setXYZ(i, r * gk, g * gk, b * gk);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    glowTint.needsUpdate = true;
    const linkCol = linkGeometry.getAttribute("color") as ThreeNS.BufferAttribute;
    let w = 0;
    for (const l of links) {
      const hot = !!hoverId && (l.s === hoverId || l.t === hoverId);
      const target = byId.get(l.t);
      const fade = Math.min(fadeOpacity(byId.get(l.s) ?? {}, now), fadeOpacity(target ?? {}, now));
      const dim = hoverId && !hot ? 0.35 : 1;
      const [r, g, b] = hot ? HIGHLIGHT_LINK : linkRgb(l.kind, layout, target?.color ?? "", parse);
      for (let k = 0; k < LINK_SEGMENTS * 2; k++) linkCol.setXYZ(w++, r * fade * dim, g * fade * dim, b * fade * dim);
    }
    linkCol.needsUpdate = true;
    const partCol = particleGeometry.getAttribute("color") as ThreeNS.BufferAttribute;
    flows.forEach((f, i) => {
      const l = links[f.link];
      const [r, g, b] = layout === "neural" ? parse(byId.get(l.t)?.color ?? "#8affd0") : parse(l.kind === "skill" ? "#f472b6" : l.kind === "session" ? "#60a5fa" : l.kind === "cross" ? "#7be0c8" : "#3ddc97");
      partCol.setXYZ(i, r, g, b);
    });
    partCol.needsUpdate = true;
  }

  function writeParticles(now: number) {
    const partPos = particleGeometry.getAttribute("position") as ThreeNS.BufferAttribute;
    // Old speed: 0.0035 of the link per frame at 60 fps (session 0.006).
    flows.forEach((f, i) => {
      const l = links[f.link];
      const speed = (l.kind === "session" ? 0.006 : 0.0035) * 60;
      const u = (f.phase + (now / 1000) * speed) % 1;
      arcPoint(pos(byId.get(l.s)), pos(byId.get(l.t)), l.curvature, l.rotation, u, p);
      partPos.setXYZ(i, p.x, p.y, p.z);
    });
    partPos.needsUpdate = true;
  }

  return {
    group,
    setData,
    /** The layout moved nodes (engine tick): positions are rewritten on the next frame. */
    markPositions() {
      positionsDirty = true;
    },
    setHover(id: string | null) {
      if (id === hoverId) return;
      hoverId = id;
      colorsDirty = true;
    },
    /** Explicit tones (focus sets): ids not listed follow hover. */
    setTones(next: Map<string, NodeTone>) {
      tones = next;
      colorsDirty = true;
    },
    setPulsing(ids: Set<string>) {
      const changed = ids.size !== pulsing.size || [...ids].some((id) => !pulsing.has(id));
      pulsing = ids;
      if (changed) positionsDirty = true;
    },
    setFlow(on: boolean) {
      flowOn = on;
      particles.visible = on;
    },
    setLinkOpacity(opacity: number) {
      linkMaterial.opacity = opacity;
    },
    /** Canvas height and camera fov give glow sprites their world size. */
    setViewport(height: number, fovDeg: number) {
      glowMaterial.uniforms.scale.value = height / (2 * Math.tan((fovDeg * Math.PI) / 360));
    },
    /** Once per animation frame: cheap when nothing moved. */
    frame(now: number) {
      if (fading) {
        positionsDirty = colorsDirty = true;
        fading = nodes.some((n) => n.visualTransition && now < n.visualTransition.at + n.visualTransition.duration);
      }
      if (pulsing.size) positionsDirty = true;
      if (positionsDirty) {
        writePositions(now);
        positionsDirty = false;
      }
      if (colorsDirty) {
        writeColors(now);
        colorsDirty = false;
      }
      if (flowOn && flows.length) writeParticles(now);
    },
    /** For tests and the perf probe. */
    stats() {
      return { records: nodes.length, links: links.length, flows: flows.length, drawCalls: 2 + (showGlow ? 1 : 0) + (flowOn && flows.length ? 1 : 0), hoverId };
    },
    colorOf(id: string) {
      const i = nodes.findIndex((n) => n.id === id);
      if (i < 0 || !mesh?.instanceColor) return null;
      const c = new THREE.Color();
      mesh.getColorAt(i, c);
      return [c.r, c.g, c.b];
    },
    instanced() {
      return mesh;
    },
    dispose() {
      if (mesh) mesh.dispose();
      sphere.dispose();
      nodeMaterial.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
      linkGeometry.dispose();
      linkMaterial.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
      group.removeFromParent();
    },
  };
}
