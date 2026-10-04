// The "site_draft" voice tool: schema + client-side handler for "Jarvis, draft a website for
// <prospect>". Kept standalone (not imported into free-voice.ts / voice-companion.tsx by this
// change) so other engineers can wire it in on their own schedule — see docs/WEBSITE-DRAFTS.md for
// the exact lines to add and why this file isn't touching theirs directly.
export type Schema = { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
function fn(name: string, description: string, properties: Record<string, unknown> = {}, required = Object.keys(properties)) {
  const parameters: Schema = { type: "object", properties, required, additionalProperties: false };
  return { type: "function" as const, function: { name, description, parameters } };
}

/** Same tool-schema shape as freeVoiceTools() in scripts/free-voice.ts. */
export function siteDraftTool() {
  return fn(
    "site_draft",
    "Create a local website preview for a CRM lead. Dental previews use the selected flagship design. Never publishes or sends. Say the lead's name or CRM id.",
    { lead: { type: "string", description: "Lead name (as in the CRM) or numeric lead id" } },
  );
}

/**
 * Calls the local /__site-draft/draft endpoint (scripts/site-draft/plugin.ts) and returns a short,
 * spoken-friendly result. `token` is the same X-Claude-OS-Token the dashboard reads from GET
 * /__token — see operatorRequest in src/lib/operator.ts for the existing pattern this mirrors.
 */
export async function requestSiteDraft(
  args: Record<string, unknown>,
  deps: { fetch?: typeof fetch; token: string } ,
): Promise<string> {
  const request = deps.fetch ?? fetch;
  const lead = typeof args.lead === "string" ? args.lead.trim() : "";
  if (!lead) return "Tell me which lead — a name or CRM id.";
  try {
    const response = await request("/__site-draft/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Claude-OS-Token": deps.token },
      body: JSON.stringify({ lead }),
    });
    const result = await response.json();
    if (!response.ok) return `Couldn't draft that one: ${result.error || "unknown error"}.`;
    return `Draft ready for ${result.name}, sir — local preview at ${result.previewUrl}. Nothing's been sent or published.`;
  } catch {
    return "Couldn't reach the site-draft service. Check the OS dev server is running.";
  }
}
