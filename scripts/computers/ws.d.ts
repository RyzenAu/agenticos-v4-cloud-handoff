// Minimal typing for the `ws` package (already installed as a dependency of the dev server); its own types are not installed.
declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";
  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    binaryType: string;
    send(data: Uint8Array | string, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: "close" | "error", listener: (...args: any[]) => void): this;
  }
  export class WebSocketServer {
    constructor(options: { noServer: true; maxPayload?: number });
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket) => void): void;
    close(): void;
  }
}
