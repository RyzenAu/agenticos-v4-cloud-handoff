// Design studio -> social platforms (Blotato): what /__design_publish does, out of vite.config.ts so it can be tested with a fake
// Blotato (a test must NEVER reach a real platform) and so the server role can put a B2 approval in front of it.
//
//   pc / cloud role      unchanged: one POST prepares, uploads the slides and posts, exactly as it always did.
//   MU_HUB_ROLE=server   nobody sits at the hub, so a founder publishes from his own browser, and EVERY caller (the owner at the
//                        console included) goes through scripts/approvals/gated-action.ts:
//                          ask  POST { carouselId, platforms, caption }                -> 202 { approval }  (nothing is posted)
//                          run  POST { carouselId, platforms, caption, approvalId }   -> upload + post, once
//                        The approval (B2 action `content.publish`) is bound to a digest of EXACTLY what would be posted: the
//                        caption text, a hash of every slide's bytes, and the Blotato account each platform resolves to. The run
//                        re-derives it from the live deck and the live account list, so editing the deck, changing the caption or
//                        re-pointing an account after approval voids the approval (digest-mismatch) instead of posting something
//                        nobody approved. The bytes hashed are the bytes uploaded.
//
// Nothing here decides who may approve (B2) or who may call (the identity gate); it only reads the principal the gate derived.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ApprovalService } from "./approvals/service";
import type { Principal } from "./approvals/principal";
import { askGated, runGated, type GatedNotify } from "./approvals/gated-action";

export const DESIGN_PUBLISH_ACTION = "content.publish";
export const BLOTATO_API = "https://backend.blotato.com/v2";

export type BlotatoResult = { status: number; ok: boolean; json: any; body: string };
/** One Blotato HTTP call. The real one talks to backend.blotato.com; tests and the harness inject a fake. */
export type BlotatoFetch = (key: string, path: string, init?: RequestInit) => Promise<BlotatoResult>;

