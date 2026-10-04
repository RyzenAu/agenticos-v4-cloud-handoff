// R11: if the app's code never starts (a module that failed to load, a hub that stopped answering mid-load), the server-rendered
// skeletons used to sit there forever. This tiny inline script shows a plain error with Reload after a bounded wait; the root
// component cancels it as soon as the app is running (clearLoadWatchdog, called from its first effect).
export const LOAD_WATCHDOG_MS = 20_000;
const GLOBAL = "__agenticOsLoadWatchdog";

function installLoadWatchdog(w: Window & Record<string, unknown>, ms: number) {
  // Serialised into an inline script: no outer names in here.
  const key = "__agenticOsLoadWatchdog";
  if (w[key]) return;
  const timer = w.setTimeout(() => {
    const d = w.document;
    if (!d.body || d.getElementById("os-load-watchdog")) return;
    const box = d.createElement("div");
    box.id = "os-load-watchdog";
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;max-width:min(36rem,calc(100vw - 32px));display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:14px 18px;border-radius:18px;border:1px solid var(--border-strong,#555);background:var(--card,#1b1b1b);color:var(--foreground,#eee);font:15px/1.5 Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35)";
    const text = d.createElement("span");
    text.style.cssText = "flex:1 1 16rem;min-width:0";
    text.textContent = "This page didn't finish loading: the app's code or the hub didn't answer. Nothing was changed.";
    const btn = d.createElement("button");
    btn.type = "button";
    btn.textContent = "Reload";
    btn.style.cssText = "min-height:40px;padding:0 18px;border-radius:999px;border:0;background:var(--brand,#c7a35a);color:var(--brand-foreground,#111);font:inherit;font-weight:600;cursor:pointer";
    btn.onclick = () => w.location.reload();
    box.append(text, btn);
    d.body.append(box);
  }, ms);
  w[key] = { cancel: () => w.clearTimeout(timer) };
}

export const LOAD_WATCHDOG_SCRIPT = `try{(${installLoadWatchdog.toString()})(window,${LOAD_WATCHDOG_MS})}catch(e){}`;

/** The app is running: cancel the watchdog (and remove its message if a slow load showed it). */
export function clearLoadWatchdog() {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, { cancel?: () => void } | undefined>;
  w[GLOBAL]?.cancel?.();
  document.getElementById("os-load-watchdog")?.remove();
}
