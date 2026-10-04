/// <reference path="./ws.d.ts" />
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { DevicesService } from "../devices/service";
import { holderKey } from "./types";
import { RfbGate } from "./rfb";
import { isAtThisPc, markLoopbackUnproven } from "../identity/principal";
import type { LocalOwnerProof } from "../identity/local-owner-token";
import type { ComputersService } from "./service";
import type { GatewayTrust } from "../gateway/hub";
import { ASSERTION_HEADER } from "../gateway/config";

/**
 * The live viewer: an authenticated WebSocket on the HUB (`/__computers/<name>/vnc`) that carries the RFB stream of a computer's
 * loopback-only VNC server, through a stdio tunnel the adapter opens (wsl.exe or ssh -W). The computer publishes no port.
 *
 * Every rule is enforced here, before a byte moves:
 *  - the caller is a PERSON (a confirmed browser session or paired device) resolved by the one identity contract; a bearer token,
 *    a cookie-less local program or a cross-site page is refused (the Origin must be the page's own host);
 *  - any founder may WATCH; only the person who holds the control lease may send input, re-checked on every message, so a lease
 *    taken back (the agent returned, it expired, the other founder took it) stops their keys and clicks at once;
 *  - the byte stream is filtered by RfbGate, so nothing but framebuffer requests and (while allowed) key/pointer/clipboard events
 *    reaches the computer.
 * A noVNC client in the page speaks this stream as is; the JPEG snapshot route is the fallback when a computer has no VNC server.
 */

/** A viewer that has connected has this long to receive a first frame before the screen is reported as "no picture". */
export const NO_FRAME_MS = 8_000;
export const VIEWER_PATH = /^\/__computers\/([a-z0-9-]{1,32})\/vnc$/;

export type ViewerOptions = {
  devices: DevicesService;
  computers: ComputersService;
  /** How long a connected viewer waits for a first frame before the screen reads "no picture" (default 8 s). */
  noFrameMs?: number;
  /**
   * Server role: a WebSocket upgrade never passes the identity gate (it is not a connect request), so the same rule is applied here:
   * a loopback upgrade is the owner only WITH the local-owner proof; otherwise it is marked nobody before identity is resolved.
   */
  localOwnerProof?: LocalOwnerProof;
  /**
   * The Dot gateway's hub-side trust (scripts/gateway/hub.ts). An upgrade carrying a gateway assertion is checked here first
   * and refused when it does not verify. A verified one is the gateway principal, which has no viewer access yet
   * (bots.operate is out of scope on the hub: DOT-GATEWAY-DESIGN.md), so it is refused too. Without trust: refused.
   */
  gateway?: GatewayTrust;
};

export function attachViewer(server: Server, options: ViewerOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = VIEWER_PATH.exec(url.pathname);
    if (!m) return; // not ours: the dev server's own sockets keep working
    void upgradeViewer(options, wss, m[1], req, socket, head);
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    wss.close();
  };
}

function refuse(socket: Duplex, status: number, message: string) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function upgradeViewer(options: ViewerOptions, wss: WebSocketServer, name: string, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const { devices, computers } = options;
  try {
    // The Dot gateway: decided before anything else, never falls through to another identity.
    if (req.headers[ASSERTION_HEADER] !== undefined) {
      const verdict = options.gateway?.screenUpgrade(req) ?? null;
      if (!verdict || !verdict.ok) return refuse(socket, verdict?.status ?? 401, "Unauthorized");
      return refuse(socket, 403, "Forbidden");
    }
    // Mark BEFORE anything resolves an identity (the gate does the same for ordinary requests). The proof headers never travel on.
    if (options.localOwnerProof) {
      const atPc = isAtThisPc(req);
      const carried = options.localOwnerProof.check(req);
      if (atPc && !carried) markLoopbackUnproven(req);
    }
    const id = devices.identify(req);
    if (!id.loopbackSocket || (!id.local && !id.tailnet)) return refuse(socket, 403, "Forbidden");
    // A page on another origin must not be able to open a viewer with the owner's cookies (cross-site WebSocket hijacking).
    const origin = req.headers.origin;
    if (origin && origin !== `${id.secure ? "https" : "http"}://${req.headers.host}`) return refuse(socket, 403, "Forbidden");
    if (!id.verified || !id.principal || id.principal.sharedOnly || id.verified.actor !== "human" || !id.verified.sessionId) return refuse(socket, 401, "Unauthorized");
    const who = { personId: id.principal.personId, session: id.verified.sessionId };
    const tunnel = await computers.openVnc(name).catch(() => null);
    if (!tunnel) {
      // Not "the screen vanished": the screen server didn't answer. Said as a failure of the viewer layer; the layers below it are judged by the host's probe.
      try {
        computers.screenFault(name, { layer: "viewer", reason: "The live view was refused: the computer's screen server (VNC) didn't answer.", at: Date.now() });
      } catch {
        /* recording why never changes the answer: the refusal is the same 404 */
      }
      return refuse(socket, 404, "No viewer");
    }
    const view = computers.view(name);
    const deviceId = view.id;
    const key = holderKey({ kind: "person", personId: who.personId, session: who.session });
    const canInput = () => {
      const lease = deviceId ? computers.leases.current(deviceId) : null;
      return !!lease && holderKey(lease.holder) === key;
    };
    const gate = new RfbGate(canInput);
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const writer = tunnel.write.getWriter();
      let closed = false;
      let framed = false;
      computers.viewerOpened(name, who);
      // Connected is not live: a viewer is only a working screen once a real frame has arrived through it.
      const noFrame = setTimeout(() => {
        if (!framed && !closed) computers.screenFault(name, { layer: "frame", reason: "The viewer connected to the screen server but no picture arrived within 8 seconds.", at: Date.now() });
      }, options.noFrameMs ?? NO_FRAME_MS);
      noFrame.unref?.();
      const shut = () => {
        if (closed) return;
        closed = true;
        clearTimeout(noFrame);
        if (framed) computers.screenGone(name);
        else if (gate.error) computers.screenFault(name, { layer: "viewer", reason: `The screen handshake failed: ${gate.error}.`, at: Date.now() });
        computers.viewerClosed(name, who); // leaving gives the computer back after a short grace (service.ts)
        try {
          tunnel.close();
        } catch {
          /* already gone */
        }
        try {
          ws.close();
        } catch {
          /* already gone */
        }
      };
      ws.on("message", (data: Buffer) => {
        const out = gate.fromClient(data);
        if (gate.state === "closed") return shut();
        if (out.length) void writer.write(out).catch(shut);
      });
      ws.on("close", shut);
      ws.on("error", shut);
      let lastNote = 0;
      void (async () => {
        const reader = tunnel.read.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const pass = gate.fromServer(value);
            if (gate.state === "closed") break;
            ws.send(pass);
            if (gate.openBytes >= 16) {
              if (!framed) {
                framed = true;
                computers.screenFrame(name, { first: true });
              } else if (Date.now() - lastNote > 5_000) computers.screenFrame(name);
              lastNote = Date.now();
            }
            const released = gate.fromClient(new Uint8Array(0)); // a viewer that spoke early gets its handshake through now
            if (released.length) void writer.write(released).catch(shut);
          }
        } catch {
          /* the tunnel dropped */
          if (!framed) computers.screenFault(name, { layer: "viewer", reason: "The tunnel to the screen server dropped before a picture arrived.", at: Date.now() });
        } finally {
          shut();
        }
      })();
    });
  } catch {
    refuse(socket, 500, "Error");
  }
}
