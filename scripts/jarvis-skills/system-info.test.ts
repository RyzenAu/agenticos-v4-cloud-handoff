import { describe, expect, test } from "bun:test";
import { batteryLine, cpuPercent, diskLines, internetLine, localAddress, memoryLine, systemIntent } from "./system-info";
import type { PsHost } from "./ps-host";

const fakePs = (out: string): PsHost => ({ run: async () => out, close: () => undefined, warm: () => undefined });

describe("system info phrases", () => {
  test("each question", () => {
    const action = (p: string) => systemIntent(p)?.action;
    expect(action("battery level")).toBe("battery");
    expect(action("how's my battery")).toBe("battery");
    expect(action("CPU usage")).toBe("cpu");
    expect(action("how busy is my CPU")).toBe("cpu");
    expect(action("memory usage")).toBe("memory");
    expect(action("how much RAM am I using")).toBe("memory");
    expect(action("CPU and memory usage")).toBe("cpu_memory");
    expect(action("how's my PC doing")).toBe("cpu_memory");
    expect(action("disk space")).toBe("disk");
    expect(action("how much space have I got left")).toBe("disk");
    expect(action("what's my IP")).toBe("ip");
    expect(action("what is my local IP address")).toBe("ip");
    expect(action("is the internet working")).toBe("internet");
    expect(action("am I online")).toBe("internet");
  });
  test("not system questions", () => {
    for (const phrase of ["memory", "show my memory", "search memory for Brooke", "what's my public IP", "status", "open task manager", "is the website working", "battery powered drills"])
      expect(systemIntent(phrase)).toBeNull();
  });
});

describe("readings", () => {
  test("battery: none, charging, discharging, error", async () => {
    expect(await batteryLine(fakePs("NONE"))).toBe("This PC hasn't got a battery, sir. It's on mains power.");
    expect(await batteryLine(fakePs("76|2|71582788"))).toBe("The battery's at 76% and charging, sir.");
    expect(await batteryLine(fakePs("40|1|95"))).toBe("The battery's at 40%, about 1 hours 35 minutes left, sir.");
    expect(await batteryLine(fakePs("ERROR: boom"))).toBe("I couldn't read the battery just now, sir.");
  });
  test("CPU from two samples", async () => {
    let call = 0;
    const read = () => {
      call++;
      const busy = call === 1 ? 0 : 300;
      const idle = call === 1 ? 0 : 700;
      return [{ model: "x", speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
    };
    expect(await cpuPercent(1, read as any)).toBe(30);
  });
  test("memory, drives, address", () => {
    expect(memoryLine(32 * 1024 ** 3, 12 * 1024 ** 3)).toBe("memory is 63% used, 20 gigabytes of 32 gigabytes");
    const stat = ((root: string) => ({ blocks: 1000, bsize: root.startsWith("C") ? 500 * 1024 ** 2 : 2 * 1024 ** 3, bavail: root.startsWith("C") ? 26 : 900 })) as any;
    expect(diskLines(["C", "D", "Z"], stat, (p: any) => !String(p).startsWith("Z"))).toEqual([
      "C drive has 12.7 gigabytes free of 488 gigabytes, which is getting tight",
      "D drive has 1.8 terabytes free of 2 terabytes",
    ]);
    const nets: any = {
      "vEthernet (WSL)": [{ family: "IPv4", internal: false, address: "172.20.0.1" }],
      Tailscale: [{ family: "IPv4", internal: false, address: "100.64.0.2" }],
      "Ethernet 2": [{ family: "IPv4", internal: false, address: "192.168.1.23" }, { family: "IPv6", internal: false, address: "fe80::1" }],
    };
    expect(localAddress(nets).pick).toEqual({ name: "Ethernet 2", address: "192.168.1.23" });
    expect(localAddress(nets).tailscale?.address).toBe("100.64.0.2");
  });
  test("internet: up, DNS broken, down", async () => {
    const up = (async () => new Response("", { status: 204 })) as unknown as typeof fetch;
    expect(await internetLine(up)).toMatch(/^Yes, sir, the internet's working\. Google answered in \d+ milliseconds\.$/);
    const dns = (async (url: string) => {
      if (url.includes("gstatic")) throw new Error("ENOTFOUND");
      return new Response("ok");
    }) as unknown as typeof fetch;
    expect(await internetLine(dns)).toContain("DNS problem");
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await internetLine(down)).toContain("can't reach the internet");
  });
});
