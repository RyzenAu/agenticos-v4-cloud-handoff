/**
 * An RFB (VNC) stream filter: the hub's gate on what a viewer can DO to a computer.
 *
 * The viewer's bytes pass through this before they reach the computer's VNC server. Everything a client may send after the
 * handshake is one of a few fixed-size messages (RFC 6143 section 7.5); the filter parses them and forwards the harmless ones
 * (pixel format, encodings, framebuffer update requests) always, but KeyEvent, PointerEvent and ClientCutText (the ones that
 * change the computer) only while `canInput()` says this viewer holds the control lease. So a founder watching through the
 * viewer, or a viewer whose lease was just taken back by the agent, sees the screen and can do nothing to it.
 *
 * The hub only speaks "None" security to the computer's loopback-only server (there is no password to hold, and nothing but the
 * hub can reach it). A server that offers only VNC authentication is refused: we would rather show nothing than carry a password
 * through a browser.
 */

export type RfbState = "version" | "security-types" | "security-result" | "server-init" | "open" | "closed";

export class RfbGate {
  state: RfbState = "version";
  /** The protocol minor version the server announced (3, 7 or 8). */
  minor = 8;
  private serverBuf = Buffer.alloc(0);
  private clientBuf = Buffer.alloc(0);
  private chosenNone = false;
  /** Client bytes held back until the server has finished its side of the handshake (we never guess). */
  dropped = { key: 0, pointer: 0, cut: 0, resize: 0 };
  error: string | null = null;
  /** Bytes the server sent after its handshake finished: framebuffer data. More than a header's worth means a real frame reached the viewer. */
  openBytes = 0;

  constructor(private readonly canInput: () => boolean) {}

  /** Track the server's handshake. Returns the bytes to forward to the viewer (all of them: the server is trusted). */
  fromServer(chunk: Uint8Array): Uint8Array {
    if (this.state === "open") this.openBytes += chunk.length;
    if (this.state === "open" || this.state === "closed") return chunk;
    this.serverBuf = Buffer.concat([this.serverBuf, chunk]);
    let progressed = true;
    while (progressed && (this.state as RfbState) !== "open" && (this.state as RfbState) !== "closed") {
      progressed = false;
      const b = this.serverBuf;
      if (this.state === "version" && b.length >= 12) {
        const m = /^RFB 003\.(\d{3})\n$/.exec(b.subarray(0, 12).toString("latin1"));
        if (!m) return this.fail("not an RFB server", chunk);
        this.minor = Number(m[1]) >= 8 ? 8 : Number(m[1]) >= 7 ? 7 : 3;
        this.serverBuf = b.subarray(12);
        this.state = this.minor >= 7 ? "security-types" : "server-init";
        progressed = true;
      } else if (this.state === "security-types" && b.length >= 1) {
        const n = b[0];
        if (n === 0) return this.fail("the server refused the connection", chunk);
        if (b.length < 1 + n) break;
        const types = [...b.subarray(1, 1 + n)];
        if (!types.includes(1)) return this.fail("the server needs a VNC password; only open loopback servers are supported", chunk);
        this.chosenNone = true;
        this.serverBuf = b.subarray(1 + n);
        this.state = this.minor >= 8 ? "security-result" : "server-init";
        progressed = true;
      } else if (this.state === "security-result" && b.length >= 4) {
        if (b.readUInt32BE(0) !== 0) return this.fail("the server refused the connection", chunk);
        this.serverBuf = b.subarray(4);
        this.state = "server-init";
        progressed = true;
      } else if (this.state === "server-init" && b.length >= 24) {
        const nameLen = b.readUInt32BE(20);
        if (nameLen > 4096) return this.fail("the server's name is too long", chunk);
        if (b.length < 24 + nameLen) break;
        this.serverBuf = Buffer.alloc(0);
        this.state = "open";
        progressed = false;
      }
    }
    return chunk;
  }

  private fail(reason: string, chunk: Uint8Array): Uint8Array {
    this.error = reason;
    this.state = "closed";
    return chunk;
  }

