// L6 (29 Sep 2026): the knowledge graph draws its plain nodes, links and flow in a handful of draw calls
// (it was ~1,900 per frame). Built headlessly (three.js needs no WebGL context to build geometry);
// synthetic nodes only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import {
  DIM,
  LINK_CURVATURE,
  MANY_LINKS,
  createGraphifyBatch,
  isBatchedNode,
  linkColorFor,
  linkParticles,
  nodeEmissive,
  nodeRadius,
  nodeShape,
} from "../src/components/graphify-batch";
import { LINK_SEGMENTS } from "../src/components/memory-graph-batch";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const node = (id: string, x: number, extra: Record<string, unknown> = {}) => ({ id, community: 1, fileType: "code", degree: 2, god: false, x, y: 0, z: 0, ...extra });
const nodes = [node("god", 0, { god: true, degree: 9 }), node("a", 10), node("b", 20, { fileType: "doc" }), node("c", -30, { fileType: "image" }), node("d", 40, { community: 2 })];
const links = [
  { source: "god", target: "a", confidence: "EXTRACTED" },
  { source: "a", target: "b", confidence: "INFERRED" },
  { source: nodes[0] as never, target: "c", confidence: "EXTRACTED" },
];
const adjacency = () => {
  const m = new Map<string, Set<string>>();
  for (const l of links) {
    const s = typeof l.source === "object" ? (l.source as { id: string }).id : l.source;
    for (const [x, y] of [[s, l.target], [l.target, s]]) (m.get(x) ?? m.set(x, new Set()).get(x)!).add(y);
  }
  return m;
};
const colorFor = (community: number) => (community === 1 ? "#3ddc97" : "#60a5fa");
const build = (over: Partial<Parameters<ReturnType<typeof createGraphifyBatch>["setData"]>[2]> = {}) => {
  const batch = createGraphifyBatch(THREE, { colorFor, accent: "#3ddc97" });
  batch.setData(nodes, links, { adjacency: adjacency(), curvature: 0, airy: false, particles: true, shown: nodes.length, ...over });
  batch.frame(0);
  return batch;
};

describe("the rules keep the old look", () => {
  test("god nodes stay their own objects; every other node is batched", () => {
    expect(isBatchedNode({ god: true })).toBe(false);
    expect(isBatchedNode({ god: false })).toBe(true);
  });
  test("shapes, sizes and glow match the per-object nodes they replace", () => {
    expect(nodeShape("doc")).toBe("octahedron");
    expect(nodeShape("markdown")).toBe("octahedron");
    expect(nodeShape("image")).toBe("icosahedron");
    expect(nodeShape("code")).toBe("sphere");
    expect(nodeRadius({ god: false, degree: 5 }, false)).toBeCloseTo(2.4 + 2);
    expect(nodeRadius({ god: false, degree: 100 }, false)).toBeCloseTo(2.4 + 5);
    expect(nodeRadius({ god: true, degree: 4 }, false)).toBeCloseTo(6 + 2);
    expect(nodeRadius({ god: false, degree: 5 }, true)).toBeCloseTo(2.2 + 1.1);
    expect(nodeEmissive(false, false)).toBe(0.8);
    expect(nodeEmissive(false, true)).toBe(0.65);
    expect(DIM).toBe(0.32);
  });
  test("flow only on small graphs and extracted links; straight links only past the size limit", () => {
    expect(linkParticles("EXTRACTED", false, 300)).toBe(2);
    expect(linkParticles("INFERRED", false, 300)).toBe(0);
    expect(linkParticles("EXTRACTED", true, 300)).toBe(0);
    expect(linkParticles("EXTRACTED", false, 900)).toBe(0);
    expect(MANY_LINKS).toBe(400);
    expect(LINK_CURVATURE).toBe(0.08);
  });
  test("an extracted link is brighter than an inferred one", () => {
    const parse = (css: string): [number, number, number] => [1, 1, 1].map((x) => x * (css === "#78e0c8" ? 1 : 0.5)) as [number, number, number];
    expect(linkColorFor("EXTRACTED", parse)[0]).toBeGreaterThan(linkColorFor("INFERRED", parse)[0]);
  });
});

