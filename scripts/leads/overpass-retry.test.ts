// The nightly lead hunt failed two nights on "Overpass 504: Gateway Timeout" (AUDIT-A4 #5). The
// find path now retries busy/timeout answers, can fall back to owner-set mirrors, and names what
// failed. No network: every request here is a fake.
import { describe, expect, test } from "bun:test";
import { fetchOsmElementsWithRetry, OverpassError, overpassEndpoints, type BBox } from "./osm";

const BBOX: BBox = { south: -33.8, west: 150.7, north: -33.7, east: 150.8 };
const ok = () => new Response(JSON.stringify({ elements: [{ type: "node", id: 1, tags: { name: "Synthetic Dental" } }] }), { headers: { "Content-Type": "application/json" } });
const status = (code: number, text: string) => new Response("", { status: code, statusText: text });

function fake(answers: Array<() => Response | Promise<Response>>) {
  const hosts: string[] = [];
  const request = (async (url: string) => {
    hosts.push(new URL(String(url)).host);
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  }) as unknown as typeof fetch;
  return { request, hosts };
}
const noSleep = { sleep: async () => {} };

describe("Overpass: retry busy and timeout answers, then fall back, then fail with the real cause", () => {
  test("a 504 then a 200 succeeds on the second try, after the configured pause", async () => {
    const waits: number[] = [];
    const { request, hosts } = fake([() => status(504, "Gateway Timeout"), ok]);
    const elements = await fetchOsmElementsWithRetry("dental", BBOX, request, { endpoints: ["https://overpass-api.de/api/interpreter"], backoffsMs: [0, 20_000, 60_000], sleep: async (ms) => { waits.push(ms); } });
    expect(elements).toHaveLength(1);
    expect(hosts).toEqual(["overpass-api.de", "overpass-api.de"]);
    expect(waits).toEqual([20_000]);
  });

  test("the main instance keeps timing out: an owner-set mirror answers", async () => {
    const { request, hosts } = fake([() => status(504, "Gateway Timeout"), () => status(504, "Gateway Timeout"), ok]);
    const elements = await fetchOsmElementsWithRetry("dental", BBOX, request, { endpoints: ["https://overpass-api.de/api/interpreter", "https://overpass.mirror.example/api/interpreter"], backoffsMs: [0, 1], ...noSleep });
    expect(elements).toHaveLength(1);
    expect(hosts).toEqual(["overpass-api.de", "overpass-api.de", "overpass.mirror.example"]);
  });

  test("still failing: the error says 504, how many attempts and which hosts, and is transient", async () => {
    const { request } = fake(Array.from({ length: 3 }, () => () => status(504, "Gateway Timeout")));
    const error = await fetchOsmElementsWithRetry("real-estate", BBOX, request, { endpoints: ["https://overpass-api.de/api/interpreter"], backoffsMs: [0, 1, 1], ...noSleep }).catch((e) => e);
    expect(error).toBeInstanceOf(OverpassError);
    expect(error.message).toBe("Overpass 504: Gateway Timeout (after 3 attempts: overpass-api.de)");
    expect(error).toMatchObject({ status: 504, transient: true });
  });

  test("no answer at all is a timeout, retried like a 504", async () => {
    const abort = () => { throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }); };
    const { request } = fake([abort, abort]);
    const error = await fetchOsmElementsWithRetry("dental", BBOX, request, { endpoints: ["https://overpass-api.de/api/interpreter"], backoffsMs: [0, 1], ...noSleep }).catch((e) => e);
    expect(error.message).toBe("Overpass timeout: no answer in 30 s (after 2 attempts: overpass-api.de)");
  });

  test("a permanent error (400 bad query) is not retried", async () => {
    const { request, hosts } = fake([() => status(400, "Bad Request"), ok]);
    const error = await fetchOsmElementsWithRetry("dental", BBOX, request, { endpoints: ["https://overpass-api.de/api/interpreter"], backoffsMs: [0, 1, 1], ...noSleep }).catch((e) => e);
    expect(error).toMatchObject({ message: "Overpass 400: Bad Request", status: 400, transient: false });
    expect(hosts).toHaveLength(1);
  });

  test("endpoints: the main instance by default; OVERPASS_URLS adds mirrors (https only, no duplicates)", () => {
    expect(overpassEndpoints({})).toEqual(["https://overpass-api.de/api/interpreter"]);
    expect(overpassEndpoints({ OVERPASS_URLS: "http://127.0.0.1:18991/api/interpreter,http://evil.example/x" })).toEqual(["http://127.0.0.1:18991/api/interpreter"]); // loopback stub only
    expect(overpassEndpoints({ OVERPASS_URLS: "https://overpass-api.de/api/interpreter, https://overpass.kumi.systems/api/interpreter,http://insecure.example/x,https://overpass-api.de/api/interpreter" }))
      .toEqual(["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]);
  });
});
