// R8 F review: an unreadable sign-in store is shown on the System page, from /__health, with the recovery. Nothing shows when it is fine.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionStoreNotice } from "../src/components/shell/pages/session-store-notice";
import { fetchSessionStoreHealth } from "../src/lib/session-store-health";

const failed = {
  status: "failed",
  detail: "Sign-in records can't be read (not valid JSON): nothing will be overwritten.",
  recovery: "1. Stop the hub. 2. Put back the sign-in records file from the newest verified backup. 3. Start the hub.",
};

test("failed: a danger notice with the plain title, the detail and the recovery", () => {
  const html = renderToStaticMarkup(<SessionStoreNotice health={failed} />);
  expect(html).toContain("Sign-in records can&#x27;t be read — nothing will be overwritten");
  expect(html).toContain("newest verified backup");
  expect(html).not.toMatch(/devices\.json|R8-F-OPS/);
});

test("ok, unknown or not allowed: nothing is shown", () => {
  expect(
    renderToStaticMarkup(
      <SessionStoreNotice health={{ status: "ok", detail: "Sign-in records read." }} />,
    ),
  ).toBe("");
  expect(renderToStaticMarkup(<SessionStoreNotice health={null} />)).toBe("");
});

test("reads the component from a 503 report; a 401 shows nothing", async () => {
  const f = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  expect(
    await fetchSessionStoreHealth(
      f(503, { status: "failed", components: { sessionStore: failed } }),
    ),
  ).toEqual(failed);
  expect(await fetchSessionStoreHealth(f(401, { error: "pair first" }))).toBeNull();
});
