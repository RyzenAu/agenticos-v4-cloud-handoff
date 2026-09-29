// System info: battery, CPU, memory, disk space, local IP and "is the internet working". Node's os
// and fs do most of it; only the battery needs Windows (one CIM query on the warm helper).
// Read-only: nothing here changes a setting.
import { cpus, freemem, networkInterfaces, totalmem } from "node:os";
import { existsSync, statfsSync } from "node:fs";
import { norm } from "./text";
import type { PsHost } from "./ps-host";

export type SystemAction = "battery" | "cpu" | "memory" | "cpu_memory" | "disk" | "ip" | "internet";
export type SystemRequest = { skill: "system"; action: SystemAction };

export function systemIntent(utterance: string): SystemRequest | null {
  const u = norm(utterance).replace(/\bwhat's\b/g, "what is").replace(/\bhow's\b/g, "how is");
  if (u.length > 80) return null;
  const q = (action: SystemAction): SystemRequest => ({ skill: "system", action });
  if (/^(?:(?:what is |what's |check |how is |how much )?(?:my |the )?battery(?: level| life| percentage| status| charge| at| left)?|how much (?:battery|charge) (?:have i got|do i have|is left)(?: left)?|am i (?:charging|on battery))$/.test(u)) return q("battery");
  if (/^(?:(?:what is |check |show )?(?:my |the )?)?(?:cpu|processor) and (?:memory|ram)(?: usage)?$|^(?:what is |check )?(?:my |the )?(?:memory|ram) and (?:cpu|processor)(?: usage)?$|^how (?:is|are) (?:my |the )?(?:pc|computer|system)(?: doing| holding up| running)?$|^system (?:load|usage|resources)$/.test(u)) return q("cpu_memory");
  if (/^(?:(?:what is |check |show )?(?:my |the )?(?:cpu|processor)(?: usage| load| use)?(?: at)?|how (?:busy|hard) is (?:my |the )?(?:cpu|processor|pc|computer)(?: working)?)$/.test(u)) return q("cpu");
  // Plain "memory" is the OS's Memory page, so the word alone isn't enough here.
  if (/^(?:(?:what is |check |show )?(?:my |the )?(?:(?:memory|ram) (?:usage|use|load)|ram)|how much (?:memory|ram) (?:am i using|is (?:free|used|left)|have i got(?: left)?|do i have(?: left)?))$/.test(u)) return q("memory");
  if (/^(?:(?:what is |check |show )?(?:my |the )?(?:disk|drive|storage|hard drive|ssd) (?:space|usage|left)|how much (?:disk |drive |storage )?space (?:have i got|do i have|is (?:left|free))(?: left)?(?: on (?:my |the )?(?:pc|computer|drives?|disks?|c drive))?|how full (?:is|are) (?:my |the )?(?:disks?|drives?|ssd|hard drive|c drive)|free (?:disk |drive )?space|how much (?:free |spare )?(?:disk |drive |storage )?space (?:is |do i have |have i got )?(?:left |free )?on (?:my |the )?(?:c|d|e)?(?: drive|:)?|how much (?:free |spare )?(?:space|room) is (?:there |left )?on (?:my |the )?(?:c |d |e )?(?:drive|disk|ssd|pc|computer))$/.test(u)) return q("disk");
  if (/^(?:what is |tell me )?(?:my |the )?(?:local |lan |internal )?ip(?: address)?(?: here)?$|^what is (?:my |the )?(?:local |lan |internal )?ip(?: address)?$/.test(u)) return q("ip");
  if (/^(?:is (?:the |my )?(?:internet|wi ?fi|connection|network)(?: connection)? (?:working|up|down|ok|okay|on)|am i (?:online|connected)(?: to the internet)?|are we (?:online|connected)|(?:check|test) (?:the |my )?(?:internet|connection|network)(?: connection)?|do (?:i|we) have (?:internet|a connection)|is the net (?:working|up|down))$/.test(u)) return q("internet");
  return null;
}

const gb = (bytes: number) => bytes / 1024 ** 3;
const size = (bytes: number) => {
  const g = gb(bytes);
  return g >= 1000 ? `${(g / 1024).toFixed(1).replace(/\.0$/, "")} terabytes` : `${g >= 100 ? Math.round(g) : g.toFixed(1).replace(/\.0$/, "")} gigabytes`;
};

/** CPU busy share over a short sample (os.loadavg is always 0 on Windows). */
export async function cpuPercent(sampleMs = 150, read: typeof cpus = cpus) {
  const snap = () => read().reduce((acc, c) => ({ idle: acc.idle + c.times.idle, total: acc.total + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }), { idle: 0, total: 0 });
  const a = snap();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / total)) : 0;
}

export function memoryLine(total = totalmem(), free = freemem()) {
  const used = total - free;
  return `memory is ${Math.round((100 * used) / total)}% used, ${size(used)} of ${size(total)}`;
}

/** The LAN address people would use, not the VPN, WSL or VMware adapters. */
export function localAddress(interfaces = networkInterfaces()) {
  const virtual = /vethernet|vmware|virtualbox|hyper-v|wsl|loopback|tailscale|zerotier|bluetooth|docker|vpn/i;
  const rows = Object.entries(interfaces).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")).map((a) => ({ name, address: a.address })),
  );
  const real = rows.filter((r) => !virtual.test(r.name));
  const pick = real.find((r) => /^(?:ethernet|wi-?fi|wlan|en|eth)/i.test(r.name)) ?? real[0] ?? null;
  const tailscale = rows.find((r) => /tailscale/i.test(r.name)) ?? null;
  return { pick, tailscale };
}

