/**
 * Seed (or check) the Dot gateway's SYNTHETIC staging data directory. Staging never uses production data, a copy of it, or
 * the CRM rehearsal instance (which was restored from a production backup).
 *
 *   bun scripts/gateway/seed-staging.ts seed  --data C:\mu-hub\data\dot-gateway-staging-synthetic
 *   bun scripts/gateway/seed-staging.ts check --data C:\mu-hub\data\dot-gateway-staging-synthetic
 *
 * `seed` refuses unless the folder is the designated synthetic one (its name ends in STAGING_DIR_NAME) and is new or empty.
 * It writes obviously fake records only ("Synthetic Dental Co" and friends, example.test addresses, 555 numbers), and a
 * marker file. `check` (the staging scripts run it before every start) refuses a folder that is not the designated one,
 * has no marker, or carries any sign of a production backup or restore.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const STAGING_DIR_NAME = "dot-gateway-staging-synthetic";
export const SYNTHETIC_MARKER = "SYNTHETIC-STAGING.json";
/** Left by scripts/cloud/backup.ts: a backup folder's manifest, and a restore's receipt. Either means real data. */
const PRODUCTION_SIGNS = ["manifest.json", ".restore-receipt.json"];

export function stagingProblems(dataDir: string, mode: "seed" | "check"): string[] {
  const dir = resolve(dataDir);
  const problems: string[] = [];
  if (basename(dir).toLowerCase() !== STAGING_DIR_NAME) problems.push(`the staging data folder must be named ${STAGING_DIR_NAME} (got ${basename(dir)})`);
  if (/production|crm-rehearsal|backup/i.test(dir)) problems.push("the path names production, a backup or the CRM rehearsal");
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  for (const sign of PRODUCTION_SIGNS) if (entries.includes(sign)) problems.push(`${sign} is present: this folder holds a backup or a restore of real data`);
  if (mode === "seed" && entries.length > 0) problems.push("the folder is not empty (seed only into a new, empty folder)");
  if (mode === "check") {
    try {
      const marker = JSON.parse(readFileSync(join(dir, SYNTHETIC_MARKER), "utf8")) as { synthetic?: boolean };
      if (marker.synthetic !== true) problems.push(`${SYNTHETIC_MARKER} does not say synthetic`);
    } catch {
      problems.push(`${SYNTHETIC_MARKER} is missing: seed the folder first`);
    }
  }
  return problems;
}

const LEADS = [
  { name: "Synthetic Dental Co", vertical: "dental", area: "Testville NSW", phone: "0255501001", website: "https://synthetic-dental.example.test" },
  { name: "Example Smiles Pty Ltd (synthetic)", vertical: "dental", area: "Sampleton NSW", phone: "0255501002", website: "" },
  { name: "Placeholder Conveyancing (synthetic)", vertical: "legal", area: "Mockford NSW", phone: "0255501003", website: "https://placeholder-conveyancing.example.test" },
  { name: "Fictional Realty Group (synthetic)", vertical: "real-estate", area: "Dummyburg NSW", phone: "0255501004", website: "" },
  { name: "Test Pattern Dental Clinic (synthetic)", vertical: "dental", area: "Testville NSW", phone: "0255501005", website: "https://test-pattern.example.test" },
] as const;

export async function seed(dataDir: string): Promise<string[]> {
  const dir = resolve(dataDir);
  const problems = stagingProblems(dir, "seed");
  if (problems.length) throw new Error(`Refusing to seed: ${problems.join("; ")}`);
  mkdirSync(dir, { recursive: true });
  // Every store below resolves its folder from MU_DATA_DIR at call time.
  process.env.MU_DATA_DIR = dir;
  const done: string[] = [];
  const root = resolve(import.meta.dir, "..", "..");

  // People: the two founder ids the OS knows, with synthetic logins that no real tailnet account has.
  writeFileSync(join(dir, "people.json"), JSON.stringify({ people: [{ name: "Usman", role: "owner", tailscale: ["staging-founder-a@example.test"] }, { name: "Mehroz", role: "co-founder", tailscale: ["staging-founder-b@example.test"] }] }, null, 2));
  done.push("people.json (synthetic logins)");

  // CRM leads and a note on each, through the CRM's own functions.
  const crm = await import("../leads/crm");
  const db = crm.openCrm(crm.crmPath(root));
  try {
    for (const [i, l] of LEADS.entries()) {
      const lead = crm.upsertLead(db, {
        placeId: `synthetic-${i + 1}`,
        name: l.name,
        vertical: l.vertical as never,
        area: l.area,
        address: `${i + 1} Synthetic Street, ${l.area}`,
        phone: l.phone,
        website: l.website,
        mapsUrl: "",
        rating: null,
        reviews: null,
        googleAt: null,
        emails: [`hello+${i + 1}@example.test`],
        emailOk: false,
        score: 50 + i,
        pitch: "website",
        reasons: ["synthetic staging record"],
        // Not "google" or "osm": a synthetic row must never look like a directory import.
        source: "manual" as never,
        attribution: "synthetic staging data",
      } as never) as unknown as { id: number };
      const row = crm.findLead(db, `synthetic-${i + 1}`);
      if (row) crm.logActivity(db, row, { kind: "note", note: "Synthetic staging note: not a real business.", by: "usman", eventId: `synthetic-seed-${i + 1}` });
      void lead;
    }
  } finally {
    db.close();
  }
  done.push(`crm.sqlite: ${LEADS.length} synthetic leads with a note each`);

  // Bots: the bot store writes its own two default bots (Research, Builder) the first time it is read.
  const bots = await import("../agents/store");
  const store = bots.createBotStore({ file: bots.botsFile(root) });
  done.push(`agents/bots.json: ${store.list().length} default bots`);

  // One conversation with a bot, owned by a founder id.
  const { conversationStore } = await import("../conversations");
  const thread = conversationStore(root).ensureThread({ personId: "usman", bot: "research", title: "Synthetic staging conversation" });
  done.push(`conversations.json: ${thread ? "one synthetic bot conversation" : "no conversation (the store refused)"}`);

  writeFileSync(join(dir, SYNTHETIC_MARKER), JSON.stringify({ synthetic: true, seededAt: new Date().toISOString(), by: "scripts/gateway/seed-staging.ts", note: "Synthetic staging data for the Dot gateway. Never production, never a copy of it." }, null, 2));
  done.push(SYNTHETIC_MARKER);
  return done;
}

if (import.meta.main) {
  const [mode, flag, value] = process.argv.slice(2);
  if ((mode !== "seed" && mode !== "check") || flag !== "--data" || !value) {
    console.error("usage: bun scripts/gateway/seed-staging.ts seed|check --data <...\\" + STAGING_DIR_NAME + ">");
    process.exit(2);
  }
  if (mode === "check") {
    const problems = stagingProblems(value, "check");
    if (problems.length) {
      console.error(`NOT a synthetic staging folder: ${problems.join("; ")}`);
      process.exit(1);
    }
    console.log("synthetic staging folder: ok");
  } else {
    seed(value)
      .then((done) => {
        for (const line of done) console.log(`seeded ${line}`);
      })
      .catch((error: Error) => {
        console.error(error.message);
        process.exit(1);
      });
  }
}