  /** Client handshake bytes still owed (version echo, the security choice for 3.7+, ClientInit); null until the server's version is known. */
  private hsLeft: number | null = null;
  private hsIndex = 0;

  /**
   * Filter the viewer's bytes. The viewer's part of the handshake is a fixed number of bytes (the version echo, one security
   * choice which must be "None", and ClientInit); they pass. Bytes beyond them are messages: only whole, recognised ones pass,
   * and input messages only while the lease is held, even if the viewer pipelined them before the server answered. Nothing
   * is forwarded before the server's version is known (a viewer cannot talk first). Anything unrecognised closes the stream.
   */
  fromClient(chunk: Uint8Array): Uint8Array {
    if (this.state === "closed") return new Uint8Array(0);
    this.clientBuf = Buffer.concat([this.clientBuf, chunk]);
    if (this.hsLeft === null) {
      if (this.state === "version") return new Uint8Array(0);
      this.hsLeft = 12 + (this.minor >= 7 ? 1 : 0) + 1;
    }
    const out: Buffer[] = [];
    while (this.hsLeft > 0 && this.clientBuf.length) {
      const take = Math.min(this.hsLeft, this.clientBuf.length);
      const part = this.clientBuf.subarray(0, take);
      if (this.minor >= 7 && this.hsIndex <= 12 && this.hsIndex + take > 12 && part[12 - this.hsIndex] !== 1) {
        this.error = "the viewer asked for a security type other than None";
        this.state = "closed";
        return new Uint8Array(0);
      }
      out.push(Buffer.from(part));
      this.hsIndex += take;
      this.hsLeft -= take;
      this.clientBuf = this.clientBuf.subarray(take);
    }
    if (this.hsLeft > 0) return out.length ? Buffer.concat(out) : new Uint8Array(0);
    for (;;) {
      const b = this.clientBuf;
      if (!b.length) break;
      const need = messageLength(b);
      if (need === -1) {
        this.error = `an unknown message type (${b[0]}) from the viewer`;
        this.state = "closed";
        this.clientBuf = Buffer.alloc(0);
        break;
      }
      if (need === 0 || b.length < need) break; // need more bytes
      const msg = b.subarray(0, need);
      this.clientBuf = b.subarray(need);
      const type = msg[0];
      // Input that changes the computer: a key (4, or QEMU's extended key 255), the pointer (5), the clipboard (6), a screen resize (251).
      if (type === 4 || type === 5 || type === 6 || type === 251 || type === 255) {
        if (this.canInput()) out.push(Buffer.from(msg));
        else this.dropped[type === 5 ? "pointer" : type === 6 ? "cut" : type === 251 ? "resize" : "key"]++;
      } else out.push(Buffer.from(msg));
    }
    return out.length ? Buffer.concat(out) : new Uint8Array(0);
  }
}

/** The byte length of the client message at the start of `b`; 0 = need more bytes to know; -1 = not a message we recognise. */
export function messageLength(b: Buffer): number {
  switch (b[0]) {
    case 0: return 20;
    case 2: return b.length >= 4 ? 4 + 4 * b.readUInt16BE(2) : 0;
    case 3: return 10;
    case 4: return 8;
    case 5: return 6;
    case 6: {
      if (b.length < 8) return 0;
      const n = b.readUInt32BE(4);
      return n > 1_048_576 ? -1 : 8 + n;
    }
    // What noVNC sends when the server advertises it: a Fence (248: flags, then a short payload), SetDesktopSize (251) and QEMU's
    // extended key event (255, subtype 0).
    case 248: {
      if (b.length < 9) return 0;
      return b[8] > 64 ? -1 : 9 + b[8];
    }
    case 251: {
      if (b.length < 8) return 0;
      return 8 + 16 * b[6];
    }
    case 255: {
      if (b.length < 2) return 0;
      return b[1] === 0 ? 12 : -1;
    }
    default: return -1;
  }
}
