import { describe, expect, test } from "bun:test";
import { containerName, DockerAdapter, volumeName } from "./docker";
import type { ExecResult, HostRunner } from "./script-adapter";

const IMAGE = `mu/computer@sha256:${"a".repeat(64)}`;
const script = "#!/usr/bin/env bash\necho script";

/** A fake `docker` CLI: records every call; answers the script's actions (inside `docker exec`) from a table. No Docker exists on this PC. */
function fakeDocker(answers: Record<string, unknown> = {}) {
  const calls: { argv: string[]; stdin: string }[] = [];
  const runner: HostRunner = async (argv, opts) => {
    calls.push({ argv, stdin: opts?.stdin ?? "" });
    if (argv[1] === "exec") {
      const action = argv[argv.indexOf("--") + 1];
      const a = answers[action];
      return { code: 0, stdout: JSON.stringify(a ?? { ok: true }), stderr: "" } satisfies ExecResult;
    }
    if (argv[1] === "inspect") return { code: 0, stdout: "true\n", stderr: "" };
    if (argv[1] === "stats") return { code: 0, stdout: "412.5MiB / 1GiB|3.25%\n", stderr: "" };
    if (argv[1] === "version") return { code: 0, stdout: "27.0.0\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls, docker: () => calls.filter((c) => c.argv[1] !== "exec").map((c) => c.argv.slice(1, 3).join(" ")) };
}

describe("docker adapter (fake CLI; Docker is not installed and is not to be)", () => {
  test("an image that is not pinned by digest is refused", () => {
    expect(() => new DockerAdapter({ image: "kasmweb/chrome:1.19.0" }, fakeDocker().runner, script)).toThrow(/pinned by digest/);
    expect(() => new DockerAdapter({ image: "kasmweb/chrome:latest@sha256:abc" }, fakeDocker().runner, script)).toThrow();
    expect(() => new DockerAdapter({ image: IMAGE, memory: "1g; rm" }, fakeDocker().runner, script)).toThrow();
    expect(() => new DockerAdapter({ image: IMAGE }, fakeDocker().runner, script)).not.toThrow();
  });

  test("the container has no published port, drops every capability, has limits, and keeps its home in its own named volume", async () => {
    const f = fakeDocker({ check: { ok: true } });
    const a = new DockerAdapter({ image: IMAGE, memory: "1g", cpus: "1.5", pids: 300 }, f.runner, script);
    await a.installBundle("D:/bundle/companion.mjs");
    await a.provision({ name: "research", display: 101, resolution: "1280x800x24", hubUrl: "http://172.17.0.1:8113", pairingCode: "ABCD-EFGH", label: "Research" });
    const run = f.calls.find((c) => c.argv[1] === "run")!.argv;
    const text = run.join(" ");
    expect(text).not.toMatch(/(^| )(-p|--publish|-P|--publish-all)( |$)/);
    expect(text).not.toMatch(/--privileged|--network host|--pid host|-v \/|docker.sock/);
    expect(text).toContain("--cap-drop ALL");
    expect(text).toContain("--security-opt no-new-privileges");
    expect(text).toContain("--memory 1g");
    expect(text).toContain("--cpus 1.5");
    expect(text).toContain("--pids-limit 300");
    expect(text).toContain(`type=volume,source=${volumeName("research")},target=/home/mu`);
    expect(run).toContain(containerName("research"));
    expect(run.at(-3)).toBe(IMAGE);
    // the pairing code rides stdin into the container, never a docker command line (docker inspect would keep it)
    expect(f.calls.map((c) => c.argv.join(" ")).join("\n")).not.toMatch(/ABCD-EFGH/);
    expect(f.calls.some((c) => c.stdin.includes("export MU_PAIR_CODE='ABCD-EFGH'"))).toBe(true);
  });

  test("provision order: volume, container, bundle copied in, script provision, script start", async () => {
    const f = fakeDocker();
    const a = new DockerAdapter({ image: IMAGE }, f.runner, script);
    await a.installBundle("D:/bundle/companion.mjs");
    await a.provision({ name: "builder", display: 102, resolution: "1280x800x24", hubUrl: "http://172.17.0.1:8113", pairingCode: "WXYZ-2345", label: "Builder" });
    const steps = f.calls.map((c) => (c.argv[1] === "exec" ? `script:${c.argv[c.argv.indexOf("--") + 1]}` : c.argv.slice(1, 3).join(" ")));
    const at = (s: string) => steps.findIndex((x) => x.startsWith(s));
    expect(at("volume create")).toBeLessThan(at("run -d"));
    expect(at("run -d")).toBeLessThan(at("cp D:/bundle"));
    expect(at("cp")).toBeLessThan(at("script:install-bundle"));
    expect(at("script:install-bundle")).toBeLessThan(at("script:provision"));
    expect(at("script:provision")).toBeLessThan(at("script:start"));
    const exec = f.calls.find((c) => c.argv[1] === "exec")!.argv;
    expect(exec.slice(0, 5)).toEqual(["docker", "exec", "-i", containerName("builder"), "bash"]);
  });

  test("lifecycle: stop stops the script then the container; suspend the same; resume starts; recover restarts; destroy removes the container and its volume", async () => {
    const f = fakeDocker();
    const a = new DockerAdapter({ image: IMAGE }, f.runner, script);
    const h = { name: "research" };
    await a.stop(h);
    expect(f.docker()).toContain("stop -t");
    await a.suspend(h);
    await a.recover(h);
    expect(f.docker()).toContain("restart -t");
    await a.destroy(h);
    const docker = f.calls.filter((c) => c.argv[1] !== "exec").map((c) => c.argv.slice(1).join(" "));
    expect(docker).toContain(`rm -f ${containerName("research")}`);
    expect(docker).toContain(`volume rm -f ${volumeName("research")}`);
    // a stop never removes the volume: files survive
    const stopIdx = docker.findIndex((c) => c.startsWith("stop"));
    expect(docker.slice(0, stopIdx + 1).some((c) => c.startsWith("volume rm"))).toBe(false);
  });

  test("probe reports the container's own memory and CPU from docker stats", async () => {
    const f = fakeDocker({ probe: { ok: true, companion: true, xvfb: true, vnc: true, browser: true, procs: 9, rssKb: 100, cpu: 1 } });
    const r = await new DockerAdapter({ image: IMAGE }, f.runner, script, () => 7).probe({ name: "research" });
    expect(r).toMatchObject({ hostUp: true, companionAlive: true, vncAlive: true });
    expect(r.resource).toMatchObject({ rssMb: 413, cpuPct: 3.25 });
  });

  test("bad computer names never reach docker; an unreachable docker is reported, not thrown", async () => {
    const f = fakeDocker();
    const a = new DockerAdapter({ image: IMAGE }, f.runner, script);
    await expect(a.start({ name: "x; rm -rf /" })).rejects.toThrow(/bad computer name/);
    expect(f.calls).toHaveLength(0);
    const down = new DockerAdapter({ image: IMAGE }, async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }), script);
    const c = await down.check();
    expect(c.ok).toBe(false);
    expect(c.notes.join(" ")).toMatch(/Docker isn't reachable/);
  });
});
