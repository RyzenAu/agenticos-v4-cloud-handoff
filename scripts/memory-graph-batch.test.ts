// W-D (29 Sep 2026): the Memory cortex draws its records in one batched layer so dragging stays
// smooth. These tests build the layer headlessly (three.js needs no WebGL context to build geometry).
import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  LINK_SEGMENTS,
  arcPoint,
  createMemoryBatch,
  fadeOpacity,
  isBatched,
  linkCurvature,
  particleCount,
  recordRadius,
} from "../src/components/memory-graph-batch";

const node = (id: string, x: number, y = 0, z = 0, extra: Record<string, unknown> = {}) => ({ id, kind: "file", color: "#88ccff", x, y, z, ...extra });

describe("arcPoint", () => {
  const s = { x: 0, y: 0, z: 0 };
  const t = { x: 100, y: 0, z: 0 };
  const out = { x: 0, y: 0, z: 0 };
  test("starts and ends on the link's nodes, straight or curved", () => {
    for (const c of [0, 0.34]) {
      expect(arcPoint(s, t, c, 1.2, 0, out)).toEqual({ x: 0, y: 0, z: 0 });
      const end = arcPoint(s, t, c, 1.2, 1, { x: 0, y: 0, z: 0 });
      expect(end.x).toBeCloseTo(100);
      expect(end.y).toBeCloseTo(0);
      expect(end.z).toBeCloseTo(0);
    }
  });
  test("a straight link's middle is the midpoint; a curved one bows out by half the curvature times its length", () => {
    expect(arcPoint(s, t, 0, 0, 0.5, out)).toEqual({ x: 50, y: 0, z: 0 });
    const mid = arcPoint(s, t, 0.4, 0.7, 0.5, { x: 0, y: 0, z: 0 });
    expect(mid.x).toBeCloseTo(50);
    expect(Math.hypot(mid.y, mid.z)).toBeCloseTo(0.5 * 0.4 * 100);
  });
  test("a link parallel to the y axis still curves (fallback perpendicular)", () => {
    const mid = arcPoint({ x: 0, y: 0, z: 0 }, { x: 0, y: 80, z: 0 }, 0.25, 0, 0.5, { x: 0, y: 0, z: 0 });
    expect(mid.y).toBeCloseTo(40);
    expect(Math.hypot(mid.x, mid.z)).toBeCloseTo(0.5 * 0.25 * 80);
  });
});

describe("batch rules keep the old look", () => {
  test("hubs and source hubs stay separate objects; records are batched", () => {
    expect(isBatched({ kind: "hub" })).toBe(false);
    expect(isBatched({ kind: "workspace", categoryHub: true })).toBe(false);
    expect(isBatched({ kind: "file" })).toBe(true);
  });
  test("sizes, curvature and flow match the previous per-object settings", () => {
    expect(recordRadius("file", "neural")).toBe(2.8);
    expect(recordRadius("workspace", "network")).toBe(14);
    expect(linkCurvature("core", "neural")).toBe(0.34);
    expect(linkCurvature("file", "network")).toBe(0);
    expect(particleCount("core", "neural", 3000, "x")).toBe(3);
    expect(particleCount("file", "neural", 3000, "x")).toBe(0);
    expect(particleCount("file", "neural", 300, "x")).toBe(1);
  });
  test("fades follow the smoothstep curve and finish at their target", () => {
    const n = { visualTransition: { from: 1, to: 0 as const, at: 1000, duration: 400 } };
    expect(fadeOpacity(n, 1000)).toBe(1);
    expect(fadeOpacity(n, 1200)).toBeCloseTo(0.5);
    expect(fadeOpacity(n, 5000)).toBe(0);
    expect(fadeOpacity({}, 0)).toBe(1);
  });
});

describe("createMemoryBatch", () => {
  const nodes = [
    { id: "hub", kind: "hub", color: "#8affd0", x: 0, y: 0, z: 0 },
    node("a", 10),
    node("b", 20, 5),
    node("c", -30, 0, 7),
  ];
  const links = [
    { source: "hub", target: "a", kind: "core" as const },
    { source: "a", target: "b", kind: "file" as const },
    { source: nodes[0] as never, target: "c", kind: "cross" as const },
  ];

  test("draws every record in a handful of draw calls", () => {
    const batch = createMemoryBatch(THREE, { glowTexture: new THREE.Texture() });
    batch.setData(nodes, links, "neural");
    batch.frame(0);
    const s = batch.stats();
    expect(s.records).toBe(3);
    expect(s.links).toBe(3);
    expect(s.drawCalls).toBeLessThanOrEqual(4);
    const mesh = batch.instanced()!;
    expect(mesh.count).toBe(3);
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(1, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect([p.x, p.y, p.z]).toEqual([20, 5, 0]);
    const linkPos = (batch.group.children[0] as THREE.LineSegments).geometry.getAttribute("position");
    expect(linkPos.count).toBe(3 * LINK_SEGMENTS * 2);
    // The first vertex of the hub→a link sits on the hub, the last on a.
    expect(linkPos.getX(0)).toBeCloseTo(0);
    expect(linkPos.getX(LINK_SEGMENTS * 2 - 1)).toBeCloseTo(10);
    batch.dispose();
  });

  test("hover dims everything outside the hovered node's neighbourhood without recreating anything", () => {
    const batch = createMemoryBatch(THREE);
    batch.setData(nodes, links, "network");
    batch.frame(0);
    const mesh = batch.instanced();
    const before = batch.colorOf("c")!;
    batch.setHover("b");
    batch.frame(16);
    expect(batch.instanced()).toBe(mesh);
    const dimmed = batch.colorOf("c")!;
    expect(dimmed[0]).toBeCloseTo(before[0] * 0.18);
    // a is b's neighbour: still lit.
    batch.setHover("b");
    expect(batch.colorOf("a")![0]).toBeGreaterThan(dimmed[0]);
    batch.setHover(null);
    batch.frame(32);
    expect(batch.colorOf("c")![0]).toBeCloseTo(before[0]);
    batch.dispose();
  });

  test("a focus set brightens its records and dims the rest", () => {
    const batch = createMemoryBatch(THREE);
    batch.setData(nodes, links, "neural");
    batch.frame(0);
    const lit = batch.colorOf("a")![1];
    batch.setTones(new Map([["a", "focus"], ["b", "dim"], ["c", "dim"]]));
    batch.frame(16);
    expect(batch.colorOf("a")![1]).toBeGreaterThan(lit);
    expect(batch.colorOf("b")![1]).toBeLessThan(lit);
    batch.dispose();
  });

  test("a record fading out shrinks to nothing", () => {
    const batch = createMemoryBatch(THREE);
    batch.setData([...nodes.slice(0, 3), node("c", 5, 0, 0, { visualTransition: { from: 1, to: 0, at: 0, duration: 100 } })], links, "neural");
    batch.frame(500);
    const m = new THREE.Matrix4();
    batch.instanced()!.getMatrixAt(2, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBe(0);
    batch.dispose();
  });

  test("the batch never takes part in the library's hover/click raycast", () => {
    const batch = createMemoryBatch(THREE);
    batch.setData(nodes, links, "neural");
    batch.frame(0);
    const raycaster = new THREE.Raycaster(new THREE.Vector3(10, 0, 50), new THREE.Vector3(0, 0, -1));
    expect(raycaster.intersectObject(batch.group, true)).toHaveLength(0);
    batch.dispose();
  });
});