export function diskLines(drives = ["C", "D", "E", "F", "G", "H"], stat = statfsSync, exists = existsSync) {
  const lines: string[] = [];
  for (const letter of drives) {
    const root = `${letter}:\\`;
    if (!exists(root)) continue;
    try {
      const s = stat(root);
      const total = Number(s.blocks) * Number(s.bsize),
        free = Number(s.bavail) * Number(s.bsize);
      if (!total) continue;
      const low = free / total < 0.1;
      lines.push(`${letter} drive has ${size(free)} free of ${size(total)}${low ? ", which is getting tight" : ""}`);
    } catch {
      /* a card reader with no card, a disconnected network drive */
    }
  }
  return lines;
}

export async function internetLine(request: typeof fetch = fetch) {
  const probe = async (url: string) => {
    const started = Date.now();
    try {
      const response = await request(url, { method: "GET", signal: AbortSignal.timeout(2500), cache: "no-store" } as RequestInit);
      await response.arrayBuffer().catch(() => undefined);
      return response.status < 500 ? Date.now() - started : null;
    } catch {
      return null;
    }
  };
  const [named, bare] = await Promise.all([probe("https://www.gstatic.com/generate_204"), probe("https://1.1.1.1/cdn-cgi/trace")]);
  if (named !== null) return `Yes, sir, the internet's working. Google answered in ${named} milliseconds.`;
  if (bare !== null) return "Partly, sir: I can reach Cloudflare by address but names aren't resolving, so it looks like a DNS problem.";
  return "No, sir, I can't reach the internet from here. Neither Google nor Cloudflare answered.";
}

export async function batteryLine(ps: PsHost) {
  const out = (
    await ps.run(
      "$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; if ($b) { '' + $b.EstimatedChargeRemaining + '|' + $b.BatteryStatus + '|' + $b.EstimatedRunTime } else { 'NONE' }",
      8000,
    )
  ).trim();
  if (out.startsWith("ERROR")) return "I couldn't read the battery just now, sir.";
  if (out === "NONE" || !out) return "This PC hasn't got a battery, sir. It's on mains power.";
  const [charge, status, minutes] = out.split("|").map(Number);
  const charging = [2, 6, 7, 8, 9, 11].includes(status);
  const runtime = !charging && minutes > 0 && minutes < 71582 ? `, about ${minutes >= 60 ? `${Math.floor(minutes / 60)} hours ${minutes % 60} minutes` : `${minutes} minutes`} left` : "";
  return `The battery's at ${charge}%${charging ? " and charging" : runtime}, sir.`;
}

export async function answerSystem(req: SystemRequest, deps: { ps: PsHost; fetch?: typeof fetch }) {
  switch (req.action) {
    case "battery":
      return batteryLine(deps.ps);
    case "cpu":
      return `The CPU's at ${await cpuPercent()}%, sir.`;
    case "memory":
      return `${memoryLine().replace(/^m/, "M")}, sir.`;
    case "cpu_memory": {
      const cpu = await cpuPercent();
      return `CPU's at ${cpu}% and ${memoryLine()}${cpu > 85 ? ". She's working hard" : ""}, sir.`;
    }
    case "disk": {
      const lines = diskLines();
      return lines.length ? `${lines.join("; ")}, sir.`.replace(/^./, (c) => c.toUpperCase()) : "I couldn't read any drives, sir.";
    }
    case "ip": {
      const { pick } = localAddress();
      return pick ? `Your local address is ${pick.address}, on ${pick.name}, sir.` : "I can't see a local network address, sir. You may be offline.";
    }
    case "internet":
      return internetLine(deps.fetch);
  }
}
