/**
 * Batched renderer for the knowledge graph (GraphifyGraph3D; follow-up L6 to W-D: "80 ms frames at 4x CPU",
 * "it lags whenever I move something").
 *
 * The library drew one mesh with its own material per node (a second mesh and a halo for god nodes),
 * one cylinder per link and one sphere per flow particle: about 1,900 WebGL draw calls per frame on the
 * default graph, and a hover swapped materials on every link. Here the plain nodes are drawn by at most
 * three InstancedMeshes (sphere, octahedron, icosahedron: one per shape), the links by ONE LineSegments
 * (curves included) and the flow particles by ONE Points. The six god nodes keep their own objects (halo,
 * pulse). The library keeps an invisible hit mesh per node for hover, tooltip, click and drag, and still
 * runs the layout. Hover only rewrites colour buffers; nothing is recreated.
 *
 * Pure three.js (no WebGL context is needed to build it), so the maths is unit-tested headlessly.
 */
import type * as ThreeNS from "three";
import { LINK_SEGMENTS, arcPoint } from "./memory-graph-batch";

type THREE = typeof ThreeNS;

export type GraphifyBatchNode = {
  id: string;
  community: number;
  fileType: string;
  degree: number;
  god: boolean;
  x?: number;
  y?: number;
  z?: number;
};
export type GraphifyBatchLink = { source: string | { id: string }; target: string | { id: string }; confidence?: string };
export type GraphifyShape = "sphere" | "octahedron" | "icosahedron";

/** Opacity a node outside the hovered neighbourhood was drawn with; now its colour brightness on the dark stage. */
export const DIM = 0.32;
/** Links per graph above which links are straight (a curve is re-sampled on every layout tick). */
export const MANY_LINKS = 400;
/** Curvature of a link on a small graph (the library's own arc formula). */
export const LINK_CURVATURE = 0.08;

const idOf = (v: string | { id: string }) => (typeof v === "object" && v ? v.id : v);

/** God nodes keep their own objects (a halo and a pulse); everything else is instanced. */
export const isBatchedNode = (n: Pick<GraphifyBatchNode, "god">) => !n.god;

/** The shape a file type is drawn as (as before: docs octahedra, images icosahedra, the rest spheres). */
export function nodeShape(fileType: string): GraphifyShape {
  const ft = String(fileType);
  if (ft === "doc" || ft === "markdown") return "octahedron";
  if (ft === "image") return "icosahedron";
  return "sphere";
}

/** Node radius, as the per-object nodes had it. "Airy" (spread) graphs use gentler sizes. */
export function nodeRadius(n: Pick<GraphifyBatchNode, "god" | "degree">, airy: boolean) {
  return n.god
    ? airy
      ? 4.5 + Math.min(5, n.degree * 0.18)
      : 6 + Math.min(8, n.degree * 0.5)
    : airy
      ? 2.2 + Math.min(3.5, n.degree * 0.22)
      : 2.4 + Math.min(5, n.degree * 0.4);
}

/** Emissive strength of a plain node; god nodes are not batched but share the table. */
export const nodeEmissive = (god: boolean, airy: boolean) => (god ? (airy ? 1.1 : 2.2) : airy ? 0.65 : 0.8);

/** Link colour (rgb 0..1, its old alpha folded in for the dark stage) and the hovered link's colour. */
export function linkColorFor(confidence: string | undefined, parse: (css: string) => [number, number, number]): [number, number, number] {
  const [hex, a] = confidence === "EXTRACTED" ? ["#78e0c8", 0.42] : ["#a78bfa", 0.22];
  const [r, g, b] = parse(hex);
  return [r * a * LINK_GAIN, g * a * LINK_GAIN, b * a * LINK_GAIN];
}
/** A 1 px line carries less light than the old cylinder, so the folded alpha is lifted a little (the old links were faint: keep the same quiet web). */
export const LINK_GAIN = 0.9;

/** Flow particles per link: the same rule as before (small graphs, extracted links only). */
export const linkParticles = (confidence: string | undefined, manyLinks: boolean, shown: number) =>
  !manyLinks && shown <= 500 && confidence === "EXTRACTED" ? 2 : 0;

export type GraphifyBatch = ReturnType<typeof createGraphifyBatch>;

