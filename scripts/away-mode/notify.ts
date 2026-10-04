// Away mode's messages to his phone: `hermes send` to his own Telegram DM with @MnUJarvis_bot.
// Hermes reuses the gateway's own credentials, so this code never reads a token. The target is
// fixed to the owner's chat; nothing here can message anyone else. Sends are queued so they arrive
// in order, and a screenshot rides along as "caption MEDIA:<path>".
import { spawn } from "node:child_process";
import { hermesBinary } from "../inbox-triage/alerts";
import { readPeople } from "../remote-access";

export type Notice = { text: string; image?: string };
export type Notifier = (notice: Notice) => Promise<{ ok: boolean; detail: string }>;

/** The owner's Telegram user ID: people.json's owner, else the known default. */
export const DEFAULT_OWNER_TELEGRAM = "1000000001";

/** His Telegram user ID: the people.json person whose role says owner. (Moved here from service.ts in R9 so the
 *  host-alert CLI can use the same owner-only target without loading away mode; service.ts re-exports it.) */
export function ownerTelegram(root: string) {
  const owner = readPeople(root).find((p) => /\bowner\b/i.test(p.role ?? ""));
  const id = owner?.telegram?.find((t) => /^\d{5,15}$/.test(t));
  return id ?? DEFAULT_OWNER_TELEGRAM;
}

export function hermesNotifier(ownerChat: () => string, options: { binary?: string; timeoutMs?: number; launch?: typeof spawn } = {}): Notifier {
  let chain: Promise<unknown> = Promise.resolve();
  const sendOne = (notice: Notice) =>
    new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const chat = ownerChat();
      if (!/^\d{5,15}$/.test(chat)) return resolve({ ok: false, detail: "no owner chat" });
      // MEDIA:<path> must be a plain path with no spaces for Hermes to pick it up.
      const media = notice.image && !/\s/.test(notice.image) ? ` MEDIA:${notice.image}` : "";
      const body = `${notice.text.slice(0, 3500)}${media}`;
      let settled = false;
      const done = (value: { ok: boolean; detail: string }) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      try {
        const child = (options.launch ?? spawn)(options.binary ?? hermesBinary(), ["send", "--to", `telegram:${chat}`, "--quiet", "--file", "-"], {
          stdio: ["pipe", "ignore", "pipe"],
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        });
        let err = "";
        child.stderr?.on("data", (chunk) => {
          err = (err + String(chunk)).slice(-400);
        });
        const timer = setTimeout(() => {
          child.kill();
          done({ ok: false, detail: "hermes send timed out" });
        }, options.timeoutMs ?? 45_000);
        child.on("error", () => {
          clearTimeout(timer);
          done({ ok: false, detail: "hermes could not be started" });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done(code === 0 ? { ok: true, detail: "sent" } : { ok: false, detail: `hermes send exit ${code}: ${err.trim().split("\n").pop()?.slice(0, 160) ?? ""}` });
        });
        child.stdin?.end(body, "utf8");
      } catch {
        done({ ok: false, detail: "hermes could not be started" });
      }
    });
  return (notice) => {
    const next = chain.then(() => sendOne(notice));
    chain = next.catch(() => undefined);
    return next;
  };
}
