// Unpack a design-system zip for POST /__design_system (T8b, review T8 S-6).
//
// argv-form unzip, never a shell string built from paths. tar.exe ships on Windows 10+ and reads zips;
// unzip does not exist there, so its ENOENT would be the message the user saw. Each attempt runs as an
// async child with a 60 s limit (the whole process tree is stopped on timeout): as execFileSync, an
// Expand-Archive of a large export held every other request for up to a minute.
import { runCapture, type CaptureResult } from "./nonblocking-exec";

export type Runner = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<CaptureResult>;

export function unpackChain(zipPath: string, unpackDir: string, isWindows = process.platform === "win32"): Array<[string, string[]]> {
  const psQuote = (v: string) => v.replace(/'/g, "''");
  return [
    ["tar", ["-xf", zipPath, "-C", unpackDir]],
    isWindows
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${psQuote(zipPath)}' -DestinationPath '${psQuote(unpackDir)}' -Force`]]
      : ["unzip", ["-o", "-q", zipPath, "-d", unpackDir]],
  ];
}

/** Tries each unpacker in turn; resolves when one succeeds, rejects with every attempt's reason otherwise. */
export async function unpackArchive(zipPath: string, unpackDir: string, options: { isWindows?: boolean; run?: Runner } = {}): Promise<void> {
  const run = options.run ?? ((file, args, o) => runCapture(file, args, o));
  const attempts: string[] = [];
  for (const [bin, args] of unpackChain(zipPath, unpackDir, options.isWindows)) {
    const r = await run(bin, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status === 0) return;
    const code = (r.error as NodeJS.ErrnoException | null)?.code;
    attempts.push(`${bin}: ${code === "ENOENT" ? "not installed" : String(r.error?.message ?? `exited ${r.status}`).slice(0, 120)}`);
  }
  throw new Error(`Could not unpack the zip — ${attempts.join("; ")}`);
}