export function createGraphifyBatch(THREE: THREE, options: { colorFor: (community: number) => string; accent: string }) {
  const group = new THREE.Group();
  group.name = "graphify-batch";
  // The library's raycaster must never pick the batch: hover, click and drag go to the per-node hit meshes.
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

  const geometries: Record<GraphifyShape, ThreeNS.BufferGeometry> = {
    sphere: new THREE.SphereGeometry(1, 16, 12),
    octahedron: new THREE.OctahedronGeometry(1, 0),
    icosahedron: new THREE.IcosahedronGeometry(1, 0),
  };
  const nodeMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8, roughness: 0.35, metalness: 0.1 });
  // Emissive follows each instance's colour (MeshStandardMaterial's emissive is otherwise per material).
  nodeMaterial.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("vec3 totalEmissiveRadiance = emissive;", "vec3 totalEmissiveRadiance = emissive * vec3( vColor );");
  };
  nodeMaterial.customProgramCacheKey = () => "graphify-batch-emissive";

  const linkMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, depthWrite: false });
  const linkGeometry = new THREE.BufferGeometry();
  const lines = new THREE.LineSegments(linkGeometry, linkMaterial);
  lines.frustumCulled = false;
  lines.raycast = () => {};

  const particleMaterial = new THREE.PointsMaterial({ size: 2.2, color: new THREE.Color(options.accent), transparent: true, opacity: 0.9, depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending });
  const particleGeometry = new THREE.BufferGeometry();
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  particles.frustumCulled = false;
  particles.raycast = () => {};
  group.add(lines, particles);

  type Slot = { shape: GraphifyShape; index: number; node: GraphifyBatchNode; radius: number };
  const meshes = new Map<GraphifyShape, ThreeNS.InstancedMesh>();
  let slots: Slot[] = [];
  let byId = new Map<string, GraphifyBatchNode>();
  let links: { s: string; t: string; confidence?: string }[] = [];
  let segments = 1;
  let curvature = 0;
  let flows: { link: number; phase: number }[] = [];
  let adjacency = new Map<string, Set<string>>();
  let hoverId: string | null = null;
  let colorsDirty = true;
  let positionsDirty = true;
  let flowOn = true;
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const p = { x: 0, y: 0, z: 0 };
  const zero = { x: 0, y: 0, z: 0 };
  const pos = (n: GraphifyBatchNode | undefined) => (n && Number.isFinite(n.x) ? (n as { x: number; y: number; z: number }) : zero);

  function clearMeshes() {
    for (const mesh of meshes.values()) {
      group.remove(mesh);
      mesh.dispose();
    }
    meshes.clear();
  }

  function setData(
    nextNodes: GraphifyBatchNode[],
    nextLinks: GraphifyBatchLink[],
    next: { adjacency: Map<string, Set<string>>; curvature: number; airy: boolean; particles: boolean; shown?: number },
  ) {
    byId = new Map(nextNodes.map((n) => [n.id, n]));
    adjacency = next.adjacency;
    curvature = next.curvature;
    segments = curvature ? LINK_SEGMENTS : 1;
    nodeMaterial.emissiveIntensity = nodeEmissive(false, next.airy);
    clearMeshes();
    const counts: Record<GraphifyShape, number> = { sphere: 0, octahedron: 0, icosahedron: 0 };
    slots = nextNodes.filter(isBatchedNode).map((node) => {
      const shape = nodeShape(node.fileType);
      return { shape, index: counts[shape]++, node, radius: nodeRadius(node, next.airy) };
    });
    for (const shape of Object.keys(counts) as GraphifyShape[]) {
      if (!counts[shape]) continue;
      const mesh = new THREE.InstancedMesh(geometries[shape], nodeMaterial, counts[shape]);
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      meshes.set(shape, mesh);
      group.add(mesh);
    }
    links = nextLinks
      .map((l) => ({ s: idOf(l.source), t: idOf(l.target), confidence: l.confidence }))
      .filter((l) => byId.has(l.s) && byId.has(l.t));
    const many = links.length > MANY_LINKS;
    flows = [];
    if (next.particles)
      links.forEach((l, i) => {
        const count = linkParticles(l.confidence, many, next.shown ?? nextNodes.length);
        for (let k = 0; k < count; k++) flows.push({ link: i, phase: (k / count + (l.t.length % 7) / 7) % 1 });
      });
    const vertices = links.length * segments * 2;
    linkGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
    linkGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(flows.length * 3), 3).setUsage(THREE.DynamicDrawUsage));
    particles.visible = flowOn && flows.length > 0;
    positionsDirty = colorsDirty = true;
  }

  /** Node positions changed (layout tick, new data): rewrite matrices and link vertices. */
  function writePositions() {
    for (const slot of slots) {
      const mesh = meshes.get(slot.shape)!;
      const { x, y, z } = pos(slot.node);
      v.set(x, y, z);
      sc.set(slot.radius, slot.radius, slot.radius);
      matrix.compose(v, q, sc);
      mesh.setMatrixAt(slot.index, matrix);
    }
    for (const mesh of meshes.values()) mesh.instanceMatrix.needsUpdate = true;
    const linkPos = linkGeometry.getAttribute("position") as ThreeNS.BufferAttribute;
    let w = 0;
    for (const l of links) {
      const s = pos(byId.get(l.s)), t = pos(byId.get(l.t));
      if (segments === 1) {
        linkPos.setXYZ(w++, s.x, s.y, s.z);
        linkPos.setXYZ(w++, t.x, t.y, t.z);
        continue;
      }
      // Deterministic arc rotation per link, as the library's default curve has none (0).
      for (let k = 0; k < segments; k++) {
        arcPoint(s, t, curvature, 0, k / segments, p);
        linkPos.setXYZ(w++, p.x, p.y, p.z);
        arcPoint(s, t, curvature, 0, (k + 1) / segments, p);
        linkPos.setXYZ(w++, p.x, p.y, p.z);
      }
    }
    linkPos.needsUpdate = true;
    linkGeometry.computeBoundingSphere();
    positionsDirty = false;
  }

  const lit = (id: string) => !hoverId || id === hoverId || !!adjacency.get(hoverId)?.has(id);

  /** Colours changed (hover, new data): rewrite instance and link colours. */
  function writeColors() {
    const c = new THREE.Color();
    for (const slot of slots) {
      const [r, g, b] = parse(options.colorFor(slot.node.community));
      const k = lit(slot.node.id) ? 1 : DIM;
      c.setRGB(r * k, g * k, b * k);
      meshes.get(slot.shape)!.setColorAt(slot.index, c);
    }
    for (const mesh of meshes.values()) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const linkCol = linkGeometry.getAttribute("color") as ThreeNS.BufferAttribute;
    const hotRgb = parse(options.accent);
    let w = 0;
    for (const l of links) {
      const hot = !!hoverId && (l.s === hoverId || l.t === hoverId);
      const [r, g, b] = hot ? ([hotRgb[0] * 0.95, hotRgb[1] * 0.95, hotRgb[2] * 0.95] as [number, number, number]) : linkColorFor(l.confidence, parse);
      for (let k = 0; k < segments * 2; k++) linkCol.setXYZ(w++, r, g, b);
    }
    linkCol.needsUpdate = true;
    colorsDirty = false;
  }

  function writeParticles(now: number) {
    const partPos = particleGeometry.getAttribute("position") as ThreeNS.BufferAttribute;
    // Old speed: 0.004 of the link per frame at 60 fps.
    const speed = 0.004 * 60;
    flows.forEach((f, i) => {
      const l = links[f.link];
      const u = (f.phase + (now / 1000) * speed) % 1;
      arcPoint(pos(byId.get(l.s)), pos(byId.get(l.t)), curvature, 0, u, p);
      partPos.setXYZ(i, p.x, p.y, p.z);
    });
    partPos.needsUpdate = true;
  }

  return {
    group,
    setData,
    /** The layout moved nodes (engine tick): write the new positions now, before this frame is drawn. */
    syncPositions() {
      writePositions();
    },
    markPositions() {
      positionsDirty = true;
    },
    setHover(id: string | null) {
      if (id === hoverId) return;
      hoverId = id;
      colorsDirty = true;
    },
    setFlow(on: boolean) {
      flowOn = on;
      particles.visible = on && flows.length > 0;
    },
    /** Once per animation frame: cheap when nothing changed. */
    frame(now: number) {
      if (positionsDirty) writePositions();
      if (colorsDirty) writeColors();
      if (flowOn && flows.length) writeParticles(now);
    },
    /** For tests and the perf probe. */
    stats() {
      return { records: slots.length, links: links.length, flows: flows.length, shapes: meshes.size, drawCalls: meshes.size + (links.length ? 1 : 0) + (flowOn && flows.length ? 1 : 0), hoverId };
    },
    colorOf(id: string) {
      const slot = slots.find((s) => s.node.id === id);
      const mesh = slot && meshes.get(slot.shape);
      if (!slot || !mesh?.instanceColor) return null;
      const c = new THREE.Color();
      mesh.getColorAt(slot.index, c);
      return [c.r, c.g, c.b] as [number, number, number];
    },
    linkVertexColors() {
      return (linkGeometry.getAttribute("color")?.array ?? new Float32Array(0)) as Float32Array;
    },
    instancedMeshes() {
      return meshes;
    },
    dispose() {
      clearMeshes();
      for (const g of Object.values(geometries)) g.dispose();
      nodeMaterial.dispose();
      linkGeometry.dispose();
      linkMaterial.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
      group.removeFromParent();
    },
  };
}
