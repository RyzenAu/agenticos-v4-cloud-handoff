#!/usr/bin/env bun
// Meeting-mode coaching from the command line — what Hermes' `mu-call-coach` skill runs, so
// Telegram gets exactly the same notes, coaching and CRM update as meeting mode in the OS.
// Nothing here listens to or records anything, and nothing is ever sent.
//
//   bun scripts/meeting-mode/cli.ts debrief --text "spoke to Sarah, practice manager…" [--lead 12] [--by usman]
//                                  (--text - reads the debrief from stdin: pasted notes or a
//                                  transcribed voice-note debrief, in his own words)
//   bun scripts/meeting-mode/cli.ts granola [--query "Smile Dental"] [--lead 12] [--by usman]
//                                  coach the latest (or matching) Granola meeting from this week
//   bun scripts/meeting-mode/cli.ts last            the latest call's notes (Markdown)
//   bun scripts/meeting-mode/cli.ts notes <id>      one call's notes
//   bun scripts/meeting-mode/cli.ts list            recent calls with scores
//   bun scripts/meeting-mode/cli.ts consents        the consent log (no audio is ever stored)
// Add --json for machine output.
import { resolve } from "node:path";
import { connectedGranolaNotes } from "../granola-connected";
import { granolaApi } from "../granola-api";
import { renderNotes } from "./coach";
import { meetingService } from "./service";

const ROOT = resolve(import.meta.dir, "..", "..");

function args(argv: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next !== "-")) flags[a.slice(2)] = "true";
      else (flags[a.slice(2)] = next), i++;
    } else rest.push(a);
  }
  return { flags, rest };
}

async function recentGranola() {
  try {
    return await connectedGranolaNotes(ROOT);
  } catch (connectedError) {
    const api = granolaApi(ROOT);
    if (api.configured()) return api.notes();
    throw new Error(`Granola isn't reachable: ${(connectedError as Error).message}`);
  }
}

async function main() {
  const [command = "help", ...argv] = process.argv.slice(2);
  const { flags, rest } = args(argv);
  const json = flags.json === "true";
  const service = meetingService(ROOT, { recentGranola });
  const print = (value: unknown, text: string) => console.log(json ? JSON.stringify(value, null, 2) : text);
  try {
    switch (command) {
      case "debrief": {
        const text = flags.text === "-" ? await new Response(Bun.stdin.stream()).text() : flags.text ?? rest.join(" ");
        const out = await service.meeting.debrief({ text, lead: flags.lead ?? null, by: flags.by });
        print(out.notes, out.markdown);
        break;
      }
      case "granola": {
        const out = await service.meeting.granola({ query: flags.query ?? rest.join(" "), lead: flags.lead ?? null, by: flags.by });
        print(out.notes, out.markdown);
        break;
      }
      case "last": {
        const [latest] = service.store.list(1);
        print(latest ?? null, latest ? renderNotes(latest) : "No call notes yet.");
        break;
      }
      case "notes": {
        const notes = service.store.notes(rest[0] ?? "");
        if (!notes) throw new Error("No notes with that id.");
        print(notes, renderNotes(notes));
        break;
      }
      case "list": {
        const all = service.store.list(20);
        print(all, all.length ? all.map((n) => `${n.id} · ${n.at.slice(0, 10)} · ${n.source} · ${n.coaching.score}/100 · ${n.title}`).join("\n") : "No call notes yet.");
        break;
      }
      case "consents": {
        const all = service.store.consents().slice(-20);
        print(all, all.length ? all.map((c) => `${c.at} · ${c.answer} · ${c.lead ? `#${c.lead.id} ${c.lead.name}` : c.leadRef || "no lead"} · "${c.confirmation}" (${c.channel})`).join("\n") : "No consent answers logged.");
        break;
      }
      default:
        console.log("Commands: debrief, granola, last, notes <id>, list, consents. See the header of scripts/meeting-mode/cli.ts.");
    }
  } finally {
    service.close();
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
