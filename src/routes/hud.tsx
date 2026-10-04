import { docTitle } from "@/components/shell/destinations";
import { createFileRoute } from "@tanstack/react-router";
import { JarvisHudWindow } from "@/components/operator/jarvis-hud";

function HudPage() {
  return (
    <>
      <h1 className="sr-only">Jarvis HUD</h1>
      <JarvisHudWindow />
    </>
  );
}

// A bare page for a small always-on-top window (e.g. Chrome's --app=http://localhost:8081/hud).
export const Route = createFileRoute("/hud")({
  head: () => ({ meta: [{ title: docTitle("/hud") }] }),
  component: HudPage,
});
