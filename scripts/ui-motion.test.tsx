// Programme C (1 Oct 2026): the one motion language, the device slot, route links and the honest
// calendar/inbox unknowns. Server markup plus plain reads of the stylesheet; synthetic values only.
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectionState, DeviceStatusSlot, SaveStatus, TaskPhase, deviceFromRecord, deviceSlotView, splitRoutes } from "../src/components/ds";
import { MOTION } from "../src/lib/ui-motion";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
const styles = read("src/styles.css");
const ms = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)ms`).exec(styles)?.[1]);
const px = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(styles)?.[1]);

describe("motion tokens", () => {
  test("the TypeScript twin matches the CSS custom properties", () => {
    expect(MOTION.dur.fast).toBe(ms("dur-fast"));
    expect(MOTION.dur.base).toBe(ms("dur-base"));
    expect(MOTION.dur.slow).toBe(ms("dur-slow"));
    expect(MOTION.dur.task).toBe(ms("dur-task"));
    expect(MOTION.move.sm).toBe(px("move-sm"));
    expect(MOTION.move.drawer).toBe(px("move-drawer"));
  });

  test("keyframes animate transform and opacity only", () => {
    for (const name of ["mo-enter", "mo-drawer-in", "mo-pop", "mo-slide", "mo-breathe"]) {
      const body = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(styles)?.[1] ?? "";
      expect(body.length).toBeGreaterThan(0);
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) expect(["transform", "opacity"]).toContain(p);
    }
  });

  test("arrival keyframes never start dim: content is legible even if no animation frame ever runs", () => {
    for (const name of ["mo-enter", "mo-drawer-in", "mo-pop"]) {
      const body = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(styles)?.[1] ?? "";
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain("opacity");
    }
  });

  test("reduced motion collapses durations and a hidden tab pauses every loop", () => {
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,[\s\S]*?animation-duration: 0\.001ms !important/);
    expect(styles).toContain("html[data-doc-hidden] *");
    expect(styles).toContain("animation-play-state: paused !important");
  });

  test("drawers and dialogs take their durations from the tokens", () => {
    expect(read("src/components/ui/sheet.tsx")).toContain("duration-[var(--dur-slow)]");
    expect(read("src/components/ui/dialog.tsx")).toContain("duration-[var(--dur-base)]");
  });

  test("the shell keys its page enter by path and installs the guards", () => {
    const root = read("src/routes/__root.tsx");
    expect(root).toContain("installMotionGuards");
    expect(root).toMatch(/key=\{pathname\}/);
    expect(root).toContain("mo-enter");
  });
});

describe("SaveStatus", () => {
  test("idle is an empty polite live region; saved and error say so in words", () => {
    const idle = html(<SaveStatus phase="idle" />);
    expect(idle).toContain('role="status"');
    expect(idle).toContain('aria-live="polite"');
    expect(idle).not.toContain("Saved");
    expect(html(<SaveStatus phase="saved" />)).toContain("Saved");
    expect(html(<SaveStatus phase="saving" />)).toContain("Saving…");
    expect(html(<SaveStatus phase="error" />)).toContain("Couldn&#x27;t save");
  });
});

describe("TaskPhase", () => {
  test("running with an unknown length slides and claims no percentage", () => {
    const out = html(<TaskPhase phase="running" label="Fix calls" />);
    expect(out).toContain("mo-fill-indeterminate");
    expect(out).not.toContain("aria-valuenow");
    expect(out).toContain("length unknown");
  });
  test("a known fraction scales on X; done is full and named", () => {
    const half = html(<TaskPhase phase="running" label="Fix calls" progress={0.5} />);
    expect(half).toContain("scaleX(0.5)");
    expect(half).toContain('aria-valuenow="50"');
    const done = html(<TaskPhase phase="done" label="Fix calls" />);
    expect(done).toContain("scaleX(1)");
    expect(done).toContain("Done");
  });
  test("queued and failed draw no bar", () => {
    expect(html(<TaskPhase phase="queued" label="x" />)).not.toContain("progressbar");
    expect(html(<TaskPhase phase="failed" label="x" />)).not.toContain("progressbar");
  });
});

describe("ConnectionState", () => {
  test("names the state in words", () => {
    expect(html(<ConnectionState state="live" />)).toContain("Live");
    expect(html(<ConnectionState state="reconnecting" />)).toContain("Reconnecting…");
    expect(html(<ConnectionState state="offline" />)).toContain("Offline");
  });
});

describe("DeviceStatusSlot", () => {
  test("This PC wins, then the label, then the id; offline and unknown are different words", () => {
    expect(deviceSlotView({ isThisPc: true, label: "Desk", online: true })).toEqual({ name: "This PC", state: "online", word: "Online" });
    expect(deviceSlotView({ label: "Studio laptop", online: false })).toEqual({ name: "Studio laptop", state: "offline", word: "Offline" });
    expect(deviceSlotView({ deviceId: "dev-7" })).toEqual({ name: "dev-7", state: "unknown", word: "Status not reported" });
    expect(deviceSlotView(null).name).toBeNull();
  });
  test("renders the slot, and says so when no device is reported", () => {
    const pc = html(<DeviceStatusSlot device={{ isThisPc: true, online: true }} />);
    expect(pc).toContain("This PC");
    expect(pc).toContain("Online");
    expect(html(<DeviceStatusSlot device={{ label: "Laptop", online: false }} />)).toContain("Offline");
    expect(html(<DeviceStatusSlot device={null} />)).toContain("No device reported");
    expect(html(<DeviceStatusSlot device={{ label: "Laptop" }} />)).toContain("Status not reported");
  });
  test("reads whichever optional fields a record has", () => {
    expect(deviceFromRecord({ targetDeviceId: "d1", deviceLabel: "Office", deviceOnline: true })).toEqual({ deviceId: "d1", label: "Office", isThisPc: null, online: true });
    expect(deviceFromRecord(undefined)).toEqual({ deviceId: null, label: null, isThisPc: null, online: null });
  });
});

describe("route text", () => {
  test("a page path in a sentence becomes a link target; other slashes stay text", () => {
    const parts = splitRoutes("Then review each call's flags on /receptionist. See https://example.test/leads and a/b.");
    expect(parts.filter((p) => p.to)).toEqual([{ text: "/receptionist", to: "/receptionist" }]);
    expect(parts.map((p) => p.text).join("")).toBe("Then review each call's flags on /receptionist. See https://example.test/leads and a/b.");
  });
  test("decision rows render their detail and progress through it", () => {
    expect(read("src/components/workspace/decision-row.tsx")).toContain("<RouteText>");
  });
});

describe("honest unknowns", () => {
  test("the calendar shows a dash, not 0, when no calendar is connected or imported", () => {
    const src = read("src/components/operator/calendar-workspace.tsx");
    expect(src).toContain("const hasSource =");
    expect(src).toContain("value={today && hasSource ? todayEvents.length : null}");
    expect(src).toContain("value={today && hasSource ? weekCount : null}");
  });
  test("the inbox does not call an unconnected inbox empty", () => {
    const src = read("src/components/operator/inbox-workspace.tsx");
    expect(src).toContain("Nothing to read yet.");
    expect(src).toContain("const anySource =");
  });
});
