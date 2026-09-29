// /__operator/desk-pay: the confirm card's API. GET is the card's feed (empty unless this is the owner at his desk), the
// two POSTs are his click on Confirm and on Cancel. The operator middleware has already checked the page token and the
// origin; confirming needs the desk verdict (loopback, no relay, a live signed-in session: a click in the OS at this PC).
import type { DeskVerdict } from "./policy";
import type { DeskPayments } from "./service";

export type DeskRouteInput = {
  path: string;
  method: string;
  body: unknown;
  desk: DeskVerdict;
  service: DeskPayments;
  send: (value: unknown, status?: number) => void;
};

export async function deskPayRoute({ path, method, body, desk, service, send }: DeskRouteInput): Promise<boolean> {
  if (path !== "/desk-pay" && !path.startsWith("/desk-pay/")) return false;
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (method === "GET" && path === "/desk-pay") {
    send(service.status({ desk }));
    return true;
  }
  if (method === "POST" && (path === "/desk-pay/confirm" || path === "/desk-pay/cancel")) {
    if (!desk.ok) {
      send({ ok: false, said: "Payments are confirmed at the PC itself, by the owner, with away mode off. Nothing was done." }, 403);
      return true;
    }
    if (path === "/desk-pay/cancel") {
      send(service.cancel(typeof b.id === "string" && b.id ? b.id : "all"));
      return true;
    }
    if (typeof b.id !== "string" || !b.id) {
      send({ ok: false, said: "Which payment?" }, 400);
      return true;
    }
    send(await service.confirm(b.id, { how: "card-click" }, { desk, source: "hands" }));
    return true;
  }
  send({ error: "Unknown desk payment route." }, 404);
  return true;
}
