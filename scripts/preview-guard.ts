import type { Plugin } from "vite";

/**
 * AGENTIC_OS_NO_BACKGROUND=1 runs a quiet second copy of the dev server (performance
 * measurement, previews) beside the live one on 8081. It starts no schedulers, timers,
 * sync loops or away-mode, never rewrites shared task/mail state at boot, and refuses every
 * mutating `/__*` request, so it cannot double-send a Telegram alert, a cron job or a sync.
 */
export function backgroundJobsDisabled(env: NodeJS.ProcessEnv = process.env) {
  return env.AGENTIC_OS_NO_BACKGROUND === "1";
}

/**
 * A quiet copy that was given its OWN memory setup (MU_WIKI_ROOT and MEMORY_STATE_DIR both set
 * explicitly: a synthetic vault and store) may use the memory routes, the voice turn (whose memory
 * rule writes there) and speech-to-text (which records a spoken yes for a forget approval), so the memory connector can be exercised end to end beside the live app. Every
 * other mutating route stays refused, and no background job starts.
 */
export function quietMemoryAllowed(path: string, env: NodeJS.ProcessEnv = process.env) {
  if (!(env.MU_WIKI_ROOT ?? "").trim() || !(env.MEMORY_STATE_DIR ?? "").trim()) return false;
  // stt: the voice pipeline's own transcription, which records a spoken yes (the forget approval).
  return /^\/__memory(?:\/[a-z/-]*)?$/.test(path) || path === "/__operator/voice/free/turn" || path === "/__operator/voice/free/stt";
}

export function previewAllowsMutation(path: string) {
  if (path === "/__website-os/connect") return true; // Read-only local preview inspection.
  // CRM deal fields, board moves and stage rules only touch this workspace's own crm.sqlite.
  if (/^\/__operator\/leads\/(?:deal|move|rules)$/.test(path)) return true;
  if (
    /^\/__operator\/memory\/apps\/(?:codex|claude|hermes|granola|gmail|outlook|notion|chatgpt)(?:\/(?:sync|import))?$/.test(
      path,
    )
  )
    return true;
  return /^\/__operator\/(?:conversations(?:\/[^/]+)?|memory(?:\/[^/]+)?|inbox|calendar(?:\/import)?|brain\/sources|settings|goals|connections\/(?:configure|start|sync|disconnect))$/.test(
    path,
  );
}

/** Preview worktrees can edit their own workspace, not installed agent/system settings. */
export function previewGuard(): Plugin {
  return {
    name: "argentic-preview-isolation",
    configureServer(server) {
      if (backgroundJobsDisabled()) {
        server.middlewares.use((req, res, next) => {
          const path = new URL(req.url || "/", "http://localhost").pathname;
          if (!path.startsWith("/__") || ["GET", "HEAD", "OPTIONS"].includes(req.method || "GET") || quietMemoryAllowed(path)) return next();
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "This is a quiet read-only copy (AGENTIC_OS_NO_BACKGROUND=1). Use the main app on 127.0.0.1:8081." }));
        });
        return;
      }
      if (process.env.ARGENTIC_PREVIEW !== "1") return;
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url || "/", "http://localhost").pathname;
        if (
          !path.startsWith("/__") ||
          ["GET", "HEAD", "OPTIONS"].includes(req.method || "GET") ||
          previewAllowsMutation(path)
        )
          return next();
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error:
              "This preview saves its own workspace. Use the main app on localhost:8081 for agent runs or system settings.",
          }),
        );
      });
    },
  };
}
