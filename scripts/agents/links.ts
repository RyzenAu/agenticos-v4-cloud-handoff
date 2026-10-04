import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirFor } from "../cloud/data-dir";

/**
 * Which coding jobs a bot's conversation drafted or started, and the CRM records they are about.
 *
 * A computer job carries `bot` and `subjects` on the job record itself (scripts/jobs). A coding job lives in the coding store, whose spec is
 * digest-protected ("Start it" confirms exactly the plan that was shown), so the bot link is kept BESIDE it here rather than inside it.
 * References only: a job id, a bot id, CRM reference strings. Never the request text.
 */

export type CodingLink = { jobId: string; bot: string; personId: string; subjects: string[]; at: number; /** Who sent the job to the bot (round 10), as the controller recorded it. */ decision?: import("../jobs/types").JevDecisionRef };

export const linksFile = (root: string) => join(dataDirFor(root), "agents", "coding-links.json");
const MAX = 500;

export function createLinksStore(options: { file: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const load = (): CodingLink[] => {
    if (!existsSync(options.file)) return [];
    try {
      const v = JSON.parse(readFileSync(options.file, "utf8")) as { links?: CodingLink[] };
      return Array.isArray(v.links) ? v.links : [];
    } catch {
      return [];
    }
  };
  const write = (links: CodingLink[]) => {
    mkdirSync(dirname(options.file), { recursive: true });
    const tmp = `${options.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, links }), { mode: 0o600 });
      renameSync(tmp, options.file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  };
  return {
    /** Record (or refresh) a coding job's bot link. The first bot to claim a job keeps it. */
    note(link: Omit<CodingLink, "at">): CodingLink {
      const links = load();
      const have = links.find((l) => l.jobId === link.jobId);
      if (have) {
        const merged = [...new Set([...have.subjects, ...link.subjects])].slice(0, 8);
        if (merged.length !== have.subjects.length) {
          have.subjects = merged;
          write(links);
        }
        return have;
      }
      const row: CodingLink = { ...link, at: now() };
      links.push(row);
      write(links.slice(-MAX));
      return row;
    },
    get: (jobId: string): CodingLink | null => load().find((l) => l.jobId === jobId) ?? null,
    forBot: (bot: string): CodingLink[] => load().filter((l) => l.bot === bot),
  };
}
export type LinksStore = ReturnType<typeof createLinksStore>;
