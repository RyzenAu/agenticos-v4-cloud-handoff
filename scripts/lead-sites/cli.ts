// Founder-triggered lead previews from the flagship templates. Never bulk: every command takes one
// lead, and deploy needs the exact domain typed back as confirmation.
//
//   bun scripts/lead-sites/cli.ts templates [dental|legal|real-estate …] [--build-root D:\mu-lead-site-builds]
//                                         build the per-vertical templates (once; dental/real estate run next build)
//   bun scripts/lead-sites/cli.ts generate <lead> [--by usman]              fill the template for one lead (local only)
//   bun scripts/lead-sites/cli.ts deploy <lead> --confirm <slug>.muventures.com.au --by usman
//   bun scripts/lead-sites/cli.ts takedown <lead> --by usman                remove the Vercel project + subdomain
//   bun scripts/lead-sites/cli.ts list                                      every preview, with its expiry state
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crmPath, openCrm } from "../leads/crm";
import { defaultDraftsRoot } from "../site-draft/orchestrator";
import { deployPreview, takeDownPreview } from "./deploy";
import { generatePreview } from "./generate";
import { readRegistry, withExpiry } from "./registry";
import { buildNextTemplate, DEFAULT_BUILD_ROOT } from "./next-templates";
import { buildTemplate, VERTICALS, type Vertical } from "./templates";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const draftsRoot = flag(args, "drafts") ?? defaultDraftsRoot();
  if (command === "templates") {
    const wanted = (args.filter((a) => !a.startsWith("--") && VERTICALS.includes(a as Vertical)) as Vertical[]);
    for (const v of wanted.length ? wanted : VERTICALS) {
      // Legal is a static site (copied); dental and real estate are Next.js flagships, built as a
      // static export WITH their client JS so the motion, menus and reveals keep working.
      const { dir, manifest } = v === "legal"
        ? await buildTemplate(v, draftsRoot)
        : await buildNextTemplate(v, draftsRoot, flag(args, "build-root") ?? DEFAULT_BUILD_ROOT, (line) => console.log(`  ${v}: ${line}`));
      console.log(`${v}: ${dir} (from ${manifest.flagship}; tokens ${manifest.tokens.join(", ")})`);
    }
    return;
  }
  if (command === "list") {
    for (const p of readRegistry(ROOT).map((r) => withExpiry(r))) {
      const state = p.status === "live" ? (p.expired ? "EXPIRED — take it down" : `live, ${p.daysLeft} day(s) left`) : p.status.replace("_", " ");
      console.log(`#${p.leadId} ${p.business} — ${p.url} — ${state}`);
    }
    return;
  }
  const ref = args.find((a) => !a.startsWith("--") && a !== flag(args, "by") && a !== flag(args, "confirm") && a !== flag(args, "drafts"));
  if (!ref) throw new Error("Say which lead (name or CRM id).");
  const by = flag(args, "by") ?? "";
  const db = openCrm(crmPath(ROOT));
  try {
    if (command === "generate") {
      const r = await generatePreview(db, /^\d+$/.test(ref) ? Number(ref) : ref, { root: ROOT, draftsRoot, by: by || "cli" });
      console.log(`Generated ${r.dir}\n  would deploy to ${r.record.url}\n  services: ${r.facts.services.length}; placeholders: ${r.missing.join(", ")}`);
      return;
    }
    const id = /^\d+$/.test(ref) ? Number(ref) : NaN;
    if (!Number.isFinite(id)) throw new Error("deploy/takedown take the CRM id.");
    if (command === "deploy") {
      const confirm = flag(args, "confirm");
      if (!confirm) throw new Error("Pass --confirm <slug>.muventures.com.au to deploy.");
      const r = await deployPreview(db, id, { root: ROOT, confirm, by });
      console.log(`${r.url} — ${r.status}; live check ${JSON.stringify(r.verified)}; expires ${r.expiresAt}${r.lastError ? `\n  ${r.lastError}` : ""}`);
      return;
    }
    if (command === "takedown") {
      const r = await takeDownPreview(db, id, { root: ROOT, by });
      console.log(`${r.url} — taken down ${r.takenDownAt}`);
      return;
    }
    throw new Error(`Unknown command "${command}".`);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
