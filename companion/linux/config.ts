import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ComputerConfig = {
  name: string;
  hubUrl: string;
  deviceId: string;
  token: string;
  expiresAt: number;
  pairedAt: number;
  label: string;
  display: string;
  resolution: string;
  vncPort: number;
  workdir: string;
  profileDir: string;
  browserPort: number;
};

export function checkComputerHubUrl(value: string): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "That is not a web address." };
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const tailnetIp = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host);
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  const privateIp = !!m && (Number(m[1]) === 10 || (Number(m[1]) === 172 && Number(m[2]) >= 16 && Number(m[2]) <= 31) || (Number(m[1]) === 192 && Number(m[2]) === 168));
  if (url.username || url.password) return { ok: false, reason: "No credentials in the address." };
  if (host.endsWith(".ts.net") && url.protocol === "https:") return { ok: true, url: url.origin };
  if ((loopback || tailnetIp || privateIp) && (url.protocol === "http:" || url.protocol === "https:")) return { ok: true, url: url.origin };
  return { ok: false, reason: "A computer only connects to the hub on the same host, over the tailnet, or through the host's private bridge." };
}

const configPath = (dir: string) => join(dir, "computer.json");

export function readComputerConfig(dir: string): ComputerConfig | null {
  try {
    const c = JSON.parse(readFileSync(configPath(dir), "utf8"));
    return typeof c?.hubUrl === "string" && typeof c?.token === "string" && typeof c?.deviceId === "string" && typeof c?.name === "string" ? (c as ComputerConfig) : null;
  } catch {
    return null;
  }
}

export function writeComputerConfig(dir: string, config: ComputerConfig) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${configPath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, configPath(dir));
}

