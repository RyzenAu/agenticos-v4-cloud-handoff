// R9 ops: the hub computer's alerts on Home and System for any signed-in founder; the plain list on System; nothing on a PC hub.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HostAlertsNotice, HostHealthList } from "../src/components/shell/pages/host-health-notice";
import { fetchHostHealth, type HostHealth } from "../src/lib/host-health";

const NOW = Date.parse("2026-10-03T08:05:00.000Z");
const base: HostHealth = {
  status: "ok",
  detail: "Every service on the hub host is answering.",
  checkedAt: "2026-10-03T08:03:00.000Z",
  host: "RYZEN-PC",
  checks: [
    { id: "hub", label: "Hub", state: "ok", detail: "Answering on port 8081." },
    { id: "staging", label: "Dot's staging gateway", state: "info", detail: "Report only." },
  ],
  alerts: [],
  telegram: true,
};

test("no alerts and a fresh report: nothing on Home", () => {
  expect(renderToStaticMarkup(<HostAlertsNotice health={base} now={NOW} />)).toBe("");
});

test("not set up here, unknown or not allowed: nothing", () => {
  expect(renderToStaticMarkup(<HostAlertsNotice health={{ ...base, checkedAt: null }} now={NOW} />)).toBe("");
  expect(renderToStaticMarkup(<HostAlertsNotice health={null} now={NOW} />)).toBe("");
  expect(renderToStaticMarkup(<HostHealthList health={{ ...base, checkedAt: null, checks: [] }} />)).toBe("");
});

test("an active alert: a danger notice in plain words; the fix commands and paths stay off the page", () => {
  const html = renderToStaticMarkup(
    <HostAlertsNotice
      health={{
        ...base,
        status: "degraded",
        alerts: [
          {
            id: "hub_gave_up",
            title: "The hub supervisor gave up",
            plain: "The hub stopped restarting itself after repeated failures. Someone needs to check the hub computer and start it again.",
            detail: "It stopped after 6 failures in 10 minutes; the hub stays down until the task is started again.",
            recovery: "Read C:\mu-hub\logs\hub-stderr.log.1, then Start-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Hub Supervisor'.",
            since: "2026-10-03T08:00:00.000Z",
          },
        ],
      }}
      now={NOW}
    />,
  );
  expect(html).toContain("Hub computer: The hub supervisor gave up");
  expect(html).toContain("Someone needs to check the hub computer");
  expect(html).toContain("went to the owner&#x27;s Telegram");
  expect(html).toContain('role="alert"');
  for (const bad of ["C:\\", "Start-ScheduledTask", ".log", ".ps1", ".md", "Fix:"]) expect(html).not.toContain(bad);
});

test("a corrupt health report: one plain line", () => {
  const html = renderToStaticMarkup(<HostAlertsNotice health={{ ...base, status: "degraded", checkedAt: null, checks: [], reportUnreadable: true, recovery: "Run the \MU\MU Health Check task once" }} now={NOW} />);
  expect(html).toContain("Hub computer: the health report can&#x27;t be read");
  expect(html).not.toContain("MU Health Check");
});

test("a stale report: one quiet warning", () => {
  const html = renderToStaticMarkup(<HostAlertsNotice health={{ ...base, checkedAt: "2026-10-03T07:00:00.000Z", detail: "last ran 65 min ago", recovery: "Check the \MU\MU Health Check task" }} now={NOW} />);
  expect(html).toContain("the health check hasn&#x27;t run recently");
  expect(html).not.toContain("MU Health Check");
});

test("System list: every check with its plain line, and where alerts go", () => {
  const html = renderToStaticMarkup(<HostHealthList health={base} />);
  expect(html).toContain("Hub computer (RYZEN-PC)");
  expect(html).toContain("Answering on port 8081.");
  expect(html).toContain("All ok");
  expect(html).toContain("Windows Event Log and to the owner&#x27;s Telegram");
});

test("reads components.host from a 200 or 503 report; a 401 or an older hub gives null", async () => {
  const f = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  expect(await fetchHostHealth(f(200, { components: { host: base } }))).toEqual(base);
  expect(await fetchHostHealth(f(503, { components: { host: base } }))).toEqual(base);
  expect(await fetchHostHealth(f(401, { error: "pair first" }))).toBeNull();
  expect(await fetchHostHealth(f(200, { components: {} }))).toBeNull();
});