export const blotatoFetch: BlotatoFetch = async (key, path, init) => {
  const r = await fetch(`${BLOTATO_API}${path}`, {
    ...init,
    headers: { "blotato-api-key": key, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* non-JSON error body */
  }
  return { status: r.status, ok: r.ok, json, body };
};

export type DesignPublishDeps = {
  /** The stored Blotato key (never read here beyond handing it to `blotato`), or null when none is connected. */
  blotatoKey: () => string | null;
  readCarousels: () => any[];
  blotato?: BlotatoFetch;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => Buffer;
};

export type DesignPublishReply = { status: number; body: Record<string, unknown> };

type Account = { id: string; platform: string; label: string };
/** Everything a post would carry, read ONCE: the digest and the upload use these same bytes. */
export type DesignPlan = {
  key: string;
  carouselId: string;
  name: string;
  caption: string;
  platforms: string[];
  files: Array<{ sha: string; bytes: Buffer }>;
  /** Per requested platform: the Blotato account it would post as, or null when none is connected. */
  targets: Array<{ platform: string; account: Account | null }>;
};

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const platformKey = (p: string) => p.trim().toLowerCase();
const accountLabel = (a: any) => String(a?.username ?? a?.fullname ?? a?.name ?? a?.handle ?? a?.id ?? "").slice(0, 60);

/** What the approval is bound to. Platforms are sorted and de-duplicated: the order of the tick boxes is not content. */
export function designArgs(plan: Pick<DesignPlan, "carouselId" | "caption" | "files" | "targets">) {
  const targets = plan.targets.map((t) => ({ platform: platformKey(t.platform), account: t.account?.id ?? null })).sort((a, b) => a.platform.localeCompare(b.platform));
  return { carouselId: plan.carouselId, text: plan.caption, media: plan.files.map((f) => f.sha), targets };
}

export function designSummary(plan: DesignPlan, by: string): string {
  const where = plan.targets.map((t) => (t.account ? `${t.platform}${t.account.label ? ` (${t.account.label})` : ""}` : `${t.platform} (no account connected, skipped)`)).join(", ");
  const caption = plan.caption.length > 70 ? `${plan.caption.slice(0, 67)}...` : plan.caption;
  return `Post the carousel "${plan.name}" (${plan.files.length} slide${plan.files.length === 1 ? "" : "s"}, caption "${caption}") to ${where} through Blotato. Asked by ${by}.`;
}

export const designResource = (carouselId: string) => `design-publish:${carouselId}`;

/**
 * Stage 1 to 3 of the old handler, unchanged in order and wording: the request, the key, the deck, its finished renders, who is
 * connected. Read only: nothing is uploaded or posted here. Returns the plan, or the answer to send.
 */
export async function prepareDesignPublish(parsed: any, deps: DesignPublishDeps): Promise<{ plan: DesignPlan } | { reply: DesignPublishReply }> {
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p));
  const blotato = deps.blotato ?? blotatoFetch;
  const carouselId = String(parsed?.carouselId ?? "");
  const platforms: string[] = Array.isArray(parsed?.platforms) ? parsed.platforms.map(String) : [];
  const caption = typeof parsed?.caption === "string" ? parsed.caption : "";
  if (!carouselId || !platforms.length) return { reply: { status: 400, body: { ok: false, error: "expected { carouselId, platforms }" } } };
  const key = deps.blotatoKey();
  if (!key) return { reply: { status: 428, body: { ok: false, stage: "key", error: "no Blotato key connected" } } };
  const doc: any = deps.readCarousels().find((c) => c?.id === carouselId);
  if (!doc) return { reply: { status: 404, body: { ok: false, error: "carousel not found" } } };
  const slides: any[] = Array.isArray(doc.slides) ? doc.slides : [];
  const renders: string[] = slides.map((s) => s?.render).filter((r) => typeof r === "string" && fileExists(r as string));
  if (renders.length !== slides.length || !renders.length)
    return { reply: { status: 409, body: { ok: false, stage: "render", error: "this deck's type is still live HTML — no finished renders to post yet" } } };
  const accounts = await blotato(key, "/users/me/accounts");
  if (!accounts.ok)
    return { reply: { status: 502, body: { ok: false, stage: "accounts", error: `Blotato accounts lookup failed (${accounts.status}): ${accounts.body.slice(0, 180)}` } } };
  const accountList: any[] = Array.isArray(accounts.json?.items) ? accounts.json.items : Array.isArray(accounts.json) ? accounts.json : [];
  // One target per platform (a ticked box twice is still one post). `platform` keeps the caller's spelling for the answer.
  const seen = new Set<string>();
  const wanted = platforms.filter((p) => !seen.has(platformKey(p)) && !!seen.add(platformKey(p)));
  const targets = wanted.map((platform) => {
    const a = accountList.find((x) => String(x?.platform ?? x?.targetType ?? "").toLowerCase() === platformKey(platform));
    return { platform, account: a ? { id: String(a.id), platform: platformKey(platform), label: accountLabel(a) } : null };
  });
  const files = renders.map((p) => {
    const bytes = readFile(p);
    return { sha: sha(bytes), bytes };
  });
  return { plan: { key, carouselId, name: String(doc.name ?? carouselId), caption: caption || String(doc.name ?? ""), platforms: wanted, files, targets } };
}

