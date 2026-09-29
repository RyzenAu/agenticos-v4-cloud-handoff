import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Microphone ownership on this PC. Only one Jarvis voice process may hold the mic at a time;
 * the lock is a file holding the owner's pid. A lock left by a process that has exited is
 * taken over. Audio never leaves this PC — the companion only reports whether it owns the mic.
 */
export class MicLock {
  private held = false;

  constructor(readonly file: string, private readonly pid = process.pid) {}

  private alive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === this.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === "EPERM";
    }
  }

  /** Claim the mic. Returns true if this process now owns it. */
  claim(): boolean {
    if (this.held) return true;
    mkdirSync(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.file, "wx");
        writeSync(fd, String(this.pid));
        closeSync(fd);
        this.held = true;
        return true;
      } catch (error: any) {
        if (error?.code !== "EEXIST") return false;
        const owner = Number(readFileSync(this.file, "utf8").trim());
        if (owner === this.pid) return (this.held = true);
        if (this.alive(owner)) return false;
        try {
          unlinkSync(this.file); // stale lock from a process that has exited
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  /**
   * Does this process own the mic right now? Checked against the lock file itself, so a lock that was
   * removed or taken over by someone else reads false (and stops counting as held) instead of a stale true.
   */
  owned() {
    if (!this.held) return false;
    try {
      if (Number(readFileSync(this.file, "utf8").trim()) === this.pid) return true;
    } catch {
      /* the lock file is gone */
    }
    this.held = false;
    return false;
  }

  /** Who holds it now (pid), if anyone. */
  holder(): number | null {
    if (!existsSync(this.file)) return null;
    const pid = Number(readFileSync(this.file, "utf8").trim());
    return this.alive(pid) ? pid : null;
  }

  release() {
    if (!this.held) return;
    this.held = false;
    try {
      if (Number(readFileSync(this.file, "utf8").trim()) === this.pid) unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}