describe("createGraphifyBatch", () => {
  test("draws every plain node, link and flow particle in a handful of draw calls", () => {
    const batch = build();
    const s = batch.stats();
    expect(s.records).toBe(4); // the god node is separate
    expect(s.links).toBe(3);
    expect(s.shapes).toBe(3); // sphere + octahedron + icosahedron
    expect(s.flows).toBe(4); // two EXTRACTED links x 2
    // 3 instanced meshes + 1 line layer + 1 flow layer, however many nodes and links there are.
    expect(s.drawCalls).toBe(5);
    const many = createGraphifyBatch(THREE, { colorFor, accent: "#3ddc97" });
    const ns = Array.from({ length: 1000 }, (_, i) => node(`n${i}`, i, { fileType: i % 3 ? "code" : "doc" }));
    const ls = Array.from({ length: 1500 }, (_, i) => ({ source: `n${i % 1000}`, target: `n${(i * 7 + 1) % 1000}`, confidence: "EXTRACTED" }));
    many.setData(ns, ls, { adjacency: new Map(), curvature: 0, airy: false, particles: true, shown: 1000 });
    many.frame(0);
    expect(many.stats().drawCalls).toBeLessThanOrEqual(4); // no flow past 500 nodes
    many.dispose();
    batch.dispose();
  });

  test("instances sit on the layout's node positions and links run between them (straight = 1 segment, curved = 8)", () => {
    const batch = build();
    const sphere = batch.instancedMeshes().get("sphere")!;
    const m = new THREE.Matrix4();
    sphere.getMatrixAt(0, m); // "a" is the first sphere
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect([p.x, p.y, p.z]).toEqual([10, 0, 0]);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(nodeRadius(nodes[1] as never, false));
    const linkPos = (batch.group.children[0] as THREE.LineSegments).geometry.getAttribute("position");
    expect(linkPos.count).toBe(3 * 2);
    expect(linkPos.getX(0)).toBeCloseTo(0); // god
    expect(linkPos.getX(1)).toBeCloseTo(10); // a
    batch.dispose();
    const curved = build({ curvature: LINK_CURVATURE });
    const pos = (curved.group.children[0] as THREE.LineSegments).geometry.getAttribute("position");
    expect(pos.count).toBe(3 * LINK_SEGMENTS * 2);
    expect(pos.getX(LINK_SEGMENTS * 2 - 1)).toBeCloseTo(10);
    curved.dispose();
  });

  test("a layout tick moves the instances and links in place (no rebuild)", () => {
    const batch = build();
    const sphere = batch.instancedMeshes().get("sphere")!;
    (nodes[1] as { x: number }).x = 55;
    batch.syncPositions();
    const m = new THREE.Matrix4();
    sphere.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(55);
    expect(batch.instancedMeshes().get("sphere")).toBe(sphere);
    (nodes[1] as { x: number }).x = 10;
    batch.dispose();
  });

  test("hover dims everything outside the hovered neighbourhood, lights its links, and recreates nothing", () => {
    const batch = build();
    const before = batch.colorOf("d")!;
    const beforeA = batch.colorOf("a")!;
    const beforeB = batch.colorOf("b")!;
    const linkBefore = Array.from(batch.linkVertexColors());
    const mesh = batch.instancedMeshes().get("sphere");
    batch.setHover("a");
    batch.frame(16);
    expect(batch.instancedMeshes().get("sphere")).toBe(mesh);
    expect(batch.colorOf("d")![1]).toBeCloseTo(before[1] * DIM); // outside a's neighbourhood: dim
    expect(batch.colorOf("a")![1]).toBeCloseTo(beforeA[1]); // itself: lit
    expect(batch.colorOf("b")![1]).toBeCloseTo(beforeB[1]); // a's neighbour: lit
    const linkHover = Array.from(batch.linkVertexColors());
    expect(linkHover).not.toEqual(linkBefore); // the hovered node's links are lit
    batch.setHover(null);
    batch.frame(32);
    expect(batch.colorOf("d")![1]).toBeCloseTo(before[1]);
    expect(Array.from(batch.linkVertexColors())).toEqual(linkBefore);
    batch.dispose();
  });

  test("flow can be switched off (reduced motion) and back on", () => {
    const batch = build();
    batch.setFlow(false);
    expect(batch.stats().drawCalls).toBe(4);
    batch.setFlow(true);
    expect(batch.stats().drawCalls).toBe(5);
    batch.dispose();
    const none = build({ particles: false });
    expect(none.stats().flows).toBe(0);
    none.dispose();
  });

  test("the batch never takes part in the library's hover/click raycast", () => {
    const batch = build();
    const raycaster = new THREE.Raycaster(new THREE.Vector3(10, 0, 50), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(batch.group, true)).toHaveLength(0);
    batch.dispose();
  });
});

describe("GraphifyGraph3D uses the batch and stops when idle", () => {
  const src = read("src/components/graphify-graph-3d.tsx");
  test("links and flow are the batch's; the library keeps no link objects; nodes keep an invisible hit target", () => {
    expect(src).toContain("linkVisibility={false}");
    expect(src).not.toMatch(/linkWidth=|linkDirectionalParticles=|__lineObj|highlightLinks/);
    expect(src).toContain("onEngineTick={onEngineTick}");
    expect(src).toContain("new THREE.MeshBasicMaterial({ visible: false })");
    expect(src).toContain('data-draw-mode="batched"');
    // God nodes are the only per-node objects with materials of their own.
    expect(src).toMatch(/if \(!n\.god && hitResources\)/);
  });
  test("no React state is written per tick or per frame", () => {
    const tick = src.slice(src.indexOf("const tick = () => {"), src.indexOf("raf = requestAnimationFrame(tick);\n    const onVisibility"));
    expect(tick).not.toMatch(/(?<![.\w])set[A-Z]\w+\(/); // (the batch's own setHover is a method, not state)
    const engine = src.slice(src.indexOf("const onEngineTick = useCallback"), src.indexOf("const onNodeHover"));
    expect(engine).not.toMatch(/(?<![.\w])set[A-Z]\w+\(/);
  });
  test("the render loop stops when hidden, off-screen or idle, and wakes on interaction", () => {
    expect(src).toContain("fg.pauseAnimation");
    expect(src).toContain("fg.resumeAnimation");
    expect(src).toContain('document.addEventListener("visibilitychange", onVisibility)');
    expect(src).toContain("new IntersectionObserver");
    expect(src).toMatch(/const idle =\s*\n\s*!rotatingRef\.current &&/);
    for (const handler of ["onPointerDown", "onPointerMove", "onWheel", "onKeyDown"]) expect(src).toMatch(new RegExp(`${handler}=\\{[^\\n]*wakeRef\\.current\\?\\.\\(\\)`));
  });
});
