// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostsRead } from "@/lib/computers-client";
import { AddComputer, ISOLATION_SENTENCE } from "./add-computer";

const render = (hosts: HostsRead, existing: string[] = []) => {
  const client = new QueryClient();
  client.setQueryData(["computers-hosts"], hosts);
  return renderToStaticMarkup(<QueryClientProvider client={client}><AddComputer existing={existing} /></QueryClientProvider>).replace(/<!-- -->/g, "");
};
const check = (ok: boolean, host: string, missing: string[] = [], notes: string[] = []) => ({ ok, host, present: [], missing, installCommand: null, notes });

describe("Add a shared computer (server render)", () => {
  test("says the true isolation sentence, lists hosts in plain words and offers Research and Builder on Ryzen-PC", () => {
    const html = render({ status: "ok", hosts: [{ kind: "wsl-local", check: check(true, "DESKTOP-X") }, { kind: "vps-ssh", check: check(true, "Ryzen-PC") }] });
    expect(html).toContain(ISOLATION_SENTENCE);
    expect(html).toContain("This PC (WSL)");
    expect(html).toContain("Ryzen-PC");
    expect(html).toContain("Create Research and Builder on Ryzen-PC");
    expect(html).toContain("Add computer");
  });

  test("a host that is not ok shows what is missing, is not selectable, and there is no suggestion on it", () => {
    const html = render({ status: "ok", hosts: [{ kind: "vps-ssh", check: check(false, "Ryzen-PC", ["Xvfb"], ["the SSH tunnel is down"]) }] });
    expect(html).toContain("Not available: missing Xvfb; the SSH tunnel is down");
    expect(html).toMatch(/<input type="radio"[^>]*disabled/);
    expect(html).not.toContain("Create Research and Builder");
  });

  test("with no SSH host ready, this PC's WSL gets the same one-click pair (the SSH host is still preferred when both are ready)", () => {
    expect(render({ status: "ok", hosts: [{ kind: "wsl-local", check: check(true, "DESKTOP-X") }] })).toContain("Create Research and Builder on This PC (WSL)");
    expect(render({ status: "ok", hosts: [{ kind: "wsl-local", check: check(true, "DESKTOP-X") }, { kind: "vps-ssh", check: check(false, "vps-ssh", [], ["the host did not answer: x"]) }] })).toContain("Create Research and Builder on This PC (WSL)");
    expect(render({ status: "ok", hosts: [{ kind: "wsl-local", check: check(true, "DESKTOP-X") }, { kind: "vps-ssh", check: check(true, "Ryzen-PC") }] })).toContain("Create Research and Builder on Ryzen-PC");
  });

  test("a host that did not answer is said to be unreachable (not 'missing packages' it was never asked about), without a technical key or stray line breaks", () => {
    const html = render({ status: "ok", hosts: [{ kind: "vps-ssh", check: check(false, "vps-ssh", ["Xvfb", "chromium"], ["the host did not answer: ssh: Could not resolve hostname ryzen-x: No such host is known. \r\n", "computers on this host run only while WSL is awake: it idles out when nothing runs in it."]) }] });
    expect(html).toContain("The host didn&#x27;t answer: ssh: Could not resolve hostname ryzen-x: No such host is known.");
    expect(html).not.toMatch(/missing Xvfb/);
    expect(html).not.toMatch(/>[^<]*vps-ssh/); // the technical key is not shown as text
    expect(html).not.toMatch(/\r|\n\s*;/);
    expect(html).toContain("Linux host over SSH");
    expect(html).not.toContain("Create Research and Builder");
  });

  test("a changed or unknown host key is shown as a refusal to connect, not as the host not answering", () => {
    const html = render({ status: "ok", hosts: [{ kind: "vps-ssh", check: check(false, "vps-ssh", [], ["This host's identity changed or is unknown — not connecting. Check the fingerprint before trusting it."]) }] });
    expect(html).toContain("identity changed or is unknown");
    expect(html).toContain("Check the fingerprint before trusting it.");
    expect(html).not.toContain("didn&#x27;t answer");
  });

  test("a host that is ready says so, with what it has", () => {
    const html = render({ status: "ok", hosts: [{ kind: "vps-ssh", check: { ...check(true, "Ryzen-PC"), present: ["Xvfb", "chromium", "x11vnc", "xdotool", "node", "fonts"] } }] });
    expect(html).toContain("Ready: Xvfb, chromium, x11vnc, xdotool, node, fonts");
  });

  test("no suggestion once Research exists; no host or an unreadable host says so instead of a form", () => {
    expect(render({ status: "ok", hosts: [{ kind: "vps-ssh", check: check(true, "Ryzen-PC") }] }, ["research"])).not.toContain("Create Research and Builder");
    expect(render({ status: "ok", hosts: [] })).toContain("No computer host is configured on this hub");
    const bad = render({ status: "unavailable", reason: "The computers service couldn't be reached." });
    expect(bad).toContain("Nothing can be added until it answers.");
    expect(bad).not.toContain("Add computer");
  });
});