/** The outward part: slides up, one post per platform that has an account. Exactly what the old handler did. */
export async function postDesign(plan: DesignPlan, deps: Pick<DesignPublishDeps, "blotato">): Promise<DesignPublishReply> {
  const blotato = deps.blotato ?? blotatoFetch;
  const mediaUrls: string[] = [];
  for (const f of plan.files) {
    const up = await blotato(plan.key, "/media", { method: "POST", body: JSON.stringify({ url: `data:image/png;base64,${f.bytes.toString("base64")}` }) });
    const url = up.json?.url ?? up.json?.publicUrl;
    if (!up.ok || !url) return { status: 502, body: { ok: false, stage: "media", error: `slide upload failed (${up.status}): ${up.body.slice(0, 180)}` } };
    mediaUrls.push(String(url));
  }
  const results: Array<{ platform: string; ok: boolean; detail: string }> = [];
  for (const t of plan.targets) {
    if (!t.account) {
      results.push({ platform: t.platform, ok: false, detail: "no account connected in Blotato" });
      continue;
    }
    const post = await blotato(plan.key, "/posts", {
      method: "POST",
      body: JSON.stringify({ post: { accountId: t.account.id, target: { targetType: platformKey(t.platform) }, content: { text: plan.caption, mediaUrls, platform: platformKey(t.platform) } } }),
    });
    results.push({ platform: t.platform, ok: post.ok, detail: post.ok ? "queued" : `${post.status}: ${post.body.slice(0, 140)}` });
  }
  return { status: 200, body: { ok: results.some((r) => r.ok), results, mediaUrls: mediaUrls.length } };
}

export type DesignPublishInput = {
  body: unknown;
  /** True in MU_HUB_ROLE=server: every caller asks first. */
  approvalMode: boolean;
  /** The verified principal the gate derived (never a body field). Required in approval mode. */
  requester: Principal | null;
  approvals?: () => ApprovalService;
  notify?: GatedNotify;
};

/** The whole route, after authentication and body parsing. */
export async function handleDesignPublish(input: DesignPublishInput, deps: DesignPublishDeps): Promise<DesignPublishReply> {
  const parsed: any = input.body ?? {};
  const prepared = await prepareDesignPublish(parsed, deps);
  if ("reply" in prepared) return prepared.reply;
  const { plan } = prepared;
  if (!input.approvalMode) return postDesign(plan, deps);

  const { requester } = input;
  if (!requester) return { status: 401, body: { ok: false, error: "Sign in first." } };
  let service: ApprovalService;
  try {
    service = input.approvals!();
  } catch (error) {
    return { status: 409, body: { ok: false, error: error instanceof Error ? error.message : "Approvals aren't available here." } };
  }
  const resource = designResource(plan.carouselId);
  const args = designArgs(plan);

  if (parsed.approvalId !== undefined) {
    // RUN: only once, only after B2 approved it; the person and the digest of what would go out now are checked inside.
    const r = await runGated(
      service,
      { action: DESIGN_PUBLISH_ACTION, resource, args, approvalId: parsed.approvalId, caller: requester, words: { noun: "post" } },
      (_by) => postDesign(plan, deps),
      (done) => done.status === 200 && done.body.ok === true,
    );
    if (!r.ok) return { status: r.status, body: { ok: false, ...r.body } };
    const outcome = r.value.status === 200 && r.value.body.ok === true ? "succeeded" : "failed";
    return { status: r.value.status, body: { ...r.value.body, approvalId: r.approvalId, outcome } };
  }

  // ASK: nothing is posted. Nothing to ask about when no selected platform has an account.
  if (!plan.targets.some((t) => t.account)) return { status: 409, body: { ok: false, stage: "accounts", error: "None of the selected platforms has an account connected in Blotato." } };
  const asked = await askGated(service, input.notify ?? (async () => ({ ok: false, detail: "no notifier" })), {
    action: DESIGN_PUBLISH_ACTION,
    resource,
    args,
    summary: designSummary(plan, requester.personId),
    requester,
    next: (id) => `Approve it (the approval card in your session, or the owner's spoken yes / Telegram code), then POST the same request with { approvalId: "${id}" } to post it once.`,
  });
  return asked.status === 202 ? { status: 202, body: { ...asked.body, ok: false, slides: plan.files.length, targets: plan.targets.map((t) => ({ platform: t.platform, account: t.account?.label ?? null })) } } : { status: asked.status, body: { ok: false, ...asked.body } };
}
